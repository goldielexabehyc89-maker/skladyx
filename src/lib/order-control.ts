import "server-only";
import { Prisma, type ControlDiscrepancyType, type ControlResolutionMethod, type WorkflowTask, type ExternalOrder } from "@prisma/client";
import { prisma } from "@/lib/db";
import { parseScannedCode } from "@/lib/qr";
import { logEvent } from "@/lib/events";
import { applyLotMovement, type Loc } from "@/lib/stock";
import { lockCell } from "@/lib/cells";
import { eanItemIdInTx } from "@/lib/barcodes";
import { orderIssueEnabled } from "@/lib/roles";
import { assignIssueCellInTx } from "@/lib/order-issue";
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

// ── Резолвинг QR группы/партии: тип GROUP или LOT, своя организация → группа хранения + склад ──
async function resolveScannedGroup(
  tx: Tx,
  companyId: string,
  raw: string,
): Promise<{ groupId: string; lotId: string; itemId: string; warehouseId: string }> {
  const code = parseScannedCode(raw);
  if (!code) throw new OrderControlError("Неверный QR группы/партии");
  const qr = await tx.qrCode.findUnique({ where: { code } });
  if (!qr || qr.companyId !== companyId) throw new OrderControlError("Это не QR этой организации");
  const sel = { id: true, lotId: true, itemId: true, warehouseId: true } as const;
  let group;
  if (qr.type === "GROUP") group = await tx.handlingGroup.findFirst({ where: { id: qr.refId, companyId }, select: sel });
  else if (qr.type === "LOT") group = await tx.handlingGroup.findFirst({ where: { lotId: qr.refId, companyId }, select: sel });
  else throw new OrderControlError("Отсканируйте QR группы или партии товара");
  if (!group) throw new OrderControlError("Группа хранения не найдена");
  return { groupId: group.id, lotId: group.lotId, itemId: group.itemId, warehouseId: group.warehouseId };
}

async function markResolved(
  tx: Tx,
  clId: string,
  method: ControlResolutionMethod,
  userId: string,
  comment: string | null | undefined,
  fallback: string,
): Promise<void> {
  await tx.controlCheckLine.update({
    where: { id: clId },
    data: { resolutionStatus: "RESOLVED", resolutionMethod: method, resolvedById: userId, resolvedAt: new Date(), resolutionComment: comment?.trim() || fallback },
  });
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

// ── Контролёр отмечает по СКАНУ QR группы/партии + количество. Сервер резолвит QR, проверяет
// tenant (организация), склад (группа на складе заказа) и связь с заказом (резерв этого заказа на
// эту группу → строка заказа). Неожиданный товар (не связан с заказом) фиксируется отдельной
// строкой lineId=null с типом EXCESS/WRONG_ITEM. Ручной ввод кода — тот же путь (fallback). ──
export async function markOrderControlByScan(input: {
  companyId: string;
  userId: string;
  taskId: string;
  ean: string;
  countedQty: number;
  discrepancyType?: string | null;
  comment?: string | null;
}): Promise<{ lineId: string | null; itemId: string; discrepancyType: ControlDiscrepancyType | null }> {
  return prisma.$transaction(async (tx) => {
    await lockCompany(tx, input.companyId);
    const task = await requireControlTask(tx, input.companyId, input.taskId, input.userId);
    if (task.status !== "IN_PROGRESS") throw new OrderControlError("Задача контроля не в работе");
    const order = await tx.externalOrder.findFirst({ where: { id: task.subjectId ?? "", companyId: input.companyId } });
    if (!order) throw new OrderControlError("Заказ не найден");
    const check = await tx.controlCheck.findUnique({ where: { taskId: task.id } });
    if (!check) throw new OrderControlError("Сначала отсканируйте QR заказа");
    if (check.status !== "IN_PROGRESS") throw new OrderControlError("Проверка уже завершена");
    // Пакет 9B: товар — по EAN. Ожидаемая строка определяется заказом и товаром.
    const itemId = await eanItemIdInTx(tx, input.companyId, input.ean);
    if (!itemId) throw new OrderControlError("Неизвестный, неактивный или чужой EAN — контроль отклонён");
    const counted = D(input.countedQty);
    if (counted.lt(0)) throw new OrderControlError("Количество не может быть отрицательным");
    const explicit = parseDiscrepancyType(input.discrepancyType);
    const comment = input.comment?.trim() || null;
    // строки заказа этого товара в проверке — детерминированно по id; берём первую ещё не отмеченную,
    // иначе первую (перепроверка). Несколько строк одного товара обрабатываются без случайного выбора.
    const itemLines = await tx.controlCheckLine.findMany({ where: { checkId: check.id, lineId: { not: null }, itemId }, orderBy: { id: "asc" } });
    const cl = itemLines.find((l) => l.countedQty === null) ?? itemLines[0] ?? null;
    if (cl) {
      let type = explicit;
      if (!counted.equals(cl.expectedQty) && !type) type = counted.lt(cl.expectedQty) ? "SHORTAGE" : "EXCESS";
      else if (counted.equals(cl.expectedQty) && (type === "SHORTAGE" || type === "EXCESS")) type = null;
      await tx.controlCheckLine.update({
        where: { id: cl.id },
        data: { countedQty: counted, discrepancyType: type, comment, byUserId: input.userId, checkedAt: new Date() },
      });
      return { lineId: cl.lineId, itemId, discrepancyType: type };
    }
    // неожиданный товар: нет строки заказа с этим товаром → EXCESS/WRONG_ITEM обязателен
    if (explicit !== "EXCESS" && explicit !== "WRONG_ITEM")
      throw new OrderControlError("Неожиданный товар: укажите тип «излишек» или «не тот товар»");
    const existing = await tx.controlCheckLine.findFirst({ where: { checkId: check.id, lineId: null, itemId } });
    if (existing) {
      await tx.controlCheckLine.update({
        where: { id: existing.id },
        data: { countedQty: counted, discrepancyType: explicit, comment, byUserId: input.userId, checkedAt: new Date() },
      });
      return { lineId: null, itemId, discrepancyType: explicit };
    }
    await tx.controlCheckLine.create({
      data: { companyId: input.companyId, checkId: check.id, lineId: null, itemId, expectedQty: D(0), countedQty: counted, discrepancyType: explicit, comment, byUserId: input.userId, checkedAt: new Date() },
    });
    return { lineId: null, itemId, discrepancyType: explicit };
  });
}

// ── CONTROL-001 (Задача N): контролёр подтверждает строку заказа КЛИКОМ (без EAN/количества).
// Записывает countedQty = requiredQty (ожидаемое), без расхождения. Идемпотентно. Проверяет
// организацию, исполнителя, CONTROL_ORDER IN_PROGRESS, текущий ControlCheck и принадлежность
// lineId ИМЕННО заказу задачи. Чужая строка/другой заказ/завершённая задача/чужая задача — отказ. ──
export async function confirmControlLine(input: {
  companyId: string;
  userId: string;
  taskId: string;
  lineId: string;
}): Promise<{ alreadyConfirmed: boolean }> {
  return prisma.$transaction(async (tx) => {
    await lockCompany(tx, input.companyId);
    const task = await requireControlTask(tx, input.companyId, input.taskId, input.userId);
    if (task.status !== "IN_PROGRESS") throw new OrderControlError("Задача контроля не в работе");
    const check = await tx.controlCheck.findUnique({ where: { taskId: task.id } });
    if (!check) throw new OrderControlError("Сначала отсканируйте QR заказа");
    if (check.status !== "IN_PROGRESS") throw new OrderControlError("Проверка уже завершена");
    // строка проверки этого заказа — по lineId (принадлежность заказу задачи). Чужой lineId → отказ.
    const cl = await tx.controlCheckLine.findFirst({ where: { checkId: check.id, lineId: input.lineId } });
    if (!cl) throw new OrderControlError("Строка не принадлежит этому заказу");
    if (cl.countedQty !== null) return { alreadyConfirmed: true }; // идемпотентно: уже подтверждена
    await tx.controlCheckLine.update({
      where: { id: cl.id },
      data: { countedQty: cl.expectedQty, discrepancyType: null, comment: null, byUserId: input.userId, checkedAt: new Date() },
    });
    return { alreadyConfirmed: false };
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
      return { status: check.status as "PASSED" | "FAILED", alreadyFinished: true, order, task, unblocked: [] as { id: string; title: string; warehouseId: string }[], correctTask: null as TaskCreateResult | null, issueTask: null as TaskCreateResult | null };
    }
    if (task.status !== "IN_PROGRESS") throw new OrderControlError("Задача контроля не в работе");
    const unmarked = await tx.controlCheckLine.count({ where: { checkId: check.id, lineId: { not: null }, countedQty: null } });
    if (unmarked > 0) throw new OrderControlError("Отметьте все строки заказа перед завершением");
    const discrepancies = await tx.controlCheckLine.count({ where: { checkId: check.id, discrepancyType: { not: null } } });
    if (discrepancies === 0) {
      await tx.controlCheck.update({ where: { id: check.id }, data: { status: "PASSED", finishedAt: new Date() } });
      await tx.externalOrder.update({ where: { id: order.id }, data: { status: "CONTROL_PASSED" } });
      const unblocked = await completeWorkflowTaskInTransaction(tx, task.id);
      // Пакет 8: при включённом флаге — авто-резерв ячейки выдачи (MOVING_TO_ISSUE + задача) или
      // AWAITING_ISSUE_CELL, если свободной ячейки нет. Флаг OFF → заказ остаётся CONTROL_PASSED.
      const issueTask = orderIssueEnabled() ? await assignIssueCellInTx(tx, input.companyId, order) : null;
      return { status: "PASSED" as const, alreadyFinished: false, order, task, unblocked, correctTask: null as TaskCreateResult | null, issueTask };
    }
    await tx.controlCheck.update({ where: { id: check.id }, data: { status: "FAILED", finishedAt: new Date() } });
    await tx.externalOrder.update({ where: { id: order.id }, data: { status: "CORRECTION_REQUIRED" } });
    // каждое расхождение ждёт разрешения сборщиком (PENDING → RESOLVED)
    await tx.controlCheckLine.updateMany({ where: { checkId: check.id, discrepancyType: { not: null } }, data: { resolutionStatus: "PENDING" } });
    const unblocked = await completeWorkflowTaskInTransaction(tx, task.id);
    const correctTask = await createCorrectTaskInTx(tx, { companyId: input.companyId, order, checkId: check.id });
    return { status: "FAILED" as const, alreadyFinished: false, order, task, unblocked, correctTask, issueTask: null as TaskCreateResult | null };
  });

  if (!out.alreadyFinished) {
    await emitTaskCompleted({ companyId: input.companyId, warehouseId: out.order.warehouseId, title: out.task.title, taskId: out.task.id, unblocked: out.unblocked });
    if (out.correctTask) await emitTaskCreated(out.correctTask);
    if (out.issueTask) await emitTaskCreated(out.issueTask);
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

// Контекст разрешения расхождения: валидная CORRECT_ORDER + строка расхождения последней FAILED-проверки.
async function loadResolutionCtx(tx: Tx, companyId: string, userId: string, taskId: string, checkLineId: string) {
  const task = await tx.workflowTask.findFirst({ where: { id: taskId, companyId } });
  if (!task) throw new OrderControlError("Задача не найдена");
  if (task.type !== TASK_TYPES.CORRECT_ORDER) throw new OrderControlError("Это не задача исправления");
  if (task.assignedUserId !== userId) throw new OrderControlError("Это не ваша задача исправления");
  if (task.status !== "IN_PROGRESS") throw new OrderControlError("Задача исправления не в работе");
  const order = await tx.externalOrder.findFirst({ where: { id: task.subjectId ?? "", companyId } });
  if (!order) throw new OrderControlError("Заказ не найден");
  if (order.status !== "CORRECTION_REQUIRED") throw new OrderControlError("Заказ не в статусе исправления");
  const check = await tx.controlCheck.findFirst({ where: { orderId: order.id, status: "FAILED" }, orderBy: { attempt: "desc" } });
  if (!check) throw new OrderControlError("Нет проваленной проверки");
  const cl = await tx.controlCheckLine.findFirst({ where: { id: checkLineId, checkId: check.id } });
  if (!cl || !cl.discrepancyType) throw new OrderControlError("Строка расхождения не найдена");
  return { order, cl };
}

// ── Разрешение НЕДОСТАЧИ: сборщик сканирует ожидаемый товар/группу и подтверждает добавленное
// количество. Приводит фактический состав к уже проведённому ledger → движение НЕ создаём
// (ALIGNED). Идемпотентно. ──
export async function resolveControlShortage(input: {
  companyId: string;
  userId: string;
  taskId: string;
  checkLineId: string;
  ean: string;
  qty: number;
  comment?: string | null;
}): Promise<{ resolved: boolean; alreadyResolved: boolean }> {
  return prisma.$transaction(async (tx) => {
    await lockCompany(tx, input.companyId);
    const { cl } = await loadResolutionCtx(tx, input.companyId, input.userId, input.taskId, input.checkLineId);
    if (cl.discrepancyType !== "SHORTAGE") throw new OrderControlError("Эта строка не недостача");
    if (cl.resolutionStatus === "RESOLVED") return { resolved: true, alreadyResolved: true };
    // строка известна из checkLineId; EAN лишь подтверждает товар недостающей строки
    const itemId = await eanItemIdInTx(tx, input.companyId, input.ean);
    if (!itemId) throw new OrderControlError("Неизвестный, неактивный или чужой EAN — исправление отклонено");
    if (itemId !== cl.itemId) throw new OrderControlError("Отсканирован не тот товар (ожидается товар недостающей строки)");
    const q = D(input.qty);
    if (q.lte(0)) throw new OrderControlError("Количество должно быть больше нуля");
    // выравнивание к ledger — без движения остатка
    await markResolved(tx, cl.id, "ALIGNED", input.userId, input.comment, `добавлено ${q.toString()}`);
    return { resolved: true, alreadyResolved: false };
  });
}

// ── Разрешение ИЗЛИШКА / НЕ ТОГО / ПОВРЕЖДЁННОГО: сборщик сканирует удаляемый товар/группу и
// подтверждает возврат в хранение (RETURN) или изоляцию в зону DISCREPANCY. Движение — ТОЛЬКО
// через ядро (stock.ts). DAMAGED/OTHER — только безопасный путь DISCREPANCY; при отсутствии зоны
// DISCREPANCY строка остаётся PENDING (задачу не завершить). Идемпотентно. ──
export async function resolveControlRemoval(input: {
  companyId: string;
  userId: string;
  taskId: string;
  checkLineId: string;
  ean: string;
  qty: number;
  disposition: "RETURN" | "DISCREPANCY";
  comment?: string | null;
}): Promise<{ resolved: boolean; alreadyResolved: boolean; moved: boolean }> {
  const res = await prisma.$transaction(async (tx) => {
    await lockCompany(tx, input.companyId);
    const { order, cl } = await loadResolutionCtx(tx, input.companyId, input.userId, input.taskId, input.checkLineId);
    if (cl.discrepancyType === "SHORTAGE") throw new OrderControlError("Недостача исправляется добавлением, не удалением");
    if (cl.resolutionStatus === "RESOLVED") return { alreadyResolved: true, moved: false, warehouseId: order.warehouseId };
    if ((cl.discrepancyType === "DAMAGED" || cl.discrepancyType === "OTHER") && input.disposition !== "DISCREPANCY")
      throw new OrderControlError("Повреждённый/прочий товар можно только изолировать в зону DISCREPANCY");
    const itemId = await eanItemIdInTx(tx, input.companyId, input.ean);
    if (!itemId) throw new OrderControlError("Неизвестный, неактивный или чужой EAN — исправление отклонено");
    if (itemId !== cl.itemId) throw new OrderControlError("Отсканирован не тот товар этого расхождения");
    const q = D(input.qty);
    if (q.lte(0)) throw new OrderControlError("Количество должно быть больше нуля");
    // источник и партия: строка заказа → зона CONTROL, партия из резерва строки; неожиданный товар
    // (lineId=null) → место и партия единственного остатка этого товара (при неоднозначности — fail-closed).
    let from: Loc;
    let lotId: string;
    if (cl.lineId) {
      const controlZone = await tx.warehouseZone.findFirst({ where: { companyId: input.companyId, warehouseId: order.warehouseId, kind: "CONTROL" }, select: { id: true } });
      if (!controlZone) throw new OrderControlError("На складе нет зоны CONTROL");
      from = { kind: "zone", warehouseId: order.warehouseId, zoneId: controlZone.id };
      const resv = await tx.stockReservation.findFirst({ where: { orderId: order.id, lineId: cl.lineId, lotId: { not: null } }, select: { lotId: true } });
      if (!resv?.lotId) throw new OrderControlError("Не найдена партия строки заказа");
      lotId = resv.lotId;
    } else {
      const itemLots = await tx.lot.findMany({ where: { companyId: input.companyId, itemId }, select: { id: true } });
      const bals = await tx.stockBalance.findMany({ where: { companyId: input.companyId, lotId: { in: itemLots.map((l) => l.id) }, qty: { gt: 0 } }, select: { lotId: true, cellId: true, zoneId: true } });
      const lots = new Set(bals.map((b) => b.lotId));
      if (lots.size === 0) throw new OrderControlError("Нет остатка этого товара для перемещения");
      if (lots.size > 1) throw new OrderControlError("Несколько партий этого товара с остатком — исправление неоднозначно");
      const bal = bals[0];
      lotId = bal.lotId;
      if (bal.cellId) { await lockCell(tx, input.companyId, bal.cellId); from = { kind: "cell", warehouseId: order.warehouseId, cellId: bal.cellId }; }
      else if (bal.zoneId) from = { kind: "zone", warehouseId: order.warehouseId, zoneId: bal.zoneId };
      else throw new OrderControlError("Не определить место остатка товара");
    }
    if (input.disposition === "DISCREPANCY") {
      const discZone = await tx.warehouseZone.findFirst({ where: { companyId: input.companyId, warehouseId: order.warehouseId, kind: "DISCREPANCY" }, select: { id: true } });
      if (!discZone) throw new OrderControlError("На складе нет зоны DISCREPANCY — исправление невозможно, оставьте задачу незавершённой");
      await applyLotMovement(tx, {
        companyId: input.companyId, docType: "INVENTORY", docId: order.id, itemId, lotId, qty: q,
        from, to: { kind: "zone", warehouseId: order.warehouseId, zoneId: discZone.id }, createdById: input.userId,
      });
      await markResolved(tx, cl.id, "ISOLATED_DISCREPANCY", input.userId, input.comment, `изолировано ${q.toString()} в DISCREPANCY`);
    } else {
      const src = cl.lineId
        ? await tx.stockReservation.findFirst({ where: { orderId: order.id, lineId: cl.lineId, cellId: { not: null } }, select: { cellId: true } })
        : null;
      if (!src?.cellId) throw new OrderControlError("Не найдена ячейка возврата — используйте изоляцию в DISCREPANCY");
      await lockCell(tx, input.companyId, src.cellId);
      await applyLotMovement(tx, {
        companyId: input.companyId, docType: "TRANSFER", docId: order.id, itemId, lotId, qty: q,
        from, to: { kind: "cell", warehouseId: order.warehouseId, cellId: src.cellId }, createdById: input.userId,
      });
      await markResolved(tx, cl.id, "RETURNED", input.userId, input.comment, `возвращено ${q.toString()} в хранение`);
    }
    return { alreadyResolved: false, moved: true, warehouseId: order.warehouseId };
  });
  return { resolved: true, alreadyResolved: res.alreadyResolved, moved: res.moved };
}

// ── Сборщик завершает исправление: заказ → полный повторный контроль (новая CONTROL_ORDER).
// Требует, чтобы ВСЕ расхождения последней FAILED-проверки были RESOLVED (иначе отказ). Остаток
// здесь НЕ двигаем — движения выполнены при разрешении каждого расхождения через ядро. Идемпотентно. ──
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
    // все расхождения последней FAILED-проверки должны быть RESOLVED
    const failed = await tx.controlCheck.findFirst({ where: { orderId: order.id, status: "FAILED" }, orderBy: { attempt: "desc" } });
    if (failed) {
      const total = await tx.controlCheckLine.count({ where: { checkId: failed.id, discrepancyType: { not: null } } });
      const pending = await tx.controlCheckLine.count({ where: { checkId: failed.id, discrepancyType: { not: null }, resolutionStatus: { not: "RESOLVED" } } });
      if (total === 0) throw new OrderControlError("Нет зафиксированных расхождений для исправления");
      if (pending > 0) throw new OrderControlError(`Разрешите все расхождения перед завершением (осталось ${pending})`);
    }
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
  // неожиданные товары (lineId=null) — зафиксированы контролёром по скану
  const extraItemIds = checkLines.filter((c) => !c.lineId).map((c) => c.itemId);
  const extraItems = extraItemIds.length ? await prisma.item.findMany({ where: { id: { in: extraItemIds } }, select: { id: true, name: true } }) : [];
  const extraName = new Map(extraItems.map((i) => [i.id, i.name]));
  const extras = checkLines
    .filter((c) => !c.lineId)
    .map((c) => ({ item: extraName.get(c.itemId) ?? c.itemId, counted: c.countedQty?.toString() ?? "—", discrepancyType: c.discrepancyType ?? null }));
  const allMarked = lines.length > 0 && lines.every((l) => l.counted != null);
  const previous = await prisma.controlCheck.findMany({
    where: { orderId: order.id, id: check ? { not: check.id } : undefined },
    orderBy: { attempt: "asc" },
    select: { attempt: true, status: true },
  });
  // Задача M Этап2: компактная карточка — позиции/единицы/прогресс проверки.
  const units = orderLines.reduce((s, l) => s.plus(l.requiredQty), new Prisma.Decimal(0));
  const marked = lines.filter((l) => l.counted != null).length;
  return {
    taskId: task.id,
    orderId: order.id,
    externalId: order.externalId,
    scanConfirmed: !!check,
    attempt: check?.attempt ?? previous.length + 1,
    positions: orderLines.length,
    units: units.toString(),
    marked,
    lines,
    extras,
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
  // код группы (для справки/ручного ввода при сканировании исправления)
  const grpIds = disc.map((d) => d.handlingGroupId).filter((x): x is string => !!x);
  const grpQrs = grpIds.length ? await prisma.qrCode.findMany({ where: { type: "GROUP", refId: { in: grpIds } }, select: { refId: true, code: true } }) : [];
  const grpCode = new Map(grpQrs.map((q) => [q.refId, q.code]));
  const discrepancies = disc.map((d) => ({
    checkLineId: d.id,
    item: itemName.get(d.itemId) ?? d.itemId,
    type: d.discrepancyType,
    expected: d.expectedQty.toString(),
    counted: d.countedQty != null ? d.countedQty.toString() : "—",
    comment: d.comment ?? null,
    resolutionStatus: d.resolutionStatus ?? "PENDING",
    resolutionMethod: d.resolutionMethod ?? null,
    groupCode: d.handlingGroupId ? grpCode.get(d.handlingGroupId) ?? null : null,
  }));
  return {
    taskId: task.id,
    orderId: order.id,
    externalId: order.externalId,
    discrepancies,
    allResolved: discrepancies.length > 0 && discrepancies.every((d) => d.resolutionStatus === "RESOLVED"),
  };
}
