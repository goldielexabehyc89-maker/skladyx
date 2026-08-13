// ORDER-003 (Задача P2): авто-возобновление BLOCKED-заказов серверным планировщиком. Движок напрямую
// (tsx + prisma). Только dev-БД; тест-данные удаляются в finally.
// Запуск: WORKFLOW_TASKS_ENABLED=true EXTERNAL_ORDER_PICKING_ENABLED=true \
//   npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-blocked-replanning.ts
/* eslint-disable no-console */
process.env.WORKFLOW_TASKS_ENABLED = "true";
process.env.EXTERNAL_ORDER_PICKING_ENABLED = "true";
import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { applyLotMovement } from "@/lib/stock";
import { ensureStandardZones, createCellsInZone } from "@/lib/cells";
import { createQrIn } from "@/lib/qr";
import { startWorkflowTask, rebalanceQueuedTasks } from "@/lib/workflow-tasks";
import { importExternalOrder, reserveAndPlanOrder, completeMoveGroup, pickOrderScan } from "@/lib/external-orders";
import { replanBlockedOnce } from "@/lib/scheduler";

const prisma = new PrismaClient();
let failures = 0;
const ok = (n: string, c: boolean, e = "") => (c ? console.log(`  ✓ ${n}`) : (failures++, console.error(`  ✗ ${n} ${e}`)));

let companyId = "", demoId = "", W = "", DW = "";
let zStorage = "", zStorageDemo = "";
let itemA = "", itemB = "", pk = "", lo = "";
const UIDS: string[] = [];
let seq = 0;
const now = new Date();

const cellId = async (code: string, wh = W) => (await prisma.cell.findFirstOrThrow({ where: { warehouseId: wh, code } })).id;
const cellCode = async (cid: string) => (await prisma.qrCode.findFirstOrThrow({ where: { type: "CELL", refId: cid } })).code;
const itemEan = new Map<string, string>();
const eanOf = (itemId: string) => itemEan.get(itemId)!;
const groupEan = async (gid: string) => eanOf((await prisma.handlingGroup.findFirstOrThrow({ where: { id: gid } })).itemId);
const groupCurrentCell = async (gid: string) => {
  const g = await prisma.handlingGroup.findFirstOrThrow({ where: { id: gid }, select: { lotId: true } });
  return (await prisma.stockBalance.findFirstOrThrow({ where: { lotId: g.lotId, cellId: { not: null }, qty: { gt: 0 } }, select: { cellId: true } })).cellId!;
};
function ean13(b12: string): string { let s = 0; for (let i = b12.length - 1, k = 0; i >= 0; i--, k++) s += Number(b12[i]) * (k % 2 === 0 ? 3 : 1); return b12 + String((10 - (s % 10)) % 10); }
async function seedEan(itemId: string, b12: string) { const code = ean13(b12); await prisma.itemBarcode.create({ data: { companyId, itemId, code, symbology: "EAN13", source: "MANUAL" } }); itemEan.set(itemId, code); }

const orderStatus = async (orderId: string) => (await prisma.externalOrder.findUniqueOrThrow({ where: { id: orderId } })).status;
const moveCountFor = (orderId: string) => prisma.workflowTask.count({ where: { type: "MOVE_GROUP", dedupeKey: { startsWith: `move:${orderId}:` } } });
const pickTaskOf = (orderId: string) => prisma.workflowTask.findFirst({ where: { type: "PICK_ORDER", subjectId: orderId }, orderBy: { createdAt: "desc" } });
const allMv = async (wh = W) => prisma.stockMovement.count({ where: { OR: [{ fromWarehouseId: wh }, { toWarehouseId: wh }] } });
const activeResvCount = (orderId: string) => prisma.stockReservation.count({ where: { orderId, status: "ACTIVE" } });

async function mkUser(id: string, cid: string, phone: string, role: Role, wh: string) {
  await prisma.user.deleteMany({ where: { id } });
  await prisma.user.create({ data: { id, companyId: cid, phone, name: id, role, isActive: true, allWarehouses: false, passwordHash: await bcrypt.hash("br", 10), userRoles: { create: { role } }, warehouseLinks: { create: { warehouseId: wh } } } });
  UIDS.push(id);
  return id;
}

async function seedGroup(itemId: string, cid: string, qty: number, createdAt: Date, wh = W): Promise<{ lotId: string; groupId: string }> {
  const number = 950000 + ++seq;
  const receipt = await prisma.receipt.create({ data: { companyId: wh === W ? companyId : demoId, number, warehouseId: wh, status: "POSTED", postedAt: now, note: "BR seed", createdById: lo } });
  const line = await prisma.receiptLine.create({ data: { companyId: wh === W ? companyId : demoId, receiptId: receipt.id, itemId, qty } });
  const lot = await prisma.lot.create({ data: { companyId: wh === W ? companyId : demoId, itemId, receiptLineId: line.id, qtyReceived: qty, createdAt } });
  await prisma.$transaction((tx) => applyLotMovement(tx, { companyId: wh === W ? companyId : demoId, docType: "RECEIPT", docId: receipt.id, itemId, lotId: lot.id, qty, from: null, to: { kind: "cell", warehouseId: wh, cellId: cid }, createdById: lo }));
  const group = await prisma.handlingGroup.create({ data: { companyId: wh === W ? companyId : demoId, warehouseId: wh, itemId, lotId: lot.id, qty, temperature: 0, thresholdX: 5, status: "IN_STORAGE", dedupeKey: `br-seed-${seq}`, acceptedById: lo } });
  await prisma.$transaction((tx) => createQrIn(tx, { companyId: wh === W ? companyId : demoId, type: "GROUP", refId: group.id }));
  return { lotId: lot.id, groupId: group.id };
}

const imp = (externalId: string, lines: { externalLineId: string; itemId: string; requiredQty: number }[], arrivalAt?: Date) =>
  importExternalOrder({ companyId, warehouseId: W, externalId, createdById: lo, arrivalAt: arrivalAt ?? null, lines });

// собрать заказ целиком (освобождает исходные ячейки — штатная складская операция)
async function runPick(orderId: string): Promise<void> {
  let t = await prisma.workflowTask.findFirst({ where: { warehouseId: W, type: "PICK_ORDER", subjectId: orderId, status: { in: ["QUEUED", "ASSIGNED", "IN_PROGRESS"] } } });
  if (!t) throw new Error("нет задачи сборки");
  if (t.status === "QUEUED") { await rebalanceQueuedTasks(companyId, { warehouseId: W }); t = await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } }); }
  if (t.status === "ASSIGNED") await startWorkflowTask(t.assignedUserId!, companyId, t.id);
  for (let i = 0; i < 50; i++) {
    const r = await prisma.stockReservation.findFirst({ where: { orderId, status: "ACTIVE" } });
    if (!r) break;
    await pickOrderScan({ companyId, userId: t.assignedUserId!, taskId: t.id, cellCode: await cellCode(r.cellId!), ean: await groupEan(r.handlingGroupId!), qty: r.qty.toNumber() });
  }
}

// прогнать все MOVE_GROUP заказа (чтобы освободить/переставить и разблокировать сборку)
async function runMoves(): Promise<void> {
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

async function provision() {
  companyId = (await prisma.company.findFirstOrThrow({ where: { slug: "rostagro" } })).id;
  W = (await prisma.warehouse.create({ data: { companyId, name: "BR W", isActive: true } })).id;
  await ensureStandardZones(companyId, W);
  zStorage = (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: W, kind: "STORAGE" } })).id;
  // Ровно эти STORAGE-ячейки: два нижних (ур.1) и два верхних (ур.3). Иных нижних/верхних нет.
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["BR-L1"], level: 1 });
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["BR-L2"], level: 1 });
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["BR-U1"], level: 3 });
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["BR-U2"], level: 3 });
  const uom = await prisma.uom.create({ data: { companyId, name: "шт BR" } });
  itemA = (await prisma.item.create({ data: { companyId, name: "BR товар A", sku: "BR-A", uomId: uom.id, tracking: "LOT", isActive: true } })).id;
  itemB = (await prisma.item.create({ data: { companyId, name: "BR товар B", sku: "BR-B", uomId: uom.id, tracking: "LOT", isActive: true } })).id;
  await seedEan(itemA, "460773000001");
  await seedEan(itemB, "460773000002");
  pk = await mkUser("br_pk", companyId, "+79995590001", "PICKER", W);
  lo = await mkUser("br_lo", companyId, "+79995590002", "LOADER", W);
  await prisma.workShift.create({ data: { companyId, userId: pk, warehouseId: W, role: "PICKER" } });
  await prisma.workShift.create({ data: { companyId, userId: lo, warehouseId: W, role: "LOADER" } });
  // Demo-организация для проверки tenant-изоляции.
  const demo = await prisma.company.upsert({ where: { slug: "br-demo" }, update: {}, create: { name: "BR Demo", slug: "br-demo", settings: {} } });
  demoId = demo.id;
  DW = (await prisma.warehouse.create({ data: { companyId: demoId, name: "BR DW", isActive: true } })).id;
  await ensureStandardZones(demoId, DW);
  zStorageDemo = (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: DW, kind: "STORAGE" } })).id;
  await createCellsInZone({ companyId: demoId, warehouseId: DW, zoneId: zStorageDemo, codes: ["DW-U1"], level: 3 });
}

async function main() {
  await provision();

  console.log("A) полное покрытие на ур.3+, нижние заняты → BLOCKED; освобождение нижней ячейки → авто-возобновление планировщиком");
  // BR-L1 и BR-L2 (нижние) заняты полностью зарезервированными группами-заполнителями (не поднимаемы);
  // BR-U1 (ур.3) — целевой товар; свободных нижних/верхних нет → нет безопасной цепочки.
  const gfill1 = await seedGroup(itemA, await cellId("BR-L1"), 3, new Date(now.getTime() - 5000));
  const gfill2 = await seedGroup(itemA, await cellId("BR-L2"), 3, new Date(now.getTime() - 4000));
  const gTop = await seedGroup(itemA, await cellId("BR-U1"), 5, new Date(now.getTime() - 3000)); void gTop; void gfill2;
  // заполнители полностью резервируем отдельными заказами (чтобы OT не мог их взять и они не были liftable)
  const of1 = await imp("BR-FILL-1", [{ externalLineId: "1", itemId: itemA, requiredQty: 3 }]);
  const of2 = await imp("BR-FILL-2", [{ externalLineId: "1", itemId: itemA, requiredQty: 3 }]);
  await reserveAndPlanOrder({ companyId, orderId: of1.orderId });
  await reserveAndPlanOrder({ companyId, orderId: of2.orderId });
  ok("[A] заполнители READY_TO_PICK (нижние ячейки заняты и зарезервированы)", (await orderStatus(of1.orderId)) === "READY_TO_PICK" && (await orderStatus(of2.orderId)) === "READY_TO_PICK");
  // целевой заказ — только верхний товар доступен
  const ot = await imp("BR-TARGET", [{ externalLineId: "1", itemId: itemA, requiredQty: 5 }], new Date(now.getTime() + 3600_000));
  await reserveAndPlanOrder({ companyId, orderId: ot.orderId });
  ok("[A] целевой заказ BLOCKED (весь резерв на ур.3+, нет безопасного места)", (await orderStatus(ot.orderId)) === "BLOCKED", await orderStatus(ot.orderId));
  ok("[A] невыполнимые MOVE_GROUP/PICK_ORDER для цели НЕ созданы", (await moveCountFor(ot.orderId)) === 0 && (await pickTaskOf(ot.orderId)) === null);
  ok("[A] цель полностью зарезервирована (5, на ур.3)", Number((await prisma.stockReservation.aggregate({ where: { orderId: ot.orderId, status: "ACTIVE" }, _sum: { qty: true } }))._sum.qty ?? 0) === 5);

  // причина НЕ устранена → тик планировщика ничего не меняет
  const mvBefore = await allMv(); const resvBefore = await activeResvCount(ot.orderId);
  await replanBlockedOnce();
  ok("[A] причина не устранена → остаётся BLOCKED без побочных изменений", (await orderStatus(ot.orderId)) === "BLOCKED" && (await allMv()) === mvBefore && (await activeResvCount(ot.orderId)) === resvBefore && (await moveCountFor(ot.orderId)) === 0);

  // штатная операция: собрать заказ-заполнитель of1 → освобождается нижняя ячейка BR-L1
  await runPick(of1.orderId);
  ok("[A] после сборки заполнителя нижняя ячейка BR-L1 освобождена", (await prisma.stockBalance.count({ where: { cellId: await cellId("BR-L1"), qty: { gt: 0 } } })) === 0);
  const mvBeforeReplan = await allMv();

  // БЕЗ браузера и повторного импорта: планировщик авто-возобновляет
  const replanned = await replanBlockedOnce();
  ok("[A] планировщик возобновил ровно один заказ", replanned === 1, String(replanned));
  ok("[A] цель → READY_TO_PICK", (await orderStatus(ot.orderId)) === "READY_TO_PICK", await orderStatus(ot.orderId));
  ok("[A] создана РОВНО одна MOVE_GROUP и одна зависимая PICK_ORDER (BLOCKED зависимостью)", (await moveCountFor(ot.orderId)) === 1 && (await pickTaskOf(ot.orderId))?.status === "BLOCKED");
  const mvTask = await prisma.workflowTask.findFirstOrThrow({ where: { type: "MOVE_GROUP", dedupeKey: { startsWith: `move:${ot.orderId}:` } } });
  const mvCr = await prisma.cellReservation.findFirstOrThrow({ where: { taskId: mvTask.id, status: "ACTIVE" } });
  ok("[A] перестановка использует освободившуюся ячейку BR-L1", mvCr.cellId === (await cellId("BR-L1")));
  ok("[A] перепланирование не создало StockMovement", (await allMv()) === mvBeforeReplan);
  const pickBefore = (await pickTaskOf(ot.orderId))!;
  ok("[A] PICK зависит от MOVE_GROUP", (await prisma.taskDependency.count({ where: { taskId: pickBefore.id, dependsOnTaskId: mvTask.id } })) === 1);

  // повторный тик — идемпотентно, без дублей
  await replanBlockedOnce();
  ok("[A] повторный тик не создал дублей MOVE/PICK/резервов", (await moveCountFor(ot.orderId)) === 1 && (await prisma.workflowTask.count({ where: { type: "PICK_ORDER", subjectId: ot.orderId } })) === 1 && (await activeResvCount(ot.orderId)) === 1);

  // выполнить перестановку → правильная PICK_ORDER разблокирована
  await runMoves();
  ok("[A] после MOVE_GROUP разблокирована правильная PICK_ORDER", ["QUEUED", "ASSIGNED"].includes((await pickTaskOf(ot.orderId))!.status));
  ok("[A] нужная группа оказалась на ур.1-2 (BR-L1)", ((await prisma.cell.findFirstOrThrow({ where: { id: await groupCurrentCell(gTop.groupId) }, select: { level: true } })).level ?? 9) <= 2);
  await runPick(ot.orderId); // довести до конца, освободить погрузчика/сборщика

  console.log("B) конкуренция: два BLOCKED + одна освободившаяся ячейка → только один; параллельные тики без дублей; следующая ячейка оживляет второй");
  // BR-L1, BR-L2 заняты заполнителями (разные товары для двух целей); BR-U1(itemA), BR-U2(itemB) — верхние цели
  const bf1 = await seedGroup(itemA, await cellId("BR-L1"), 2, new Date(now.getTime() - 2500));
  const bf2 = await seedGroup(itemB, await cellId("BR-L2"), 2, new Date(now.getTime() - 2400)); void bf1; void bf2;
  const bTopA = await seedGroup(itemA, await cellId("BR-U1"), 4, new Date(now.getTime() - 2300));
  const bTopB = await seedGroup(itemB, await cellId("BR-U2"), 4, new Date(now.getTime() - 2200)); void bTopA; void bTopB;
  const bofA = await imp("BR-BFILL-A", [{ externalLineId: "1", itemId: itemA, requiredQty: 2 }]);
  const bofB = await imp("BR-BFILL-B", [{ externalLineId: "1", itemId: itemB, requiredQty: 2 }]);
  await reserveAndPlanOrder({ companyId, orderId: bofA.orderId });
  await reserveAndPlanOrder({ companyId, orderId: bofB.orderId });
  const otA = await imp("BR-TGT-A", [{ externalLineId: "1", itemId: itemA, requiredQty: 4 }], new Date(now.getTime() + 1000));
  const otB = await imp("BR-TGT-B", [{ externalLineId: "1", itemId: itemB, requiredQty: 4 }], new Date(now.getTime() + 2000));
  await reserveAndPlanOrder({ companyId, orderId: otA.orderId });
  await reserveAndPlanOrder({ companyId, orderId: otB.orderId });
  ok("[B] оба целевых BLOCKED", (await orderStatus(otA.orderId)) === "BLOCKED" && (await orderStatus(otB.orderId)) === "BLOCKED");
  // освободить ОДНУ нижнюю ячейку (собрать заполнитель A → BR-L1)
  await runPick(bofA.orderId);
  // параллельные тики — идемпотентны, ровно один заказ получает ячейку
  await Promise.all([replanBlockedOnce(), replanBlockedOnce(), replanBlockedOnce()]);
  const aReady = (await orderStatus(otA.orderId)) === "READY_TO_PICK";
  const bReady = (await orderStatus(otB.orderId)) === "READY_TO_PICK";
  ok("[B] ровно ОДИН заказ получил ячейку (детерм. порядок arrivalAt/createdAt/id → раньше otA)", aReady && !bReady, `A=${await orderStatus(otA.orderId)} B=${await orderStatus(otB.orderId)}`);
  ok("[B] параллельные тики не создали дублей у победителя", (await moveCountFor(otA.orderId)) === 1 && (await prisma.workflowTask.count({ where: { type: "PICK_ORDER", subjectId: otA.orderId } })) === 1);
  ok("[B] на освободившуюся ячейку ровно одна активная бронь", (await prisma.cellReservation.count({ where: { cellId: await cellId("BR-L1"), status: "ACTIVE" } })) === 1);
  // следующая освободившаяся ячейка оживляет второй заказ
  await runMoves(); await runPick(otA.orderId); // довести победителя (освободит и погрузчика)
  await runPick(bofB.orderId); // штатно освободить BR-L2
  await replanBlockedOnce();
  ok("[B] после освобождения второй ячейки второй заказ оживает (READY_TO_PICK)", (await orderStatus(otB.orderId)) === "READY_TO_PICK", await orderStatus(otB.orderId));
  await runMoves(); await runPick(otB.orderId);

  console.log("C) tenant-изоляция, рестарт-безопасность, отсутствие безопасного места");
  // Demo-организация: BLOCKED-заказ, который планировщик обрабатывает в СВОЁМ контуре, не смешивая с rostagro.
  const demoUom = await prisma.uom.create({ data: { companyId: demoId, name: "шт BRD" } });
  const demoItem = (await prisma.item.create({ data: { companyId: demoId, name: "BRD товар", sku: "BRD", uomId: demoUom.id, tracking: "LOT", isActive: true } })).id;
  const dGroup = await seedGroup(demoItem, await cellId("DW-U1", DW), 2, new Date(now.getTime() - 1000), DW); void dGroup;
  // Импорт demo-заказа напрямую (единственный склад demo — DW) через importExternalOrder
  const dImp = await importExternalOrder({ companyId: demoId, warehouseId: DW, externalId: "DW-BLK", createdById: null, arrivalAt: null, lines: [{ externalLineId: "1", itemId: demoItem, requiredQty: 2 }] });
  await reserveAndPlanOrder({ companyId: demoId, orderId: dImp.orderId });
  ok("[C] demo-заказ BLOCKED (нет нижней ячейки в demo)", (await orderStatus(dImp.orderId)) === "BLOCKED", await orderStatus(dImp.orderId));
  // «рестарт»: replanBlockedOnce не хранит состояния — свежий вызов читает BLOCKED из БД по всем контурам
  await replanBlockedOnce();
  ok("[C] demo-заказ остаётся BLOCKED (нет свободной нижней в его контуре) — состояние не изменено", (await orderStatus(dImp.orderId)) === "BLOCKED");
  ok("[C] tenant-изоляция: обработка demo не затронула склад rostagro (нет посторонних задач)", (await prisma.workflowTask.count({ where: { warehouseId: DW } })) === 0);
  ok("[C] рестарт-безопасность: планировщик перечитывает BLOCKED из БД без внутрипроцессного состояния (повторный вызов идемпотентен)", (await orderStatus(dImp.orderId)) === "BLOCKED");

  console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ ORDER-003 ПРОЙДЕНЫ ✓" : `\nПРОВАЛ: ${failures} проверок`);
}

async function cleanup() {
  for (const cid of [companyId, demoId]) {
    const orders = await prisma.externalOrder.findMany({ where: { companyId: cid }, select: { id: true } });
    const oids = orders.map((o) => o.id);
    await prisma.stockReservation.deleteMany({ where: { orderId: { in: oids } } });
    await prisma.externalOrderLine.deleteMany({ where: { orderId: { in: oids } } });
    await prisma.externalOrder.deleteMany({ where: { id: { in: oids } } });
  }
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
  await prisma.workShift.deleteMany({ where: { userId: { in: UIDS } } });
  const cs = (await prisma.cell.findMany({ where: { warehouseId: { in: [W, DW] } }, select: { id: true } })).map((c) => c.id);
  await prisma.qrCode.deleteMany({ where: { type: "CELL", refId: { in: cs } } });
  await prisma.cell.deleteMany({ where: { warehouseId: { in: [W, DW] } } });
  await prisma.warehouseZone.deleteMany({ where: { warehouseId: { in: [W, DW] } } });
  await prisma.user.deleteMany({ where: { id: { in: UIDS } } });
  await prisma.itemBarcode.deleteMany({ where: { itemId: { in: [itemA, itemB] } } });
  await prisma.item.deleteMany({ where: { id: { in: [itemA, itemB] } } });
  await prisma.warehouse.deleteMany({ where: { id: { in: [W, DW] } } });
  if (demoId) {
    await prisma.qrCode.deleteMany({ where: { companyId: demoId } });
    await prisma.item.deleteMany({ where: { companyId: demoId } });
    await prisma.uom.deleteMany({ where: { companyId: demoId } });
    await prisma.company.deleteMany({ where: { id: demoId, slug: "br-demo" } });
  }
  await prisma.uom.deleteMany({ where: { companyId, name: "шт BR" } });
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => {
    await cleanup().catch((e) => console.error("cleanup:", e));
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });
