import "server-only";
import { Prisma, type ControlDiscrepancyType, type WorkflowTask, type ExternalOrder } from "@prisma/client";
import { prisma } from "@/lib/db";
import { parseScannedCode } from "@/lib/qr";
import { logEvent } from "@/lib/events";
import { TASK_TYPES } from "@/lib/workflow-task-types";
import {
  lockCompany,
  createWorkflowTaskInTx,
  emitTaskCreated,
  emitTaskCompleted,
  completeWorkflowTaskInTransaction,
  rebalanceQueuedTasks,
  type TaskCreateResult,
} from "@/lib/workflow-tasks";

// Этап 5/Пакет 7: контроль заказа, исправление, полный повторный контроль. За флагом
// ORDER_CONTROL_ENABLED. ExternalOrder — единственный владелец жизненного цикла (§1.6/§2.4);
// ControlCheck — сущность результата проверки, не параллельная машина состояний. Контроль сам
// остаток НЕ двигает (§2.9); движения при исправлении — только через ядро/инвентаризацию, вне
// этого модуля. Конкурентность/идемпотентность — lockCompany + dedupeKey + taskId-unique проверки.

export class OrderControlError extends Error {}
type Tx = Prisma.TransactionClient;
const D = (x: Prisma.Decimal | number | string) => new Prisma.Decimal(x);

export const DISCREPANCY_TYPES: readonly ControlDiscrepancyType[] = [
  "SHORTAGE",
  "EXCESS",
  "WRONG_ITEM",
  "DAMAGED",
  "OTHER",
];
function parseDiscrepancyType(x: string | null | undefined): ControlDiscrepancyType | null {
  if (!x) return null;
  return (DISCREPANCY_TYPES as readonly string[]).includes(x) ? (x as ControlDiscrepancyType) : null;
}

// ── Резолвинг QR заказа: тип ORDER, своя организация, существующий ExternalOrder ──
async function resolveScannedOrder(tx: Tx, companyId: string, raw: string): Promise<string> {
  const code = parseScannedCode(raw);
  if (!code) throw new OrderControlError("Неверный QR заказа");
  const qr = await tx.qrCode.findUnique({ where: { code } });
  if (!qr || qr.companyId !== companyId || qr.type !== "ORDER")
    throw new OrderControlError("Это не QR заказа этой организации");
  const order = await tx.externalOrder.findFirst({ where: { id: qr.refId, companyId }, select: { id: true } });
  if (!order) throw new OrderControlError("Заказ не найден");
  return order.id;
}

// ── Создание задачи контроля CONTROL_ORDER в ПЕРЕДАННОЙ tx (под lockCompany). Идемпотентно по
// dedupeKey. Вызывается из pickOrderScan (при переходе в IN_CONTROL, флаг ON) и при повторном
// контроле после исправления. ──
export async function createControlTaskInTx(
  tx: Tx,
  input: { companyId: string; order: Pick<ExternalOrder, "id" | "warehouseId" | "externalId" | "arrivalAt">; dedupeKey: string },
): Promise<TaskCreateResult> {
  return createWorkflowTaskInTx(tx, {
    companyId: input.companyId,
    warehouseId: input.order.warehouseId,
    type: TASK_TYPES.CONTROL_ORDER,
    requiredRole: "CONTROLLER",
    priority: "NORMAL",
    title: `Контроль заказа ${input.order.externalId}`,
    subjectType: "externalOrder",
    subjectId: input.order.id,
    dedupeKey: input.dedupeKey,
    loadUnits: 1, // нагрузка контролёра — по числу заказов (§2.2)
    dueAt: input.order.arrivalAt ?? undefined,
  });
}

// Найти/создать проверку для CONTROL_ORDER-задачи (идемпотентно по taskId) + снимок строк заказа.
async function ensureCheck(tx: Tx, companyId: string, task: WorkflowTask): Promise<{ id: string }> {
  const existing = await tx.controlCheck.findUnique({ where: { taskId: task.id }, select: { id: true } });
  if (existing) return existing;
  const attempt = (await tx.controlCheck.count({ where: { orderId: task.subjectId ?? "" } })) + 1;
  const check = await tx.controlCheck.create({
    data: {
      companyId,
      orderId: task.subjectId ?? "",
      taskId: task.id,
      attempt,
      status: "IN_PROGRESS",
      controllerId: task.assignedUserId,
    },
    select: { id: true },
  });
  const lines = await tx.externalOrderLine.findMany({
    where: { orderId: task.subjectId ?? "" },
    orderBy: { externalLineId: "asc" },
  });
  for (const l of lines) {
    await tx.controlCheckLine.create({
      data: { companyId, checkId: check.id, lineId: l.id, itemId: l.itemId, expectedQty: l.requiredQty },
    });
  }
  return check;
}

async function requireControlTask(tx: Tx, companyId: string, taskId: string, userId: string): Promise<WorkflowTask> {
  const task = await tx.workflowTask.findFirst({ where: { id: taskId, companyId } });
  if (!task) throw new OrderControlError("Задача не найдена");
  if (task.type !== TASK_TYPES.CONTROL_ORDER) throw new OrderControlError("Это не задача контроля");
  if (task.assignedUserId !== userId) throw new OrderControlError("Это не ваша задача контроля");
  return task;
}

// ── Контролёр сканирует QR заказа: сверка QR ↔ заказ задачи, старт проверки (идемпотентно) ──
export async function scanOrderForControl(input: {
  companyId: string;
  userId: string;
  taskId: string;
  orderCode: string;
}): Promise<{ checkId: string; alreadyStarted: boolean }> {
  return prisma.$transaction(async (tx) => {
    await lockCompany(tx, input.companyId);
    const task = await requireControlTask(tx, input.companyId, input.taskId, input.userId);
    if (task.status !== "IN_PROGRESS") throw new OrderControlError("Задача контроля не в работе");
    const scannedOrderId = await resolveScannedOrder(tx, input.companyId, input.orderCode);
    if (scannedOrderId !== task.subjectId) throw new OrderControlError("Отсканирован не тот заказ");
    const existed = await tx.controlCheck.findUnique({ where: { taskId: task.id }, select: { id: true } });
    const check = await ensureCheck(tx, input.companyId, task);
    return { checkId: check.id, alreadyStarted: !!existed };
  });
}

// ── Контролёр отмечает строку: фактическое количество + (опц.) тип расхождения и комментарий ──
export async function markOrderControlLine(input: {
  companyId: string;
  userId: string;
  taskId: string;
  lineId: string;
  countedQty: number;
  discrepancyType?: string | null;
  comment?: string | null;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockCompany(tx, input.companyId);
    const task = await requireControlTask(tx, input.companyId, input.taskId, input.userId);
    if (task.status !== "IN_PROGRESS") throw new OrderControlError("Задача контроля не в работе");
    const check = await tx.controlCheck.findUnique({ where: { taskId: task.id } });
    if (!check) throw new OrderControlError("Сначала отсканируйте QR заказа");
    if (check.status !== "IN_PROGRESS") throw new OrderControlError("Проверка уже завершена");
    const cl = await tx.controlCheckLine.findFirst({ where: { checkId: check.id, lineId: input.lineId } });
    if (!cl) throw new OrderControlError("Строка не относится к этой проверке");
    const counted = D(input.countedQty);
    if (counted.lt(0)) throw new OrderControlError("Количество не может быть отрицательным");
    // тип расхождения: явный (валидируем) либо авто по количеству; равенство → нет расхождения
    let type = parseDiscrepancyType(input.discrepancyType);
    if (!counted.equals(cl.expectedQty) && !type) type = counted.lt(cl.expectedQty) ? "SHORTAGE" : "EXCESS";
    else if (counted.equals(cl.expectedQty) && (type === "SHORTAGE" || type === "EXCESS")) type = null;
    await tx.controlCheckLine.update({
      where: { id: cl.id },
      data: { countedQty: counted, discrepancyType: type, comment: input.comment?.trim() || null, byUserId: input.userId, checkedAt: new Date() },
    });
  });
}

// Назначить CORRECT_ORDER исходному сборщику, если у него активна смена PICKER на этом складе;
// иначе оставить авто-назначение наименее загруженному (createWorkflowTaskInTx уже назначил).
async function createCorrectTaskInTx(
  tx: Tx,
  input: { companyId: string; order: Pick<ExternalOrder, "id" | "warehouseId" | "externalId" | "arrivalAt">; checkId: string },
): Promise<TaskCreateResult> {
  const pick = await tx.workflowTask.findFirst({
    where: { companyId: input.companyId, type: TASK_TYPES.PICK_ORDER, subjectId: input.order.id },
    orderBy: { createdAt: "desc" },
    select: { assignedUserId: true },
  });
  const res = await createWorkflowTaskInTx(tx, {
    companyId: input.companyId,
    warehouseId: input.order.warehouseId,
    type: TASK_TYPES.CORRECT_ORDER,
    requiredRole: "PICKER",
    priority: "URGENT",
    title: `Исправить заказ ${input.order.externalId}`,
    subjectType: "externalOrder",
    subjectId: input.order.id,
    dedupeKey: `correct:${input.order.id}:${input.checkId}`,
    loadUnits: 1,
    dueAt: input.order.arrivalAt ?? undefined,
  });
  if (res.created && pick?.assignedUserId) {
    const shift = await tx.workShift.findFirst({
      where: { companyId: input.companyId, userId: pick.assignedUserId, warehouseId: input.order.warehouseId, role: "PICKER", endedAt: null },
      select: { id: true },
    });
    const fresh = await tx.workflowTask.findUnique({ where: { id: res.task.id } });
    if (shift && fresh && (fresh.status === "QUEUED" || fresh.status === "ASSIGNED") && fresh.assignedUserId !== pick.assignedUserId) {
      const upd = await tx.workflowTask.update({
        where: { id: res.task.id },
        data: { status: "ASSIGNED", assignedUserId: pick.assignedUserId, assignedShiftId: shift.id, assignedAt: new Date() },
      });
      return { task: upd, created: true, assignedTo: pick.assignedUserId };
    }
  }
  return res;
}

// ── Завершение контроля: требует все строки отмечены. Нет расхождений → PASSED (CONTROL_PASSED);
// есть → FAILED (CORRECTION_REQUIRED + срочная CORRECT_ORDER). Идемпотентно; конкурентно —
// один переход (lockCompany + статус проверки). Контроль остаток НЕ двигает. ──
export async function finishOrderControl(input: {
  companyId: string;
  userId: string;
  taskId: string;
}): Promise<{ status: "PASSED" | "FAILED"; alreadyFinished: boolean }> {
  const out = await prisma.$transaction(async (tx) => {
    await lockCompany(tx, input.companyId);
    const task = await requireControlTask(tx, input.companyId, input.taskId, input.userId);
    const order = await tx.externalOrder.findFirst({ where: { id: task.subjectId ?? "", companyId: input.companyId } });
    if (!order) throw new OrderControlError("Заказ не найден");
    const check = await tx.controlCheck.findUnique({ where: { taskId: task.id } });
    if (!check) throw new OrderControlError("Сначала отсканируйте QR заказа");
    // идемпотентность: проверка уже завершена → тот же результат без второго перехода
    if (check.status !== "IN_PROGRESS") {
      return { status: check.status as "PASSED" | "FAILED", alreadyFinished: true, order, task, unblocked: [] as { id: string; title: string; warehouseId: string }[], correctTask: null as TaskCreateResult | null };
    }
    if (task.status !== "IN_PROGRESS") throw new OrderControlError("Задача контроля не в работе");
    const unmarked = await tx.controlCheckLine.count({ where: { checkId: check.id, lineId: { not: null }, countedQty: null } });
    if (unmarked > 0) throw new OrderControlError("Отметьте все строки заказа перед завершением");
    const discrepancies = await tx.controlCheckLine.count({ where: { checkId: check.id, discrepancyType: { not: null } } });
    if (discrepancies === 0) {
      await tx.controlCheck.update({ where: { id: check.id }, data: { status: "PASSED", finishedAt: new Date() } });
      await tx.externalOrder.update({ where: { id: order.id }, data: { status: "CONTROL_PASSED" } });
      const unblocked = await completeWorkflowTaskInTransaction(tx, task.id);
      return { status: "PASSED" as const, alreadyFinished: false, order, task, unblocked, correctTask: null as TaskCreateResult | null };
    }
    await tx.controlCheck.update({ where: { id: check.id }, data: { status: "FAILED", finishedAt: new Date() } });
    await tx.externalOrder.update({ where: { id: order.id }, data: { status: "CORRECTION_REQUIRED" } });
    const unblocked = await completeWorkflowTaskInTransaction(tx, task.id);
    const correctTask = await createCorrectTaskInTx(tx, { companyId: input.companyId, order, checkId: check.id });
    return { status: "FAILED" as const, alreadyFinished: false, order, task, unblocked, correctTask };
  });

  if (!out.alreadyFinished) {
    await emitTaskCompleted({ companyId: input.companyId, warehouseId: out.order.warehouseId, title: out.task.title, taskId: out.task.id, unblocked: out.unblocked });
    if (out.correctTask) await emitTaskCreated(out.correctTask);
    await logEvent({
      companyId: input.companyId,
      type: out.status === "PASSED" ? "order_control_passed" : "order_correction_required",
      title: out.status === "PASSED" ? "Контроль пройден" : "Заказ на исправление",
      body: `Заказ ${out.order.externalId}: ${out.status === "PASSED" ? "расхождений нет" : "найдены расхождения"}`,
      url: "/warehouse/tasks",
      warehouseIds: [out.order.warehouseId],
      actorId: input.userId,
    });
    await rebalanceQueuedTasks(input.companyId, { warehouseId: out.order.warehouseId });
  }
  return { status: out.status, alreadyFinished: out.alreadyFinished };
}

// ── Сборщик завершает исправление: заказ → полный повторный контроль (новая CONTROL_ORDER).
// Остаток здесь НЕ двигаем — физическая коррекция и любые движения остатка выполняются отдельно
// через ядро/инвентаризацию (зона DISCREPANCY). Идемпотентно. ──
export async function completeOrderCorrection(input: {
  companyId: string;
  userId: string;
  taskId: string;
}): Promise<{ recontrol: boolean }> {
  const out = await prisma.$transaction(async (tx) => {
    await lockCompany(tx, input.companyId);
    const task = await tx.workflowTask.findFirst({ where: { id: input.taskId, companyId: input.companyId } });
    if (!task) throw new OrderControlError("Задача не найдена");
    if (task.type !== TASK_TYPES.CORRECT_ORDER) throw new OrderControlError("Это не задача исправления");
    if (task.assignedUserId !== input.userId) throw new OrderControlError("Это не ваша задача исправления");
    const order = await tx.externalOrder.findFirst({ where: { id: task.subjectId ?? "", companyId: input.companyId } });
    if (!order) throw new OrderControlError("Заказ не найден");
    if (task.status === "COMPLETED")
      return { alreadyDone: true, order, controlTask: null as TaskCreateResult | null, unblocked: [] as { id: string; title: string; warehouseId: string }[] };
    if (task.status !== "IN_PROGRESS") throw new OrderControlError("Задача исправления не в работе");
    if (order.status !== "CORRECTION_REQUIRED") throw new OrderControlError("Заказ не в статусе исправления");
    await tx.externalOrder.update({ where: { id: order.id }, data: { status: "IN_CONTROL" } });
    const unblocked = await completeWorkflowTaskInTransaction(tx, task.id);
    const controlTask = await createControlTaskInTx(tx, { companyId: input.companyId, order, dedupeKey: `control:${order.id}:recheck:${task.id}` });
    return { alreadyDone: false, order, controlTask, unblocked };
  });

  if (!out.alreadyDone) {
    await emitTaskCompleted({ companyId: input.companyId, warehouseId: out.order.warehouseId, title: "Исправление выполнено", taskId: input.taskId, unblocked: out.unblocked });
    if (out.controlTask) await emitTaskCreated(out.controlTask);
    await rebalanceQueuedTasks(input.companyId, { warehouseId: out.order.warehouseId });
  }
  return { recontrol: !out.alreadyDone };
}

// ── Геттеры для UI ──
export async function getControlOrderContext(companyId: string, taskId: string) {
  const task = await prisma.workflowTask.findFirst({ where: { id: taskId, companyId, type: TASK_TYPES.CONTROL_ORDER } });
  if (!task?.subjectId) return null;
  const order = await prisma.externalOrder.findFirst({ where: { id: task.subjectId, companyId } });
  if (!order) return null;
  const orderLines = await prisma.externalOrderLine.findMany({ where: { orderId: order.id }, orderBy: { externalLineId: "asc" } });
  const items = await prisma.item.findMany({ where: { id: { in: orderLines.map((l) => l.itemId) } }, select: { id: true, name: true } });
  const itemName = new Map(items.map((i) => [i.id, i.name]));
  const check = await prisma.controlCheck.findUnique({ where: { taskId: task.id } });
  const checkLines = check
    ? await prisma.controlCheckLine.findMany({ where: { checkId: check.id }, orderBy: { id: "asc" } })
    : [];
  const byLine = new Map(checkLines.filter((c) => c.lineId).map((c) => [c.lineId as string, c]));
  const lines = orderLines.map((l) => {
    const c = byLine.get(l.id);
    return {
      lineId: l.id,
      item: itemName.get(l.itemId) ?? l.itemId,
      required: l.requiredQty.toString(),
      counted: c?.countedQty != null ? c.countedQty.toString() : null,
      discrepancyType: c?.discrepancyType ?? null,
    };
  });
  const allMarked = lines.length > 0 && lines.every((l) => l.counted != null);
  const previous = await prisma.controlCheck.findMany({
    where: { orderId: order.id, id: check ? { not: check.id } : undefined },
    orderBy: { attempt: "asc" },
    select: { attempt: true, status: true },
  });
  return {
    taskId: task.id,
    orderId: order.id,
    externalId: order.externalId,
    scanConfirmed: !!check,
    attempt: check?.attempt ?? previous.length + 1,
    lines,
    allMarked,
    previousChecks: previous.map((p) => ({ attempt: p.attempt, status: p.status })),
  };
}

export async function getCorrectOrderContext(companyId: string, taskId: string) {
  const task = await prisma.workflowTask.findFirst({ where: { id: taskId, companyId, type: TASK_TYPES.CORRECT_ORDER } });
  if (!task?.subjectId) return null;
  const order = await prisma.externalOrder.findFirst({ where: { id: task.subjectId, companyId } });
  if (!order) return null;
  const lastFailed = await prisma.controlCheck.findFirst({
    where: { orderId: order.id, status: "FAILED" },
    orderBy: { attempt: "desc" },
  });
  const disc = lastFailed
    ? await prisma.controlCheckLine.findMany({ where: { checkId: lastFailed.id, discrepancyType: { not: null } }, orderBy: { id: "asc" } })
    : [];
  const items = await prisma.item.findMany({ where: { id: { in: disc.map((d) => d.itemId) } }, select: { id: true, name: true } });
  const itemName = new Map(items.map((i) => [i.id, i.name]));
  return {
    taskId: task.id,
    orderId: order.id,
    externalId: order.externalId,
    discrepancies: disc.map((d) => ({
      item: itemName.get(d.itemId) ?? d.itemId,
      type: d.discrepancyType,
      expected: d.expectedQty.toString(),
      counted: d.countedQty != null ? d.countedQty.toString() : "—",
      comment: d.comment ?? null,
    })),
  };
}
