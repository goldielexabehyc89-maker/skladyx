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

  const warehouse = await prisma.warehouse.create({
    data: { companyId: s.companyId, name: parsed.data.name, address: parsed.data.address },
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

  await prisma.warehouse.update({
    where: { id },
    data: {
      name: parsed.data.name,
      address: parsed.data.address ?? null,
      isActive: formData.get("isActive") === "on",
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

  const isStaging = formData.get("isStaging") === "on";
  const pad = String(to).length > 2 ? String(to).length : 2;
  const codes: string[] = [];
  for (let i = from; i <= to; i++) codes.push(`${prefix}${String(i).padStart(pad, "0")}`);

  const created = await prisma.$transaction(async (tx) => {
    let count = 0;
    for (const code of codes) {
      const exists = await tx.cell.findUnique({
        where: { warehouseId_code: { warehouseId, code } },
      });
      if (exists) continue;
      const cell = await tx.cell.create({
        data: { companyId: s.companyId, warehouseId, code, isStaging },
      });
      await createQrIn(tx, { companyId: s.companyId, type: "CELL", refId: cell.id });
      count++;
    }
    return count;
  });

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
