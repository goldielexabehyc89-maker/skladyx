import "server-only";
import { Prisma, type ExternalOrder } from "@prisma/client";
import { prisma } from "@/lib/db";
import { parseScannedCode } from "@/lib/qr";
import { logEvent } from "@/lib/events";
import { applyLotMovement } from "@/lib/stock";
import { lockCell } from "@/lib/cells";
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

// Этап 5/Пакет 8: размещение проверенного заказа в ячейки зоны ISSUE и выдача водителю. За флагом
// ORDER_ISSUE_ENABLED. ExternalOrder — единственный владелец состояния заказа. Все движения остатка —
// только через src/lib/stock.ts. Одна активная ячейка выдачи — под один заказ (partial unique +
// per-cell advisory lock). Идемпотентность: OrderIssuePlacement(orderId,lotId) unique,
// OrderShipment(orderId) unique, dedupeKey задач.

export class OrderIssueError extends Error {}
type Tx = Prisma.TransactionClient;
type OrderLite = Pick<ExternalOrder, "id" | "warehouseId" | "externalId" | "arrivalAt">;
const D = (x: Prisma.Decimal | number | string) => new Prisma.Decimal(x);

// ── Резолвинг QR ──
async function resolveScannedOrder(tx: Tx, companyId: string, raw: string): Promise<string> {
  const code = parseScannedCode(raw);
  if (!code) throw new OrderIssueError("Неверный QR заказа");
  const qr = await tx.qrCode.findUnique({ where: { code } });
  if (!qr || qr.companyId !== companyId || qr.type !== "ORDER") throw new OrderIssueError("Это не QR заказа этой организации");
  const order = await tx.externalOrder.findFirst({ where: { id: qr.refId, companyId }, select: { id: true } });
  if (!order) throw new OrderIssueError("Заказ не найден");
  return order.id;
}
async function resolveScannedCell(tx: Tx, companyId: string, warehouseId: string, raw: string): Promise<string> {
  const code = parseScannedCode(raw);
  if (!code) throw new OrderIssueError("Неверный QR ячейки");
  const qr = await tx.qrCode.findUnique({ where: { code } });
  if (!qr || qr.companyId !== companyId || qr.type !== "CELL") throw new OrderIssueError("Это не QR ячейки этой организации");
  const cell = await tx.cell.findFirst({ where: { id: qr.refId, companyId, warehouseId }, select: { id: true } });
  if (!cell) throw new OrderIssueError("Ячейка не найдена на этом складе");
  return cell.id;
}

// зона CONTROL склада (там товар заказа после сборки/контроля)
async function controlZoneId(tx: Tx, companyId: string, warehouseId: string): Promise<string> {
  const z = await tx.warehouseZone.findFirst({ where: { companyId, warehouseId, kind: "CONTROL" }, select: { id: true } });
  if (!z) throw new OrderIssueError("На складе нет зоны CONTROL");
  return z.id;
}

// Свободная активная ячейка зоны ISSUE. Кандидат берётся ТОЛЬКО под lockCell с повторной проверкой в
// одном цикле (гонка со старыми операциями): пусто по остатку и серийным единицам, нет активной брони
// выдачи и охлаждения. Занятый конкурентно кандидат пропускается; null — только если свободных нет вовсе.
async function reserveFreeIssueCell(tx: Tx, companyId: string, warehouseId: string): Promise<string | null> {
  const cells = await tx.cell.findMany({
    where: { companyId, warehouseId, isActive: true, zone: { kind: "ISSUE" } },
    select: { id: true }, orderBy: { code: "asc" },
  });
  for (const c of cells) {
    await lockCell(tx, companyId, c.id);
    const [bal, unit, occ, coolRes] = await Promise.all([
      tx.stockBalance.findFirst({ where: { cellId: c.id, qty: { gt: 0 } }, select: { id: true } }),
      tx.itemUnit.findFirst({ where: { cellId: c.id }, select: { id: true } }),
      tx.orderIssueCell.findFirst({ where: { cellId: c.id, status: { not: "RELEASED" } }, select: { id: true } }),
      tx.cellReservation.findFirst({ where: { cellId: c.id, status: "ACTIVE" }, select: { id: true } }),
    ]);
    if (!bal && !unit && !occ && !coolRes) return c.id;
  }
  return null;
}

// Количество, собранное ЭТИМ заказом из партии (FULFILLED-резервы order+lot). Пакет 6 допускает
// несколько заказов на одну партию, поэтому берём долю ЗАКАЗА, а не весь остаток общей зоны CONTROL.
async function orderLotPickedQty(tx: Tx, orderId: string, lotId: string): Promise<Prisma.Decimal> {
  const agg = await tx.stockReservation.aggregate({ where: { orderId, lotId, status: "FULFILLED" }, _sum: { qty: true } });
  return D(agg._sum.qty ?? 0);
}

// Остаток заказа, ещё не перемещённый из CONTROL = собрано заказом − уже размещено. НЕ зависит от
// количеств ДРУГИХ заказов той же партии в общей зоне CONTROL. 0 → весь заказ перемещён.
async function orderControlRemaining(tx: Tx, orderId: string): Promise<Prisma.Decimal> {
  const [picked, placed] = await Promise.all([
    tx.stockReservation.aggregate({ where: { orderId, status: "FULFILLED" }, _sum: { qty: true } }),
    tx.orderIssuePlacement.aggregate({ where: { orderId }, _sum: { qty: true } }),
  ]);
  return D(picked._sum.qty ?? 0).minus(placed._sum.qty ?? 0);
}

// ── Авто-резерв ячейки выдачи после контроля (в ПЕРЕДАННОЙ tx под lockCompany). Найдена свободная
// ячейка → бронь + срочная ISSUE_ORDER, заказ MOVING_TO_ISSUE; нет → AWAITING_ISSUE_CELL, без задачи.
// Идемпотентно: если заказ уже размещается/размещён — не повторяем. ──
export async function assignIssueCellInTx(tx: Tx, companyId: string, order: OrderLite): Promise<TaskCreateResult | null> {
  // уже есть активная ячейка/задача — идемпотентно
  const existing = await tx.orderIssueCell.findFirst({ where: { orderId: order.id, status: { not: "RELEASED" } }, select: { id: true } });
  if (existing) return null;
  // выбор кандидата + lockCell + повторная проверка — в одном цикле; занятые пропускаются
  const cellId = await reserveFreeIssueCell(tx, companyId, order.warehouseId);
  if (!cellId) {
    await tx.externalOrder.update({ where: { id: order.id }, data: { status: "AWAITING_ISSUE_CELL" } });
    return null;
  }
  await tx.orderIssueCell.create({ data: { companyId, orderId: order.id, warehouseId: order.warehouseId, cellId, status: "RESERVED" } });
  await tx.externalOrder.update({ where: { id: order.id }, data: { status: "MOVING_TO_ISSUE" } });
  return createWorkflowTaskInTx(tx, {
    companyId, warehouseId: order.warehouseId, type: TASK_TYPES.ISSUE_ORDER, requiredRole: "LOADER", priority: "URGENT",
    title: `Разместить в выдаче: заказ ${order.externalId}`, subjectType: "externalOrder", subjectId: order.id,
    dedupeKey: `issue:${order.id}:place`, loadUnits: 1, dueAt: order.arrivalAt ?? undefined,
  });
}

// ── Реобработка ожидающих ячейку заказов: по arrivalAt ASC (nulls last) → createdAt ASC, пока есть
// свободные ячейки. Вызывается после освобождения ячейки (выдача). Возвращает созданные задачи. ──
async function reprocessPendingInTx(tx: Tx, companyId: string, warehouseId: string): Promise<TaskCreateResult[]> {
  const created: TaskCreateResult[] = [];
  const pending = await tx.externalOrder.findMany({
    where: { companyId, warehouseId, status: "AWAITING_ISSUE_CELL" },
    orderBy: [{ arrivalAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
    select: { id: true, warehouseId: true, externalId: true, arrivalAt: true },
  });
  for (const o of pending) {
    const res = await assignIssueCellInTx(tx, companyId, o);
    if (res) created.push(res);
    else break; // нет свободных ячеек — остальные ждут
  }
  return created;
}

async function requireIssueTask(tx: Tx, companyId: string, taskId: string, userId: string, type: string) {
  const task = await tx.workflowTask.findFirst({ where: { id: taskId, companyId } });
  if (!task) throw new OrderIssueError("Задача не найдена");
  if (task.type !== type) throw new OrderIssueError(type === TASK_TYPES.ISSUE_ORDER ? "Это не задача размещения" : "Это не задача выдачи");
  if (task.assignedUserId !== userId) throw new OrderIssueError("Это не ваша задача");
  if (task.status !== "IN_PROGRESS") throw new OrderIssueError("Задача не в работе");
  const order = await tx.externalOrder.findFirst({ where: { id: task.subjectId ?? "", companyId } });
  if (!order) throw new OrderIssueError("Заказ не найден");
  return { task, order };
}

// ── ISSUE-002 v1 (Задача N): проверка назначенной ячейки — существует, активна, на складе задачи и в
// ФИЗИЧЕСКОЙ зоне ISSUE. Отсутствующая/неактивная/перенесённая в другую зону → fail-closed. Вызывается
// и в read-only проверке, и повторно под lockCell непосредственно перед движением. ──
async function assertAssignedIssueCell(tx: Tx, companyId: string, cellId: string, warehouseId: string): Promise<void> {
  const cell = await tx.cell.findFirst({ where: { id: cellId, companyId }, include: { zone: true } });
  if (!cell || !cell.isActive) throw new OrderIssueError("Назначенная ячейка недоступна (отсутствует или неактивна)");
  if (cell.warehouseId !== warehouseId) throw new OrderIssueError("Назначенная ячейка на другом складе");
  if (cell.zone?.kind !== "ISSUE") throw new OrderIssueError("Назначенная ячейка не в зоне выдачи");
}

// Ровно одна активная (не RELEASED) назначенная ячейка заказа + её валидация. Fail-closed при 0/>1
// или недоступной ячейке. Возвращает саму запись OrderIssueCell (в т.ч. её cellId).
async function requireSingleAssignedCell(tx: Tx, companyId: string, orderId: string, warehouseId: string) {
  const cells = await tx.orderIssueCell.findMany({ where: { orderId, status: { not: "RELEASED" } } });
  if (cells.length === 0) throw new OrderIssueError("Заказу не назначена ячейка выдачи");
  if (cells.length > 1) throw new OrderIssueError("Заказу назначено несколько ячеек выдачи — обратитесь к администратору");
  await assertAssignedIssueCell(tx, companyId, cells[0].cellId, warehouseId);
  return cells[0];
}

// ── ISSUE-002 v1 (Задача N): немедленная read-only проверка скана QR заказа. Задача исполнителя,
// ISSUE_ORDER IN_PROGRESS, tenant, склад и QR ИМЕННО заказа задачи. Fail-closed: ровно одна активная
// назначенная ISSUE-ячейка. БД не меняется. Неверный QR/несоответствие — ошибка (шаг не меняется). ──
export async function verifyIssueOrderScan(input: {
  companyId: string; userId: string; taskId: string; orderCode: string;
}): Promise<{ ok: true; cellCode: string }> {
  return prisma.$transaction(async (tx) => {
    const { order } = await requireIssueTask(tx, input.companyId, input.taskId, input.userId, TASK_TYPES.ISSUE_ORDER);
    const scannedOrderId = await resolveScannedOrder(tx, input.companyId, input.orderCode);
    if (scannedOrderId !== order.id) throw new OrderIssueError("Отсканирован не тот заказ");
    // fail-closed: ровно одна активная ячейка + существует/активна/этот склад/зона ISSUE
    const ic = await requireSingleAssignedCell(tx, input.companyId, order.id, order.warehouseId);
    const cellRow = await tx.cell.findFirst({ where: { id: ic.cellId, companyId: input.companyId }, select: { code: true } });
    return { ok: true as const, cellCode: cellRow?.code ?? "" };
  });
}

// ── ISSUE-002 v1 (Задача N): скан назначенной ISSUE-ячейки → ОДНА атомарная транзакция: перемещает
// весь оставшийся объём заказа из CONTROL в эту ячейку (все FULFILLED-доли по lotId, чужие доли той же
// партии не трогаются), помечает ячейку PLACED, завершает ISSUE_ORDER и создаёт ровно одну DELIVER_ORDER.
// Сервер повторно проверяет заказ и назначенную ячейку (не доверяя клиенту). Идемпотентно: точный повтор
// не создаёт второго движения/placement/задачи. Fail-closed при 0 или >1 назначенных ячейках. ──
export async function placeWholeOrderInIssueCell(input: {
  companyId: string; userId: string; taskId: string; orderCode: string; cellCode: string;
}): Promise<{ done: boolean; alreadyDone: boolean }> {
  const out = await prisma.$transaction(async (tx) => {
    await lockCompany(tx, input.companyId);
    const task = await tx.workflowTask.findFirst({ where: { id: input.taskId, companyId: input.companyId } });
    if (!task || task.type !== TASK_TYPES.ISSUE_ORDER) throw new OrderIssueError("Это не задача размещения");
    if (task.assignedUserId !== input.userId) throw new OrderIssueError("Это не ваша задача");
    if (task.status !== "IN_PROGRESS" && task.status !== "COMPLETED") throw new OrderIssueError("Задача размещения не в работе");
    const order = await tx.externalOrder.findFirst({ where: { id: task.subjectId ?? "", companyId: input.companyId } });
    if (!order) throw new OrderIssueError("Заказ не найден");
    // Точная идемпотентность: проверки заказа и ячейки выполняются ВСЕГДА (в т.ч. после COMPLETED),
    // не доверяя клиенту. Неверный заказ или неверная/недоступная ячейка отклоняются даже на повторе.
    const scannedOrderId = await resolveScannedOrder(tx, input.companyId, input.orderCode);
    if (scannedOrderId !== order.id) throw new OrderIssueError("Отсканирован не тот заказ");
    // fail-closed: ровно одна активная назначенная ячейка + существует/активна/этот склад/зона ISSUE
    const ic = await requireSingleAssignedCell(tx, input.companyId, order.id, order.warehouseId);
    // скан обязан совпасть с фактически назначенной ячейкой
    const scannedCellId = await resolveScannedCell(tx, input.companyId, order.warehouseId, input.cellCode);
    if (scannedCellId !== ic.cellId) throw new OrderIssueError("Отсканирована не назначенная ячейка выдачи");
    await lockCell(tx, input.companyId, ic.cellId);
    // повторная валидация ячейки под lockCell непосредственно перед движением (гонка с переносом зоны)
    await assertAssignedIssueCell(tx, input.companyId, ic.cellId, order.warehouseId);
    // точный повтор после завершения задачи → успех без движения/placement/события/второй DELIVER_ORDER
    if (task.status === "COMPLETED") return { alreadyDone: true, order, deliverTask: null as TaskCreateResult | null, unblocked: [] as { id: string; title: string; warehouseId: string }[] };
    const zoneCtl = await controlZoneId(tx, input.companyId, order.warehouseId);
    // все FULFILLED-доли заказа (по lotId), ещё не размещённые — переместить каждую долю ЗАКАЗА
    const resvs = await tx.stockReservation.findMany({ where: { orderId: order.id, status: "FULFILLED" }, select: { lotId: true }, distinct: ["lotId"] });
    const lotIds = resvs.map((r) => r.lotId).filter((l): l is string => !!l);
    const already = await tx.orderIssuePlacement.findMany({ where: { orderId: order.id }, select: { lotId: true } });
    const placedSet = new Set(already.map((p) => p.lotId));
    for (const lotId of lotIds) {
      if (placedSet.has(lotId)) continue; // идемпотентно: доля уже перемещена
      const qty = await orderLotPickedQty(tx, order.id, lotId);
      if (qty.lte(0)) continue;
      const lot = await tx.lot.findFirst({ where: { id: lotId, companyId: input.companyId }, select: { itemId: true } });
      if (!lot) throw new OrderIssueError("Партия не найдена");
      // в общей зоне CONTROL должно быть не меньше доли ЗАКАЗА (чужие количества той же партии не трогаем)
      const bal = await tx.stockBalance.aggregate({ where: { lotId, locKey: `Z:${zoneCtl}`, qty: { gt: 0 } }, _sum: { qty: true } });
      if (D(bal._sum.qty ?? 0).lt(qty)) throw new OrderIssueError("В зоне контроля недостаточно остатка партии для заказа");
      await applyLotMovement(tx, {
        companyId: input.companyId, docType: "TRANSFER", docId: order.id, itemId: lot.itemId, lotId, qty,
        from: { kind: "zone", warehouseId: order.warehouseId, zoneId: zoneCtl },
        to: { kind: "cell", warehouseId: order.warehouseId, cellId: ic.cellId },
        createdById: input.userId,
      });
      await tx.orderIssuePlacement.create({ data: { companyId: input.companyId, issueCellId: ic.id, orderId: order.id, lotId, itemId: lot.itemId, qty } });
    }
    if (ic.status === "RESERVED") await tx.orderIssueCell.update({ where: { id: ic.id }, data: { status: "PLACED", placedAt: new Date() } });
    // весь заказ перемещён из CONTROL → READY_FOR_DRIVER, завершить ISSUE_ORDER, создать одну DELIVER_ORDER
    const remaining = await orderControlRemaining(tx, order.id);
    if (remaining.gt(0)) throw new OrderIssueError("Не весь заказ перемещён из зоны контроля");
    await tx.externalOrder.update({ where: { id: order.id }, data: { status: "READY_FOR_DRIVER" } });
    const unblocked = await completeWorkflowTaskInTransaction(tx, task.id);
    const deliverTask = await createWorkflowTaskInTx(tx, {
      companyId: input.companyId, warehouseId: order.warehouseId, type: TASK_TYPES.DELIVER_ORDER, requiredRole: "LOADER", priority: "NORMAL",
      title: `Выдать водителю: заказ ${order.externalId}`, subjectType: "externalOrder", subjectId: order.id,
      dedupeKey: `deliver:${order.id}`, loadUnits: 1, dueAt: order.arrivalAt ?? undefined,
    });
    return { alreadyDone: false, order, deliverTask, unblocked };
  });
  if (!out.alreadyDone) {
    await emitTaskCompleted({ companyId: input.companyId, warehouseId: out.order.warehouseId, title: "Заказ размещён в выдаче", taskId: input.taskId, unblocked: out.unblocked });
    if (out.deliverTask) await emitTaskCreated(out.deliverTask);
    await logEvent({ companyId: input.companyId, type: "order_ready_for_driver", title: "Заказ готов к выдаче", body: `Заказ ${out.order.externalId} размещён в ячейке выдачи`, url: "/warehouse/tasks", warehouseIds: [out.order.warehouseId], actorId: input.userId });
    await rebalanceQueuedTasks(input.companyId, { warehouseId: out.order.warehouseId });
  }
  return { done: true, alreadyDone: out.alreadyDone };
}

// ── Выдача водителю: скан QR заказа + всех занятых ячеек. Сервер проверяет tenant/склад/заказ и
// ПОЛНЫЙ набор ячеек. Расход из ячеек → внешний мир через ядро; заказ ISSUED, ячейки RELEASED;
// OrderShipment (issuedById/issuedAt). Идемпотентно по заказу. Затем — реобработка ожидающих. ──
export async function issueOrderToDriver(input: {
  companyId: string; userId: string; taskId: string; orderCode: string; cellCodes: string[];
}): Promise<{ issued: boolean; alreadyIssued: boolean }> {
  const out = await prisma.$transaction(async (tx) => {
    await lockCompany(tx, input.companyId);
    const task = await tx.workflowTask.findFirst({ where: { id: input.taskId, companyId: input.companyId } });
    if (!task || task.type !== TASK_TYPES.DELIVER_ORDER) throw new OrderIssueError("Это не задача выдачи");
    if (task.assignedUserId !== input.userId) throw new OrderIssueError("Это не ваша задача выдачи");
    const order = await tx.externalOrder.findFirst({ where: { id: task.subjectId ?? "", companyId: input.companyId } });
    if (!order) throw new OrderIssueError("Заказ не найден");
    const scannedOrderId = await resolveScannedOrder(tx, input.companyId, input.orderCode);
    if (scannedOrderId !== order.id) throw new OrderIssueError("Отсканирован не тот заказ");
    // идемпотентность: уже выдан
    const shipped = await tx.orderShipment.findUnique({ where: { orderId: order.id }, select: { id: true } });
    if (shipped) return { alreadyIssued: true, order, unblocked: [] as { id: string; title: string; warehouseId: string }[], created: [] as TaskCreateResult[] };
    if (task.status !== "IN_PROGRESS") throw new OrderIssueError("Задача выдачи не в работе");
    // полный набор ячеек: все активные (PLACED) ячейки заказа должны быть отсканированы
    const cells = await tx.orderIssueCell.findMany({ where: { orderId: order.id, status: { not: "RELEASED" } } });
    if (cells.length === 0) throw new OrderIssueError("У заказа нет занятых ячеек выдачи");
    const scannedIds = new Set<string>();
    for (const raw of input.cellCodes) scannedIds.add(await resolveScannedCell(tx, input.companyId, order.warehouseId, raw));
    const need = new Set(cells.map((c) => c.cellId));
    for (const c of need) if (!scannedIds.has(c)) throw new OrderIssueError("Отсканированы не все ячейки выдачи заказа");
    for (const s of scannedIds) if (!need.has(s)) throw new OrderIssueError("Отсканирована ячейка, не относящаяся к заказу");
    // расход из каждой ячейки во внешний мир через ядро
    for (const ic of cells) {
      await lockCell(tx, input.companyId, ic.cellId);
      const placements = await tx.orderIssuePlacement.findMany({ where: { issueCellId: ic.id } });
      for (const p of placements) {
        await applyLotMovement(tx, {
          companyId: input.companyId, docType: "ISSUE", docId: order.id, itemId: p.itemId, lotId: p.lotId, qty: p.qty,
          from: { kind: "cell", warehouseId: order.warehouseId, cellId: ic.cellId }, to: null, createdById: input.userId,
        });
      }
      await tx.orderIssueCell.update({ where: { id: ic.id }, data: { status: "RELEASED", releasedAt: new Date() } });
    }
    await tx.externalOrder.update({ where: { id: order.id }, data: { status: "ISSUED" } });
    await tx.orderShipment.create({ data: { companyId: input.companyId, orderId: order.id, warehouseId: order.warehouseId, issuedById: input.userId } });
    const unblocked = await completeWorkflowTaskInTransaction(tx, task.id);
    // ячейки освободились → реобработка ожидающих заказов
    const created = await reprocessPendingInTx(tx, input.companyId, order.warehouseId);
    return { alreadyIssued: false, order, unblocked, created };
  });
  if (!out.alreadyIssued) {
    await emitTaskCompleted({ companyId: input.companyId, warehouseId: out.order.warehouseId, title: "Заказ выдан водителю", taskId: input.taskId, unblocked: out.unblocked });
    for (const t of out.created) await emitTaskCreated(t);
    await logEvent({ companyId: input.companyId, type: "order_issued", title: "Заказ выдан водителю", body: `Заказ ${out.order.externalId} передан водителю`, url: "/warehouse/tasks", warehouseIds: [out.order.warehouseId], actorId: input.userId });
    await rebalanceQueuedTasks(input.companyId, { warehouseId: out.order.warehouseId });
  }
  return { issued: true, alreadyIssued: out.alreadyIssued };
}

// ── Геттеры для UI ──
export async function getIssueOrderContext(companyId: string, taskId: string) {
  const task = await prisma.workflowTask.findFirst({ where: { id: taskId, companyId, type: TASK_TYPES.ISSUE_ORDER } });
  if (!task?.subjectId) return null;
  const order = await prisma.externalOrder.findFirst({ where: { id: task.subjectId, companyId } });
  if (!order) return null;
  const cells = await prisma.orderIssueCell.findMany({ where: { orderId: order.id, status: { not: "RELEASED" } }, orderBy: { reservedAt: "asc" } });
  const cellCodes = cells.length ? await prisma.qrCode.findMany({ where: { type: "CELL", refId: { in: cells.map((c) => c.cellId) } }, select: { refId: true, code: true } }) : [];
  const codeByCell = new Map(cellCodes.map((q) => [q.refId, q.code]));
  const cellRows = await prisma.cell.findMany({ where: { id: { in: cells.map((c) => c.cellId) } }, select: { id: true, code: true } });
  const nameByCell = new Map(cellRows.map((c) => [c.id, c.code]));
  const remaining = await prisma.$transaction((tx) => orderControlRemaining(tx, order.id));
  // ISSUE-002 v1: компактная карточка — N поз. · M шт и назначенная ячейка (ровно одна). Больше/меньше
  // одной активной ячейки → assignedCellCode=null (UI показывает fail-closed, движения не будет).
  const orderLines = await prisma.externalOrderLine.findMany({ where: { orderId: order.id }, select: { requiredQty: true } });
  const units = orderLines.reduce((s, l) => s.plus(l.requiredQty), new Prisma.Decimal(0));
  const assignedCellCode = cells.length === 1 ? (nameByCell.get(cells[0].cellId) ?? null) : null;
  return {
    taskId: task.id, orderId: order.id, externalId: order.externalId,
    arrivalAt: order.arrivalAt ? order.arrivalAt.toISOString() : null,
    cells: cells.map((c) => ({ cell: nameByCell.get(c.cellId) ?? c.cellId, code: codeByCell.get(c.cellId) ?? null, status: c.status })),
    positions: orderLines.length,
    units: units.toString(),
    assignedCellCode,
    remainingInControl: remaining.toString(),
    canFinish: remaining.lte(0) && cells.some((c) => c.status === "PLACED"),
  };
}

export async function getDeliverOrderContext(companyId: string, taskId: string) {
  const task = await prisma.workflowTask.findFirst({ where: { id: taskId, companyId, type: TASK_TYPES.DELIVER_ORDER } });
  if (!task?.subjectId) return null;
  const order = await prisma.externalOrder.findFirst({ where: { id: task.subjectId, companyId } });
  if (!order) return null;
  const cells = await prisma.orderIssueCell.findMany({ where: { orderId: order.id, status: { not: "RELEASED" } }, orderBy: { reservedAt: "asc" } });
  const cellRows = await prisma.cell.findMany({ where: { id: { in: cells.map((c) => c.cellId) } }, select: { id: true, code: true } });
  const nameByCell = new Map(cellRows.map((c) => [c.id, c.code]));
  return {
    taskId: task.id, orderId: order.id, externalId: order.externalId,
    arrivalAt: order.arrivalAt ? order.arrivalAt.toISOString() : null,
    cells: cells.map((c) => ({ cell: nameByCell.get(c.cellId) ?? c.cellId })),
  };
}
