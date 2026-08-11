"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { orderIssueEnabled } from "@/lib/roles";
import {
  issueOrderToDriver,
  verifyIssueOrderScan,
  placeWholeOrderInIssueCell,
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

// ISSUE-002 v1 (Задача N): шаг 1 — read-only проверка скана QR заказа (без изменения БД). Клиент
// показывает зелёное подтверждение (UI-005) и сам открывает скан ячейки → БЕЗ revalidatePath.
export async function verifyIssueScanAction(_prev: IssueActionState, formData: FormData): Promise<IssueActionState> {
  if (!orderIssueEnabled()) return OFF;
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "").trim();
  const orderCode = String(formData.get("orderCode") ?? "").trim();
  if (!orderCode) return { error: "Отсканируйте QR заказа" };
  try {
    await verifyIssueOrderScan({ companyId: s.companyId, userId: session.userId, taskId, orderCode });
    return { ok: true };
  } catch (e) {
    return { error: msg(e) };
  }
}

// ISSUE-002 v1 (Задача N): шаг 2 — скан назначенной ячейки → атомарное размещение всего заказа +
// DELIVER_ORDER. БЕЗ revalidatePath: финальное уведомление держится до «Ок», затем клиент router.refresh().
export async function placeWholeOrderAction(_prev: IssueActionState, formData: FormData): Promise<IssueActionState> {
  if (!orderIssueEnabled()) return OFF;
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "").trim();
  const orderCode = String(formData.get("orderCode") ?? "").trim();
  const cellCode = String(formData.get("cellCode") ?? "").trim();
  if (!orderCode || !cellCode) return { error: "Отсканируйте QR заказа и назначенную ячейку" };
  try {
    await placeWholeOrderInIssueCell({ companyId: s.companyId, userId: session.userId, taskId, orderCode, cellCode });
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
