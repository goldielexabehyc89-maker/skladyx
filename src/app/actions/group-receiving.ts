"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { groupReceivingEnabled } from "@/lib/roles";
import { getActiveShift } from "@/lib/work-shift";
import { createHandlingGroup, completeGroupPlacement, prepareGroupPlacement, GroupError } from "@/lib/group-receiving";
import { findItemByEan } from "@/lib/barcodes";

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

  // Пакет 9B: товар определяется ТОЛЬКО заводским EAN (скан камерой или ручной ввод EAN как fallback).
  // Ручной выбор товара/SKU убран. Неизвестный/неактивный/чужой EAN — отказ.
  const ean = String(formData.get("ean") ?? "").trim();
  if (!ean) return { error: "Отсканируйте заводской штрихкод товара (EAN)" };
  const found = await findItemByEan(s.companyId, ean);
  if (!found) return { error: "Неизвестный, неактивный или чужой EAN — товар не найден" };
  const itemId = found.item.id;

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
    // Событие «Приёмка группы» пишется в движке createHandlingGroup (идемпотентно по created).
    revalidatePath("/warehouse/tasks");
    revalidatePath("/warehouse/receiving");
    return {
      ok: true,
      itemName: item?.name ?? "",
      qty,
      temperature,
      route: res.status === "AWAITING_COOLING" ? "COOLING" : "STORAGE",
      taskCreated: !!res.taskId,
    };
  } catch (e) {
    return { error: msg(e) };
  }
}

export interface PlacementState {
  error?: string;
}

// Пакет 11 (коррекция): назначение целевой ячейки при открытии сценария размещения. Идемпотентно —
// повторный вызов возвращает ту же ячейку. UI показывает «Назначенная ячейка: <код>».
export interface PreparePlacementState {
  error?: string;
  cellCode?: string;
}

export async function prepareGroupPlacementAction(
  _prev: PreparePlacementState,
  formData: FormData,
): Promise<PreparePlacementState> {
  if (!groupReceivingEnabled()) return { error: "Групповая приёмка сейчас отключена" };
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "").trim();
  try {
    const r = await prepareGroupPlacement({ companyId: s.companyId, userId: session.userId, taskId });
    return { cellCode: r.cellCode };
  } catch (e) {
    return { error: msg(e) };
  }
}

export async function completeGroupPlacementAction(
  _prev: PlacementState,
  formData: FormData,
): Promise<PlacementState> {
  if (!groupReceivingEnabled()) return { error: "Групповая приёмка сейчас отключена" };
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "").trim();
  const cellCode = String(formData.get("cellCode") ?? "").trim();
  const ean = String(formData.get("ean") ?? "").trim();
  if (!ean) return { error: "Отсканируйте заводской штрихкод товара (EAN)" };
  if (!cellCode) return { error: "Отсканируйте QR/Code 128 целевой ячейки" };
  try {
    await completeGroupPlacement({ companyId: s.companyId, userId: session.userId, taskId, cellCode, ean });
  } catch (e) {
    return { error: msg(e) };
  }
  // Событие «Размещение» пишется в движке completeGroupPlacement (стабильный ключ, единично).
  revalidatePath("/warehouse/tasks");
  return {};
}
