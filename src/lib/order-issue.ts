import "server-only";
import { Prisma, type ExternalOrder } from "@prisma/client";
import { prisma } from "@/lib/db";
import { parseScannedCode } from "@/lib/qr";
import { logEvent } from "@/lib/events";
import { applyLotMovement } from "@/lib/stock";
import { lockCell } from "@/lib/cells";
import { eanItemIdInTx } from "@/lib/barcodes";
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
async function resolveScannedGroup(tx: Tx, companyId: string, raw: string): Promise<{ lotId: string; itemId: string; warehouseId: string }> {
  const code = parseScannedCode(raw);
  if (!code) throw new OrderIssueError("Неверный QR группы/партии");
  const qr = await tx.qrCode.findUnique({ where: { code } });
  if (!qr || qr.companyId !== companyId) throw new OrderIssueError("Это не QR этой организации");
  const sel = { lotId: true, itemId: true, warehouseId: true } as const;
  let group;
  if (qr.type === "GROUP") group = await tx.handlingGroup.findFirst({ where: { id: qr.refId, companyId }, select: sel });
  else if (qr.type === "LOT") group = await tx.handlingGroup.findFirst({ where: { lotId: qr.refId, companyId }, select: sel });
  else throw new OrderIssueError("Отсканируйте QR группы или партии товара");
  if (!group) throw new OrderIssueError("Группа хранения не найдена");
  return { lotId: group.lotId, itemId: group.itemId, warehouseId: group.warehouseId };
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

// Пакет 9B: партии заданного товара, собранные заказом (FULFILLED-резервы), в детерминированном
// порядке (старейшая Lot.createdAt первой). Товар определяется EAN; конкретная партия — из резервов.
async function orderFulfilledLotsForItem(tx: Tx, orderId: string, itemId: string): Promise<string[]> {
  const resvs = await tx.stockReservation.findMany({ where: { orderId, status: "FULFILLED" }, select: { lotId: true }, distinct: ["lotId"] });
  const lotIds = resvs.map((r) => r.lotId).filter((l): l is string => !!l);
  if (lotIds.length === 0) return [];
  const lots = await tx.lot.findMany({ where: { id: { in: lotIds }, itemId }, select: { id: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  return lots.map((l) => l.id);
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

// ── Размещение: скан QR заказа + зарезервированной ячейки ISSUE + группы/партии. Перемещает всю
// CONTROL-часть партии в ячейку через ядро. Идемпотентно по (order, lot). ──
export async function placeOrderGroup(input: {
  companyId: string; userId: string; taskId: string; orderCode: string; cellCode: string; ean: string;
}): Promise<{ placed: boolean; alreadyPlaced: boolean }> {
  return prisma.$transaction(async (tx) => {
    await lockCompany(tx, input.companyId);
    const { order } = await requireIssueTask(tx, input.companyId, input.taskId, input.userId, TASK_TYPES.ISSUE_ORDER);
    const scannedOrderId = await resolveScannedOrder(tx, input.companyId, input.orderCode);
    if (scannedOrderId !== order.id) throw new OrderIssueError("Отсканирован не тот заказ");
    const cellId = await resolveScannedCell(tx, input.companyId, order.warehouseId, input.cellCode);
    const ic = await tx.orderIssueCell.findFirst({ where: { orderId: order.id, cellId, status: { not: "RELEASED" } } });
    if (!ic) throw new OrderIssueError("Эта ячейка не зарезервирована под заказ (сначала «Добавить ячейку»)");
    // Пакет 9B: товар по EAN. Сервер берёт ещё НЕ размещённую долю FULFILLED-резерва этого заказа для
    // данного товара (детерминированно, старейшая партия). Всё уже размещено → идемпотентный успех.
    const itemId = await eanItemIdInTx(tx, input.companyId, input.ean);
    if (!itemId) throw new OrderIssueError("Неизвестный, неактивный или чужой EAN — размещение отклонено");
    // партии этого товара, собранные заказом (FULFILLED), старейшая первой
    const lotIds = await orderFulfilledLotsForItem(tx, order.id, itemId);
    if (lotIds.length === 0) throw new OrderIssueError("Этот товар не собран для заказа");
    const placed = await tx.orderIssuePlacement.findMany({ where: { orderId: order.id, lotId: { in: lotIds } }, select: { lotId: true } });
    const placedSet = new Set(placed.map((p) => p.lotId));
    const lotId = lotIds.find((l) => !placedSet.has(l));
    if (!lotId) return { placed: true, alreadyPlaced: true }; // весь товар этого EAN уже размещён — идемпотентно
    const qty = await orderLotPickedQty(tx, order.id, lotId);
    if (qty.lte(0)) throw new OrderIssueError("Эта партия не собрана для заказа");
    await lockCell(tx, input.companyId, cellId);
    const zoneCtl = await controlZoneId(tx, input.companyId, order.warehouseId);
    // в общей зоне CONTROL должно быть не меньше доли ЗАКАЗА (чужие количества той же партии не трогаем)
    const bal = await tx.stockBalance.aggregate({ where: { lotId, locKey: `Z:${zoneCtl}`, qty: { gt: 0 } }, _sum: { qty: true } });
    if (D(bal._sum.qty ?? 0).lt(qty)) throw new OrderIssueError("В зоне контроля недостаточно остатка партии для заказа");
    await applyLotMovement(tx, {
      companyId: input.companyId, docType: "TRANSFER", docId: order.id, itemId, lotId, qty,
      from: { kind: "zone", warehouseId: order.warehouseId, zoneId: zoneCtl },
      to: { kind: "cell", warehouseId: order.warehouseId, cellId },
      createdById: input.userId,
    });
    await tx.orderIssuePlacement.create({ data: { companyId: input.companyId, issueCellId: ic.id, orderId: order.id, lotId, itemId, qty } });
    if (ic.status === "RESERVED") await tx.orderIssueCell.update({ where: { id: ic.id }, data: { status: "PLACED", placedAt: new Date() } });
    return { placed: true, alreadyPlaced: false };
  });
}

// ── «Добавить ячейку»: скан свободной ячейки ISSUE → бронь под заказ. Идемпотентно. ──
export async function addIssueCell(input: {
  companyId: string; userId: string; taskId: string; cellCode: string;
}): Promise<{ added: boolean; alreadyReserved: boolean }> {
  return prisma.$transaction(async (tx) => {
    await lockCompany(tx, input.companyId);
    const { order } = await requireIssueTask(tx, input.companyId, input.taskId, input.userId, TASK_TYPES.ISSUE_ORDER);
    const cellId = await resolveScannedCell(tx, input.companyId, order.warehouseId, input.cellCode);
    const cell = await tx.cell.findFirst({ where: { id: cellId, companyId: input.companyId }, include: { zone: true } });
    if (cell?.zone?.kind !== "ISSUE") throw new OrderIssueError("Это не ячейка зоны выдачи");
    await lockCell(tx, input.companyId, cellId);
    const occ = await tx.orderIssueCell.findFirst({ where: { cellId, status: { not: "RELEASED" } } });
    if (occ) {
      if (occ.orderId === order.id) return { added: true, alreadyReserved: true }; // уже под этот заказ
      throw new OrderIssueError("Ячейка занята другим заказом");
    }
    const [bal, unit] = await Promise.all([
      tx.stockBalance.findFirst({ where: { cellId, qty: { gt: 0 } }, select: { id: true } }),
      tx.itemUnit.findFirst({ where: { cellId }, select: { id: true } }),
    ]);
    if (bal || unit) throw new OrderIssueError("Ячейка не пуста");
    await tx.orderIssueCell.create({ data: { companyId: input.companyId, orderId: order.id, warehouseId: order.warehouseId, cellId, status: "RESERVED" } });
    return { added: true, alreadyReserved: false };
  });
}

// ── «Готово»: доступно только когда весь заказ перемещён из CONTROL. → READY_FOR_DRIVER + задача
// выдачи (DELIVER_ORDER, dueAt=arrivalAt). Идемпотентно. ──
export async function finishIssuePlacement(input: {
  companyId: string; userId: string; taskId: string;
}): Promise<{ ready: boolean; alreadyReady: boolean }> {
  const out = await prisma.$transaction(async (tx) => {
    await lockCompany(tx, input.companyId);
    const task = await tx.workflowTask.findFirst({ where: { id: input.taskId, companyId: input.companyId } });
    if (!task || task.type !== TASK_TYPES.ISSUE_ORDER) throw new OrderIssueError("Это не задача размещения");
    if (task.assignedUserId !== input.userId) throw new OrderIssueError("Это не ваша задача");
    const order = await tx.externalOrder.findFirst({ where: { id: task.subjectId ?? "", companyId: input.companyId } });
    if (!order) throw new OrderIssueError("Заказ не найден");
    if (task.status === "COMPLETED") return { alreadyReady: true, order, deliverTask: null as TaskCreateResult | null, unblocked: [] as { id: string; title: string; warehouseId: string }[] };
    if (task.status !== "IN_PROGRESS") throw new OrderIssueError("Задача размещения не в работе");
    const remaining = await orderControlRemaining(tx, order.id);
    if (remaining.gt(0)) throw new OrderIssueError("Не весь заказ перемещён из зоны контроля — разместите остаток");
    const placedCells = await tx.orderIssueCell.count({ where: { orderId: order.id, status: "PLACED" } });
    if (placedCells === 0) throw new OrderIssueError("Заказ ещё не размещён в ячейках выдачи");
    await tx.externalOrder.update({ where: { id: order.id }, data: { status: "READY_FOR_DRIVER" } });
    const unblocked = await completeWorkflowTaskInTransaction(tx, task.id);
    const deliverTask = await createWorkflowTaskInTx(tx, {
      companyId: input.companyId, warehouseId: order.warehouseId, type: TASK_TYPES.DELIVER_ORDER, requiredRole: "LOADER", priority: "NORMAL",
      title: `Выдать водителю: заказ ${order.externalId}`, subjectType: "externalOrder", subjectId: order.id,
      dedupeKey: `deliver:${order.id}`, loadUnits: 1, dueAt: order.arrivalAt ?? undefined,
    });
    return { alreadyReady: false, order, deliverTask, unblocked };
  });
  if (!out.alreadyReady) {
    await emitTaskCompleted({ companyId: input.companyId, warehouseId: out.order.warehouseId, title: "Размещение в выдаче завершено", taskId: input.taskId, unblocked: out.unblocked });
    if (out.deliverTask) await emitTaskCreated(out.deliverTask);
    await logEvent({ companyId: input.companyId, type: "order_ready_for_driver", title: "Заказ готов к выдаче", body: `Заказ ${out.order.externalId} размещён в ячейках выдачи`, url: "/warehouse/tasks", warehouseIds: [out.order.warehouseId], actorId: input.userId });
    await rebalanceQueuedTasks(input.companyId, { warehouseId: out.order.warehouseId });
  }
  return { ready: true, alreadyReady: out.alreadyReady };
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
  return {
    taskId: task.id, orderId: order.id, externalId: order.externalId,
    arrivalAt: order.arrivalAt ? order.arrivalAt.toISOString() : null,
    cells: cells.map((c) => ({ cell: nameByCell.get(c.cellId) ?? c.cellId, code: codeByCell.get(c.cellId) ?? null, status: c.status })),
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
