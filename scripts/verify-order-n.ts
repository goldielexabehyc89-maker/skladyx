// Задача N: упрощённый контроль (подтверждение строк кликом) + размещение ЦЕЛОГО заказа в назначенную
// ячейку выдачи (без EAN). Движок напрямую (tsx + prisma). Только dev-БД; тест-данные удаляются в finally.
// Запуск: WORKFLOW_TASKS_ENABLED=true EXTERNAL_ORDER_PICKING_ENABLED=true \
//   npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-order-n.ts
/* eslint-disable no-console */
process.env.ORDER_CONTROL_ENABLED = "true";
process.env.ORDER_ISSUE_ENABLED = "true";
import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { applyLotMovement } from "@/lib/stock";
import { ensureStandardZones, createCellsInZone } from "@/lib/cells";
import { createQrIn } from "@/lib/qr";
import { startWorkflowTask, rebalanceQueuedTasks } from "@/lib/workflow-tasks";
import { importExternalOrder, reserveAndPlanOrder, pickOrderScan } from "@/lib/external-orders";
import { scanOrderForControl, confirmControlLine, finishOrderControl } from "@/lib/order-control";
import { verifyIssueOrderScan, placeWholeOrderInIssueCell, getIssueOrderContext } from "@/lib/order-issue";

const prisma = new PrismaClient();
let failures = 0;
const ok = (n: string, c: boolean, e = "") => (c ? console.log(`  ✓ ${n}`) : (failures++, console.error(`  ✗ ${n} ${e}`)));
const err = async (fn: () => Promise<unknown>) => { try { await fn(); return ""; } catch (e) { return (e as Error).message; } };

let companyId = "", W = "", zControl = "", zIssue = "", zStorage = "";
let itemA = "", itemB = "", pk = "", ctl = "", lo = "";
const UIDS: string[] = [];
let seq = 0;
const now = new Date();

const cellCode = async (cid: string) => (await prisma.qrCode.findFirstOrThrow({ where: { type: "CELL", refId: cid } })).code;
const groupCode = async (gid: string) => (await prisma.qrCode.findFirstOrThrow({ where: { type: "GROUP", refId: gid } })).code;
const cellId = async (code: string) => (await prisma.cell.findFirstOrThrow({ where: { warehouseId: W, code } })).id;
const orderStatus = async (orderId: string) => (await prisma.externalOrder.findUniqueOrThrow({ where: { id: orderId } })).status;
const orderQr = async (orderId: string) => (await prisma.qrCode.findFirstOrThrow({ where: { type: "ORDER", refId: orderId } })).code;
const orderLines = (orderId: string) => prisma.externalOrderLine.findMany({ where: { orderId }, orderBy: { externalLineId: "asc" } });
const lotMv = async (lotId: string) => prisma.stockMovement.count({ where: { lotId } });
const controlTask = (orderId: string) => prisma.workflowTask.findFirst({ where: { type: "CONTROL_ORDER", subjectId: orderId }, orderBy: { createdAt: "desc" } });
const issueTaskOf = (orderId: string) => prisma.workflowTask.findFirst({ where: { type: "ISSUE_ORDER", subjectId: orderId }, orderBy: { createdAt: "desc" } });
const deliverTaskOf = (orderId: string) => prisma.workflowTask.findFirst({ where: { type: "DELIVER_ORDER", subjectId: orderId }, orderBy: { createdAt: "desc" } });
const activeCells = (orderId: string) => prisma.orderIssueCell.findMany({ where: { orderId, status: { not: "RELEASED" } }, orderBy: { reservedAt: "asc" } });
const lotOfLine = async (orderId: string, lineId: string) => (await prisma.stockReservation.findFirstOrThrow({ where: { orderId, lineId }, select: { lotId: true } })).lotId!;
const zoneBal = async (lotId: string, zoneId: string) => Number((await prisma.stockBalance.aggregate({ where: { lotId, locKey: `Z:${zoneId}`, qty: { gt: 0 } }, _sum: { qty: true } }))._sum.qty ?? 0);
const cellBal = async (lotId: string, cid: string) => Number((await prisma.stockBalance.aggregate({ where: { lotId, cellId: cid, qty: { gt: 0 } }, _sum: { qty: true } }))._sum.qty ?? 0);
const allMv = async () => prisma.stockMovement.count({ where: { OR: [{ fromWarehouseId: W }, { toWarehouseId: W }] } });

const itemEan = new Map<string, string>();
const eanOf = (itemId: string) => itemEan.get(itemId)!;
const groupEan = async (gid: string) => eanOf((await prisma.handlingGroup.findFirstOrThrow({ where: { id: gid } })).itemId);
function ean13(b12: string): string { let s = 0; for (let i = b12.length - 1, k = 0; i >= 0; i--, k++) s += Number(b12[i]) * (k % 2 === 0 ? 3 : 1); return b12 + String((10 - (s % 10)) % 10); }
async function seedEan(itemId: string, b12: string) { const code = ean13(b12); await prisma.itemBarcode.create({ data: { companyId, itemId, code, symbology: "EAN13", source: "MANUAL" } }); itemEan.set(itemId, code); }

async function mkUser(id: string, phone: string, role: Role) {
  await prisma.user.deleteMany({ where: { id } });
  await prisma.user.create({ data: { id, companyId, phone, name: id, role, isActive: true, allWarehouses: false, passwordHash: await bcrypt.hash("n", 10), userRoles: { create: { role } }, warehouseLinks: { create: { warehouseId: W } } } });
  UIDS.push(id);
  return id;
}
const mkShift = (userId: string, role: Role) => prisma.workShift.create({ data: { companyId, userId, warehouseId: W, role } });

async function seedGroup(itemId: string, cid: string, qty: number): Promise<string> {
  const number = 700000 + ++seq;
  const receipt = await prisma.receipt.create({ data: { companyId, number, warehouseId: W, status: "POSTED", postedAt: now, note: "N seed", createdById: pk } });
  const line = await prisma.receiptLine.create({ data: { companyId, receiptId: receipt.id, itemId, qty } });
  const lot = await prisma.lot.create({ data: { companyId, itemId, receiptLineId: line.id, qtyReceived: qty, createdAt: new Date(now.getTime() - seq * 1000) } });
  await prisma.$transaction((tx) => applyLotMovement(tx, { companyId, docType: "RECEIPT", docId: receipt.id, itemId, lotId: lot.id, qty, from: null, to: { kind: "cell", warehouseId: W, cellId: cid }, createdById: pk }));
  const group = await prisma.handlingGroup.create({ data: { companyId, warehouseId: W, itemId, lotId: lot.id, qty, temperature: 0, thresholdX: 5, status: "IN_STORAGE", dedupeKey: `n-seed-${seq}`, acceptedById: pk } });
  await prisma.$transaction((tx) => createQrIn(tx, { companyId, type: "GROUP", refId: group.id }));
  return lot.id;
}

// импорт + сборка до IN_CONTROL (товар в зоне CONTROL). seed=false → сток уже засеян (общая партия).
async function pickToControl(externalId: string, lines: { externalLineId: string; itemId: string; qty: number; cell: string }[], seed = true): Promise<string> {
  if (seed) for (const l of lines) await seedGroup(l.itemId, await cellId(l.cell), l.qty);
  const imp = await importExternalOrder({ companyId, warehouseId: W, externalId, createdById: pk, arrivalAt: null, lines: lines.map((l) => ({ externalLineId: l.externalLineId, itemId: l.itemId, requiredQty: l.qty })) });
  await reserveAndPlanOrder({ companyId, orderId: imp.orderId });
  let t = await prisma.workflowTask.findFirst({ where: { type: "PICK_ORDER", subjectId: imp.orderId } });
  if (t && t.status === "QUEUED") { await rebalanceQueuedTasks(companyId, { warehouseId: W }); t = await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } }); }
  const picker = t?.assignedUserId;
  if (!t || !picker) throw new Error(`PICK не назначен (${t?.status})`);
  if (t.status === "ASSIGNED") await startWorkflowTask(picker, companyId, t.id);
  for (let i = 0; i < 50; i++) {
    const r = await prisma.stockReservation.findFirst({ where: { orderId: imp.orderId, status: "ACTIVE" } });
    if (!r) break;
    await pickOrderScan({ companyId, userId: picker, taskId: t.id, cellCode: await cellCode(r.cellId!), ean: await groupEan(r.handlingGroupId!), qty: r.qty.toNumber() });
  }
  return imp.orderId;
}

// начать CONTROL_ORDER + сканировать QR заказа (без подтверждения строк)
async function startControlScan(orderId: string): Promise<string> {
  let t = await controlTask(orderId);
  if (!t) throw new Error("нет задачи контроля");
  if (t.status === "QUEUED") { await rebalanceQueuedTasks(companyId, { warehouseId: W }); t = await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } }); }
  if (t.status === "ASSIGNED" && t.assignedUserId === ctl) await startWorkflowTask(ctl, companyId, t.id);
  await scanOrderForControl({ companyId, userId: ctl, taskId: t.id, orderCode: await orderQr(orderId) });
  return t.id;
}

async function startLoaderTask(orderId: string, type: "ISSUE_ORDER"): Promise<string> {
  let t = await prisma.workflowTask.findFirst({ where: { type, subjectId: orderId, status: { not: "COMPLETED" } }, orderBy: { createdAt: "desc" } });
  if (!t) throw new Error(`нет задачи ${type} для ${orderId}`);
  if (t.status === "QUEUED") { await rebalanceQueuedTasks(companyId, { warehouseId: W }); t = await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } }); }
  if (t.status === "ASSIGNED" && t.assignedUserId) await startWorkflowTask(t.assignedUserId, companyId, t.id);
  return t.id;
}
const taskAssignee = async (taskId: string) => (await prisma.workflowTask.findUniqueOrThrow({ where: { id: taskId } })).assignedUserId!;

async function provision() {
  companyId = (await prisma.company.findFirstOrThrow({ where: { slug: "rostagro" } })).id;
  W = (await prisma.warehouse.create({ data: { companyId, name: "N W", isActive: true } })).id;
  await ensureStandardZones(companyId, W);
  zStorage = (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: W, kind: "STORAGE" } })).id;
  zControl = (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: W, kind: "CONTROL" } })).id;
  zIssue = (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: W, kind: "ISSUE" } })).id;
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["N-L1A", "N-L1B", "N-L1C", "N-L1D", "N-L1E"], level: 1 });
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zIssue, codes: ["N-I1", "N-I2", "N-I3", "N-I4", "N-I5", "N-I6"], level: null });
  const uom = await prisma.uom.create({ data: { companyId, name: "шт N" } });
  itemA = (await prisma.item.create({ data: { companyId, name: "N товар A", sku: "N-A", uomId: uom.id, tracking: "LOT", isActive: true } })).id;
  itemB = (await prisma.item.create({ data: { companyId, name: "N товар B", sku: "N-B", uomId: uom.id, tracking: "LOT", isActive: true } })).id;
  await seedEan(itemA, "460772000001");
  await seedEan(itemB, "460772000002");
  pk = await mkUser("n_pk", "+79995580001", "PICKER");
  ctl = await mkUser("n_ctl", "+79995580002", "CONTROLLER");
  lo = await mkUser("n_lo", "+79995580003", "LOADER");
  await mkShift(pk, "PICKER");
  await mkShift(ctl, "CONTROLLER");
  await mkShift(lo, "LOADER");
}

async function cleanup() {
  const orders = await prisma.externalOrder.findMany({ where: { companyId, warehouseId: W }, select: { id: true } });
  const oids = orders.map((o) => o.id);
  await prisma.orderShipment.deleteMany({ where: { orderId: { in: oids } } });
  await prisma.orderIssuePlacement.deleteMany({ where: { orderId: { in: oids } } });
  await prisma.orderIssueCell.deleteMany({ where: { orderId: { in: oids } } });
  await prisma.controlCheckLine.deleteMany({ where: { check: { orderId: { in: oids } } } });
  await prisma.controlCheck.deleteMany({ where: { orderId: { in: oids } } });
  await prisma.stockReservation.deleteMany({ where: { orderId: { in: oids } } });
  await prisma.externalOrderLine.deleteMany({ where: { orderId: { in: oids } } });
  await prisma.externalOrder.deleteMany({ where: { id: { in: oids } } });
  await prisma.cellReservation.deleteMany({ where: { warehouseId: W } });
  await prisma.workflowTask.deleteMany({ where: { warehouseId: W } });
  const groups = await prisma.handlingGroup.findMany({ where: { warehouseId: W }, select: { id: true, lotId: true } });
  const lotIds = groups.map((g) => g.lotId);
  await prisma.qrCode.deleteMany({ where: { type: "GROUP", refId: { in: groups.map((g) => g.id) } } });
  await prisma.qrCode.deleteMany({ where: { type: "ORDER", refId: { in: oids } } });
  await prisma.handlingGroup.deleteMany({ where: { warehouseId: W } });
  if (lotIds.length) {
    await prisma.stockMovement.deleteMany({ where: { lotId: { in: lotIds } } });
    await prisma.stockBalance.deleteMany({ where: { lotId: { in: lotIds } } });
    const rls = (await prisma.lot.findMany({ where: { id: { in: lotIds } }, select: { receiptLineId: true } })).map((l) => l.receiptLineId);
    await prisma.lot.deleteMany({ where: { id: { in: lotIds } } });
    const recs = [...new Set((await prisma.receiptLine.findMany({ where: { id: { in: rls } }, select: { receiptId: true } })).map((r) => r.receiptId))];
    await prisma.receiptLine.deleteMany({ where: { id: { in: rls } } });
    await prisma.receipt.deleteMany({ where: { id: { in: recs } } });
  }
  await prisma.workShift.deleteMany({ where: { userId: { in: UIDS } } });
  const cs = (await prisma.cell.findMany({ where: { warehouseId: W }, select: { id: true } })).map((c) => c.id);
  await prisma.qrCode.deleteMany({ where: { type: "CELL", refId: { in: cs } } });
  await prisma.cell.deleteMany({ where: { warehouseId: W } });
  await prisma.warehouseZone.deleteMany({ where: { warehouseId: W } });
  await prisma.user.deleteMany({ where: { id: { in: UIDS } } });
  await prisma.itemBarcode.deleteMany({ where: { itemId: { in: [itemA, itemB] } } });
  await prisma.item.deleteMany({ where: { id: { in: [itemA, itemB] } } });
  await prisma.warehouse.deleteMany({ where: { id: W } });
  await prisma.uom.deleteMany({ where: { companyId, name: "шт N" } });
}

async function main() {
  await provision();
  const _z = zStorage; void _z;

  // ── Часть 1: CONTROL_ORDER подтверждением строк кликом (без EAN/количества) ──
  console.log("N-C1) контроль подтверждением строк: клик подтверждает строку, завершение только после всех");
  const oc = await pickToControl("N-C1", [{ externalLineId: "1", itemId: itemA, qty: 5, cell: "N-L1A" }, { externalLineId: "2", itemId: itemB, qty: 3, cell: "N-L1B" }]);
  const ctid = await startControlScan(oc);
  const [l1, l2] = await orderLines(oc);
  const lotA = await lotOfLine(oc, l1.id), lotB = await lotOfLine(oc, l2.id);
  const ocMv = async () => (await lotMv(lotA)) + (await lotMv(lotB)); // движения только партий ЭТОГО заказа
  const mvC0 = await ocMv();
  // завершение недоступно, пока не подтверждены все строки
  const eEarly = await err(async () => finishOrderControl({ companyId, userId: ctl, taskId: ctid }));
  ok("[N-C1] завершение недоступно до подтверждения всех строк", /Отметьте все строки/.test(eEarly), eEarly);
  // подтверждаем первую строку кликом
  const r1 = await confirmControlLine({ companyId, userId: ctl, taskId: ctid, lineId: l1.id });
  ok("[N-C1] строка 1 подтверждена кликом (не повтор)", r1.alreadyConfirmed === false);
  const cl1 = await prisma.controlCheckLine.findFirstOrThrow({ where: { check: { taskId: ctid }, lineId: l1.id } });
  ok("[N-C1] countedQty = requiredQty, без расхождения", cl1.countedQty?.toString() === "5" && cl1.discrepancyType === null);
  // идемпотентный повтор
  const r1b = await confirmControlLine({ companyId, userId: ctl, taskId: ctid, lineId: l1.id });
  ok("[N-C1] повторное подтверждение идемпотентно", r1b.alreadyConfirmed === true);
  // всё ещё нельзя завершить (строка 2 не подтверждена)
  const eEarly2 = await err(async () => finishOrderControl({ companyId, userId: ctl, taskId: ctid }));
  ok("[N-C1] одна неподтверждённая строка блокирует завершение", /Отметьте все строки/.test(eEarly2), eEarly2);
  // чужая строка (строка другого заказа) отклоняется без изменений
  const ocOther = await pickToControl("N-COTHER", [{ externalLineId: "1", itemId: itemA, qty: 1, cell: "N-L1C" }]);
  const otherLine = (await orderLines(ocOther))[0];
  const eForeign = await err(async () => confirmControlLine({ companyId, userId: ctl, taskId: ctid, lineId: otherLine.id }));
  ok("[N-C1] чужая строка (другой заказ) отклонена без изменений", /не принадлежит этому заказу/.test(eForeign), eForeign);
  // задача другого сотрудника отклоняется
  const eWrongUser = await err(async () => confirmControlLine({ companyId, userId: pk, taskId: ctid, lineId: l2.id }));
  ok("[N-C1] задача другого сотрудника отклонена", /не ваша задача/.test(eWrongUser), eWrongUser);
  ok("[N-C1] подтверждение строк не создало движений остатка", (await ocMv()) === mvC0, `${mvC0}->${await ocMv()}`);
  // подтверждаем вторую → завершение доступно → PASSED
  await confirmControlLine({ companyId, userId: ctl, taskId: ctid, lineId: l2.id });
  const fin = await finishOrderControl({ companyId, userId: ctl, taskId: ctid });
  ok("[N-C1] после подтверждения всех строк контроль PASSED", fin.status === "PASSED");
  ok("[N-C1] заказ MOVING_TO_ISSUE (авто-резерв ячейки выдачи)", (await orderStatus(oc)) === "MOVING_TO_ISSUE", await orderStatus(oc));
  ok("[N-C1] контроль не двигал остаток (движений столько же)", (await ocMv()) === mvC0, `${mvC0}->${await ocMv()}`);

  // ── Часть 2: ISSUE_ORDER — размещение ЦЕЛОГО заказа в назначенную ячейку (без EAN) ──
  console.log("N-I1) размещение всего заказа (2 товара/партии) одним сканом ячейки → DELIVER_ORDER");
  const cells = await activeCells(oc);
  ok("[N-I1] заказу назначена ровно одна ячейка выдачи", cells.length === 1 && cells[0].status === "RESERVED", `n=${cells.length}`);
  const assignedCellId = cells[0].cellId;
  const assignedCode = await cellCode(assignedCellId); // QR-код для скана
  const assignedHuman = (await prisma.cell.findUniqueOrThrow({ where: { id: assignedCellId } })).code; // человекочитаемый код
  ok("[N-I1] до размещения весь товар в CONTROL (A=5,B=3), в ячейке 0", (await zoneBal(lotA, zControl)) === 5 && (await zoneBal(lotB, zControl)) === 3 && (await cellBal(lotA, assignedCellId)) === 0);
  const itid = await startLoaderTask(oc, "ISSUE_ORDER");
  // шаг 1: read-only проверка QR — неверный QR отклонён, БД не меняется
  const mvI0 = await allMv();
  const eWrongQr = await err(async () => verifyIssueOrderScan({ companyId, userId: lo, taskId: itid, orderCode: await orderQr(ocOther) }));
  ok("[N-I1] неверный QR (другой заказ) → отказ, немедленно", /не тот заказ/.test(eWrongQr), eWrongQr);
  ok("[N-I1] неверный QR не изменил БД (движений нет)", (await allMv()) === mvI0);
  const vok = await verifyIssueOrderScan({ companyId, userId: lo, taskId: itid, orderCode: await orderQr(oc) });
  ok("[N-I1] верный QR → ok + код назначенной ячейки", vok.ok === true && vok.cellCode === assignedHuman);
  ok("[N-I1] read-only проверка не изменила БД", (await allMv()) === mvI0);
  // шаг 2: чужая/неназначенная ячейка → ошибка без движения
  const eWrongCell = await err(async () => placeWholeOrderInIssueCell({ companyId, userId: lo, taskId: itid, orderCode: await orderQr(oc), cellCode: await cellCode(await cellId("N-I2")) }));
  ok("[N-I1] неназначенная ячейка → ошибка без движения", /не назначенн/i.test(eWrongCell) && (await allMv()) === mvI0, eWrongCell);
  // правильная назначенная ячейка → атомарно перемещает ВЕСЬ заказ (2 партии) + DELIVER
  const done = await placeWholeOrderInIssueCell({ companyId, userId: lo, taskId: itid, orderCode: await orderQr(oc), cellCode: assignedCode });
  ok("[N-I1] размещение выполнено (не повтор)", done.done && !done.alreadyDone);
  ok("[N-I1] обе партии перемещены в ячейку (A=5,B=3), CONTROL=0, +2 движения", (await cellBal(lotA, assignedCellId)) === 5 && (await cellBal(lotB, assignedCellId)) === 3 && (await zoneBal(lotA, zControl)) === 0 && (await zoneBal(lotB, zControl)) === 0 && (await allMv()) === mvI0 + 2);
  ok("[N-I1] две строки размещения (по партии)", (await prisma.orderIssuePlacement.count({ where: { orderId: oc } })) === 2);
  ok("[N-I1] ячейка PLACED", (await prisma.orderIssueCell.findUniqueOrThrow({ where: { id: cells[0].id } })).status === "PLACED");
  ok("[N-I1] заказ READY_FOR_DRIVER, ISSUE_ORDER COMPLETED", (await orderStatus(oc)) === "READY_FOR_DRIVER" && (await issueTaskOf(oc))?.status === "COMPLETED");
  ok("[N-I1] создана ровно одна DELIVER_ORDER (LOADER)", (await prisma.workflowTask.count({ where: { type: "DELIVER_ORDER", subjectId: oc } })) === 1 && (await deliverTaskOf(oc))?.requiredRole === "LOADER");

  console.log("N-I2) точный повтор размещения идемпотентен: без второго движения/placement/DELIVER");
  const mvRepeat = await allMv();
  const rep = await placeWholeOrderInIssueCell({ companyId, userId: lo, taskId: itid, orderCode: await orderQr(oc), cellCode: assignedCode });
  ok("[N-I2] повтор → alreadyDone, без движения, без второй строки/задачи", rep.alreadyDone && (await allMv()) === mvRepeat && (await prisma.orderIssuePlacement.count({ where: { orderId: oc } })) === 2 && (await prisma.workflowTask.count({ where: { type: "DELIVER_ORDER", subjectId: oc } })) === 1);

  console.log("N-I3) общая партия: перемещается только доля ЗАКАЗА, чужая доля не тронута");
  await prisma.stockBalance.count(); // no-op ensure connection
  const shLot = await seedGroup(itemA, await cellId("N-L1A"), 10);
  const oSA = await pickToControl("N-SH-A", [{ externalLineId: "1", itemId: itemA, qty: 4, cell: "N-L1A" }], false);
  const oSB = await pickToControl("N-SH-B", [{ externalLineId: "1", itemId: itemA, qty: 4, cell: "N-L1A" }], false);
  const saTid = await startControlScan(oSA); for (const l of await orderLines(oSA)) await confirmControlLine({ companyId, userId: ctl, taskId: saTid, lineId: l.id }); await finishOrderControl({ companyId, userId: ctl, taskId: saTid });
  const sbTid = await startControlScan(oSB); for (const l of await orderLines(oSB)) await confirmControlLine({ companyId, userId: ctl, taskId: sbTid, lineId: l.id }); await finishOrderControl({ companyId, userId: ctl, taskId: sbTid });
  ok("[N-I3] обе заявки собраны из одной партии, в CONTROL 8", (await lotOfLine(oSA, (await orderLines(oSA))[0].id)) === shLot && (await lotOfLine(oSB, (await orderLines(oSB))[0].id)) === shLot && (await zoneBal(shLot, zControl)) === 8);
  const saIt = await startLoaderTask(oSA, "ISSUE_ORDER"); const saUser = await taskAssignee(saIt);
  const saCellId = (await activeCells(oSA))[0].cellId; const saCode = await cellCode(saCellId);
  await placeWholeOrderInIssueCell({ companyId, userId: saUser, taskId: saIt, orderCode: await orderQr(oSA), cellCode: saCode });
  ok("[N-I3] A разместил РОВНО свою долю 4 (не 8)", (await cellBal(shLot, saCellId)) === 4);
  ok("[N-I3] доля B (4) в CONTROL не тронута", (await zoneBal(shLot, zControl)) === 4);
  const ctxB = await getIssueOrderContext(companyId, (await issueTaskOf(oSB))!.id);
  ok("[N-I3] B видит только свою долю (remaining=4), назначена своя ячейка", ctxB?.remainingInControl === "4" && !!ctxB?.assignedCellCode && ctxB?.assignedCellCode !== saCode);
  // довести B до размещения (освободить единственного погрузчика для следующего сценария)
  const sbIt = await startLoaderTask(oSB, "ISSUE_ORDER"); const sbUser = await taskAssignee(sbIt);
  await placeWholeOrderInIssueCell({ companyId, userId: sbUser, taskId: sbIt, orderCode: await orderQr(oSB), cellCode: await cellCode((await activeCells(oSB))[0].cellId) });

  console.log("N-I4) fail-closed: 0 или >1 назначенных ячеек — без движения");
  const oF = await pickToControl("N-FC", [{ externalLineId: "1", itemId: itemA, qty: 2, cell: "N-L1D" }]);
  const fTid = await startControlScan(oF); for (const l of await orderLines(oF)) await confirmControlLine({ companyId, userId: ctl, taskId: fTid, lineId: l.id }); await finishOrderControl({ companyId, userId: ctl, taskId: fTid });
  const fIt = await startLoaderTask(oF, "ISSUE_ORDER"); const fUser = await taskAssignee(fIt);
  const fCells = await activeCells(oF); const fCode = await cellCode(fCells[0].cellId);
  const lotF = await lotOfLine(oF, (await orderLines(oF))[0].id);
  const mvF0 = await allMv();
  // >1: добавим вторую активную ячейку вручную (симуляция аномалии) — на СВОБОДНОЙ ISSUE-ячейке
  const issueCellRows = await prisma.cell.findMany({ where: { warehouseId: W, zone: { kind: "ISSUE" } }, select: { id: true } });
  const activeCellIds = new Set((await prisma.orderIssueCell.findMany({ where: { status: { not: "RELEASED" } }, select: { cellId: true } })).map((c) => c.cellId));
  const extraCell = issueCellRows.find((c) => !activeCellIds.has(c.id))!.id;
  const extra = await prisma.orderIssueCell.create({ data: { companyId, orderId: oF, warehouseId: W, cellId: extraCell, status: "RESERVED" } });
  const eMulti = await err(async () => placeWholeOrderInIssueCell({ companyId, userId: fUser, taskId: fIt, orderCode: await orderQr(oF), cellCode: fCode }));
  ok("[N-I4] >1 назначенной ячейки → fail-closed без движения", /несколько ячеек/i.test(eMulti) && (await allMv()) === mvF0 && (await zoneBal(lotF, zControl)) === 2, eMulti);
  const vMulti = await err(async () => verifyIssueOrderScan({ companyId, userId: fUser, taskId: fIt, orderCode: await orderQr(oF) }));
  ok("[N-I4] read-only проверка тоже fail-closed при >1 ячейке", /несколько ячеек/i.test(vMulti), vMulti);
  await prisma.orderIssueCell.delete({ where: { id: extra.id } });
  // 0: снимем единственную ячейку (RELEASED)
  await prisma.orderIssueCell.updateMany({ where: { orderId: oF, status: { not: "RELEASED" } }, data: { status: "RELEASED", releasedAt: new Date() } });
  const eZero = await err(async () => placeWholeOrderInIssueCell({ companyId, userId: fUser, taskId: fIt, orderCode: await orderQr(oF), cellCode: fCode }));
  ok("[N-I4] 0 назначенных ячеек → fail-closed без движения", /не назначена ячейка/i.test(eZero) && (await allMv()) === mvF0 && (await zoneBal(lotF, zControl)) === 2, eZero);

  console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ N ПРОЙДЕНЫ ✓" : `\nПРОВАЛ: ${failures} проверок`);
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => {
    await cleanup().catch((e) => console.error("cleanup:", e));
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });
