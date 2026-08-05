"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { orderControlEnabled } from "@/lib/roles";
import {
  scanOrderForControl,
  markOrderControlByScan,
  finishOrderControl,
  resolveControlShortage,
  resolveControlRemoval,
  completeOrderCorrection,
  OrderControlError,
} from "@/lib/order-control";

// Этап 5/Пакет 7: server actions контроля заказа и исправления. Все гейтятся ORDER_CONTROL_ENABLED.
// Контроль — CONTROLLER с назначенной задачей; исправление — PICKER (движок сверяет назначение/статус).

export interface ControlActionState {
  error?: string;
  ok?: boolean;
  status?: string;
}

const OFF: ControlActionState = { error: "Контроль заказов сейчас отключён" };

function msg(e: unknown): string {
  if (e instanceof OrderControlError) return e.message;
  return "Не удалось выполнить операцию";
}

// Контролёр сканирует QR заказа → старт проверки (серверная сверка QR ↔ заказ задачи).
export async function scanOrderControlAction(_prev: ControlActionState, formData: FormData): Promise<ControlActionState> {
  if (!orderControlEnabled()) return OFF;
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "").trim();
  const orderCode = String(formData.get("orderCode") ?? "").trim();
  if (!orderCode) return { error: "Отсканируйте QR заказа" };
  try {
    await scanOrderForControl({ companyId: s.companyId, userId: session.userId, taskId, orderCode });
  } catch (e) {
    return { error: msg(e) };
  }
  revalidatePath("/warehouse/tasks");
  return { ok: true };
}

// Контролёр отмечает по СКАНУ QR группы/партии + количество (ручной ввод кода — fallback).
export async function markControlScanAction(_prev: ControlActionState, formData: FormData): Promise<ControlActionState> {
  if (!orderControlEnabled()) return OFF;
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "").trim();
  const groupCode = String(formData.get("groupCode") ?? "").trim();
  const countedQty = Number(String(formData.get("countedQty") ?? "").trim().replace(",", "."));
  const discrepancyType = String(formData.get("discrepancyType") ?? "").trim() || null;
  const comment = String(formData.get("comment") ?? "").trim() || null;
  if (!groupCode) return { error: "Отсканируйте QR группы/партии" };
  if (!Number.isFinite(countedQty)) return { error: "Укажите фактическое количество" };
  try {
    await markOrderControlByScan({ companyId: s.companyId, userId: session.userId, taskId, groupCode, countedQty, discrepancyType, comment });
  } catch (e) {
    return { error: msg(e) };
  }
  revalidatePath("/warehouse/tasks");
  return { ok: true };
}

// Сборщик разрешает НЕДОСТАЧУ: скан ожидаемого товара/группы + добавленное количество (без движения).
export async function resolveShortageAction(_prev: ControlActionState, formData: FormData): Promise<ControlActionState> {
  if (!orderControlEnabled()) return OFF;
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "").trim();
  const checkLineId = String(formData.get("checkLineId") ?? "").trim();
  const groupCode = String(formData.get("groupCode") ?? "").trim();
  const qty = Number(String(formData.get("qty") ?? "").trim().replace(",", "."));
  const comment = String(formData.get("comment") ?? "").trim() || null;
  if (!checkLineId || !groupCode) return { error: "Отсканируйте QR товара недостающей строки" };
  if (!Number.isFinite(qty)) return { error: "Укажите количество" };
  try {
    await resolveControlShortage({ companyId: s.companyId, userId: session.userId, taskId, checkLineId, groupCode, qty, comment });
    revalidatePath("/warehouse/tasks");
    return { ok: true };
  } catch (e) {
    return { error: msg(e) };
  }
}

// Сборщик разрешает ИЗЛИШЕК/НЕ ТОТ/ПОВРЕЖДЁННЫЙ: скан удаляемого товара/группы + возврат (RETURN)
// или изоляция в DISCREPANCY (движение через ядро).
export async function resolveRemovalAction(_prev: ControlActionState, formData: FormData): Promise<ControlActionState> {
  if (!orderControlEnabled()) return OFF;
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "").trim();
  const checkLineId = String(formData.get("checkLineId") ?? "").trim();
  const groupCode = String(formData.get("groupCode") ?? "").trim();
  const qty = Number(String(formData.get("qty") ?? "").trim().replace(",", "."));
  const disposition = String(formData.get("disposition") ?? "").trim() === "RETURN" ? "RETURN" : "DISCREPANCY";
  const comment = String(formData.get("comment") ?? "").trim() || null;
  if (!checkLineId || !groupCode) return { error: "Отсканируйте QR удаляемого товара/группы" };
  if (!Number.isFinite(qty)) return { error: "Укажите количество" };
  try {
    await resolveControlRemoval({ companyId: s.companyId, userId: session.userId, taskId, checkLineId, groupCode, qty, disposition, comment });
    revalidatePath("/warehouse/tasks");
    return { ok: true };
  } catch (e) {
    return { error: msg(e) };
  }
}

// Контролёр завершает проверку: PASSED (нет расхождений) / FAILED (создаётся исправление).
export async function finishControlAction(_prev: ControlActionState, formData: FormData): Promise<ControlActionState> {
  if (!orderControlEnabled()) return OFF;
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "").trim();
  try {
    const r = await finishOrderControl({ companyId: s.companyId, userId: session.userId, taskId });
    revalidatePath("/warehouse/tasks");
    return { ok: true, status: r.status };
  } catch (e) {
    return { error: msg(e) };
  }
}

// Сборщик завершает исправление → заказ уходит на ПОЛНЫЙ повторный контроль.
export async function completeCorrectionAction(_prev: ControlActionState, formData: FormData): Promise<ControlActionState> {
  if (!orderControlEnabled()) return OFF;
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "").trim();
  try {
    await completeOrderCorrection({ companyId: s.companyId, userId: session.userId, taskId });
    revalidatePath("/warehouse/tasks");
    return { ok: true };
  } catch (e) {
    return { error: msg(e) };
  }
}
