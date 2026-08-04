"use server";

import { revalidatePath } from "next/cache";
import { requireUser, requireAdmin } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { externalOrderPickingEnabled } from "@/lib/roles";
import {
  importExternalOrder,
  reserveAndPlanOrder,
  completeMoveGroup,
  pickOrderScan,
  reportPickShortage,
  ExternalOrderError,
  type ImportLine,
} from "@/lib/external-orders";

// Этап 5/Пакет 6: server actions внешних заказов. Импорт — ADMIN (позже заменит интеграционный
// адаптер/webhook); сборка/перестановка — исполнитель с назначенной задачей (движок проверяет).
// Все гейтятся флагом EXTERNAL_ORDER_PICKING_ENABLED.

export interface OrderActionState {
  error?: string;
  ok?: boolean;
  status?: string;
  orderId?: string;
}

const OFF: OrderActionState = { error: "Сборка внешних заказов сейчас отключена" };

function msg(e: unknown): string {
  if (e instanceof ExternalOrderError) return e.message;
  return "Не удалось выполнить операцию";
}

// Импорт заказа + FIFO-резерв + планирование (идемпотентно). lines — JSON-массив
// [{externalLineId,itemId,requiredQty}]. Для интеграции позже вызывается напрямую importExternalOrder.
export async function importOrderAction(_prev: OrderActionState, formData: FormData): Promise<OrderActionState> {
  if (!externalOrderPickingEnabled()) return OFF;
  const session = await requireAdmin();
  const s = scoped(session);
  const externalId = String(formData.get("externalId") ?? "").trim();
  const warehouseId = String(formData.get("warehouseId") ?? "").trim();
  const arrivalAtRaw = String(formData.get("arrivalAt") ?? "").trim();
  const linesRaw = String(formData.get("lines") ?? "").trim();
  if (!externalId || !warehouseId) return { error: "externalId и склад обязательны" };
  let lines: ImportLine[];
  try {
    lines = JSON.parse(linesRaw);
    if (!Array.isArray(lines) || lines.length === 0) throw new Error("empty");
  } catch {
    return { error: "Некорректный список строк (lines: JSON-массив)" };
  }
  try {
    const { orderId } = await importExternalOrder({
      companyId: s.companyId,
      warehouseId,
      externalId,
      createdById: session.userId,
      arrivalAt: arrivalAtRaw || null,
      lines,
    });
    const { status } = await reserveAndPlanOrder({ companyId: s.companyId, orderId, userId: session.userId });
    revalidatePath("/warehouse/tasks");
    return { ok: true, orderId, status };
  } catch (e) {
    return { error: msg(e) };
  }
}

// Перестановка: настоящее сканирование — QR группы + QR целевой ячейки (сырые коды, resolve на сервере).
export async function completeMoveGroupAction(_prev: OrderActionState, formData: FormData): Promise<OrderActionState> {
  if (!externalOrderPickingEnabled()) return OFF;
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "").trim();
  const groupCode = String(formData.get("groupCode") ?? "").trim();
  const cellCode = String(formData.get("cellCode") ?? "").trim();
  if (!groupCode || !cellCode) return { error: "Отсканируйте QR группы и целевой ячейки" };
  try {
    await completeMoveGroup({ companyId: s.companyId, userId: session.userId, taskId, groupCode, cellCode });
  } catch (e) {
    return { error: msg(e) };
  }
  revalidatePath("/warehouse/tasks");
  return { ok: true };
}

// Сборка: настоящее сканирование — QR ячейки + QR группы/партии + количество (коды, resolve на сервере).
export async function pickScanAction(_prev: OrderActionState, formData: FormData): Promise<OrderActionState> {
  if (!externalOrderPickingEnabled()) return OFF;
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "").trim();
  const cellCode = String(formData.get("cellCode") ?? "").trim();
  const groupCode = String(formData.get("groupCode") ?? "").trim();
  const qty = Number(String(formData.get("qty") ?? "").trim().replace(",", "."));
  if (!cellCode || !groupCode) return { error: "Отсканируйте QR ячейки и группы" };
  if (!Number.isFinite(qty)) return { error: "Укажите количество" };
  try {
    const r = await pickOrderScan({ companyId: s.companyId, userId: session.userId, taskId, cellCode, groupCode, qty });
    revalidatePath("/warehouse/tasks");
    return { ok: true, status: r.done ? "IN_CONTROL" : r.alreadyPicked ? "alreadyPicked" : "PICKING" };
  } catch (e) {
    return { error: msg(e) };
  }
}

export async function reportShortageAction(_prev: OrderActionState, formData: FormData): Promise<OrderActionState> {
  if (!externalOrderPickingEnabled()) return OFF;
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  try {
    await reportPickShortage({ companyId: s.companyId, userId: session.userId, taskId, reason });
  } catch (e) {
    return { error: msg(e) };
  }
  revalidatePath("/warehouse/tasks");
  return { ok: true };
}
