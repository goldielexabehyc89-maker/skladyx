"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { warehouseAccess, isWhAllowed } from "@/lib/warehouse-access";
import { logEvent } from "@/lib/events";
import { broadcastRealtime } from "@/lib/realtime";
import { createQrIn } from "@/lib/qr";
import { warehouseZonesEnabled, coolingWorkflowEnabled } from "@/lib/roles";
import {
  createStandardZonesInTx,
  createCellsInZone,
  changeCellZone,
  renameZone,
  addPhysicalZone,
  cellErrorMessage,
} from "@/lib/cells";
import { isPhysicalZoneKind } from "@/lib/zones";
import type { ZoneKind } from "@prisma/client";

export interface FormState {
  error?: string;
}

const warehouseSchema = z.object({
  name: z.string().trim().min(1, "Укажите название склада"),
  address: z.string().trim().optional(),
});

export async function createWarehouseAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);

  const parsed = warehouseSchema.safeParse({
    name: formData.get("name"),
    address: formData.get("address") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.errors[0].message };
  if (!(await warehouseAccess(session)).all)
    return { error: "Создавать склады может только пользователь с доступом ко всем складам" };

  // Пакет 3: склад и 7 стандартных зон создаём в ОДНОЙ транзакции — при ошибке зон
  // склад не должен остаться без зон (атомарность).
  const warehouse = await prisma.$transaction(async (tx) => {
    const w = await tx.warehouse.create({
      data: { companyId: s.companyId, name: parsed.data.name, address: parsed.data.address },
    });
    await createStandardZonesInTx(tx, s.companyId, w.id);
    return w;
  });
  await logEvent({
    companyId: s.companyId,
    type: "warehouse_created",
    title: "Создан склад",
    body: warehouse.name,
    url: `/warehouse/warehouses/${warehouse.id}`,
    actorId: session.userId,
  });
  revalidatePath("/warehouse/warehouses");
  redirect(`/warehouse/warehouses/${warehouse.id}`);
}

export async function updateWarehouseAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);
  const id = String(formData.get("id") ?? "");
  await s.warehouse(id); // проверка принадлежности компании
  if (!isWhAllowed(await warehouseAccess(session), id))
    return { error: "Нет доступа к этому складу" };

  const parsed = warehouseSchema.safeParse({
    name: formData.get("name"),
    address: formData.get("address") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.errors[0].message };

  // Пакет 5: скорость охлаждения R (°C/час) — только при включённом флаге (иначе поле не трогаем).
  let coolingRate: number | null | undefined;
  if (coolingWorkflowEnabled()) {
    const rRaw = String(formData.get("coolingRate") ?? "").trim().replace(",", ".");
    if (rRaw === "") coolingRate = null;
    else {
      const r = Number(rRaw);
      if (!Number.isFinite(r) || r <= 0) return { error: "Скорость охлаждения R должна быть больше 0 (°C/час)" };
      coolingRate = r;
    }
  }

  await prisma.warehouse.update({
    where: { id },
    data: {
      name: parsed.data.name,
      address: parsed.data.address ?? null,
      isActive: formData.get("isActive") === "on",
      ...(coolingRate !== undefined ? { coolingRate } : {}),
    },
  });
  broadcastRealtime({
    type: "document.updated",
    entity: "warehouse",
    entityId: id,
    companyId: s.companyId,
    warehouseIds: [id],
    actorUserId: session.userId,
  });
  revalidatePath(`/warehouse/warehouses/${id}`);
  revalidatePath("/warehouse/warehouses");
  return {};
}

const bulkCellsSchema = z.object({
  prefix: z.string().trim().min(1, "Укажите префикс, например «А-»"),
  from: z.coerce.number().int().min(0),
  to: z.coerce.number().int().min(0),
});

// Массовое создание ячеек: префикс + диапазон номеров («А-» 1..20 → А-01…А-20).
export async function createCellsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);
  const warehouseId = String(formData.get("warehouseId") ?? "");
  await s.warehouse(warehouseId);
  if (!isWhAllowed(await warehouseAccess(session), warehouseId))
    return { error: "Нет доступа к этому складу" };

  const parsed = bulkCellsSchema.safeParse({
    prefix: formData.get("prefix"),
    from: formData.get("from"),
    to: formData.get("to"),
  });
  if (!parsed.success) return { error: parsed.error.errors[0].message };
  const { prefix, from, to } = parsed.data;
  if (to < from) return { error: "Конец диапазона меньше начала" };
  if (to - from + 1 > 500) return { error: "Не больше 500 ячеек за раз" };

  const pad = String(to).length > 2 ? String(to).length : 2;
  const codes: string[] = [];
  for (let i = from; i <= to; i++) codes.push(`${prefix}${String(i).padStart(pad, "0")}`);

  let created = 0;
  if (warehouseZonesEnabled()) {
    // Пакет 3: ячейки создаются в выбранной физической зоне; для STORAGE обязателен уровень.
    const zoneId = String(formData.get("zoneId") ?? "");
    if (!zoneId) return { error: "Выберите зону для ячеек" };
    const levelRaw = String(formData.get("level") ?? "").trim();
    const level = levelRaw ? Number(levelRaw) : null;
    if (levelRaw && (!Number.isInteger(level) || (level as number) < 1))
      return { error: "Уровень должен быть целым числом ≥ 1" };
    try {
      created = await createCellsInZone({ companyId: s.companyId, warehouseId, zoneId, codes, level });
    } catch (e) {
      return { error: cellErrorMessage(e) };
    }
  } else {
    const isStaging = formData.get("isStaging") === "on";
    created = await prisma.$transaction(async (tx) => {
      let count = 0;
      for (const code of codes) {
        const exists = await tx.cell.findUnique({ where: { warehouseId_code: { warehouseId, code } } });
        if (exists) continue;
        const cell = await tx.cell.create({ data: { companyId: s.companyId, warehouseId, code, isStaging } });
        await createQrIn(tx, { companyId: s.companyId, type: "CELL", refId: cell.id });
        count++;
      }
      return count;
    });
  }

  if (created === 0) return { error: "Все ячейки диапазона уже существуют" };
  broadcastRealtime({
    type: "cell.updated",
    entity: "cell",
    companyId: s.companyId,
    warehouseIds: [warehouseId],
    actorUserId: session.userId,
  });
  revalidatePath(`/warehouse/warehouses/${warehouseId}`);
  return {};
}

export async function toggleCellStagingAction(formData: FormData): Promise<void> {
  // Пакет 3: в режиме зон «зона выдачи» задаётся сменой зоны (changeCellZone), а не этим
  // тумблером. No-op — защита от старой вкладки, открытой до включения флага.
  if (warehouseZonesEnabled()) return;
  const session = await requireAdmin();
  const s = scoped(session);
  const cellId = String(formData.get("cellId") ?? "");
  const cell = await s.cell(cellId);
  if (!isWhAllowed(await warehouseAccess(session), cell.warehouseId)) return;
  await prisma.cell.update({ where: { id: cellId }, data: { isStaging: !cell.isStaging } });
  broadcastRealtime({
    type: "cell.updated",
    entity: "cell",
    entityId: cellId,
    companyId: s.companyId,
    warehouseIds: [cell.warehouseId],
    actorUserId: session.userId,
  });
  revalidatePath(`/warehouse/warehouses/${cell.warehouseId}`);
}

export async function toggleCellActiveAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const s = scoped(session);
  const cellId = String(formData.get("cellId") ?? "");
  const cell = await s.cell(cellId);
  if (!isWhAllowed(await warehouseAccess(session), cell.warehouseId)) return;
  await prisma.cell.update({ where: { id: cellId }, data: { isActive: !cell.isActive } });
  broadcastRealtime({
    type: "cell.updated",
    entity: "cell",
    entityId: cellId,
    companyId: s.companyId,
    warehouseIds: [cell.warehouseId],
    actorUserId: session.userId,
  });
  revalidatePath(`/warehouse/warehouses/${cell.warehouseId}`);
}

// ── Пакет 3: зоны ──

// Перенести ячейку в другую физическую зону (замена «сделать зоной выдачи»).
export async function changeCellZoneAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);
  const cellId = String(formData.get("cellId") ?? "");
  const zoneId = String(formData.get("zoneId") ?? "");
  if (!zoneId) return { error: "Выберите зону" };
  const levelRaw = String(formData.get("level") ?? "").trim();
  const level = levelRaw ? Number(levelRaw) : null;
  if (levelRaw && (!Number.isInteger(level) || (level as number) < 1))
    return { error: "Уровень должен быть целым ≥ 1" };
  const cell = await s.cell(cellId);
  if (!isWhAllowed(await warehouseAccess(session), cell.warehouseId)) return { error: "Нет доступа к складу" };
  try {
    await changeCellZone({ companyId: s.companyId, cellId, zoneId, level });
  } catch (e) {
    return { error: cellErrorMessage(e) };
  }
  broadcastRealtime({
    type: "cell.updated",
    entity: "cell",
    entityId: cellId,
    companyId: s.companyId,
    warehouseIds: [cell.warehouseId],
    actorUserId: session.userId,
  });
  revalidatePath(`/warehouse/warehouses/${cell.warehouseId}`);
  return {};
}

// Переименовать зону (названия зон настраиваются организацией). Плоское form-действие.
export async function renameZoneAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const s = scoped(session);
  const zoneId = String(formData.get("zoneId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const zone = await prisma.warehouseZone.findFirst({ where: { id: zoneId, companyId: s.companyId } });
  if (!zone) return;
  if (!isWhAllowed(await warehouseAccess(session), zone.warehouseId)) return;
  await renameZone(s.companyId, zoneId, name);
  revalidatePath(`/warehouse/warehouses/${zone.warehouseId}`);
}

// Добавить дополнительную физическую зону (допускается несколько зон одного kind).
export async function addZoneAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);
  const warehouseId = String(formData.get("warehouseId") ?? "");
  await s.warehouse(warehouseId);
  if (!isWhAllowed(await warehouseAccess(session), warehouseId)) return { error: "Нет доступа к складу" };
  const kind = String(formData.get("kind") ?? "") as ZoneKind;
  if (!isPhysicalZoneKind(kind)) return { error: "Добавлять можно только физические зоны" };
  try {
    await addPhysicalZone({ companyId: s.companyId, warehouseId, kind, name: String(formData.get("name") ?? "") });
  } catch (e) {
    return { error: cellErrorMessage(e) };
  }
  revalidatePath(`/warehouse/warehouses/${warehouseId}`);
  return {};
}
