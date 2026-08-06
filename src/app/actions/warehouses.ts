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
import { warehouseZonesEnabled } from "@/lib/roles";
import {
  createStandardZonesInTx,
  createCellsBatch,
  changeCellZone,
  renameCell,
  deleteCell,
  setCellActive,
  cellErrorMessage,
} from "@/lib/cells";

export interface FormState {
  error?: string;
  ok?: string;
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

  // Пакет 9A: скорость охлаждения R (°C/час) настраивается ВСЕГДА (даже при выключенных бизнес-флагах);
  // nullable, при заполнении строго > 0. Поле отправляется формой только когда присутствует в разметке.
  let coolingRate: number | null | undefined;
  if (formData.has("coolingRate")) {
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

// Пакет 9A: построить набор кодов ячеек. mode=manual → один код; mode=bulk → префикс + диапазон мест
// (+ для STORAGE диапазон уровней, код вида «PREFIX-МЕСТО-УРN»). Возвращает {code, level}[] (≤500) или ошибку.
function buildCellItems(fd: FormData, isStorage: boolean): { items?: { code: string; level: number | null }[]; error?: string } {
  const mode = String(fd.get("mode") ?? "bulk");
  if (mode === "manual") {
    const code = String(fd.get("code") ?? "").trim();
    if (!code) return { error: "Укажите код ячейки" };
    let level: number | null = null;
    if (isStorage) {
      const lv = Number(String(fd.get("level") ?? "").trim());
      if (!Number.isInteger(lv) || lv < 1) return { error: "Для зоны хранения укажите уровень (целое ≥ 1)" };
      level = lv;
    } else if (String(fd.get("level") ?? "").trim() !== "") {
      return { error: "Уровень задаётся только для зоны хранения" };
    }
    return { items: [{ code, level }] };
  }
  const prefix = String(fd.get("prefix") ?? "").trim();
  if (!prefix) return { error: "Укажите префикс, например «А-»" };
  const from = Number(fd.get("from")), to = Number(fd.get("to"));
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0) return { error: "Диапазон мест — целые числа ≥ 0" };
  if (to < from) return { error: "Конец диапазона меньше начала" };
  const pad = String(to).length > 2 ? String(to).length : 2;
  let levels: (number | null)[] = [null];
  if (isStorage) {
    const lFrom = Number(fd.get("levelFrom")), lTo = Number(fd.get("levelTo"));
    if (!Number.isInteger(lFrom) || !Number.isInteger(lTo) || lFrom < 1 || lTo < lFrom)
      return { error: "Для зоны хранения укажите диапазон уровней (целые ≥ 1)" };
    levels = [];
    for (let l = lFrom; l <= lTo; l++) levels.push(l);
  } else if (String(fd.get("levelFrom") ?? "").trim() !== "" || String(fd.get("levelTo") ?? "").trim() !== "") {
    return { error: "Уровень задаётся только для зоны хранения" };
  }
  const items: { code: string; level: number | null }[] = [];
  for (const level of levels)
    for (let i = from; i <= to; i++) {
      const place = `${prefix}${String(i).padStart(pad, "0")}`;
      items.push({ code: level == null ? place : `${place}-У${level}`, level });
    }
  if (items.length === 0) return { error: "Пустой набор ячеек" };
  if (items.length > 500) return { error: "Не больше 500 ячеек за раз" };
  return { items };
}

// Создание ячеек: ручное (один код) или массовое (диапазон + уровни для STORAGE). Одна транзакция.
export async function createCellsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);
  const warehouseId = String(formData.get("warehouseId") ?? "");
  await s.warehouse(warehouseId);
  if (!isWhAllowed(await warehouseAccess(session), warehouseId))
    return { error: "Нет доступа к этому складу" };
  const zoneId = String(formData.get("zoneId") ?? "");

  // Legacy-режим (флаг зон выключен, ячейки без зоны): плоское создание по префиксу/диапазону.
  if (!zoneId) {
    if (warehouseZonesEnabled()) return { error: "Выберите зону для ячеек" };
    const prefix = String(formData.get("prefix") ?? "").trim();
    if (!prefix) return { error: "Укажите префикс, например «А-»" };
    const from = Number(formData.get("from")), to = Number(formData.get("to"));
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return { error: "Проверьте диапазон номеров" };
    if (to - from + 1 > 500) return { error: "Не больше 500 ячеек за раз" };
    const pad = String(to).length > 2 ? String(to).length : 2;
    const isStaging = formData.get("isStaging") === "on";
    const created = await prisma.$transaction(async (tx) => {
      let count = 0;
      for (let i = from; i <= to; i++) {
        const code = `${prefix}${String(i).padStart(pad, "0")}`;
        if (await tx.cell.findUnique({ where: { warehouseId_code: { warehouseId, code } } })) continue;
        const cell = await tx.cell.create({ data: { companyId: s.companyId, warehouseId, code, isStaging } });
        await createQrIn(tx, { companyId: s.companyId, type: "CELL", refId: cell.id });
        count++;
      }
      return count;
    });
    if (created === 0) return { error: "Все ячейки диапазона уже существуют" };
    broadcastRealtime({ type: "cell.updated", entity: "cell", companyId: s.companyId, warehouseIds: [warehouseId], actorUserId: session.userId });
    revalidatePath(`/warehouse/warehouses/${warehouseId}`);
    return { ok: `Создано ячеек: ${created}.` };
  }

  const zone = await prisma.warehouseZone.findFirst({ where: { id: zoneId, companyId: s.companyId, warehouseId } });
  if (!zone) return { error: "Зона не найдена" };

  const built = buildCellItems(formData, zone.kind === "STORAGE");
  if (built.error || !built.items) return { error: built.error ?? "Нет ячеек" };

  let result: { created: number; skipped: string[] };
  try {
    result = await createCellsBatch({ companyId: s.companyId, warehouseId, zoneId, items: built.items });
  } catch (e) {
    return { error: cellErrorMessage(e) };
  }
  if (result.created === 0)
    return { error: `Новых ячеек нет (все ${result.skipped.length} кода уже существуют)` };
  broadcastRealtime({ type: "cell.updated", entity: "cell", companyId: s.companyId, warehouseIds: [warehouseId], actorUserId: session.userId });
  revalidatePath(`/warehouse/warehouses/${warehouseId}`);
  const skipMsg = result.skipped.length ? ` Пропущено (уже есть): ${result.skipped.length}.` : "";
  return { ok: `Создано ячеек: ${result.created}.${skipMsg}` };
}

// Переименовать неиспользованную ячейку (после первого движения/резерва/задачи — отказ).
export async function renameCellAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);
  const cellId = String(formData.get("cellId") ?? "");
  const cell = await s.cell(cellId);
  if (!isWhAllowed(await warehouseAccess(session), cell.warehouseId)) return { error: "Нет доступа к складу" };
  try {
    await renameCell(s.companyId, cellId, String(formData.get("code") ?? ""));
  } catch (e) {
    return { error: cellErrorMessage(e) };
  }
  revalidatePath(`/warehouse/warehouses/${cell.warehouseId}`);
  return { ok: "Код ячейки изменён" };
}

// Удалить неиспользованную ячейку (атомарно с QR).
export async function deleteCellAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);
  const cellId = String(formData.get("cellId") ?? "");
  const cell = await s.cell(cellId);
  if (!isWhAllowed(await warehouseAccess(session), cell.warehouseId)) return { error: "Нет доступа к складу" };
  try {
    await deleteCell(s.companyId, cellId);
  } catch (e) {
    return { error: cellErrorMessage(e) };
  }
  revalidatePath(`/warehouse/warehouses/${cell.warehouseId}`);
  return { ok: "Ячейка удалена" };
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

// Пакет 9A: деактивация/активация ячейки с серверным guard'ом (нельзя деактивировать занятую).
export async function setCellActiveAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);
  const cellId = String(formData.get("cellId") ?? "");
  const cell = await s.cell(cellId);
  if (!isWhAllowed(await warehouseAccess(session), cell.warehouseId)) return { error: "Нет доступа к складу" };
  const active = String(formData.get("active") ?? "") === "true";
  try {
    await setCellActive(s.companyId, cellId, active);
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
  return { ok: active ? "Ячейка активирована" : "Ячейка деактивирована" };
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

// Пакет 9A: системные зоны фиксированы (7 на склад). Добавление/переименование/удаление/деактивация
// зон закрыто на сервере — соответствующих actions больше нет (renameZoneAction/addZoneAction удалены).
