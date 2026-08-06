// Проверка Этапа 5/Пакет 6 (внешние заказы, FIFO-резерв, перестановка, сборка). Движок напрямую
// (tsx + prisma). Только dev-БД; тест-данные удаляются в finally.
// Запуск: npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-external-orders.ts
/* eslint-disable no-console */
import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { applyLotMovement } from "@/lib/stock";
import { ensureStandardZones, createCellsInZone } from "@/lib/cells";
import { createQrIn } from "@/lib/qr";
import { startWorkflowTask, rebalanceQueuedTasks, cancelWorkflowTask } from "@/lib/workflow-tasks";
import {
  importExternalOrder,
  reserveAndPlanOrder,
  completeMoveGroup,
  pickOrderScan,
  reportPickShortage,
} from "@/lib/external-orders";

const prisma = new PrismaClient();
let failures = 0;
const ok = (n: string, c: boolean, e = "") => (c ? console.log(`  ✓ ${n}`) : (failures++, console.error(`  ✗ ${n} ${e}`)));
const err = async (fn: () => Promise<unknown>) => { try { await fn(); return ""; } catch (e) { return (e as Error).message; } };

let companyId = "", demoId = "", W = "", DW = "";
let zStorage = "", zControl = "";
let itemA = "", itemB = "", lo = "", pk = "";
const UIDS: string[] = [];
let seq = 0;
const now = new Date();

const cellId = async (code: string) => (await prisma.cell.findFirstOrThrow({ where: { warehouseId: W, code } })).id;
const cellQty = async (cid: string) => (await prisma.stockBalance.aggregate({ where: { cellId: cid, qty: { gt: 0 } }, _sum: { qty: true } }))._sum.qty?.toNumber() ?? 0;
// настоящие QR-коды (для сканов): ячейка создаёт CELL-QR (createCellsInZone), группа — GROUP-QR (seedGroup)
const cellCode = async (cid: string) => (await prisma.qrCode.findFirstOrThrow({ where: { type: "CELL", refId: cid } })).code;
const groupCode = async (gid: string) => (await prisma.qrCode.findFirstOrThrow({ where: { type: "GROUP", refId: gid } })).code;
// Пакет 9B: EAN товара + текущая ячейка группы (для скана исходной ячейки при перестановке)
const itemEan = new Map<string, string>();
const eanOf = (itemId: string) => itemEan.get(itemId)!;
const groupEan = async (gid: string) => eanOf((await prisma.handlingGroup.findFirstOrThrow({ where: { id: gid } })).itemId);
const groupCurrentCell = async (gid: string) => {
  const g = await prisma.handlingGroup.findFirstOrThrow({ where: { id: gid }, select: { lotId: true } });
  return (await prisma.stockBalance.findFirstOrThrow({ where: { lotId: g.lotId, cellId: { not: null }, qty: { gt: 0 } }, select: { cellId: true } })).cellId!;
};
function ean13(b12: string): string { let s = 0; for (let i = b12.length - 1, k = 0; i >= 0; i--, k++) s += Number(b12[i]) * (k % 2 === 0 ? 3 : 1); return b12 + String((10 - (s % 10)) % 10); }
async function seedEan(itemId: string, b12: string) { const code = ean13(b12); await prisma.itemBarcode.create({ data: { companyId, itemId, code, symbology: "EAN13", source: "MANUAL" } }); itemEan.set(itemId, code); }
const mvCount = async (lotId: string) => prisma.stockMovement.count({ where: { lotId } });

async function mkUser(id: string, cid: string, phone: string, role: Role, wh: string) {
  await prisma.user.deleteMany({ where: { id } });
  await prisma.user.create({ data: { id, companyId: cid, phone, name: id, role, isActive: true, allWarehouses: false, passwordHash: await bcrypt.hash("eo", 10), userRoles: { create: { role } }, warehouseLinks: { create: { warehouseId: wh } } } });
  UIDS.push(id);
  return id;
}
const mkShift = (userId: string, role: Role, wh: string) => prisma.workShift.create({ data: { companyId, userId, warehouseId: wh, role } });

// прямой посев группы в ячейку (контроль FIFO через lot.createdAt), IN_STORAGE
async function seedGroup(itemId: string, cid: string, qty: number, createdAt: Date): Promise<{ lotId: string; groupId: string }> {
  const number = 900000 + ++seq;
  const receipt = await prisma.receipt.create({ data: { companyId, number, warehouseId: W, status: "POSTED", postedAt: now, note: "EO seed", createdById: lo } });
  const line = await prisma.receiptLine.create({ data: { companyId, receiptId: receipt.id, itemId, qty } });
  const lot = await prisma.lot.create({ data: { companyId, itemId, receiptLineId: line.id, qtyReceived: qty, createdAt } });
  await prisma.$transaction((tx) => applyLotMovement(tx, { companyId, docType: "RECEIPT", docId: receipt.id, itemId, lotId: lot.id, qty, from: null, to: { kind: "cell", warehouseId: W, cellId: cid }, createdById: lo }));
  const group = await prisma.handlingGroup.create({ data: { companyId, warehouseId: W, itemId, lotId: lot.id, qty, temperature: 0, thresholdX: 5, status: "IN_STORAGE", dedupeKey: `eo-seed-${seq}`, acceptedById: lo } });
  await prisma.$transaction((tx) => createQrIn(tx, { companyId, type: "GROUP", refId: group.id })); // GROUP-QR для сканов сборки/перестановки
  return { lotId: lot.id, groupId: group.id };
}

const imp = (externalId: string, lines: { externalLineId: string; itemId: string; requiredQty: number }[], arrivalAt?: Date) =>
  importExternalOrder({ companyId, warehouseId: W, externalId, createdById: lo, arrivalAt: arrivalAt ?? null, lines });

// прогнать все задачи перестановки (цепочка: завершение одной разблокирует зависимую)
async function runMoves() {
  for (let i = 0; i < 20; i++) {
    let t = await prisma.workflowTask.findFirst({ where: { warehouseId: W, type: "MOVE_GROUP", status: { in: ["ASSIGNED", "QUEUED"] } }, orderBy: { createdAt: "asc" } });
    if (!t) break;
    if (t.status === "QUEUED") { await rebalanceQueuedTasks(companyId, { warehouseId: W }); t = await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } }); }
    if (t.status !== "ASSIGNED" || !t.assignedUserId) break;
    await startWorkflowTask(t.assignedUserId, companyId, t.id);
    const cr = await prisma.cellReservation.findFirstOrThrow({ where: { taskId: t.id, status: "ACTIVE" } });
    await completeMoveGroup({ companyId, userId: t.assignedUserId, taskId: t.id, fromCellCode: await cellCode(await groupCurrentCell(t.subjectId!)), ean: await groupEan(t.subjectId!), cellCode: await cellCode(cr.cellId) });
  }
}

// собрать заказ целиком (скан всех активных резервов)
async function runPick(orderId: string): Promise<string> {
  let t = await prisma.workflowTask.findFirst({ where: { warehouseId: W, type: "PICK_ORDER", subjectId: orderId, status: { in: ["QUEUED", "ASSIGNED", "IN_PROGRESS"] } } });
  if (!t) return "нет задачи сборки";
  if (t.status === "QUEUED") { await rebalanceQueuedTasks(companyId, { warehouseId: W }); t = await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } }); }
  if (t.assignedUserId !== pk) return `сборка не назначена сборщику (${t.status})`;
  if (t.status === "ASSIGNED") await startWorkflowTask(pk, companyId, t.id); // уже IN_PROGRESS — повторно не стартуем
  for (let i = 0; i < 50; i++) {
    const r = await prisma.stockReservation.findFirst({ where: { orderId, status: "ACTIVE" } });
    if (!r) break;
    await pickOrderScan({ companyId, userId: pk, taskId: t.id, cellCode: await cellCode(r.cellId!), ean: await groupEan(r.handlingGroupId!), qty: r.qty.toNumber() });
  }
  return "";
}

async function resetScenario() {
  const orders = await prisma.externalOrder.findMany({ where: { companyId }, select: { id: true } });
  await prisma.stockReservation.deleteMany({ where: { companyId } });
  await prisma.externalOrder.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } }); // cascade lines
  await prisma.cellReservation.deleteMany({ where: { warehouseId: { in: [W, DW] } } });
  await prisma.workflowTask.deleteMany({ where: { warehouseId: { in: [W, DW] } } });
  const groups = await prisma.handlingGroup.findMany({ where: { warehouseId: { in: [W, DW] } }, select: { id: true, lotId: true } });
  const lotIds = groups.map((g) => g.lotId);
  await prisma.qrCode.deleteMany({ where: { type: "GROUP", refId: { in: groups.map((g) => g.id) } } });
  await prisma.handlingGroup.deleteMany({ where: { warehouseId: { in: [W, DW] } } });
  if (lotIds.length) {
    await prisma.stockMovement.deleteMany({ where: { lotId: { in: lotIds } } });
    await prisma.stockBalance.deleteMany({ where: { lotId: { in: lotIds } } });
    const rls = (await prisma.lot.findMany({ where: { id: { in: lotIds } }, select: { receiptLineId: true } })).map((l) => l.receiptLineId);
    await prisma.lot.deleteMany({ where: { id: { in: lotIds } } });
    const recs = [...new Set((await prisma.receiptLine.findMany({ where: { id: { in: rls } }, select: { receiptId: true } })).map((r) => r.receiptId))];
    await prisma.receiptLine.deleteMany({ where: { id: { in: rls } } });
    await prisma.receipt.deleteMany({ where: { id: { in: recs } } });
  }
  await prisma.qrCode.deleteMany({ where: { companyId, type: "ORDER" } });
}

async function provision() {
  companyId = (await prisma.company.findFirstOrThrow({ where: { slug: "rostagro" } })).id;
  W = (await prisma.warehouse.create({ data: { companyId, name: "EO W", isActive: true } })).id;
  await ensureStandardZones(companyId, W);
  zStorage = (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: W, kind: "STORAGE" } })).id;
  zControl = (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: W, kind: "CONTROL" } })).id;
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["EO-L1A", "EO-L1B"], level: 1 });
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["EO-L2A", "EO-L2B"], level: 2 });
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["EO-U3A", "EO-U3B"], level: 3 });
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["EO-U11"], level: 11 }); // верхняя ур.11
  const uom = await prisma.uom.create({ data: { companyId, name: "шт EO" } });
  itemA = (await prisma.item.create({ data: { companyId, name: "EO товар A", sku: "EO-A", uomId: uom.id, tracking: "LOT", isActive: true } })).id;
  itemB = (await prisma.item.create({ data: { companyId, name: "EO товар B", sku: "EO-B", uomId: uom.id, tracking: "LOT", isActive: true } })).id;
  await seedEan(itemA, "460773000001");
  await seedEan(itemB, "460773000002");
  const demo = await prisma.company.upsert({ where: { slug: "eo-demo" }, update: {}, create: { name: "EO Demo", slug: "eo-demo", settings: {} } });
  demoId = demo.id;
  DW = (await prisma.warehouse.create({ data: { companyId: demoId, name: "EO DW", isActive: true } })).id;
  await ensureStandardZones(demoId, DW);
  const dzs = (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: DW, kind: "STORAGE" } })).id;
  await createCellsInZone({ companyId: demoId, warehouseId: DW, zoneId: dzs, codes: ["EO-DEMO1"], level: 1 }); // чужая ячейка (QR другой организации)
  lo = await mkUser("eo_lo", companyId, "+79995550001", "LOADER", W);
  pk = await mkUser("eo_pk", companyId, "+79995550002", "PICKER", W);
  await mkShift(lo, "LOADER", W);
  await mkShift(pk, "PICKER", W);
}

async function cleanup() {
  await resetScenario();
  await prisma.workShift.deleteMany({ where: { userId: { in: UIDS } } });
  const cs = (await prisma.cell.findMany({ where: { warehouseId: { in: [W, DW] } }, select: { id: true } })).map((c) => c.id);
  await prisma.qrCode.deleteMany({ where: { type: { in: ["CELL", "GROUP", "ORDER"] }, refId: { in: cs } } });
  await prisma.cell.deleteMany({ where: { warehouseId: { in: [W, DW] } } });
  await prisma.warehouseZone.deleteMany({ where: { warehouseId: { in: [W, DW] } } });
  await prisma.user.deleteMany({ where: { id: { in: UIDS } } });
  await prisma.itemBarcode.deleteMany({ where: { itemId: { in: [itemA, itemB] } } });
  await prisma.item.deleteMany({ where: { id: { in: [itemA, itemB] } } });
  await prisma.warehouse.deleteMany({ where: { id: W } });
  if (demoId) {
    await prisma.warehouseZone.deleteMany({ where: { companyId: demoId } });
    await prisma.warehouse.deleteMany({ where: { companyId: demoId } });
    await prisma.company.deleteMany({ where: { id: demoId, slug: "eo-demo" } });
  }
  await prisma.uom.deleteMany({ where: { companyId, name: "шт EO" } });
}

const activeRes = (orderId: string) => prisma.stockReservation.findMany({ where: { orderId, status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
const orderStatus = async (orderId: string) => (await prisma.externalOrder.findUniqueOrThrow({ where: { id: orderId } })).status;
const pickTask = (orderId: string) => prisma.workflowTask.findFirst({ where: { type: "PICK_ORDER", subjectId: orderId } });

async function main() {
  await provision();

  console.log("1) идемпотентный импорт; изменённый payload → контролируемая ошибка");
  const l1 = [{ externalLineId: "1", itemId: itemA, requiredQty: 5 }];
  const i1 = await imp("EO-1", l1);
  const i1b = await imp("EO-1", l1);
  ok("повторный импорт того же payload → тот же заказ, created=false", i1.orderId === i1b.orderId && i1b.created === false);
  const changed = await err(() => imp("EO-1", [{ externalLineId: "1", itemId: itemA, requiredQty: 6 }]));
  ok("изменённый payload существующего заказа → ошибка", changed.includes("другим содержимым"));
  ok("QR заказа создан", !!(await prisma.qrCode.findFirst({ where: { companyId, type: "ORDER", refId: i1.orderId } })));
  await resetScenario();

  console.log("2) FIFO: резерв из самой старой партии (Lot.createdAt), tie-break по id");
  const lotOld = await seedGroup(itemA, await cellId("EO-L1A"), 10, new Date(now.getTime() - 20_000));
  const lotNew = await seedGroup(itemA, await cellId("EO-L1B"), 10, new Date(now.getTime() - 10_000));
  const oFifo = await imp("EO-FIFO", [{ externalLineId: "1", itemId: itemA, requiredQty: 6 }]);
  await reserveAndPlanOrder({ companyId, orderId: oFifo.orderId, userId: lo });
  const rFifo = await activeRes(oFifo.orderId);
  ok("зарезервирована старая партия (не новая), qty=6", rFifo.length === 1 && rFifo[0].lotId === lotOld.lotId && rFifo[0].qty.toNumber() === 6, JSON.stringify(rFifo.map((r) => [r.lotId, r.qty.toString()])));
  ok("полное покрытие на ур.1 → READY_TO_PICK + задача PICK_ORDER", (await orderStatus(oFifo.orderId)) === "READY_TO_PICK" && !!(await pickTask(oFifo.orderId)));
  void lotNew;
  await resetScenario();

  console.log("3) несколько групп в строке: FIFO по партиям до покрытия");
  await seedGroup(itemA, await cellId("EO-L1A"), 10, new Date(now.getTime() - 20_000));
  await seedGroup(itemA, await cellId("EO-L1B"), 10, new Date(now.getTime() - 10_000));
  const oMulti = await imp("EO-MULTI", [{ externalLineId: "1", itemId: itemA, requiredQty: 14 }]);
  await reserveAndPlanOrder({ companyId, orderId: oMulti.orderId, userId: lo });
  const rMulti = await activeRes(oMulti.orderId);
  const sumMulti = rMulti.reduce((s, r) => s + r.qty.toNumber(), 0);
  ok("две брони из двух групп, сумма = 14", rMulti.length === 2 && sumMulti === 14);
  ok("полное покрытие → READY_TO_PICK", (await orderStatus(oMulti.orderId)) === "READY_TO_PICK");
  await resetScenario();

  console.log("4) частичный резерв (нехватка) → PARTIALLY_RESERVED, задача сборки НЕ создаётся");
  await seedGroup(itemA, await cellId("EO-L1A"), 5, new Date(now.getTime() - 20_000));
  const oPart = await imp("EO-PART", [{ externalLineId: "1", itemId: itemA, requiredQty: 12 }]);
  await reserveAndPlanOrder({ companyId, orderId: oPart.orderId, userId: lo });
  ok("статус PARTIALLY_RESERVED", (await orderStatus(oPart.orderId)) === "PARTIALLY_RESERVED");
  ok("зарезервировано только 5, PICK_ORDER нет", (await activeRes(oPart.orderId)).reduce((s, r) => s + r.qty.toNumber(), 0) === 5 && !(await pickTask(oPart.orderId)));
  await resetScenario();

  console.log("5) два параллельных заказа не резервируют один остаток дважды (Σ active ≤ balance)");
  const src = await seedGroup(itemA, await cellId("EO-L1A"), 10, new Date(now.getTime() - 20_000));
  const oc1 = await imp("EO-C1", [{ externalLineId: "1", itemId: itemA, requiredQty: 7 }]);
  const oc2 = await imp("EO-C2", [{ externalLineId: "1", itemId: itemA, requiredQty: 7 }]);
  await Promise.all([
    reserveAndPlanOrder({ companyId, orderId: oc1.orderId, userId: lo }),
    reserveAndPlanOrder({ companyId, orderId: oc2.orderId, userId: lo }),
  ]);
  const totalActive = (await prisma.stockReservation.aggregate({ where: { lotId: src.lotId, sourceLocKey: `C:${await cellId("EO-L1A")}`, status: "ACTIVE" }, _sum: { qty: true } }))._sum.qty?.toNumber() ?? 0;
  ok("сумма активных резервов на источнике ≤ остатка (10)", totalActive <= 10, `Σ=${totalActive}`);
  ok("ровно один заказ полностью покрыт, второй — частично", [await orderStatus(oc1.orderId), await orderStatus(oc2.orderId)].filter((s) => s === "READY_TO_PICK").length === 1);
  await resetScenario();

  console.log("6) приоритет очереди: ближайший arrivalAt раньше (dueAt asc)");
  await seedGroup(itemA, await cellId("EO-L1A"), 10, new Date(now.getTime() - 20_000));
  await seedGroup(itemB, await cellId("EO-L1B"), 10, new Date(now.getTime() - 20_000));
  const oLate = await imp("EO-LATE", [{ externalLineId: "1", itemId: itemA, requiredQty: 3 }], new Date(now.getTime() + 3_600_000));
  const oEarly = await imp("EO-EARLY", [{ externalLineId: "1", itemId: itemB, requiredQty: 3 }], new Date(now.getTime() + 60_000));
  await reserveAndPlanOrder({ companyId, orderId: oLate.orderId, userId: lo });
  await reserveAndPlanOrder({ companyId, orderId: oEarly.orderId, userId: lo });
  const queued = await prisma.workflowTask.findMany({
    where: { warehouseId: W, type: "PICK_ORDER", status: { in: ["QUEUED", "ASSIGNED"] } },
    orderBy: [{ priority: "desc" }, { dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
  });
  ok("первым в очереди — заказ с ближайшим arrivalAt", queued[0]?.subjectId === oEarly.orderId, `first=${queued[0]?.subjectId}`);
  await resetScenario();

  console.log("7) сборка: скан ячейки+группы → CONTROL; излишек отклонён; повтор не двоит; недостача после завершения отклонена");
  const g7 = await seedGroup(itemA, await cellId("EO-L1A"), 8, new Date(now.getTime() - 20_000));
  const oPick = await imp("EO-PICK", [{ externalLineId: "1", itemId: itemA, requiredQty: 8 }]);
  await reserveAndPlanOrder({ companyId, orderId: oPick.orderId, userId: lo });
  const pt = await pickTask(oPick.orderId);
  await rebalanceQueuedTasks(companyId, { warehouseId: W });
  await startWorkflowTask(pk, companyId, pt!.id);
  const cc7 = await cellCode(await cellId("EO-L1A")), gc7 = eanOf(itemA);
  const ctrl7 = async () => (await prisma.stockBalance.aggregate({ where: { lotId: g7.lotId, locKey: `Z:${zControl}` }, _sum: { qty: true } }))._sum.qty?.toNumber() ?? 0;
  const excess = await err(() => pickOrderScan({ companyId, userId: pk, taskId: pt!.id, cellCode: cc7, ean: gc7, qty: 99 }));
  ok("излишек (qty>резерв) отклонён", excess.includes("больше зарезервированного"));
  await pickOrderScan({ companyId, userId: pk, taskId: pt!.id, cellCode: cc7, ean: gc7, qty: 8 });
  const mv7 = await mvCount(g7.lotId);
  ok("вся строка отобрана в зону CONTROL (8), исходная ячейка пуста", (await ctrl7()) === 8 && (await cellQty(await cellId("EO-L1A"))) === 0);
  ok("заказ IN_CONTROL, PICK_ORDER COMPLETED, резерв FULFILLED", (await orderStatus(oPick.orderId)) === "IN_CONTROL" && (await prisma.workflowTask.findUniqueOrThrow({ where: { id: pt!.id } })).status === "COMPLETED" && (await prisma.stockReservation.count({ where: { orderId: oPick.orderId, status: "FULFILLED" } })) === 1);
  const repeat = await err(() => pickOrderScan({ companyId, userId: pk, taskId: pt!.id, cellCode: cc7, ean: gc7, qty: 8 }));
  ok("повтор финального скана: без ошибки, без второго движения, CONTROL=8", repeat === "" && (await mvCount(g7.lotId)) === mv7 && (await ctrl7()) === 8);
  const shortAfter = await err(() => reportPickShortage({ companyId, userId: pk, taskId: pt!.id, reason: "поздно" }));
  ok("недостача после завершения (IN_CONTROL) отклонена", shortAfter.includes("уже собран") || shortAfter.includes("в работе"));
  await resetScenario();

  console.log("8) уровень 3+: цепочка перестановки вниз (свободная нижняя) → сборка с ур.1");
  const g8 = await seedGroup(itemA, await cellId("EO-U3A"), 6, new Date(now.getTime() - 20_000)); // на ур.3
  const o8 = await imp("EO-MOVE1", [{ externalLineId: "1", itemId: itemA, requiredQty: 6 }]);
  await reserveAndPlanOrder({ companyId, orderId: o8.orderId, userId: lo });
  ok("создана задача перестановки MOVE_GROUP, PICK_ORDER заблокирован зависимостью", (await prisma.workflowTask.count({ where: { warehouseId: W, type: "MOVE_GROUP" } })) === 1 && (await pickTask(o8.orderId))!.status === "BLOCKED");
  await runMoves();
  const movedBal = await prisma.stockBalance.findFirst({ where: { lotId: g8.lotId, qty: { gt: 0 } }, select: { cellId: true } });
  const movedCell = movedBal?.cellId ? await prisma.cell.findUnique({ where: { id: movedBal.cellId }, select: { level: true } }) : null;
  ok("группа переставлена на уровень 1-2", (movedCell?.level ?? 9) <= 2);
  ok("резерв товара переехал на новую ячейку", (await activeRes(o8.orderId))[0]?.cellId === movedBal?.cellId);
  ok("после перестановки сборка доступна и проходит", (await runPick(o8.orderId)) === "" && (await orderStatus(o8.orderId)) === "IN_CONTROL");
  await resetScenario();

  console.log("9) уровень 3+: нижние заняты → подъём невостребованной группы + перестановка вниз");
  // заполнить все нижние (ур.1-2) невостребованными группами; одну верхнюю оставить свободной
  await seedGroup(itemB, await cellId("EO-L1A"), 4, new Date(now.getTime() - 30_000));
  await seedGroup(itemB, await cellId("EO-L1B"), 4, new Date(now.getTime() - 30_000));
  await seedGroup(itemB, await cellId("EO-L2A"), 4, new Date(now.getTime() - 30_000));
  await seedGroup(itemB, await cellId("EO-L2B"), 4, new Date(now.getTime() - 30_000));
  const g9 = await seedGroup(itemA, await cellId("EO-U3A"), 6, new Date(now.getTime() - 20_000)); // нужная на ур.3, EO-U3B свободна
  const o9 = await imp("EO-MOVE2", [{ externalLineId: "1", itemId: itemA, requiredQty: 6 }]);
  await reserveAndPlanOrder({ companyId, orderId: o9.orderId, userId: lo });
  ok("создана цепочка из двух MOVE_GROUP (подъём + перестановка) с зависимостью", (await prisma.workflowTask.count({ where: { warehouseId: W, type: "MOVE_GROUP" } })) === 2 && (await prisma.taskDependency.count({ where: { task: { warehouseId: W, type: "MOVE_GROUP" } } })) === 1);
  await runMoves();
  const b9 = await prisma.stockBalance.findFirst({ where: { lotId: g9.lotId, qty: { gt: 0 } }, select: { cellId: true } });
  const c9 = b9?.cellId ? await prisma.cell.findUnique({ where: { id: b9.cellId }, select: { level: true } }) : null;
  ok("нужная группа оказалась на уровне 1-2", (c9?.level ?? 9) <= 2);
  ok("сборка проходит, заказ IN_CONTROL", (await runPick(o9.orderId)) === "" && (await orderStatus(o9.orderId)) === "IN_CONTROL");
  await resetScenario();

  console.log("10) нет безопасного места → BLOCKED, невыполнимая задача НЕ создаётся");
  // все нижние заняты невостребованными; верхних свободных нет (обе верхние заняты)
  await seedGroup(itemB, await cellId("EO-L1A"), 4, new Date(now.getTime() - 30_000));
  await seedGroup(itemB, await cellId("EO-L1B"), 4, new Date(now.getTime() - 30_000));
  await seedGroup(itemB, await cellId("EO-L2A"), 4, new Date(now.getTime() - 30_000));
  await seedGroup(itemB, await cellId("EO-L2B"), 4, new Date(now.getTime() - 30_000));
  const g10 = await seedGroup(itemA, await cellId("EO-U3A"), 6, new Date(now.getTime() - 20_000)); // нужная на ур.3
  await seedGroup(itemB, await cellId("EO-U3B"), 4, new Date(now.getTime() - 30_000)); // занять ур.3B
  await seedGroup(itemB, await cellId("EO-U11"), 4, new Date(now.getTime() - 30_000)); // занять и ур.11 — верхних свободных нет
  const o10 = await imp("EO-BLOCK", [{ externalLineId: "1", itemId: itemA, requiredQty: 6 }]);
  await reserveAndPlanOrder({ companyId, orderId: o10.orderId, userId: lo });
  ok("статус BLOCKED", (await orderStatus(o10.orderId)) === "BLOCKED");
  ok("PICK_ORDER не создан, задач перестановки нет", !(await pickTask(o10.orderId)) && (await prisma.workflowTask.count({ where: { warehouseId: W, type: "MOVE_GROUP" } })) === 0);
  ok("резерв товара на нужную группу сохранён (для последующей попытки)", (await prisma.stockReservation.count({ where: { orderId: o10.orderId, handlingGroupId: g10.groupId, status: "ACTIVE" } })) === 1);
  await resetScenario();

  console.log("11) tenant-изоляция");
  await seedGroup(itemA, await cellId("EO-L1A"), 5, new Date(now.getTime() - 20_000));
  const foreignImport = await err(() => importExternalOrder({ companyId: demoId, warehouseId: W, externalId: "EO-X", createdById: lo, lines: [{ externalLineId: "1", itemId: itemA, requiredQty: 1 }] }));
  ok("импорт чужой компании на чужой склад → отказ", !!foreignImport);
  const oIso = await imp("EO-ISO", [{ externalLineId: "1", itemId: itemA, requiredQty: 5 }]);
  const foreignReserve = await err(() => reserveAndPlanOrder({ companyId: demoId, orderId: oIso.orderId, userId: lo }));
  ok("резерв чужого заказа (другой companyId) → отказ", !!foreignReserve);
  await resetScenario();

  console.log("12) QR-валидация сборки: чужой tenant-QR и неверный QR отклонены, корректный — собирает");
  const g12 = await seedGroup(itemA, await cellId("EO-L1A"), 4, new Date(now.getTime() - 20_000));
  const o12 = await imp("EO-QR", [{ externalLineId: "1", itemId: itemA, requiredQty: 4 }]);
  await reserveAndPlanOrder({ companyId, orderId: o12.orderId, userId: lo });
  const pt12 = await pickTask(o12.orderId); await rebalanceQueuedTasks(companyId, { warehouseId: W }); await startWorkflowTask(pk, companyId, pt12!.id);
  const demoCell = await prisma.cell.findFirstOrThrow({ where: { warehouseId: DW, code: "EO-DEMO1" } });
  const foreignCellCode = await cellCode(demoCell.id);
  const g12code = eanOf(itemA);
  const foreignCell = await err(() => pickOrderScan({ companyId, userId: pk, taskId: pt12!.id, cellCode: foreignCellCode, ean: g12code, qty: 4 }));
  ok("чужой tenant-QR ячейки отклонён", foreignCell.includes("этой организации") || foreignCell.includes("не найдена"));
  const badQr = await err(() => pickOrderScan({ companyId, userId: pk, taskId: pt12!.id, cellCode: "NEVERQR234", ean: g12code, qty: 4 }));
  ok("неверный QR ячейки отклонён", !!badQr);
  ok("после отказов корректный скан собирает заказ", (await runPick(o12.orderId)) === "" && (await orderStatus(o12.orderId)) === "IN_CONTROL");
  await resetScenario();

  console.log("13) два заказа на одну верхнюю группу → одна перестановка (без дубля), второй зависит от неё");
  const g13 = await seedGroup(itemA, await cellId("EO-U3A"), 10, new Date(now.getTime() - 20_000)); // общая группа на ур.3
  const o13a = await imp("EO-SHARE-A", [{ externalLineId: "1", itemId: itemA, requiredQty: 4 }]);
  await reserveAndPlanOrder({ companyId, orderId: o13a.orderId, userId: lo });
  const o13b = await imp("EO-SHARE-B", [{ externalLineId: "1", itemId: itemA, requiredQty: 4 }]);
  await reserveAndPlanOrder({ companyId, orderId: o13b.orderId, userId: lo });
  ok("ровно ОДНА задача перестановки на общую группу (без дубля)", (await prisma.workflowTask.count({ where: { warehouseId: W, type: "MOVE_GROUP", subjectId: g13.groupId } })) === 1);
  ok("ровно одна активная бронь ячейки на группу (partial-unique)", (await prisma.cellReservation.count({ where: { handlingGroupId: g13.groupId, status: "ACTIVE" } })) === 1);
  const moveTask13 = await prisma.workflowTask.findFirstOrThrow({ where: { warehouseId: W, type: "MOVE_GROUP", subjectId: g13.groupId } });
  const pickB13 = await prisma.workflowTask.findFirstOrThrow({ where: { type: "PICK_ORDER", subjectId: o13b.orderId } });
  ok("второй заказ (PICK) зависит от той же задачи перестановки", pickB13.status === "BLOCKED" && (await prisma.taskDependency.count({ where: { taskId: pickB13.id, dependsOnTaskId: moveTask13.id } })) === 1);
  await runMoves();
  ok("после одной перестановки оба заказа собираются в IN_CONTROL", (await runPick(o13a.orderId)) === "" && (await runPick(o13b.orderId)) === "" && (await orderStatus(o13a.orderId)) === "IN_CONTROL" && (await orderStatus(o13b.orderId)) === "IN_CONTROL");
  await resetScenario();

  console.log("14) уровень 11 годится как верхняя ячейка (lift-target): нижние заняты, свободна только ур.11");
  await seedGroup(itemB, await cellId("EO-L1A"), 4, new Date(now.getTime() - 30_000));
  await seedGroup(itemB, await cellId("EO-L1B"), 4, new Date(now.getTime() - 30_000));
  await seedGroup(itemB, await cellId("EO-L2A"), 4, new Date(now.getTime() - 30_000));
  await seedGroup(itemB, await cellId("EO-L2B"), 4, new Date(now.getTime() - 30_000));
  const g14 = await seedGroup(itemA, await cellId("EO-U3A"), 6, new Date(now.getTime() - 20_000)); // нужная на ур.3
  await seedGroup(itemB, await cellId("EO-U3B"), 4, new Date(now.getTime() - 30_000)); // ур.3B занят; свободна только ур.11
  const o14 = await imp("EO-LVL11", [{ externalLineId: "1", itemId: itemA, requiredQty: 6 }]);
  const st14 = await reserveAndPlanOrder({ companyId, orderId: o14.orderId, userId: lo });
  ok("не BLOCKED: ур.11 распознан как верхняя для подъёма", st14.status === "READY_TO_PICK");
  ok("невостребованная группа поднимается именно в ур.11", !!(await prisma.cellReservation.findFirst({ where: { cellId: await cellId("EO-U11"), status: "ACTIVE" } })));
  await runMoves();
  const c14 = await prisma.stockBalance.findFirst({ where: { lotId: g14.lotId, qty: { gt: 0 } }, select: { cellId: true } });
  const lvl14 = c14?.cellId ? (await prisma.cell.findUnique({ where: { id: c14.cellId }, select: { level: true } }))?.level : 9;
  ok("нужная группа спущена на ур.1-2, заказ собран", (lvl14 ?? 9) <= 2 && (await runPick(o14.orderId)) === "" && (await orderStatus(o14.orderId)) === "IN_CONTROL");
  await resetScenario();

  console.log("15) loadUnits сборки = число несобранных строк (уменьшается после отбора)");
  const g15a = await seedGroup(itemA, await cellId("EO-L1A"), 3, new Date(now.getTime() - 20_000));
  await seedGroup(itemB, await cellId("EO-L1B"), 3, new Date(now.getTime() - 20_000));
  const o15 = await imp("EO-LOAD", [{ externalLineId: "1", itemId: itemA, requiredQty: 3 }, { externalLineId: "2", itemId: itemB, requiredQty: 3 }]);
  await reserveAndPlanOrder({ companyId, orderId: o15.orderId, userId: lo });
  const pt15 = await pickTask(o15.orderId); await rebalanceQueuedTasks(companyId, { warehouseId: W }); await startWorkflowTask(pk, companyId, pt15!.id);
  ok("до сборки loadUnits = 2 (две строки)", (await prisma.workflowTask.findUniqueOrThrow({ where: { id: pt15!.id } })).loadUnits === 2);
  await pickOrderScan({ companyId, userId: pk, taskId: pt15!.id, cellCode: await cellCode(await cellId("EO-L1A")), ean: await groupEan(g15a.groupId), qty: 3 });
  ok("после отбора одной строки loadUnits = 1", (await prisma.workflowTask.findUniqueOrThrow({ where: { id: pt15!.id } })).loadUnits === 1);
  ok("после сбора всех строк заказ IN_CONTROL", (await runPick(o15.orderId)) === "" && (await orderStatus(o15.orderId)) === "IN_CONTROL");
  await resetScenario();

  console.log("16) группа поднимается НАВЕРХ: заказ на её товар не получает готовую сборку; после — безопасная цепочка");
  const H16 = await seedGroup(itemB, await cellId("EO-L1A"), 4, new Date(now.getTime() - 5_000)); // H (itemB) — единственный источник itemB, нижняя
  await seedGroup(itemA, await cellId("EO-L1B"), 4, new Date(now.getTime() - 5_000)); // filler (нижние заняты → нужен подъём)
  await seedGroup(itemA, await cellId("EO-L2A"), 4, new Date(now.getTime() - 5_000));
  await seedGroup(itemA, await cellId("EO-L2B"), 4, new Date(now.getTime() - 5_000));
  const G16 = await seedGroup(itemA, await cellId("EO-U3A"), 6, new Date(now.getTime() - 60_000)); // самый старый itemA → его берёт A
  void G16;
  const oA16 = await imp("EO-LIFT-A", [{ externalLineId: "1", itemId: itemA, requiredQty: 6 }]);
  await reserveAndPlanOrder({ companyId, orderId: oA16.orderId, userId: lo });
  const hRes = await prisma.cellReservation.findFirst({ where: { handlingGroupId: H16.groupId, status: "ACTIVE" }, select: { cellId: true } });
  const hTargetLevel = hRes ? (await prisma.cell.findUnique({ where: { id: hRes.cellId }, select: { level: true } }))?.level ?? 0 : 0;
  ok("A подняла невостребованную нижнюю группу H НАВЕРХ (ур.3+)", hTargetLevel >= 3, `target level=${hTargetLevel}`);
  const oB16 = await imp("EO-LIFT-B", [{ externalLineId: "1", itemId: itemB, requiredQty: 4 }]);
  await reserveAndPlanOrder({ companyId, orderId: oB16.orderId, userId: lo });
  ok("B (товар поднимаемой группы) не резервирует её и не получает сборку (IMPORTED, без PICK)", (await orderStatus(oB16.orderId)) === "IMPORTED" && (await activeRes(oB16.orderId)).length === 0 && !(await pickTask(oB16.orderId)));
  await runMoves();
  ok("A собрана", (await runPick(oA16.orderId)) === "" && (await orderStatus(oA16.orderId)) === "IN_CONTROL");
  await reserveAndPlanOrder({ companyId, orderId: oB16.orderId, userId: lo });
  ok("повторное планирование B: зарезервировал H и получил безопасную цепочку", (await activeRes(oB16.orderId)).length >= 1 && !!(await pickTask(oB16.orderId)));
  await runMoves();
  ok("B собран после безопасной перестановки", (await runPick(oB16.orderId)) === "" && (await orderStatus(oB16.orderId)) === "IN_CONTROL");
  await resetScenario();

  console.log("17) точная идемпотентность финального скана после IN_CONTROL; чужой скан/tenant/QR отклонён");
  const g17 = await seedGroup(itemA, await cellId("EO-L1A"), 5, new Date(now.getTime() - 20_000));
  const o17 = await imp("EO-IDEM", [{ externalLineId: "1", itemId: itemA, requiredQty: 5 }]);
  await reserveAndPlanOrder({ companyId, orderId: o17.orderId, userId: lo });
  ok("заказ собран (IN_CONTROL)", (await runPick(o17.orderId)) === "" && (await orderStatus(o17.orderId)) === "IN_CONTROL");
  const pt17 = await prisma.workflowTask.findFirstOrThrow({ where: { type: "PICK_ORDER", subjectId: o17.orderId } });
  const l1c = await cellCode(await cellId("EO-L1A")); const g17c = await groupEan(g17.groupId);
  const mv17 = await mvCount(g17.lotId);
  const repeatRes = await pickOrderScan({ companyId, userId: pk, taskId: pt17.id, cellCode: l1c, ean: g17c, qty: 5 });
  ok("точный повтор финального скана: alreadyPicked, без движения", repeatRes.alreadyPicked && (await mvCount(g17.lotId)) === mv17);
  const l2c = await cellCode(await cellId("EO-L2A"));
  const wrongCell = await err(() => pickOrderScan({ companyId, userId: pk, taskId: pt17.id, cellCode: l2c, ean: g17c, qty: 5 }));
  ok("чужая ячейка после IN_CONTROL отклонена", /не соответствует|нет группы/.test(wrongCell), wrongCell);
  const other17 = await seedGroup(itemA, await cellId("EO-L2B"), 2, new Date(now.getTime() - 10_000));
  const other17c = await groupEan(other17.groupId); const l2bc = await cellCode(await cellId("EO-L2B"));
  const wrongGroup = await err(() => pickOrderScan({ companyId, userId: pk, taskId: pt17.id, cellCode: l2bc, ean: other17c, qty: 2 }));
  ok("чужая группа после IN_CONTROL отклонена", /не соответствует|нет группы/.test(wrongGroup), wrongGroup);
  const demoCell17 = await prisma.cell.findFirstOrThrow({ where: { warehouseId: DW, code: "EO-DEMO1" } });
  const demoCell17c = await cellCode(demoCell17.id);
  const foreignTenant = await err(() => pickOrderScan({ companyId, userId: pk, taskId: pt17.id, cellCode: demoCell17c, ean: g17c, qty: 5 }));
  ok("чужой tenant-QR после IN_CONTROL отклонён", foreignTenant.includes("этой организации") || foreignTenant.includes("не найдена"));
  const badQr17 = await err(() => pickOrderScan({ companyId, userId: pk, taskId: pt17.id, cellCode: "NEVERQR234", ean: g17c, qty: 5 }));
  ok("неверный QR после IN_CONTROL отклонён", !!badQr17);
  await resetScenario();

  console.log("18) отмена активной MOVE_GROUP запрещена; задача/бронь/зависимость целы");
  const g18 = await seedGroup(itemA, await cellId("EO-U3A"), 6, new Date(now.getTime() - 20_000)); // ур.3 → перестановка
  const o18 = await imp("EO-CANCELMOVE", [{ externalLineId: "1", itemId: itemA, requiredQty: 6 }]);
  await reserveAndPlanOrder({ companyId, orderId: o18.orderId, userId: lo });
  const mt18 = await prisma.workflowTask.findFirstOrThrow({ where: { warehouseId: W, type: "MOVE_GROUP", subjectId: g18.groupId } });
  const cancelErr = await err(() => cancelWorkflowTask(mt18.id));
  ok("generic-отмена MOVE_GROUP с активной бронью отклонена", cancelErr.includes("Активную перестановку нельзя отменить"));
  ok("задача, бронь и зависимость целы, PICK не разблокирован", (await prisma.workflowTask.findUniqueOrThrow({ where: { id: mt18.id } })).status !== "CANCELLED" && (await prisma.cellReservation.count({ where: { taskId: mt18.id, status: "ACTIVE" } })) === 1 && (await pickTask(o18.orderId))!.status === "BLOCKED");
  await resetScenario();
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ P6 ПРОЙДЕНЫ ✓" : `\nПРОВАЛЕНО: ${failures}`);
    process.exit(failures === 0 ? 0 : 1);
  });
