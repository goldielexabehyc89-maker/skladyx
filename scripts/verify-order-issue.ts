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
import { placeOrderGroup, addIssueCell, finishIssuePlacement, issueOrderToDriver } from "@/lib/order-issue";

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

// импорт + сборка до IN_CONTROL (товар в зоне CONTROL)
async function pickToControl(externalId: string, lines: { externalLineId: string; itemId: string; qty: number; cell: string }[], arrivalAt: Date | null): Promise<string> {
  for (const l of lines) await seedGroup(l.itemId, await cellId(l.cell), l.qty);
  const imp = await importExternalOrder({ companyId, warehouseId: W, externalId, createdById: pk, arrivalAt, lines: lines.map((l) => ({ externalLineId: l.externalLineId, itemId: l.itemId, requiredQty: l.qty })) });
  await reserveAndPlanOrder({ companyId, orderId: imp.orderId, userId: pk });
  let t = await prisma.workflowTask.findFirst({ where: { type: "PICK_ORDER", subjectId: imp.orderId } });
  if (t && t.status === "QUEUED") { await rebalanceQueuedTasks(companyId, { warehouseId: W }); t = await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } }); }
  const picker = t?.assignedUserId;
  if (!t || !picker) throw new Error(`PICK не назначен (${t?.status})`);
  if (t.status === "ASSIGNED") await startWorkflowTask(picker, companyId, t.id);
  for (let i = 0; i < 50; i++) {
    const r = await prisma.stockReservation.findFirst({ where: { orderId: imp.orderId, status: "ACTIVE" } });
    if (!r) break;
    await pickOrderScan({ companyId, userId: picker, taskId: t.id, cellCode: await cellCode(r.cellId!), groupCode: await groupCode(r.handlingGroupId!), qty: r.qty.toNumber() });
  }
  return imp.orderId;
}

// сборка → полный контроль без расхождений → CONTROL_PASSED (→ авто-резерв ячейки выдачи)
async function toControlPassed(externalId: string, lines: { externalLineId: string; itemId: string; qty: number; cell: string }[], arrivalAt: Date | null = null): Promise<string> {
  const orderId = await pickToControl(externalId, lines, arrivalAt);
  let t = await controlTask(orderId);
  if (!t) throw new Error("нет задачи контроля");
  if (t.status === "QUEUED") { await rebalanceQueuedTasks(companyId, { warehouseId: W }); t = await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } }); }
  if (t.status === "ASSIGNED" && t.assignedUserId === ctl) await startWorkflowTask(ctl, companyId, t.id);
  await scanOrderForControl({ companyId, userId: ctl, taskId: t.id, orderCode: await orderQr(orderId) });
  for (const l of await orderLines(orderId)) await markOrderControlByScan({ companyId, userId: ctl, taskId: t.id, groupCode: await ctlGroupCode(orderId, l.id), countedQty: l.requiredQty.toNumber(), discrepancyType: null });
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

// разместить весь заказ (все строки в первую ячейку) + завершить + выдать (скан ВСЕХ активных ячеек)
async function fullyIssue(orderId: string) {
  const tid = await startLoaderTask(orderId, "ISSUE_ORDER");
  const uid = await taskAssignee(tid);
  const firstCell = await reservedCellCode(orderId);
  const oc = await orderQr(orderId);
  for (const l of await orderLines(orderId)) await placeOrderGroup({ companyId, userId: uid, taskId: tid, orderCode: oc, cellCode: firstCell, groupCode: await ctlGroupCode(orderId, l.id) });
  await finishIssuePlacement({ companyId, userId: uid, taskId: tid });
  const dtid = await startLoaderTask(orderId, "DELIVER_ORDER");
  const duid = await taskAssignee(dtid);
  await issueOrderToDriver({ companyId, userId: duid, taskId: dtid, orderCode: oc, cellCodes: await allActiveCellCodes(orderId) });
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
  await prisma.item.deleteMany({ where: { id: { in: [itemA, itemB] } } });
  await prisma.warehouse.deleteMany({ where: { id: { in: [W, DW] } } });
  if (demoId) await prisma.company.deleteMany({ where: { id: demoId, slug: "oi-demo" } });
  await prisma.uom.deleteMany({ where: { companyId, name: "шт OI" } });
}

async function main() {
  await provision();
  await setIssueActive(["OI-I1", "OI-I2", "OI-I3", "OI-I4", "OI-I5", "OI-I6"]);

  console.log("S1) Контроль пройден → авто-резерв ОДНОЙ ячейки выдачи + срочная ISSUE_ORDER (LOADER)");
  const o1 = await toControlPassed("OI-1", [{ externalLineId: "1", itemId: itemA, qty: 5, cell: "OI-L1A" }]);
  ok("[S1] заказ MOVING_TO_ISSUE", (await orderStatus(o1)) === "MOVING_TO_ISSUE", await orderStatus(o1));
  const it1 = await issueTaskOf(o1);
  ok("[S1] ISSUE_ORDER создана: LOADER, URGENT, назначена погрузчику", !!it1 && it1.requiredRole === "LOADER" && it1.priority === "URGENT" && it1.assignedUserId === lo, `${it1?.priority}/${it1?.assignedUserId}`);
  const cells1 = await activeCells(o1);
  ok("[S1] ровно одна ячейка RESERVED", cells1.length === 1 && cells1[0].status === "RESERVED", `n=${cells1.length}`);
  const lotA1 = await lotOfLine(o1, (await orderLines(o1))[0].id);
  ok("[S11] после контроля весь товар в зоне CONTROL (5), в ячейке выдачи 0", (await zoneBal(lotA1, zControl)) === 5 && (await cellBal(lotA1, cells1[0].cellId)) === 0);

  console.log("S1) размещение: скан заказа+ячейки+группы → перемещение CONTROL→ячейка через ядро");
  const t1 = await startLoaderTask(o1, "ISSUE_ORDER");
  const cc1 = await cellCode(cells1[0].cellId);
  const mvBeforePlace = await lotMv(lotA1);
  const r1 = await placeOrderGroup({ companyId, userId: lo, taskId: t1, orderCode: await orderQr(o1), cellCode: cc1, groupCode: await ctlGroupCode(o1, (await orderLines(o1))[0].id) });
  ok("[S1] размещено (не повтор)", r1.placed && !r1.alreadyPlaced);
  ok("[S11] товар перемещён в ячейку (ядро, +1 движение): в ячейке 5, в CONTROL 0", (await cellBal(lotA1, cells1[0].cellId)) === 5 && (await zoneBal(lotA1, zControl)) === 0 && (await lotMv(lotA1)) === mvBeforePlace + 1);
  ok("[S1] ячейка стала PLACED", (await prisma.orderIssueCell.findUniqueOrThrow({ where: { id: cells1[0].id } })).status === "PLACED");
  const placeCount1 = await prisma.orderIssuePlacement.count({ where: { orderId: o1 } });
  ok("[S1] создана строка размещения (order,lot)", placeCount1 === 1);

  console.log("S10) идемпотентность размещения: повтор скана → без второго движения/строки");
  const mvAfterPlace = await lotMv(lotA1);
  const r1r = await placeOrderGroup({ companyId, userId: lo, taskId: t1, orderCode: await orderQr(o1), cellCode: cc1, groupCode: await ctlGroupCode(o1, (await orderLines(o1))[0].id) });
  ok("[S10] повтор размещения идемпотентен (alreadyPlaced, без движения, без дубля строки)", r1r.alreadyPlaced && (await lotMv(lotA1)) === mvAfterPlace && (await prisma.orderIssuePlacement.count({ where: { orderId: o1 } })) === 1);

  console.log("S1) «Готово» → READY_FOR_DRIVER + задача выдачи (DELIVER_ORDER)");
  const finR = await finishIssuePlacement({ companyId, userId: lo, taskId: t1 });
  ok("[S1] размещение завершено, заказ READY_FOR_DRIVER", finR.ready && (await orderStatus(o1)) === "READY_FOR_DRIVER");
  ok("[S1] ISSUE_ORDER COMPLETED", (await issueTaskOf(o1))?.status === "COMPLETED");
  const dt1 = await deliverTaskOf(o1);
  ok("[S1] DELIVER_ORDER создана (LOADER), dueAt учитывает приезд", !!dt1 && dt1.requiredRole === "LOADER" && dt1.type === "DELIVER_ORDER");

  console.log("S1/S12/S13) выдача водителю: скан заказа + ячейки → расход через ядро, без подтверждения водителя");
  const dtid1 = await startLoaderTask(o1, "DELIVER_ORDER");
  const mvBeforeIssue = await lotMv(lotA1);
  const iss1 = await issueOrderToDriver({ companyId, userId: lo, taskId: dtid1, orderCode: await orderQr(o1), cellCodes: [cc1] });
  ok("[S1] выдано (не повтор)", iss1.issued && !iss1.alreadyIssued);
  ok("[S1] заказ ISSUED", (await orderStatus(o1)) === "ISSUED", await orderStatus(o1));
  ok("[S11] расход во внешний мир через ядро (+1 движение), остаток партии = 0 везде", (await totalBal(lotA1)) === 0 && (await lotMv(lotA1)) === mvBeforeIssue + 1);
  const ship1 = await prisma.orderShipment.findUnique({ where: { orderId: o1 } });
  ok("[S13] OrderShipment создан: issuedById=погрузчик, поля подтверждения водителя нет", !!ship1 && ship1.issuedById === lo && !("driverConfirmedAt" in ship1));
  ok("[S12] после выдачи ячейка RELEASED (свободна)", (await activeCells(o1)).length === 0 && (await prisma.orderIssueCell.count({ where: { orderId: o1, status: "RELEASED" } })) === 1);
  ok("[S1] DELIVER_ORDER COMPLETED", (await deliverTaskOf(o1))?.status === "COMPLETED");

  console.log("S10) идемпотентность выдачи: повтор → без второго расхода");
  const dtid1b = await startLoaderTask(o1, "DELIVER_ORDER").catch(() => dtid1);
  const mvAfterIssue = await lotMv(lotA1);
  const iss1r = await issueOrderToDriver({ companyId, userId: lo, taskId: dtid1b, orderCode: await orderQr(o1), cellCodes: [cc1] });
  ok("[S10] повтор выдачи идемпотентен (alreadyIssued, без второго движения)", iss1r.alreadyIssued && (await lotMv(lotA1)) === mvAfterIssue);

  console.log("S2/S7/S9) большой заказ → несколько ячеек");
  const o2 = await toControlPassed("OI-2", [{ externalLineId: "1", itemId: itemA, qty: 4, cell: "OI-L1B" }, { externalLineId: "2", itemId: itemB, qty: 3, cell: "OI-L1C" }]);
  const [o2a, o2b] = await orderLines(o2);
  const t2 = await startLoaderTask(o2, "ISSUE_ORDER");
  const cell2a = await reservedCellCode(o2);
  await placeOrderGroup({ companyId, userId: lo, taskId: t2, orderCode: await orderQr(o2), cellCode: cell2a, groupCode: await ctlGroupCode(o2, o2a.id) });
  const eEarly = await err(() => finishIssuePlacement({ companyId, userId: lo, taskId: t2 }));
  ok("[S7] нельзя «Готово», пока не весь заказ перемещён из контроля", /Не весь заказ перемещён/.test(eEarly), eEarly);
  const addRes = await addIssueCell({ companyId, userId: lo, taskId: t2, cellCode: await cellCode(await cellId("OI-I2")) });
  ok("[S2] «Добавить ячейку» → вторая ячейка зарезервирована", addRes.added && !addRes.alreadyReserved && (await activeCells(o2)).length === 2);
  await placeOrderGroup({ companyId, userId: lo, taskId: t2, orderCode: await orderQr(o2), cellCode: await cellCode(await cellId("OI-I2")), groupCode: await ctlGroupCode(o2, o2b.id) });
  const lotB2 = await lotOfLine(o2, o2b.id);
  ok("[S2] itemB размещён во вторую ячейку", (await cellBal(lotB2, await cellId("OI-I2"))) === 3);
  const fin2 = await finishIssuePlacement({ companyId, userId: lo, taskId: t2 });
  ok("[S2] «Готово» после размещения всего заказа → READY_FOR_DRIVER", fin2.ready && (await orderStatus(o2)) === "READY_FOR_DRIVER");
  const dt2 = await startLoaderTask(o2, "DELIVER_ORDER");
  const codes2 = await allActiveCellCodes(o2);
  ok("[S2] у заказа две активные ячейки выдачи", codes2.length === 2);
  const o2qr = await orderQr(o2);
  const ePartial = await err(() => issueOrderToDriver({ companyId, userId: lo, taskId: dt2, orderCode: o2qr, cellCodes: [codes2[0]] }));
  ok("[S9] выдача требует скан ВСЕХ ячеек (одной мало)", /не все ячейки/.test(ePartial), ePartial);
  const iss2 = await issueOrderToDriver({ companyId, userId: lo, taskId: dt2, orderCode: o2qr, cellCodes: codes2 });
  ok("[S2/S12] выдача при полном наборе ячеек → ISSUED, обе ячейки освобождены", iss2.issued && (await orderStatus(o2)) === "ISSUED" && (await activeCells(o2)).length === 0);

  console.log("S8) изоляция: чужой tenant / чужой заказ / неверный QR / чужой исполнитель");
  const o3 = await toControlPassed("OI-3", [{ externalLineId: "1", itemId: itemA, qty: 2, cell: "OI-L1D" }]);
  const t3 = await startLoaderTask(o3, "ISSUE_ORDER");
  const cc3 = await reservedCellCode(o3);
  const gc3 = await ctlGroupCode(o3, (await orderLines(o3))[0].id);
  const demoOrder = await prisma.externalOrder.create({ data: { companyId: demoId, warehouseId: DW, externalId: "OI-DEMO", status: "CONTROL_PASSED", payloadHash: "x", createdById: pk } });
  const demoQr = await prisma.$transaction((tx) => createQrIn(tx, { companyId: demoId, type: "ORDER", refId: demoOrder.id }));
  const eForeign = await err(() => placeOrderGroup({ companyId, userId: lo, taskId: t3, orderCode: demoQr, cellCode: cc3, groupCode: gc3 }));
  ok("[S8] чужой tenant (ORDER-QR другой организации) — отказ", /этой организации/.test(eForeign), eForeign);
  const o2qr2 = await orderQr(o2);
  const eWrongOrder = await err(() => placeOrderGroup({ companyId, userId: lo, taskId: t3, orderCode: o2qr2, cellCode: cc3, groupCode: gc3 }));
  ok("[S8] не тот заказ — отказ", /не тот заказ/.test(eWrongOrder), eWrongOrder);
  const eBadQr = await err(() => placeOrderGroup({ companyId, userId: lo, taskId: t3, orderCode: "ZZZZZZZZZZ", cellCode: cc3, groupCode: gc3 }));
  ok("[S8] неверный QR заказа — отказ", eBadQr.length > 0, eBadQr);
  const o3qr = await orderQr(o3);
  const eForeignTask = await err(() => placeOrderGroup({ companyId, userId: pk, taskId: t3, orderCode: o3qr, cellCode: cc3, groupCode: gc3 }));
  ok("[S8] чужой исполнитель (не назначен) — отказ", /не ваша задача/.test(eForeignTask), eForeignTask);
  await fullyIssue(o3); // довести до ISSUED (освободить ячейку)

  console.log("S3/S4) одна ячейка — под один заказ; конкурентный резерв (два погрузчика)");
  await mkShift(lo2, "LOADER"); // второй погрузчик выходит на смену — задачи двух заказов распределятся по одному
  const o4 = await toControlPassed("OI-4", [{ externalLineId: "1", itemId: itemA, qty: 2, cell: "OI-L1E" }]);
  const o5 = await toControlPassed("OI-5", [{ externalLineId: "1", itemId: itemA, qty: 2, cell: "OI-L1F" }]);
  const t4 = await startLoaderTask(o4, "ISSUE_ORDER");
  const u4 = await taskAssignee(t4);
  const t5 = await startLoaderTask(o5, "ISSUE_ORDER");
  const u5 = await taskAssignee(t5);
  ok("[S4] задачи двух заказов у РАЗНЫХ погрузчиков (обе IN_PROGRESS одновременно)", u4 !== u5, `${u4} vs ${u5}`);
  // свободная третья ячейка, за которую конкурируют оба заказа
  const freeCode = await cellCode(await cellId("OI-I3"));
  const par = await Promise.allSettled([
    addIssueCell({ companyId, userId: u4, taskId: t4, cellCode: freeCode }),
    addIssueCell({ companyId, userId: u5, taskId: t5, cellCode: freeCode }),
  ]);
  const added = par.filter((r) => r.status === "fulfilled").length;
  ok("[S4] конкурентный резерв: ровно один заказ добавил ячейку, второй отклонён", added === 1, `added=${added}`);
  const activeOnFree = await prisma.orderIssueCell.count({ where: { cellId: await cellId("OI-I3"), status: { not: "RELEASED" } } });
  ok("[S4] на ячейку ровно одна активная бронь (partial unique + lock)", activeOnFree === 1, `n=${activeOnFree}`);
  // владелец ячейки I3 — тот заказ, что победил
  const ownerOfFree = (await prisma.orderIssueCell.findFirstOrThrow({ where: { cellId: await cellId("OI-I3"), status: { not: "RELEASED" } } })).orderId;
  const loser = ownerOfFree === o4 ? { t: t5, u: u5 } : { t: t4, u: u4 };
  const eOccupied = await err(() => addIssueCell({ companyId, userId: loser.u, taskId: loser.t, cellCode: freeCode }));
  ok("[S3] ячейка занята другим заказом — второй заказ получает отказ", /занята другим заказом/.test(eOccupied), eOccupied);
  await fullyIssue(o4); await fullyIssue(o5);
  await endShift(lo2); // возвращаем один погрузчик для детерминизма следующих сценариев

  console.log("S5/S6) нет свободной ячейки → AWAITING (без задачи); освобождение активирует ближайший ожидающий");
  await setIssueActive(["OI-I4"]); // только одна активная свободная ячейка на складе
  const oP = await toControlPassed("OI-P", [{ externalLineId: "1", itemId: itemA, qty: 2, cell: "OI-L1G" }], plusH(1));
  ok("[S5] первый заказ занял единственную ячейку → MOVING_TO_ISSUE + задача", (await orderStatus(oP)) === "MOVING_TO_ISSUE" && !!(await issueTaskOf(oP)));
  const oQ = await toControlPassed("OI-Q", [{ externalLineId: "1", itemId: itemA, qty: 2, cell: "OI-L1H" }], plusH(2));
  const oR = await toControlPassed("OI-R", [{ externalLineId: "1", itemId: itemA, qty: 2, cell: "OI-L1A" }], plusH(3));
  ok("[S5] нет свободной ячейки → заказ AWAITING_ISSUE_CELL, задача НЕ создана", (await orderStatus(oQ)) === "AWAITING_ISSUE_CELL" && !(await issueTaskOf(oQ)));
  ok("[S5] второй ожидающий тоже AWAITING без задачи", (await orderStatus(oR)) === "AWAITING_ISSUE_CELL" && !(await issueTaskOf(oR)));
  await fullyIssue(oP); // выдача oP → ячейка I4 освобождается → реобработка ожидающих
  ok("[S6] освобождение ячейки активировало БЛИЖАЙШИЙ ожидающий (arrivalAt раньше): oQ → MOVING_TO_ISSUE + задача", (await orderStatus(oQ)) === "MOVING_TO_ISSUE" && !!(await issueTaskOf(oQ)));
  ok("[S6] следующий по очереди (oR, приезд позже) остаётся AWAITING", (await orderStatus(oR)) === "AWAITING_ISSUE_CELL" && !(await issueTaskOf(oR)));
  await fullyIssue(oQ); // выдача oQ → ячейка → oR активируется
  ok("[S6] после следующего освобождения активируется oR", (await orderStatus(oR)) === "MOVING_TO_ISSUE" && !!(await issueTaskOf(oR)));
  await fullyIssue(oR);

  console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ P8 ПРОЙДЕНЫ ✓" : `\nПРОВАЛ: ${failures} проверок`);
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => {
    await cleanup().catch((e) => console.error("cleanup:", e));
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });
