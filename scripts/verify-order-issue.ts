// Проверка Этапа 5/Пакет 8 (размещение проверенного заказа в зоне выдачи + выдача водителю).
// Движок напрямую (tsx + prisma). Только dev-БД; тест-данные удаляются в finally.
// Запуск: npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-order-issue.ts
/* eslint-disable no-console */
process.env.ORDER_CONTROL_ENABLED = "true"; // хук pickOrderScan → CONTROL_ORDER при IN_CONTROL
process.env.ORDER_ISSUE_ENABLED = "true"; // хук finishOrderControl → авто-резерв ячейки выдачи
import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { applyLotMovement } from "@/lib/stock";
import { ensureStandardZones, createCellsInZone } from "@/lib/cells";
import { createQrIn } from "@/lib/qr";
import { startWorkflowTask, rebalanceQueuedTasks } from "@/lib/workflow-tasks";
import { importExternalOrder, reserveAndPlanOrder, pickOrderScan } from "@/lib/external-orders";
import { scanOrderForControl, markOrderControlByScan, finishOrderControl } from "@/lib/order-control";
import { verifyIssueOrderScan, placeWholeOrderInIssueCell, verifyDeliverOrderScan, deliverWholeOrder, getIssueOrderContext } from "@/lib/order-issue";
import { assertCellNotHeldByGroup, changeCellZone } from "@/lib/cells";

const prisma = new PrismaClient();
let failures = 0;
const ok = (n: string, c: boolean, e = "") => (c ? console.log(`  ✓ ${n}`) : (failures++, console.error(`  ✗ ${n} ${e}`)));
const err = async (fn: () => Promise<unknown>) => { try { await fn(); return ""; } catch (e) { return (e as Error).message; } };

let companyId = "", demoId = "", W = "", DW = "";
let zStorage = "", zControl = "", zIssue = "";
let itemA = "", itemB = "", pk = "", ctl = "", lo = "", lo2 = "";
const UIDS: string[] = [];
let seq = 0;
const now = new Date();
const plusH = (h: number) => new Date(now.getTime() + h * 3600_000);

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
const lotOfLine = async (orderId: string, lineId: string) =>
  (await prisma.stockReservation.findFirstOrThrow({ where: { orderId, lineId }, select: { lotId: true } })).lotId!;
const ctlGroupCode = async (orderId: string, lineId: string) =>
  groupCode((await prisma.stockReservation.findFirstOrThrow({ where: { orderId, lineId }, select: { handlingGroupId: true } })).handlingGroupId!);
const zoneBal = async (lotId: string, zoneId: string) =>
  Number((await prisma.stockBalance.aggregate({ where: { lotId, locKey: `Z:${zoneId}`, qty: { gt: 0 } }, _sum: { qty: true } }))._sum.qty ?? 0);
const cellBal = async (lotId: string, cid: string) =>
  Number((await prisma.stockBalance.aggregate({ where: { lotId, cellId: cid, qty: { gt: 0 } }, _sum: { qty: true } }))._sum.qty ?? 0);
const totalBal = async (lotId: string) =>
  Number((await prisma.stockBalance.aggregate({ where: { lotId, qty: { gt: 0 } }, _sum: { qty: true } }))._sum.qty ?? 0);

// Пакет 9B: EAN товара — товар сканируется по заводскому штрихкоду, группа выводится из контекста.
const itemEan = new Map<string, string>();
const eanOf = (itemId: string) => itemEan.get(itemId)!;
const lineEan = async (orderId: string, lineId: string) => eanOf((await prisma.externalOrderLine.findFirstOrThrow({ where: { id: lineId, orderId } })).itemId);
const groupEan = async (gid: string) => eanOf((await prisma.handlingGroup.findFirstOrThrow({ where: { id: gid } })).itemId);
function ean13(b12: string): string { let s = 0; for (let i = b12.length - 1, k = 0; i >= 0; i--, k++) s += Number(b12[i]) * (k % 2 === 0 ? 3 : 1); return b12 + String((10 - (s % 10)) % 10); }
async function seedEan(itemId: string, b12: string) { const code = ean13(b12); await prisma.itemBarcode.create({ data: { companyId, itemId, code, symbology: "EAN13", source: "MANUAL" } }); itemEan.set(itemId, code); }

async function mkUser(id: string, phone: string, role: Role) {
  await prisma.user.deleteMany({ where: { id } });
  await prisma.user.create({ data: { id, companyId, phone, name: id, role, isActive: true, allWarehouses: false, passwordHash: await bcrypt.hash("oi", 10), userRoles: { create: { role } }, warehouseLinks: { create: { warehouseId: W } } } });
  UIDS.push(id);
  return id;
}
const mkShift = (userId: string, role: Role) => prisma.workShift.create({ data: { companyId, userId, warehouseId: W, role } });
const endShift = (userId: string) => prisma.workShift.updateMany({ where: { userId, endedAt: null }, data: { endedAt: new Date() } });

async function seedGroup(itemId: string, cid: string, qty: number): Promise<string> {
  const number = 800000 + ++seq;
  const receipt = await prisma.receipt.create({ data: { companyId, number, warehouseId: W, status: "POSTED", postedAt: now, note: "OI seed", createdById: pk } });
  const line = await prisma.receiptLine.create({ data: { companyId, receiptId: receipt.id, itemId, qty } });
  const lot = await prisma.lot.create({ data: { companyId, itemId, receiptLineId: line.id, qtyReceived: qty, createdAt: new Date(now.getTime() - seq * 1000) } });
  await prisma.$transaction((tx) => applyLotMovement(tx, { companyId, docType: "RECEIPT", docId: receipt.id, itemId, lotId: lot.id, qty, from: null, to: { kind: "cell", warehouseId: W, cellId: cid }, createdById: pk }));
  const group = await prisma.handlingGroup.create({ data: { companyId, warehouseId: W, itemId, lotId: lot.id, qty, temperature: 0, thresholdX: 5, status: "IN_STORAGE", dedupeKey: `oi-seed-${seq}`, acceptedById: pk } });
  await prisma.$transaction((tx) => createQrIn(tx, { companyId, type: "GROUP", refId: group.id }));
  return lot.id;
}

// импорт + сборка до IN_CONTROL (товар в зоне CONTROL). seed=false → сток уже засеян (общая партия).
async function pickToControl(externalId: string, lines: { externalLineId: string; itemId: string; qty: number; cell: string }[], arrivalAt: Date | null, seed = true): Promise<string> {
  if (seed) for (const l of lines) await seedGroup(l.itemId, await cellId(l.cell), l.qty);
  const imp = await importExternalOrder({ companyId, warehouseId: W, externalId, createdById: pk, arrivalAt, lines: lines.map((l) => ({ externalLineId: l.externalLineId, itemId: l.itemId, requiredQty: l.qty })) });
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

// сборка → полный контроль без расхождений → CONTROL_PASSED (→ авто-резерв ячейки выдачи)
async function toControlPassed(externalId: string, lines: { externalLineId: string; itemId: string; qty: number; cell: string }[], arrivalAt: Date | null = null, seed = true): Promise<string> {
  const orderId = await pickToControl(externalId, lines, arrivalAt, seed);
  let t = await controlTask(orderId);
  if (!t) throw new Error("нет задачи контроля");
  if (t.status === "QUEUED") { await rebalanceQueuedTasks(companyId, { warehouseId: W }); t = await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } }); }
  if (t.status === "ASSIGNED" && t.assignedUserId === ctl) await startWorkflowTask(ctl, companyId, t.id);
  await scanOrderForControl({ companyId, userId: ctl, taskId: t.id, orderCode: await orderQr(orderId) });
  for (const l of await orderLines(orderId)) await markOrderControlByScan({ companyId, userId: ctl, taskId: t.id, ean: await lineEan(orderId, l.id), countedQty: l.requiredQty.toNumber(), discrepancyType: null });
  await finishOrderControl({ companyId, userId: ctl, taskId: t.id });
  return orderId;
}

// назначить+начать LOADER-задачу указанного типа её ФАКТИЧЕСКОМУ исполнителю (один погрузчик держит
// одну активную задачу — поэтому исполнителя берём из назначения, а не хардкодим)
async function startLoaderTask(orderId: string, type: "ISSUE_ORDER" | "DELIVER_ORDER"): Promise<string> {
  let t = await prisma.workflowTask.findFirst({ where: { type, subjectId: orderId, status: { not: "COMPLETED" } }, orderBy: { createdAt: "desc" } });
  if (!t) throw new Error(`нет задачи ${type} для ${orderId}`);
  if (t.status === "QUEUED") { await rebalanceQueuedTasks(companyId, { warehouseId: W }); t = await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } }); }
  if (t.status === "ASSIGNED" && t.assignedUserId) await startWorkflowTask(t.assignedUserId, companyId, t.id);
  return t.id;
}
const taskAssignee = async (taskId: string) => (await prisma.workflowTask.findUniqueOrThrow({ where: { id: taskId } })).assignedUserId!;

const reservedCellCode = async (orderId: string) => cellCode((await activeCells(orderId))[0].cellId);
const allActiveCellCodes = async (orderId: string) => Promise.all((await activeCells(orderId)).map((c) => cellCode(c.cellId)));

// ISSUE-002 v1: разместить ВЕСЬ заказ в назначенную ячейку (один скан) + выдать водителю.
async function fullyIssue(orderId: string) {
  const tid = await startLoaderTask(orderId, "ISSUE_ORDER");
  const uid = await taskAssignee(tid);
  const cell = await reservedCellCode(orderId);
  const oc = await orderQr(orderId);
  await placeWholeOrderInIssueCell({ companyId, userId: uid, taskId: tid, orderCode: oc, cellCode: cell });
  const dtid = await startLoaderTask(orderId, "DELIVER_ORDER");
  const duid = await taskAssignee(dtid);
  await deliverWholeOrder({ companyId, userId: duid, taskId: dtid, orderCode: oc, cellCode: await reservedCellCode(orderId) });
}
// только выдача (заказ уже размещён) — освобождает ячейку/погрузчика
async function deliverOrder(orderId: string) {
  const d = await startLoaderTask(orderId, "DELIVER_ORDER");
  const du = await taskAssignee(d);
  await deliverWholeOrder({ companyId, userId: du, taskId: d, orderCode: await orderQr(orderId), cellCode: await reservedCellCode(orderId) });
}

async function setIssueActive(activeCodes: string[]) {
  const cells = await prisma.cell.findMany({ where: { warehouseId: W, zone: { kind: "ISSUE" } }, select: { id: true, code: true } });
  for (const c of cells) await prisma.cell.update({ where: { id: c.id }, data: { isActive: activeCodes.includes(c.code) } });
}

async function provision() {
  companyId = (await prisma.company.findFirstOrThrow({ where: { slug: "rostagro" } })).id;
  W = (await prisma.warehouse.create({ data: { companyId, name: "OI W", isActive: true } })).id;
  await ensureStandardZones(companyId, W);
  zStorage = (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: W, kind: "STORAGE" } })).id;
  zControl = (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: W, kind: "CONTROL" } })).id;
  zIssue = (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: W, kind: "ISSUE" } })).id;
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["OI-L1A", "OI-L1B", "OI-L1C", "OI-L1D", "OI-L1E", "OI-L1F", "OI-L1G", "OI-L1H"], level: 1 });
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zIssue, codes: ["OI-I1", "OI-I2", "OI-I3", "OI-I4", "OI-I5", "OI-I6"], level: null });
  const uom = await prisma.uom.create({ data: { companyId, name: "шт OI" } });
  itemA = (await prisma.item.create({ data: { companyId, name: "OI товар A", sku: "OI-A", uomId: uom.id, tracking: "LOT", isActive: true } })).id;
  itemB = (await prisma.item.create({ data: { companyId, name: "OI товар B", sku: "OI-B", uomId: uom.id, tracking: "LOT", isActive: true } })).id;
  await seedEan(itemA, "460771000001");
  await seedEan(itemB, "460771000002");
  pk = await mkUser("oi_pk", "+79995570001", "PICKER");
  ctl = await mkUser("oi_ctl", "+79995570002", "CONTROLLER");
  lo = await mkUser("oi_lo", "+79995570003", "LOADER");
  lo2 = await mkUser("oi_lo2", "+79995570004", "LOADER"); // второй погрузчик для теста конкурентного резерва
  await mkShift(pk, "PICKER");
  await mkShift(ctl, "CONTROLLER");
  await mkShift(lo, "LOADER");
  const demo = await prisma.company.upsert({ where: { slug: "oi-demo" }, update: {}, create: { name: "OI Demo", slug: "oi-demo", settings: {} } });
  demoId = demo.id;
  DW = (await prisma.warehouse.create({ data: { companyId: demoId, name: "OI DW", isActive: true } })).id;
}

async function cleanup() {
  const orders = await prisma.externalOrder.findMany({ where: { companyId: { in: [companyId, demoId] }, warehouseId: { in: [W, DW] } }, select: { id: true } });
  const oids = orders.map((o) => o.id);
  await prisma.orderShipment.deleteMany({ where: { orderId: { in: oids } } });
  await prisma.orderIssuePlacement.deleteMany({ where: { orderId: { in: oids } } });
  await prisma.orderIssueCell.deleteMany({ where: { orderId: { in: oids } } });
  await prisma.controlCheck.deleteMany({ where: { orderId: { in: oids } } });
  await prisma.stockReservation.deleteMany({ where: { orderId: { in: oids } } });
  await prisma.externalOrder.deleteMany({ where: { id: { in: oids } } });
  await prisma.cellReservation.deleteMany({ where: { warehouseId: { in: [W, DW] } } });
  await prisma.workflowTask.deleteMany({ where: { warehouseId: { in: [W, DW] } } });
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
  await prisma.cell.deleteMany({ where: { warehouseId: { in: [W, DW] } } });
  await prisma.warehouseZone.deleteMany({ where: { warehouseId: { in: [W, DW] } } });
  await prisma.user.deleteMany({ where: { id: { in: UIDS } } });
  await prisma.itemBarcode.deleteMany({ where: { itemId: { in: [itemA, itemB] } } });
  await prisma.item.deleteMany({ where: { id: { in: [itemA, itemB] } } });
  await prisma.warehouse.deleteMany({ where: { id: { in: [W, DW] } } });
  if (demoId) await prisma.company.deleteMany({ where: { id: demoId, slug: "oi-demo" } });
  await prisma.uom.deleteMany({ where: { companyId, name: "шт OI" } });
}

async function main() {
  await provision();
  await setIssueActive(["OI-I1", "OI-I2", "OI-I3", "OI-I4", "OI-I5", "OI-I6"]);
  const humanCode = async (cid: string) => (await prisma.cell.findUniqueOrThrow({ where: { id: cid } })).code;

  console.log("S1) Контроль пройден → авто-резерв ОДНОЙ ячейки выдачи + срочная ISSUE_ORDER (LOADER)");
  const o1 = await toControlPassed("OI-1", [{ externalLineId: "1", itemId: itemA, qty: 5, cell: "OI-L1A" }]);
  ok("[S1] заказ MOVING_TO_ISSUE", (await orderStatus(o1)) === "MOVING_TO_ISSUE", await orderStatus(o1));
  const it1 = await issueTaskOf(o1);
  ok("[S1] ISSUE_ORDER создана: LOADER, URGENT, назначена", !!it1 && it1.requiredRole === "LOADER" && it1.priority === "URGENT" && !!it1.assignedUserId);
  const c1 = await activeCells(o1);
  ok("[S1] ровно одна ячейка RESERVED", c1.length === 1 && c1[0].status === "RESERVED", `n=${c1.length}`);
  const lotA1 = await lotOfLine(o1, (await orderLines(o1))[0].id);
  ok("[S1] весь товар в CONTROL (5), в ячейке 0", (await zoneBal(lotA1, zControl)) === 5 && (await cellBal(lotA1, c1[0].cellId)) === 0);

  const t1 = await startLoaderTask(o1, "ISSUE_ORDER"); const u1 = await taskAssignee(t1);
  const cc1 = await cellCode(c1[0].cellId); const o1qr = await orderQr(o1);

  console.log("S2) read-only проверка QR: неверный/чужой отклонён, верный → ok + код ячейки; БД не меняется");
  const mvV0 = await lotMv(lotA1);
  const eBadQr = await err(async () => verifyIssueOrderScan({ companyId, userId: u1, taskId: t1, orderCode: "ZZZZZZZZZZ" }));
  ok("[S2] неверный QR отклонён", eBadQr.length > 0, eBadQr);
  const demoOrder = await prisma.externalOrder.create({ data: { companyId: demoId, warehouseId: DW, externalId: "OI-DEMO", status: "CONTROL_PASSED", payloadHash: "x", createdById: pk } });
  const demoQr = await prisma.$transaction((tx) => createQrIn(tx, { companyId: demoId, type: "ORDER", refId: demoOrder.id }));
  const eForeignTenant = await err(async () => verifyIssueOrderScan({ companyId, userId: u1, taskId: t1, orderCode: demoQr }));
  ok("[S2] чужой tenant отклонён", /этой организации/.test(eForeignTenant), eForeignTenant);
  const otherOrd = await prisma.externalOrder.create({ data: { companyId, warehouseId: W, externalId: "OI-OTHER", status: "CONTROL_PASSED", payloadHash: "y", createdById: pk } });
  const otherQr = await prisma.$transaction((tx) => createQrIn(tx, { companyId, type: "ORDER", refId: otherOrd.id }));
  const eWrongOrder = await err(async () => verifyIssueOrderScan({ companyId, userId: u1, taskId: t1, orderCode: otherQr }));
  ok("[S2] не тот заказ отклонён", /не тот заказ/.test(eWrongOrder), eWrongOrder);
  const eForeignUser = await err(async () => verifyIssueOrderScan({ companyId, userId: pk, taskId: t1, orderCode: o1qr }));
  ok("[S2] чужой исполнитель отклонён", /не ваша задача/.test(eForeignUser), eForeignUser);
  const vok = await verifyIssueOrderScan({ companyId, userId: u1, taskId: t1, orderCode: o1qr });
  ok("[S2] верный QR → ok + код назначенной ячейки", vok.ok && vok.cellCode === (await humanCode(c1[0].cellId)));
  ok("[S2] проверка QR не создала движений", (await lotMv(lotA1)) === mvV0);

  console.log("S3) размещение всего заказа: скан назначенной ячейки → CONTROL→ячейка (ядро), +1 движение");
  const eWrongCell = await err(async () => placeWholeOrderInIssueCell({ companyId, userId: u1, taskId: t1, orderCode: o1qr, cellCode: await cellCode(await cellId("OI-I2")) }));
  ok("[S3] неназначенная ячейка → ошибка без движения", /не назначенн/i.test(eWrongCell) && (await lotMv(lotA1)) === mvV0, eWrongCell);
  const r1 = await placeWholeOrderInIssueCell({ companyId, userId: u1, taskId: t1, orderCode: o1qr, cellCode: cc1 });
  ok("[S3] размещено (не повтор)", r1.done && !r1.alreadyDone);
  ok("[S3] товар в ячейке 5, CONTROL 0, +1 движение", (await cellBal(lotA1, c1[0].cellId)) === 5 && (await zoneBal(lotA1, zControl)) === 0 && (await lotMv(lotA1)) === mvV0 + 1);
  ok("[S3] ячейка PLACED", (await prisma.orderIssueCell.findUniqueOrThrow({ where: { id: c1[0].id } })).status === "PLACED");
  ok("[S3] READY_FOR_DRIVER + ISSUE COMPLETED + ровно одна DELIVER_ORDER", (await orderStatus(o1)) === "READY_FOR_DRIVER" && (await issueTaskOf(o1))?.status === "COMPLETED" && (await prisma.workflowTask.count({ where: { type: "DELIVER_ORDER", subjectId: o1 } })) === 1);

  console.log("S5) точная идемпотентность ПОСЛЕ COMPLETED: проверка QR/ячейки, повтор без движения/DELIVER");
  const mvC0 = await lotMv(lotA1);
  const eIdemBadOrder = await err(async () => placeWholeOrderInIssueCell({ companyId, userId: u1, taskId: t1, orderCode: otherQr, cellCode: cc1 }));
  ok("[S5] неверный QR после COMPLETED → отказ (не тот заказ)", /не тот заказ/.test(eIdemBadOrder), eIdemBadOrder);
  const eIdemBadCell = await err(async () => placeWholeOrderInIssueCell({ companyId, userId: u1, taskId: t1, orderCode: o1qr, cellCode: await cellCode(await cellId("OI-I3")) }));
  ok("[S5] неверная ячейка после COMPLETED → отказ", /не та ячейка/.test(eIdemBadCell), eIdemBadCell);
  const rep = await placeWholeOrderInIssueCell({ companyId, userId: u1, taskId: t1, orderCode: o1qr, cellCode: cc1 });
  ok("[S5] точный повтор → alreadyDone, без второго движения/строки/DELIVER", rep.alreadyDone && (await lotMv(lotA1)) === mvC0 && (await prisma.orderIssuePlacement.count({ where: { orderId: o1 } })) === 1 && (await prisma.workflowTask.count({ where: { type: "DELIVER_ORDER", subjectId: o1 } })) === 1);

  console.log("S8) DELIVER v1: verify QR → ячейка → атомарная выдача; идемпотентность; неверный QR/ячейка");
  const dtid1 = await startLoaderTask(o1, "DELIVER_ORDER"); const du1 = await taskAssignee(dtid1);
  // read-only проверка QR: неверный/чужой отклонён, верный → ok + код ячейки; БД не меняется
  const mvV = await lotMv(lotA1);
  ok("[S8] DELIVER verify: неверный QR отклонён", (await err(async () => verifyDeliverOrderScan({ companyId, userId: du1, taskId: dtid1, orderCode: "ZZZZZZZZZZ" }))).length > 0);
  ok("[S8] DELIVER verify: не тот заказ отклонён", /не тот заказ/.test(await err(async () => verifyDeliverOrderScan({ companyId, userId: du1, taskId: dtid1, orderCode: otherQr }))));
  ok("[S8] DELIVER verify: чужой исполнитель отклонён", /не ваша задача/.test(await err(async () => verifyDeliverOrderScan({ companyId, userId: pk, taskId: dtid1, orderCode: o1qr }))));
  const vD = await verifyDeliverOrderScan({ companyId, userId: du1, taskId: dtid1, orderCode: o1qr });
  ok("[S8] DELIVER verify: верный QR → ok + код ячейки; БД не менялась", vD.ok && vD.cellCode === (await humanCode(c1[0].cellId)) && (await lotMv(lotA1)) === mvV);
  // неверная ячейка → отказ без движения
  ok("[S8] DELIVER: неверная ячейка → отказ без движения", /не та ячейка/.test(await err(async () => deliverWholeOrder({ companyId, userId: du1, taskId: dtid1, orderCode: o1qr, cellCode: await cellCode(await cellId("OI-I3")) }))) && (await lotMv(lotA1)) === mvV);
  const mvBI = await lotMv(lotA1);
  const iss1 = await deliverWholeOrder({ companyId, userId: du1, taskId: dtid1, orderCode: o1qr, cellCode: cc1 });
  ok("[S8] выдано, ISSUED, остаток 0, +1 движение (расход)", iss1.issued && (await orderStatus(o1)) === "ISSUED" && (await totalBal(lotA1)) === 0 && (await lotMv(lotA1)) === mvBI + 1);
  ok("[S8] ячейка RELEASED + shipment создан", (await activeCells(o1)).length === 0 && !!(await prisma.orderShipment.findUnique({ where: { orderId: o1 } })));
  const mvAI = await lotMv(lotA1);
  // точный повтор после выдачи → alreadyIssued без второго расхода; историческая ячейка (RELEASED)
  const iss1r = await deliverWholeOrder({ companyId, userId: du1, taskId: dtid1, orderCode: o1qr, cellCode: cc1 });
  ok("[S8] точный повтор выдачи → alreadyIssued без второго расхода", iss1r.alreadyIssued && (await lotMv(lotA1)) === mvAI);
  ok("[S8] неверный QR после выдачи → отказ (не повтор)", /не тот заказ/.test(await err(async () => deliverWholeOrder({ companyId, userId: du1, taskId: dtid1, orderCode: otherQr, cellCode: cc1 }))));
  ok("[S8] неверная ячейка после выдачи → отказ (не повтор)", /не та ячейка/.test(await err(async () => deliverWholeOrder({ companyId, userId: du1, taskId: dtid1, orderCode: o1qr, cellCode: await cellCode(await cellId("OI-I3")) }))));

  console.log("S13) точная идемпотентность ПОСЛЕ выдачи (OrderIssueCell RELEASED): историческая ячейка");
  ok("[S13] после выдачи ячейка RELEASED (нет активной)", (await activeCells(o1)).length === 0);
  const mvHist = await lotMv(lotA1); const placeHist = await prisma.orderIssuePlacement.count({ where: { orderId: o1 } });
  const repDel = await placeWholeOrderInIssueCell({ companyId, userId: u1, taskId: t1, orderCode: o1qr, cellCode: cc1 });
  ok("[S13] точный повтор после выдачи → alreadyDone без записей (движение/placement неизменны)", repDel.alreadyDone && (await lotMv(lotA1)) === mvHist && (await prisma.orderIssuePlacement.count({ where: { orderId: o1 } })) === placeHist);
  ok("[S13] неверный QR после выдачи → отказ", /не тот заказ/.test(await err(async () => placeWholeOrderInIssueCell({ companyId, userId: u1, taskId: t1, orderCode: otherQr, cellCode: cc1 }))));
  ok("[S13] неверная ячейка после выдачи → отказ", /не та ячейка/.test(await err(async () => placeWholeOrderInIssueCell({ companyId, userId: u1, taskId: t1, orderCode: o1qr, cellCode: await cellCode(await cellId("OI-I3")) }))));

  console.log("S4) многострочный заказ (2 партии) размещается ОДНИМ сканом ячейки (+2 движения)");
  const o4 = await toControlPassed("OI-4", [{ externalLineId: "1", itemId: itemA, qty: 4, cell: "OI-L1B" }, { externalLineId: "2", itemId: itemB, qty: 3, cell: "OI-L1C" }]);
  const [o4a, o4b] = await orderLines(o4);
  const t4 = await startLoaderTask(o4, "ISSUE_ORDER"); const u4 = await taskAssignee(t4);
  const c4 = (await activeCells(o4))[0]; const cc4 = await cellCode(c4.cellId);
  const lot4a = await lotOfLine(o4, o4a.id), lot4b = await lotOfLine(o4, o4b.id);
  const mv4 = (await lotMv(lot4a)) + (await lotMv(lot4b));
  await placeWholeOrderInIssueCell({ companyId, userId: u4, taskId: t4, orderCode: await orderQr(o4), cellCode: cc4 });
  ok("[S4] обе партии в ячейке (4,3), CONTROL 0, +2 движения, 2 placement", (await cellBal(lot4a, c4.cellId)) === 4 && (await cellBal(lot4b, c4.cellId)) === 3 && (await zoneBal(lot4a, zControl)) === 0 && (await zoneBal(lot4b, zControl)) === 0 && ((await lotMv(lot4a)) + (await lotMv(lot4b))) === mv4 + 2 && (await prisma.orderIssuePlacement.count({ where: { orderId: o4 } })) === 2);
  ok("[S4] READY_FOR_DRIVER + ровно одна DELIVER", (await orderStatus(o4)) === "READY_FOR_DRIVER" && (await prisma.workflowTask.count({ where: { type: "DELIVER_ORDER", subjectId: o4 } })) === 1);
  await deliverOrder(o4);

  console.log("S6) валидация назначенной ячейки: неактивна / перенесена в другую зону → fail-closed без движения");
  const o6 = await toControlPassed("OI-6", [{ externalLineId: "1", itemId: itemA, qty: 2, cell: "OI-L1D" }]);
  const t6 = await startLoaderTask(o6, "ISSUE_ORDER"); const u6 = await taskAssignee(t6);
  const ic6 = (await activeCells(o6))[0]; const cc6 = await cellCode(ic6.cellId); const o6qr = await orderQr(o6);
  const lot6 = await lotOfLine(o6, (await orderLines(o6))[0].id); const mv6 = await lotMv(lot6);
  await prisma.cell.update({ where: { id: ic6.cellId }, data: { isActive: false } });
  const eInactiveV = await err(async () => verifyIssueOrderScan({ companyId, userId: u6, taskId: t6, orderCode: o6qr }));
  ok("[S6] неактивная ячейка → verify fail-closed (без зелёного)", /недоступна/.test(eInactiveV), eInactiveV);
  const eInactiveP = await err(async () => placeWholeOrderInIssueCell({ companyId, userId: u6, taskId: t6, orderCode: o6qr, cellCode: cc6 }));
  ok("[S6] неактивная ячейка → place fail-closed без движения", /недоступна/.test(eInactiveP) && (await lotMv(lot6)) === mv6, eInactiveP);
  await prisma.cell.update({ where: { id: ic6.cellId }, data: { isActive: true } });
  await prisma.cell.update({ where: { id: ic6.cellId }, data: { zoneId: zStorage } });
  const eZoneV = await err(async () => verifyIssueOrderScan({ companyId, userId: u6, taskId: t6, orderCode: o6qr }));
  ok("[S6] перенос в другую зону → verify fail-closed", /не в зоне выдачи/.test(eZoneV), eZoneV);
  const eZoneP = await err(async () => placeWholeOrderInIssueCell({ companyId, userId: u6, taskId: t6, orderCode: o6qr, cellCode: cc6 }));
  ok("[S6] перенос в другую зону → place fail-closed без движения", /не в зоне выдачи/.test(eZoneP) && (await lotMv(lot6)) === mv6, eZoneP);
  await prisma.cell.update({ where: { id: ic6.cellId }, data: { zoneId: zIssue } });
  await placeWholeOrderInIssueCell({ companyId, userId: u6, taskId: t6, orderCode: o6qr, cellCode: cc6 });
  ok("[S6] после восстановления ячейки размещение выполнено", (await orderStatus(o6)) === "READY_FOR_DRIVER");
  await deliverOrder(o6);

  console.log("S7) fail-closed: 0 или >1 назначенных ячеек — без движения");
  const o7 = await toControlPassed("OI-7", [{ externalLineId: "1", itemId: itemA, qty: 2, cell: "OI-L1E" }]);
  const t7 = await startLoaderTask(o7, "ISSUE_ORDER"); const u7 = await taskAssignee(t7);
  const ic7 = (await activeCells(o7))[0]; const cc7 = await cellCode(ic7.cellId); const o7qr = await orderQr(o7);
  const lot7 = await lotOfLine(o7, (await orderLines(o7))[0].id); const mv7 = await lotMv(lot7);
  const freeIssue = await prisma.cell.findMany({ where: { warehouseId: W, zone: { kind: "ISSUE" } }, select: { id: true } });
  const activeSet = new Set((await prisma.orderIssueCell.findMany({ where: { status: { not: "RELEASED" } }, select: { cellId: true } })).map((c) => c.cellId));
  const spare = freeIssue.find((c) => !activeSet.has(c.id))!.id;
  const extra = await prisma.orderIssueCell.create({ data: { companyId, orderId: o7, warehouseId: W, cellId: spare, status: "RESERVED" } });
  const eMulti = await err(async () => placeWholeOrderInIssueCell({ companyId, userId: u7, taskId: t7, orderCode: o7qr, cellCode: cc7 }));
  ok("[S7] >1 ячейки → fail-closed без движения", /несколько ячеек/i.test(eMulti) && (await lotMv(lot7)) === mv7, eMulti);
  await prisma.orderIssueCell.delete({ where: { id: extra.id } });
  await prisma.orderIssueCell.updateMany({ where: { orderId: o7, status: { not: "RELEASED" } }, data: { status: "RELEASED", releasedAt: new Date() } });
  const eZero = await err(async () => placeWholeOrderInIssueCell({ companyId, userId: u7, taskId: t7, orderCode: o7qr, cellCode: cc7 }));
  ok("[S7] 0 ячеек → fail-closed без движения", /не назначена ячейка/i.test(eZero) && (await lotMv(lot7)) === mv7, eZero);
  // восстановить o7 в размещаемое состояние и довести (иначе задача остаётся IN_PROGRESS у погрузчика)
  const activeSet2 = new Set((await prisma.orderIssueCell.findMany({ where: { status: { not: "RELEASED" } }, select: { cellId: true } })).map((c) => c.cellId));
  const spare2 = freeIssue.find((c) => !activeSet2.has(c.id))!.id;
  await prisma.orderIssueCell.create({ data: { companyId, orderId: o7, warehouseId: W, cellId: spare2, status: "RESERVED" } });
  await placeWholeOrderInIssueCell({ companyId, userId: u7, taskId: t7, orderCode: o7qr, cellCode: await cellCode(spare2) });
  await deliverOrder(o7);

  console.log("S9) общая партия в CONTROL: перемещается только доля ЗАКАЗА (чужая доля цела)");
  const shLot = await seedGroup(itemA, await cellId("OI-L1A"), 10);
  const oSA = await toControlPassed("OI-SH-A", [{ externalLineId: "1", itemId: itemA, qty: 4, cell: "OI-L1A" }], null, false);
  const oSB = await toControlPassed("OI-SH-B", [{ externalLineId: "1", itemId: itemA, qty: 4, cell: "OI-L1A" }], null, false);
  ok("[S9] обе заявки из ОДНОЙ партии, в CONTROL 8", (await lotOfLine(oSA, (await orderLines(oSA))[0].id)) === shLot && (await zoneBal(shLot, zControl)) === 8);
  const tSA = await startLoaderTask(oSA, "ISSUE_ORDER"); const uSA = await taskAssignee(tSA);
  const cSA = (await activeCells(oSA))[0].cellId; const ccSA = await cellCode(cSA);
  await placeWholeOrderInIssueCell({ companyId, userId: uSA, taskId: tSA, orderCode: await orderQr(oSA), cellCode: ccSA });
  ok("[S9] A разместил РОВНО долю 4 (не 8), доля B (4) в CONTROL цела", (await cellBal(shLot, cSA)) === 4 && (await zoneBal(shLot, zControl)) === 4);
  const ctxB = await getIssueOrderContext(companyId, (await issueTaskOf(oSB))!.id);
  ok("[S9] B видит только свою долю (remaining=4), назначена своя ячейка", ctxB?.remainingInControl === "4" && !!ctxB?.assignedCellCode);
  // разместить B (его ISSUE — URGENT, погрузчик свободен после завершения A) — сначала оба размещения,
  // затем обе выдачи: срочный ISSUE не блокирует старт обычной DELIVER, когда оба ISSUE завершены.
  const tSB = await startLoaderTask(oSB, "ISSUE_ORDER"); const uSB = await taskAssignee(tSB);
  await placeWholeOrderInIssueCell({ companyId, userId: uSB, taskId: tSB, orderCode: await orderQr(oSB), cellCode: await cellCode((await activeCells(oSB))[0].cellId) });
  await deliverOrder(oSA); await deliverOrder(oSB);
  ok("[S9] выдано ровно 8 (по 4), в CONTROL 0, остаток партии 2 (незаказанное)", (await zoneBal(shLot, zControl)) === 0 && (await totalBal(shLot)) === 2);

  console.log("S10) нет свободной ячейки → AWAITING (без задачи); освобождение активирует ближайший ожидающий");
  await setIssueActive(["OI-I4"]);
  const oP = await toControlPassed("OI-P", [{ externalLineId: "1", itemId: itemA, qty: 2, cell: "OI-L1F" }], plusH(1));
  ok("[S10] первый занял единственную ячейку → MOVING_TO_ISSUE + задача", (await orderStatus(oP)) === "MOVING_TO_ISSUE" && !!(await issueTaskOf(oP)));
  const oQ = await toControlPassed("OI-Q", [{ externalLineId: "1", itemId: itemA, qty: 2, cell: "OI-L1G" }], plusH(2));
  ok("[S10] нет свободной ячейки → AWAITING_ISSUE_CELL, задача НЕ создана", (await orderStatus(oQ)) === "AWAITING_ISSUE_CELL" && !(await issueTaskOf(oQ)));
  await fullyIssue(oP);
  ok("[S10] освобождение активировало ожидающий oQ → MOVING_TO_ISSUE + задача", (await orderStatus(oQ)) === "MOVING_TO_ISSUE" && !!(await issueTaskOf(oQ)));
  await fullyIssue(oQ);

  console.log("S11) изоляция размещения: чужой tenant / не тот заказ / неверный QR / чужой исполнитель");
  await setIssueActive(["OI-I1", "OI-I2", "OI-I3", "OI-I4", "OI-I5", "OI-I6"]);
  const o11 = await toControlPassed("OI-11", [{ externalLineId: "1", itemId: itemA, qty: 2, cell: "OI-L1H" }]);
  const t11 = await startLoaderTask(o11, "ISSUE_ORDER"); const u11 = await taskAssignee(t11);
  const cc11 = await cellCode((await activeCells(o11))[0].cellId); const o11qr = await orderQr(o11);
  ok("[S11] чужой tenant отклонён", /этой организации/.test(await err(async () => placeWholeOrderInIssueCell({ companyId, userId: u11, taskId: t11, orderCode: demoQr, cellCode: cc11 }))));
  ok("[S11] не тот заказ отклонён", /не тот заказ/.test(await err(async () => placeWholeOrderInIssueCell({ companyId, userId: u11, taskId: t11, orderCode: otherQr, cellCode: cc11 }))));
  ok("[S11] неверный QR отклонён", (await err(async () => placeWholeOrderInIssueCell({ companyId, userId: u11, taskId: t11, orderCode: "ZZZZZZZZZZ", cellCode: cc11 }))).length > 0);
  ok("[S11] чужой исполнитель отклонён", /не ваша задача/.test(await err(async () => placeWholeOrderInIssueCell({ companyId, userId: pk, taskId: t11, orderCode: o11qr, cellCode: cc11 }))));
  await placeWholeOrderInIssueCell({ companyId, userId: u11, taskId: t11, orderCode: o11qr, cellCode: cc11 });
  await deliverOrder(o11);

  console.log("S12) changeCellZone: RESERVED под ISSUE ячейку переносить нельзя (последовательно и конкурентно)");
  const o12 = await toControlPassed("OI-12", [{ externalLineId: "1", itemId: itemA, qty: 2, cell: "OI-L1B" }]);
  const ic12 = (await activeCells(o12))[0]; const o12qr = await orderQr(o12);
  const cc12 = await cellCode(ic12.cellId); const lot12 = await lotOfLine(o12, (await orderLines(o12))[0].id);
  // последовательно: ячейка RESERVED под ISSUE_ORDER → changeCellZone отклоняется, зона не меняется
  const eSeq = await err(async () => changeCellZone({ companyId, cellId: ic12.cellId, zoneId: zStorage, level: 1 }));
  ok("[S12] RESERVED под ISSUE → changeCellZone отклонён", /занятой или зарезервированной/.test(eSeq), eSeq);
  ok("[S12] ячейка осталась в зоне ISSUE", (await prisma.cell.findUniqueOrThrow({ where: { id: ic12.cellId } })).zoneId === zIssue);
  // конкурентно: параллельные changeCellZone / placeWholeOrder не позволяют переместить товар в ячейку,
  // переставшую быть ISSUE (общий lockCell + cellOccupied). changeCellZone всегда отклоняется.
  const t12 = await startLoaderTask(o12, "ISSUE_ORDER"); const u12 = await taskAssignee(t12);
  const par = await Promise.allSettled([
    changeCellZone({ companyId, cellId: ic12.cellId, zoneId: zStorage, level: 1 }),
    placeWholeOrderInIssueCell({ companyId, userId: u12, taskId: t12, orderCode: o12qr, cellCode: cc12 }),
  ]);
  ok("[S12] параллельно: changeCellZone отклонён, размещение выполнено", par[0].status === "rejected" && par[1].status === "fulfilled", `${par[0].status}/${par[1].status}`);
  ok("[S12] инвариант: товар в ячейке И ячейка осталась ISSUE (не перенесена в STORAGE)", (await cellBal(lot12, ic12.cellId)) === 2 && (await prisma.cell.findUniqueOrThrow({ where: { id: ic12.cellId } })).zoneId === zIssue);
  await deliverOrder(o12);

  console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ P8 (v1) ПРОЙДЕНЫ ✓" : `\nПРОВАЛ: ${failures} проверок`);
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => {
    await cleanup().catch((e) => console.error("cleanup:", e));
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });
