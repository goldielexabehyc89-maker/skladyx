"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { orderIssueEnabled } from "@/lib/roles";
import {
  placeOrderGroup,
  addIssueCell,
  finishIssuePlacement,
  issueOrderToDriver,
  OrderIssueError,
} from "@/lib/order-issue";

// Этап 5/Пакет 8: server actions размещения в выдаче и выдачи водителю. Гейтятся ORDER_ISSUE_ENABLED.
// Размещение/выдача — LOADER с назначенной задачей (движок сверяет назначение/статус/tenant/склад).

export interface IssueActionState {
  error?: string;
  ok?: boolean;
}

const OFF: IssueActionState = { error: "Выдача заказов сейчас отключена" };

function msg(e: unknown): string {
  if (e instanceof OrderIssueError) return e.message;
  return "Не удалось выполнить операцию";
}

// Погрузчик размещает: скан QR заказа + зарезервированной ячейки + группы/партии.
export async function placeGroupAction(_prev: IssueActionState, formData: FormData): Promise<IssueActionState> {
  if (!orderIssueEnabled()) return OFF;
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "").trim();
  const orderCode = String(formData.get("orderCode") ?? "").trim();
  const cellCode = String(formData.get("cellCode") ?? "").trim();
  const ean = String(formData.get("ean") ?? "").trim();
  if (!orderCode || !cellCode || !ean) return { error: "Отсканируйте QR заказа, ячейку и EAN товара" };
  try {
    await placeOrderGroup({ companyId: s.companyId, userId: session.userId, taskId, orderCode, cellCode, ean });
    revalidatePath("/warehouse/tasks");
    return { ok: true };
  } catch (e) {
    return { error: msg(e) };
  }
}

// «Добавить ячейку»: скан свободной ячейки выдачи → бронь под заказ.
export async function addCellAction(_prev: IssueActionState, formData: FormData): Promise<IssueActionState> {
  if (!orderIssueEnabled()) return OFF;
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "").trim();
  const cellCode = String(formData.get("cellCode") ?? "").trim();
  if (!cellCode) return { error: "Отсканируйте QR свободной ячейки выдачи" };
  try {
    await addIssueCell({ companyId: s.companyId, userId: session.userId, taskId, cellCode });
    revalidatePath("/warehouse/tasks");
    return { ok: true };
  } catch (e) {
    return { error: msg(e) };
  }
}

// «Готово»: доступно только когда весь заказ перемещён из CONTROL.
export async function finishPlacementAction(_prev: IssueActionState, formData: FormData): Promise<IssueActionState> {
  if (!orderIssueEnabled()) return OFF;
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "").trim();
  try {
    await finishIssuePlacement({ companyId: s.companyId, userId: session.userId, taskId });
    revalidatePath("/warehouse/tasks");
    return { ok: true };
  } catch (e) {
    return { error: msg(e) };
  }
}

// Выдача водителю: скан QR заказа + всех занятых ячеек (несколько полей cellCode или список через запятую).
export async function issueAction(_prev: IssueActionState, formData: FormData): Promise<IssueActionState> {
  if (!orderIssueEnabled()) return OFF;
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "").trim();
  const orderCode = String(formData.get("orderCode") ?? "").trim();
  const codes = new Set<string>();
  for (const v of formData.getAll("cellCode")) { const c = String(v).trim(); if (c) codes.add(c); }
  for (const v of String(formData.get("cellCodes") ?? "").split(/[,\s]+/)) { const c = v.trim(); if (c) codes.add(c); }
  if (!orderCode || codes.size === 0) return { error: "Отсканируйте QR заказа и все ячейки выдачи" };
  try {
    await issueOrderToDriver({ companyId: s.companyId, userId: session.userId, taskId, orderCode, cellCodes: [...codes] });
    revalidatePath("/warehouse/tasks");
    return { ok: true };
  } catch (e) {
    return { error: msg(e) };
  }
}
