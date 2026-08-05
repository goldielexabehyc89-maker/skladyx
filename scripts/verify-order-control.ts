// Проверка Этапа 5/Пакет 7 (контроль заказа, исправление, полный повторный контроль). Движок
// напрямую (tsx + prisma). Только dev-БД; тест-данные удаляются в finally.
// Запуск: npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-order-control.ts
/* eslint-disable no-console */
process.env.ORDER_CONTROL_ENABLED = "true"; // хук в pickOrderScan создаёт CONTROL_ORDER при IN_CONTROL
import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { applyLotMovement } from "@/lib/stock";
import { ensureStandardZones, createCellsInZone } from "@/lib/cells";
import { createQrIn } from "@/lib/qr";
import { startWorkflowTask, rebalanceQueuedTasks } from "@/lib/workflow-tasks";
import { importExternalOrder, reserveAndPlanOrder, pickOrderScan } from "@/lib/external-orders";
import {
  scanOrderForControl,
  markOrderControlLine,
  finishOrderControl,
  completeOrderCorrection,
} from "@/lib/order-control";

const prisma = new PrismaClient();
let failures = 0;
const ok = (n: string, c: boolean, e = "") => (c ? console.log(`  ✓ ${n}`) : (failures++, console.error(`  ✗ ${n} ${e}`)));
const err = async (fn: () => Promise<unknown>) => { try { await fn(); return ""; } catch (e) { return (e as Error).message; } };

let companyId = "", demoId = "", W = "", DW = "";
let zStorage = "", zControl = "";
let itemA = "", itemB = "", pk = "", pk2 = "", ctl = "";
const UIDS: string[] = [];
let seq = 0;
const now = new Date();

const cellCode = async (cid: string) => (await prisma.qrCode.findFirstOrThrow({ where: { type: "CELL", refId: cid } })).code;
const groupCode = async (gid: string) => (await prisma.qrCode.findFirstOrThrow({ where: { type: "GROUP", refId: gid } })).code;
const cellId = async (code: string) => (await prisma.cell.findFirstOrThrow({ where: { warehouseId: W, code } })).id;
const orderStatus = async (orderId: string) => (await prisma.externalOrder.findUniqueOrThrow({ where: { id: orderId } })).status;
const controlTask = (orderId: string, status?: string) =>
  prisma.workflowTask.findFirst({ where: { type: "CONTROL_ORDER", subjectId: orderId, ...(status ? { status: status as never } : {}) }, orderBy: { createdAt: "desc" } });
const correctTask = (orderId: string) =>
  prisma.workflowTask.findFirst({ where: { type: "CORRECT_ORDER", subjectId: orderId }, orderBy: { createdAt: "desc" } });
const lotMv = async (lotId: string) => prisma.stockMovement.count({ where: { lotId } });

async function mkUser(id: string, cid: string, phone: string, role: Role, wh: string) {
  await prisma.user.deleteMany({ where: { id } });
  await prisma.user.create({ data: { id, companyId: cid, phone, name: id, role, isActive: true, allWarehouses: false, passwordHash: await bcrypt.hash("oc", 10), userRoles: { create: { role } }, warehouseLinks: { create: { warehouseId: wh } } } });
  UIDS.push(id);
  return id;
}
const mkShift = (userId: string, role: Role, wh: string) => prisma.workShift.create({ data: { companyId, userId, warehouseId: wh, role } });
const endShift = (userId: string) => prisma.workShift.updateMany({ where: { userId, endedAt: null }, data: { endedAt: new Date() } });

async function seedGroup(itemId: string, cid: string, qty: number): Promise<{ lotId: string; groupId: string }> {
  const number = 700000 + ++seq;
  const receipt = await prisma.receipt.create({ data: { companyId, number, warehouseId: W, status: "POSTED", postedAt: now, note: "OC seed", createdById: pk } });
  const line = await prisma.receiptLine.create({ data: { companyId, receiptId: receipt.id, itemId, qty } });
  const lot = await prisma.lot.create({ data: { companyId, itemId, receiptLineId: line.id, qtyReceived: qty, createdAt: new Date(now.getTime() - seq * 1000) } });
  await prisma.$transaction((tx) => applyLotMovement(tx, { companyId, docType: "RECEIPT", docId: receipt.id, itemId, lotId: lot.id, qty, from: null, to: { kind: "cell", warehouseId: W, cellId: cid }, createdById: pk }));
  const group = await prisma.handlingGroup.create({ data: { companyId, warehouseId: W, itemId, lotId: lot.id, qty, temperature: 0, thresholdX: 5, status: "IN_STORAGE", dedupeKey: `oc-seed-${seq}`, acceptedById: pk } });
  await prisma.$transaction((tx) => createQrIn(tx, { companyId, type: "GROUP", refId: group.id }));
  return { lotId: lot.id, groupId: group.id };
}

// импорт + сборка до IN_CONTROL. lines: [{externalLineId,itemId,requiredQty, cellId(seed)}]
async function pickToControl(externalId: string, lines: { externalLineId: string; itemId: string; qty: number; cell: string }[]): Promise<string> {
  for (const l of lines) await seedGroup(l.itemId, await cellId(l.cell), l.qty);
  const imp = await importExternalOrder({ companyId, warehouseId: W, externalId, createdById: pk, arrivalAt: null, lines: lines.map((l) => ({ externalLineId: l.externalLineId, itemId: l.itemId, requiredQty: l.qty })) });
  await reserveAndPlanOrder({ companyId, orderId: imp.orderId, userId: pk });
  let t = await prisma.workflowTask.findFirst({ where: { type: "PICK_ORDER", subjectId: imp.orderId } });
  if (t && t.status === "QUEUED") { await rebalanceQueuedTasks(companyId, { warehouseId: W }); t = await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } }); }
  const picker = t?.assignedUserId; // сборку ведёт ФАКТИЧЕСКИ назначенный сборщик (может быть pk или pk2)
  if (!t || !picker) throw new Error(`PICK не назначен сборщику (${t?.status})`);
  if (t.status === "ASSIGNED") await startWorkflowTask(picker, companyId, t.id);
  for (let i = 0; i < 50; i++) {
    const r = await prisma.stockReservation.findFirst({ where: { orderId: imp.orderId, status: "ACTIVE" } });
    if (!r) break;
    await pickOrderScan({ companyId, userId: picker, taskId: t.id, cellCode: await cellCode(r.cellId!), groupCode: await groupCode(r.handlingGroupId!), qty: r.qty.toNumber() });
  }
  return imp.orderId;
}
const orderQr = async (orderId: string) => (await prisma.qrCode.findFirstOrThrow({ where: { type: "ORDER", refId: orderId } })).code;
const pickerOf = async (orderId: string) => (await prisma.workflowTask.findFirstOrThrow({ where: { type: "PICK_ORDER", subjectId: orderId } })).assignedUserId;

// назначить и начать задачу контроля контролёром ctl
async function startControl(orderId: string): Promise<string> {
  let t = await controlTask(orderId);
  if (!t) throw new Error("нет задачи контроля");
  if (t.status === "QUEUED") { await rebalanceQueuedTasks(companyId, { warehouseId: W }); t = await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } }); }
  if (t.status === "ASSIGNED" && t.assignedUserId === ctl) await startWorkflowTask(ctl, companyId, t.id);
  return t.id;
}
const orderLines = (orderId: string) => prisma.externalOrderLine.findMany({ where: { orderId }, orderBy: { externalLineId: "asc" } });

async function provision() {
  companyId = (await prisma.company.findFirstOrThrow({ where: { slug: "rostagro" } })).id;
  W = (await prisma.warehouse.create({ data: { companyId, name: "OC W", isActive: true } })).id;
  await ensureStandardZones(companyId, W);
  zStorage = (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: W, kind: "STORAGE" } })).id;
  zControl = (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: W, kind: "CONTROL" } })).id;
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["OC-L1A", "OC-L1B", "OC-L1C", "OC-L1D", "OC-L1E", "OC-L1F"], level: 1 });
  const uom = await prisma.uom.create({ data: { companyId, name: "шт OC" } });
  itemA = (await prisma.item.create({ data: { companyId, name: "OC товар A", sku: "OC-A", uomId: uom.id, tracking: "LOT", isActive: true } })).id;
  itemB = (await prisma.item.create({ data: { companyId, name: "OC товар B", sku: "OC-B", uomId: uom.id, tracking: "LOT", isActive: true } })).id;
  pk = await mkUser("oc_pk", companyId, "+79995560001", "PICKER", W);
  pk2 = await mkUser("oc_pk2", companyId, "+79995560002", "PICKER", W);
  ctl = await mkUser("oc_ctl", companyId, "+79995560003", "CONTROLLER", W);
  await mkShift(pk, "PICKER", W);
  await mkShift(pk2, "PICKER", W);
  await mkShift(ctl, "CONTROLLER", W);
  // чужая организация: заказ с ORDER-QR (tenant-изоляция скана)
  const demo = await prisma.company.upsert({ where: { slug: "oc-demo" }, update: {}, create: { name: "OC Demo", slug: "oc-demo", settings: {} } });
  demoId = demo.id;
  DW = (await prisma.warehouse.create({ data: { companyId: demoId, name: "OC DW", isActive: true } })).id;
}

async function cleanup() {
  const orders = await prisma.externalOrder.findMany({ where: { companyId: { in: [companyId, demoId] }, warehouseId: { in: [W, DW] } }, select: { id: true } });
  const oids = orders.map((o) => o.id);
  await prisma.controlCheck.deleteMany({ where: { orderId: { in: oids } } }); // cascade lines
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
  if (demoId) await prisma.company.deleteMany({ where: { id: demoId, slug: "oc-demo" } });
  await prisma.uom.deleteMany({ where: { companyId, name: "шт OC" } });
}

async function main() {
  await provision();

  console.log("1) IN_CONTROL при флаге ON → авто-создание CONTROL_ORDER (CONTROLLER)");
  const o1 = await pickToControl("OC-1", [{ externalLineId: "1", itemId: itemA, qty: 5, cell: "OC-L1A" }]);
  const ct1 = await controlTask(o1);
  ok("[1] заказ IN_CONTROL", (await orderStatus(o1)) === "IN_CONTROL", await orderStatus(o1));
  ok("[1] CONTROL_ORDER создан, роль CONTROLLER, назначен контролёру", !!ct1 && ct1.requiredRole === "CONTROLLER" && ct1.assignedUserId === ctl, `${ct1?.status}/${ct1?.assignedUserId}`);
  const lot1 = (await prisma.handlingGroup.findFirstOrThrow({ where: { warehouseId: W, itemId: itemA } })).lotId;
  const mvBefore1 = await lotMv(lot1);

  console.log("2) старт контроля, скан QR заказа (идемпотентно), нельзя завершить неполную проверку");
  const t1 = await startControl(o1);
  const s1a = await scanOrderForControl({ companyId, userId: ctl, taskId: t1, orderCode: await orderQr(o1) });
  const s1b = await scanOrderForControl({ companyId, userId: ctl, taskId: t1, orderCode: await orderQr(o1) });
  ok("[2] повторный скан QR заказа идемпотентен (та же проверка)", s1a.checkId === s1b.checkId && s1b.alreadyStarted);
  const eIncomplete = await err(() => finishOrderControl({ companyId, userId: ctl, taskId: t1 }));
  ok("[2] нельзя завершить, пока не отмечены все строки", /Отметьте все строки/.test(eIncomplete), eIncomplete);

  console.log("3) happy path: отметить строку без расхождения → PASSED → CONTROL_PASSED, остаток не двигали");
  const l1 = (await orderLines(o1))[0];
  await markOrderControlLine({ companyId, userId: ctl, taskId: t1, lineId: l1.id, countedQty: 5 });
  const fin1 = await finishOrderControl({ companyId, userId: ctl, taskId: t1 });
  ok("[3] контроль PASSED", fin1.status === "PASSED");
  ok("[3] заказ CONTROL_PASSED", (await orderStatus(o1)) === "CONTROL_PASSED", await orderStatus(o1));
  ok("[3] задача контроля COMPLETED", (await controlTask(o1))?.status === "COMPLETED");
  ok("[3] контроль остаток НЕ двигал (движений столько же)", (await lotMv(lot1)) === mvBefore1);
  const finRepeat = await finishOrderControl({ companyId, userId: ctl, taskId: t1 });
  ok("[3] повторное завершение идемпотентно (тот же результат, без второго перехода)", finRepeat.alreadyFinished && finRepeat.status === "PASSED");
  ok("[3] задачи исправления нет (расхождений не было)", !(await correctTask(o1)));

  console.log("4) несколько расхождений → FAILED → CORRECTION_REQUIRED + CORRECT_ORDER первонач. сборщику");
  const o2 = await pickToControl("OC-2", [
    { externalLineId: "1", itemId: itemA, qty: 4, cell: "OC-L1B" },
    { externalLineId: "2", itemId: itemB, qty: 3, cell: "OC-L1C" },
  ]);
  const t2 = await startControl(o2);
  await scanOrderForControl({ companyId, userId: ctl, taskId: t2, orderCode: await orderQr(o2) });
  const [o2a, o2b] = await orderLines(o2);
  await markOrderControlLine({ companyId, userId: ctl, taskId: t2, lineId: o2a.id, countedQty: 3 }); // недостача
  await markOrderControlLine({ companyId, userId: ctl, taskId: t2, lineId: o2b.id, countedQty: 5 }); // излишек
  const fin2 = await finishOrderControl({ companyId, userId: ctl, taskId: t2 });
  ok("[4] контроль FAILED", fin2.status === "FAILED");
  ok("[4] заказ CORRECTION_REQUIRED", (await orderStatus(o2)) === "CORRECTION_REQUIRED", await orderStatus(o2));
  const corr2 = await correctTask(o2);
  ok("[4] CORRECT_ORDER создан (PICKER, срочный) и назначен первонач. сборщику", !!corr2 && corr2.requiredRole === "PICKER" && corr2.priority === "URGENT" && corr2.assignedUserId === pk, `${corr2?.assignedUserId}`);
  const chk2 = await prisma.controlCheck.findFirstOrThrow({ where: { orderId: o2, attempt: 1 } });
  const disc2 = await prisma.controlCheckLine.count({ where: { checkId: chk2.id, discrepancyType: { not: null } } });
  ok("[4] в проверке зафиксированы 2 расхождения (тип/строка/факт)", disc2 === 2, `disc=${disc2}`);

  console.log("5) исправление → полный повторный контроль (attempt 2); история попытки 1 сохранена");
  await startWorkflowTask(pk, companyId, corr2!.id);
  const mvBefore2 = await lotMv((await prisma.handlingGroup.findFirstOrThrow({ where: { warehouseId: W, itemId: itemA, lotId: { not: lot1 } } })).lotId);
  await completeOrderCorrection({ companyId, userId: pk, taskId: corr2!.id });
  ok("[5] CORRECT_ORDER COMPLETED", (await prisma.workflowTask.findUniqueOrThrow({ where: { id: corr2!.id } })).status === "COMPLETED");
  ok("[5] заказ снова IN_CONTROL", (await orderStatus(o2)) === "IN_CONTROL", await orderStatus(o2));
  const ct2new = await controlTask(o2, undefined);
  ok("[5] создана НОВАЯ задача контроля (полный повтор)", !!ct2new && ct2new.status !== "COMPLETED" && ct2new.id !== t2);
  ok("[5] исправление остаток НЕ двигало (движения только через ядро/инвентаризацию, вне модуля)", (await lotMv((await prisma.handlingGroup.findFirstOrThrow({ where: { warehouseId: W, itemId: itemA, lotId: { not: lot1 } } })).lotId)) === mvBefore2);
  // повторная полная проверка: все строки заново
  const t2b = await startControl(o2);
  const s2 = await scanOrderForControl({ companyId, userId: ctl, taskId: t2b, orderCode: await orderQr(o2) });
  const chk2bLines = await prisma.controlCheckLine.count({ where: { checkId: s2.checkId, countedQty: null } });
  ok("[5] повторная проверка НЕ засчитывает прежние строки (все не отмечены)", chk2bLines === 2, `unmarked=${chk2bLines}`);
  const [o2a2, o2b2] = await orderLines(o2);
  await markOrderControlLine({ companyId, userId: ctl, taskId: t2b, lineId: o2a2.id, countedQty: 4 });
  await markOrderControlLine({ companyId, userId: ctl, taskId: t2b, lineId: o2b2.id, countedQty: 3 });
  const fin2b = await finishOrderControl({ companyId, userId: ctl, taskId: t2b });
  ok("[5] повторный контроль PASSED → CONTROL_PASSED", fin2b.status === "PASSED" && (await orderStatus(o2)) === "CONTROL_PASSED");
  const checks2 = await prisma.controlCheck.findMany({ where: { orderId: o2 }, orderBy: { attempt: "asc" } });
  ok("[5] история: 2 проверки (attempt1 FAILED сохранена, attempt2 PASSED)", checks2.length === 2 && checks2[0].attempt === 1 && checks2[0].status === "FAILED" && checks2[1].status === "PASSED");

  console.log("6) tenant/warehouse/QR-изоляция скана");
  const o3 = await pickToControl("OC-3", [{ externalLineId: "1", itemId: itemA, qty: 2, cell: "OC-L1D" }]);
  const t3 = await startControl(o3);
  // чужой tenant: ORDER-QR другой организации
  const demoOrder = await prisma.externalOrder.create({ data: { companyId: demoId, warehouseId: DW, externalId: "OC-DEMO", status: "IN_CONTROL", payloadHash: "x", createdById: pk } });
  const demoQr = await prisma.$transaction((tx) => createQrIn(tx, { companyId: demoId, type: "ORDER", refId: demoOrder.id }));
  const eForeign = await err(() => scanOrderForControl({ companyId, userId: ctl, taskId: t3, orderCode: demoQr }));
  ok("[6] чужой tenant (ORDER-QR другой организации) — отказ", /этой организации/.test(eForeign), eForeign);
  // не тот заказ: ORDER-QR другого заказа этой организации
  const o2qr = await orderQr(o2);
  const eWrongOrder = await err(() => scanOrderForControl({ companyId, userId: ctl, taskId: t3, orderCode: o2qr }));
  ok("[6] не тот заказ — отказ", /не тот заказ/.test(eWrongOrder), eWrongOrder);
  // неверный QR
  const eBadQr = await err(() => scanOrderForControl({ companyId, userId: ctl, taskId: t3, orderCode: "ZZZZZZZZZZ" }));
  ok("[6] неверный QR заказа — отказ", eBadQr.length > 0, eBadQr);
  // чужая задача: скан контролёром pk (не назначен)
  const o3qr = await orderQr(o3);
  const eForeignTask = await err(() => scanOrderForControl({ companyId, userId: pk, taskId: t3, orderCode: o3qr }));
  ok("[6] чужой исполнитель — отказ", /не ваша задача/.test(eForeignTask), eForeignTask);
  // корректный скан o3 доводим до конца для чистоты
  await scanOrderForControl({ companyId, userId: ctl, taskId: t3, orderCode: o3qr });
  await markOrderControlLine({ companyId, userId: ctl, taskId: t3, lineId: (await orderLines(o3))[0].id, countedQty: 2 });
  await finishOrderControl({ companyId, userId: ctl, taskId: t3 });

  console.log("7) конкурентное завершение FAILED → ровно один переход и одна CORRECT_ORDER");
  const o4 = await pickToControl("OC-4", [{ externalLineId: "1", itemId: itemA, qty: 3, cell: "OC-L1E" }]);
  const t4 = await startControl(o4);
  await scanOrderForControl({ companyId, userId: ctl, taskId: t4, orderCode: await orderQr(o4) });
  await markOrderControlLine({ companyId, userId: ctl, taskId: t4, lineId: (await orderLines(o4))[0].id, countedQty: 1 }); // недостача
  const parFin = await Promise.allSettled([
    finishOrderControl({ companyId, userId: ctl, taskId: t4 }),
    finishOrderControl({ companyId, userId: ctl, taskId: t4 }),
  ]);
  ok("[7] оба вызова без исключений", parFin.every((r) => r.status === "fulfilled"));
  const corr4count = await prisma.workflowTask.count({ where: { type: "CORRECT_ORDER", subjectId: o4 } });
  ok("[7] создана ровно одна CORRECT_ORDER", corr4count === 1, `count=${corr4count}`);
  const chk4count = await prisma.controlCheck.count({ where: { orderId: o4 } });
  ok("[7] ровно одна проверка (без дублей)", chk4count === 1, `checks=${chk4count}`);

  console.log("8) fallback назначения: исходный сборщик не на смене → другому сборщику на смене");
  const o5 = await pickToControl("OC-5", [{ externalLineId: "1", itemId: itemA, qty: 2, cell: "OC-L1F" }]);
  const o5pk = await pickerOf(o5); // фактический сборщик o5 (pk или pk2)
  const t5 = await startControl(o5);
  await scanOrderForControl({ companyId, userId: ctl, taskId: t5, orderCode: await orderQr(o5) });
  await markOrderControlLine({ companyId, userId: ctl, taskId: t5, lineId: (await orderLines(o5))[0].id, countedQty: 1 });
  await endShift(o5pk!); // исходный сборщик o5 уходит со смены; второй сборщик остаётся на смене
  const other = o5pk === pk ? pk2 : pk;
  await finishOrderControl({ companyId, userId: ctl, taskId: t5 });
  const corr5 = await correctTask(o5);
  ok("[8] исходный сборщик не на смене → CORRECT_ORDER другому сборщику на смене", !!corr5 && corr5.assignedUserId === other && corr5.assignedUserId !== o5pk, `assignee=${corr5?.assignedUserId} orig=${o5pk}`);
  await mkShift(o5pk!, "PICKER", W); // вернуть смену исходного сборщика

  console.log("9) флаг OFF → CONTROL_ORDER не создаётся (поведение Пакета 6)");
  process.env.ORDER_CONTROL_ENABLED = "false";
  const o6 = await pickToControl("OC-6", [{ externalLineId: "1", itemId: itemA, qty: 2, cell: "OC-L1A" }]);
  ok("[9] заказ IN_CONTROL", (await orderStatus(o6)) === "IN_CONTROL");
  ok("[9] задача контроля НЕ создана при выключенном флаге", !(await controlTask(o6)));
  process.env.ORDER_CONTROL_ENABLED = "true";

  console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ P7 ПРОЙДЕНЫ ✓" : `\nПРОВАЛ: ${failures} проверок`);
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => {
    await cleanup().catch((e) => console.error("cleanup:", e));
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });
