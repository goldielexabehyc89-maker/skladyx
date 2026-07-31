"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { groupReceivingEnabled } from "@/lib/roles";
import { getActiveShift } from "@/lib/work-shift";
import { createHandlingGroup, completeGroupPlacement, GroupError } from "@/lib/group-receiving";
import { qrUrl } from "@/lib/qr";

// Этап 5/Пакет 4: групповая приёмка. Доступ — RECEIVER с активной сменой на его складе
// (ADMIN — только при активной смене RECEIVER; чистый ADMIN/OBSERVER не проводят).

export interface ReceivingState {
  error?: string;
  ok?: boolean;
  itemName?: string;
  qty?: number;
  temperature?: number;
  route?: "STORAGE" | "COOLING";
  qrUrl?: string;
  taskCreated?: boolean;
}

function msg(e: unknown): string {
  if (e instanceof GroupError) return e.message;
  return "Не удалось выполнить приёмку";
}

export async function createGroupReceivingAction(
  _prev: ReceivingState,
  formData: FormData,
): Promise<ReceivingState> {
  if (!groupReceivingEnabled()) return { error: "Групповая приёмка сейчас отключена" };
  const session = await requireUser();
  const s = scoped(session);

  // доступ: активная смена RECEIVER (склад берём из смены)
  const shift = await getActiveShift(session.userId, s.companyId);
  if (!shift || shift.role !== "RECEIVER")
    return { error: "Нужна активная смена приёмщика (RECEIVER). Начните смену на складе." };

  // товар: по id из поиска либо по точному sku (скан)
  let itemId = String(formData.get("itemId") ?? "").trim();
  const sku = String(formData.get("sku") ?? "").trim();
  if (!itemId && sku) {
    const bySku = await prisma.item.findFirst({ where: { companyId: s.companyId, sku, isActive: true } });
    if (!bySku) return { error: `Товар с артикулом «${sku}» не найден` };
    itemId = bySku.id;
  }
  if (!itemId) return { error: "Выберите товар из номенклатуры или отсканируйте артикул" };

  const qty = Number(String(formData.get("qty") ?? "").trim());
  if (!Number.isInteger(qty) || qty <= 0) return { error: "Количество — целое число больше нуля" };
  const temperature = Number(String(formData.get("temperature") ?? "").trim().replace(",", "."));
  if (!Number.isFinite(temperature)) return { error: "Укажите температуру группы" };

  const dedupeKey = String(formData.get("dedupeKey") ?? "").trim();
  if (!dedupeKey) return { error: "Отсутствует токен идемпотентности" };

  try {
    const res = await createHandlingGroup({
      companyId: s.companyId,
      warehouseId: shift.warehouseId,
      itemId,
      qty,
      temperature,
      acceptedById: session.userId,
      dedupeKey: `grcv:${s.companyId}:${dedupeKey}`,
    });
    const item = await prisma.item.findFirst({ where: { id: itemId, companyId: s.companyId }, select: { name: true } });
    revalidatePath("/warehouse/tasks");
    revalidatePath("/warehouse/receiving");
    return {
      ok: true,
      itemName: item?.name ?? "",
      qty,
      temperature,
      route: res.status === "AWAITING_COOLING" ? "COOLING" : "STORAGE",
      qrUrl: res.qrCode ? qrUrl(res.qrCode) : undefined,
      taskCreated: !!res.taskId,
    };
  } catch (e) {
    return { error: msg(e) };
  }
}

export interface PlacementState {
  error?: string;
}

export async function completeGroupPlacementAction(
  _prev: PlacementState,
  formData: FormData,
): Promise<PlacementState> {
  if (!groupReceivingEnabled()) return { error: "Групповая приёмка сейчас отключена" };
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "").trim();
  const cellId = String(formData.get("cellId") ?? "").trim();
  if (!cellId) return { error: "Выберите целевую ячейку" };
  try {
    await completeGroupPlacement({ companyId: s.companyId, userId: session.userId, taskId, cellId });
  } catch (e) {
    return { error: msg(e) };
  }
  revalidatePath("/warehouse/tasks");
  return {};
}
