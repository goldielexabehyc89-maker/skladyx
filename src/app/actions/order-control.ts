"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { orderControlEnabled } from "@/lib/roles";
import {
  scanOrderForControl,
  markOrderControlByScan,
  confirmControlLine,
  finishOrderControl,
  resolveControlShortage,
  resolveControlRemoval,
  completeOrderCorrection,
  getControlOrderContext,
  OrderControlError,
} from "@/lib/order-control";

// Этап 5/Пакет 7: server actions контроля заказа и исправления. Все гейтятся ORDER_CONTROL_ENABLED.
// Контроль — CONTROLLER с назначенной задачей; исправление — PICKER (движок сверяет назначение/статус).

export interface ControlActionState {
  error?: string;
  ok?: boolean;
  status?: string;
  // UI-004: после успешной отметки товара клиент решает — авто-переход к скану следующего товара
  // (остались непроверенные строки) или закрыть мастер и показать завершение проверки (все отмечены).
  allMarked?: boolean;
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
  // Намеренно БЕЗ revalidatePath: клиент (ScanOrderCamera) показывает заметное зелёное подтверждение
  // (UI-005), затем сам вызывает router.refresh() — иначе серверная ревалидация мгновенно подменит
  // панель шагом EAN и подтверждение не будет видно.
  return { ok: true };
}

// Контролёр отмечает по СКАНУ заводского штрихкода товара (EAN) + количество (ручной ввод EAN — fallback).
export async function markControlScanAction(_prev: ControlActionState, formData: FormData): Promise<ControlActionState> {
  if (!orderControlEnabled()) return OFF;
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "").trim();
  const ean = String(formData.get("ean") ?? "").trim();
  const countedQty = Number(String(formData.get("countedQty") ?? "").trim().replace(",", "."));
  const discrepancyType = String(formData.get("discrepancyType") ?? "").trim() || null;
  const comment = String(formData.get("comment") ?? "").trim() || null;
  if (!ean) return { error: "Отсканируйте заводской штрихкод товара (EAN)" };
  if (!Number.isFinite(countedQty)) return { error: "Укажите фактическое количество" };
  try {
    await markOrderControlByScan({ companyId: s.companyId, userId: session.userId, taskId, ean, countedQty, discrepancyType, comment });
  } catch (e) {
    return { error: msg(e) };
  }
  revalidatePath("/warehouse/tasks");
  const ctx = await getControlOrderContext(s.companyId, taskId);
  return { ok: true, allMarked: ctx?.allMarked ?? false };
}

// CONTROL-001 (Задача N): контролёр подтверждает строку заказа КЛИКОМ (без EAN/количества).
// Сервер записывает countedQty=requiredQty без расхождения; идемпотентно; чужая строка/заказ отклонены.
export async function confirmControlLineAction(_prev: ControlActionState, formData: FormData): Promise<ControlActionState> {
  if (!orderControlEnabled()) return OFF;
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "").trim();
  const lineId = String(formData.get("lineId") ?? "").trim();
  if (!lineId) return { error: "Не указана строка заказа" };
  try {
    await confirmControlLine({ companyId: s.companyId, userId: session.userId, taskId, lineId });
  } catch (e) {
    return { error: msg(e) };
  }
  revalidatePath("/warehouse/tasks");
  const ctx = await getControlOrderContext(s.companyId, taskId);
  return { ok: true, allMarked: ctx?.allMarked ?? false };
}

// Сборщик разрешает НЕДОСТАЧУ: скан ожидаемого товара/группы + добавленное количество (без движения).
export async function resolveShortageAction(_prev: ControlActionState, formData: FormData): Promise<ControlActionState> {
  if (!orderControlEnabled()) return OFF;
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "").trim();
  const checkLineId = String(formData.get("checkLineId") ?? "").trim();
  const ean = String(formData.get("ean") ?? "").trim();
  const qty = Number(String(formData.get("qty") ?? "").trim().replace(",", "."));
  const comment = String(formData.get("comment") ?? "").trim() || null;
  if (!checkLineId || !ean) return { error: "Отсканируйте EAN товара недостающей строки" };
  if (!Number.isFinite(qty)) return { error: "Укажите количество" };
  try {
    await resolveControlShortage({ companyId: s.companyId, userId: session.userId, taskId, checkLineId, ean, qty, comment });
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
  const ean = String(formData.get("ean") ?? "").trim();
  const qty = Number(String(formData.get("qty") ?? "").trim().replace(",", "."));
  const disposition = String(formData.get("disposition") ?? "").trim() === "RETURN" ? "RETURN" : "DISCREPANCY";
  const comment = String(formData.get("comment") ?? "").trim() || null;
  if (!checkLineId || !ean) return { error: "Отсканируйте EAN удаляемого товара" };
  if (!Number.isFinite(qty)) return { error: "Укажите количество" };
  try {
    await resolveControlRemoval({ companyId: s.companyId, userId: session.userId, taskId, checkLineId, ean, qty, disposition, comment });
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
