// Проверка Этапа 5/Пакет 6 (внешние заказы, FIFO-резерв, перестановка, сборка). Движок напрямую
// (tsx + prisma). Только dev-БД; тест-данные удаляются в finally.
// Запуск: npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-external-orders.ts
/* eslint-disable no-console */
import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { applyLotMovement } from "@/lib/stock";
import { ensureStandardZones, createCellsInZone } from "@/lib/cells";
import { startWorkflowTask, rebalanceQueuedTasks } from "@/lib/workflow-tasks";
import {
  importExternalOrder,
  reserveAndPlanOrder,
  completeMoveGroup,
  pickOrderScan,
  ExternalOrderError,
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
const bal = (lotId: string, locKey: string) => prisma.stockBalance.findFirst({ where: { lotId, locKey } });
const cellQty = async (cid: string) => (await prisma.stockBalance.aggregate({ where: { cellId: cid, qty: { gt: 0 } }, _sum: { qty: true } }))._sum.qty?.toNumber() ?? 0;

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
    await completeMoveGroup({ companyId, userId: t.assignedUserId, taskId: t.id });
  }
}

// собрать заказ целиком (скан всех активных резервов)
async function runPick(orderId: string): Promise<string> {
  let t = await prisma.workflowTask.findFirst({ where: { warehouseId: W, type: "PICK_ORDER", subjectId: orderId, status: { in: ["QUEUED", "ASSIGNED"] } } });
  if (!t) return "нет задачи сборки";
  if (t.status === "QUEUED") { await rebalanceQueuedTasks(companyId, { warehouseId: W }); t = await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } }); }
  if (t.status !== "ASSIGNED" || t.assignedUserId !== pk) return `сборка не назначена сборщику (${t.status})`;
  await startWorkflowTask(pk, companyId, t.id);
  for (let i = 0; i < 50; i++) {
    const r = await prisma.stockReservation.findFirst({ where: { orderId, status: "ACTIVE" }, include: { line: true } });
    if (!r) break;
    await pickOrderScan({ companyId, userId: pk, taskId: t.id, cellId: r.cellId!, itemId: r.line.itemId, qty: r.qty.toNumber() });
  }
  return "";
}

async function resetScenario() {
  const orders = await prisma.externalOrder.findMany({ where: { companyId }, select: { id: true } });
  await prisma.stockReservation.deleteMany({ where: { companyId } });
  await prisma.externalOrder.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } }); // cascade lines
  await prisma.cellReservation.deleteMany({ where: { warehouseId: { in: [W, DW] } } });
  await prisma.workflowTask.deleteMany({ where: { warehouseId: { in: [W, DW] } } });
  const groups = await prisma.handlingGroup.findMany({ where: { warehouseId: { in: [W, DW] } }, select: { lotId: true } });
  const lotIds = groups.map((g) => g.lotId);
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
  const uom = await prisma.uom.create({ data: { companyId, name: "шт EO" } });
  itemA = (await prisma.item.create({ data: { companyId, name: "EO товар A", sku: "EO-A", uomId: uom.id, tracking: "LOT", isActive: true } })).id;
  itemB = (await prisma.item.create({ data: { companyId, name: "EO товар B", sku: "EO-B", uomId: uom.id, tracking: "LOT", isActive: true } })).id;
  const demo = await prisma.company.upsert({ where: { slug: "eo-demo" }, update: {}, create: { name: "EO Demo", slug: "eo-demo", settings: {} } });
  demoId = demo.id;
  DW = (await prisma.warehouse.create({ data: { companyId: demoId, name: "EO DW", isActive: true } })).id;
  await ensureStandardZones(demoId, DW);
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

  console.log("7) сборка: отбор через ядро → зона CONTROL; повтор скана идемпотентен; IN_CONTROL");
  await seedGroup(itemA, await cellId("EO-L1A"), 8, new Date(now.getTime() - 20_000));
  const oPick = await imp("EO-PICK", [{ externalLineId: "1", itemId: itemA, requiredQty: 8 }]);
  await reserveAndPlanOrder({ companyId, orderId: oPick.orderId, userId: lo });
  const pt = await pickTask(oPick.orderId);
  await rebalanceQueuedTasks(companyId, { warehouseId: W });
  await startWorkflowTask(pk, companyId, pt!.id);
  const rPick = (await activeRes(oPick.orderId))[0];
  await pickOrderScan({ companyId, userId: pk, taskId: pt!.id, cellId: rPick.cellId!, itemId: itemA, qty: 8 });
  const excess = await err(() => pickOrderScan({ companyId, userId: pk, taskId: pt!.id, cellId: rPick.cellId!, itemId: itemA, qty: 1 }));
  const controlQty = (await prisma.stockBalance.aggregate({ where: { lotId: rPick.lotId!, locKey: `Z:${zControl}` }, _sum: { qty: true } }))._sum.qty?.toNumber() ?? 0;
  const cellLeft = await cellQty(await cellId("EO-L1A"));
  ok("вся строка отобрана в зону CONTROL (8), исходная ячейка пуста", controlQty === 8 && cellLeft === 0);
  ok("повторный скан не двоит движение (в CONTROL всё ещё 8)", excess === "" || excess.length >= 0 ? controlQty === 8 : false);
  ok("заказ IN_CONTROL, PICK_ORDER COMPLETED, резерв FULFILLED", (await orderStatus(oPick.orderId)) === "IN_CONTROL" && (await prisma.workflowTask.findUniqueOrThrow({ where: { id: pt!.id } })).status === "COMPLETED" && (await prisma.stockReservation.count({ where: { orderId: oPick.orderId, status: "FULFILLED" } })) === 1);
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
  await seedGroup(itemB, await cellId("EO-U3B"), 4, new Date(now.getTime() - 30_000)); // занять последнюю верхнюю
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
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ P6 ПРОЙДЕНЫ ✓" : `\nПРОВАЛЕНО: ${failures}`);
    process.exit(failures === 0 ? 0 : 1);
  });
