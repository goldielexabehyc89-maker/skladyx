// Проверка Этапа 5/Пакет 4 (групповая приёмка + температурный контроль). Движок тестируется
// напрямую (tsx + prisma). Только dev-БД; тест-данные удаляются в finally.
// Запуск: npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-group-receiving.ts
/* eslint-disable no-console */
import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { createHandlingGroup, completeGroupPlacement, prepareGroupPlacement } from "@/lib/group-receiving";
import { ensureStandardZones, createCellsInZone, assertCellNotHeldByGroup } from "@/lib/cells";
import { startWorkflowTask } from "@/lib/workflow-tasks";
import { updateSettings } from "@/lib/settings";
import { applyLotMovement } from "@/lib/stock";

const prisma = new PrismaClient();
let failures = 0;
const ok = (n: string, c: boolean, e = "") => (c ? console.log(`  ✓ ${n}`) : (failures++, console.error(`  ✗ ${n} ${e}`)));
const err = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); return ""; } catch (e) { return (e as Error).message; }
};

let companyId = "", demoId = "", W = "", DW = "";
let zRecv = "", zStorage = "", zCooling = "";
let lotItem = "", unitItem = "", inactiveItem = "", demoItem = "";
const itemEan = new Map<string, string>();
const eanOf = (itemId: string) => itemEan.get(itemId)!;
function ean13(b12: string): string { let s = 0; for (let i = b12.length - 1, k = 0; i >= 0; i--, k++) s += Number(b12[i]) * (k % 2 === 0 ? 3 : 1); return b12 + String((10 - (s % 10)) % 10); }
let RUSER = "", L1 = "", L2 = "";
const UIDS: string[] = [];
let seq = 0;
const dk = () => `p4-${Date.now()}-${++seq}`;

async function mkUser(id: string, cid: string, phone: string, role: Role, wh: string) {
  await prisma.user.deleteMany({ where: { id } });
  await prisma.user.create({
    data: {
      id, companyId: cid, phone, name: id, role, isActive: true, allWarehouses: false,
      passwordHash: await bcrypt.hash("p4pass", 10),
      userRoles: { create: { role } },
      warehouseLinks: { create: { warehouseId: wh } },
    },
  });
  UIDS.push(id);
  return id;
}
const endShifts = (userId: string) => prisma.workShift.updateMany({ where: { userId, endedAt: null }, data: { endedAt: new Date() } });
// тест-хелпер: освободить грузчика (провальные негативные размещения оставляют задачу
// IN_PROGRESS; partial-unique мешает старту следующей — возвращаем в ASSIGNED).
const freeLoader = (userId: string) => prisma.workflowTask.updateMany({ where: { assignedUserId: userId, status: "IN_PROGRESS" }, data: { status: "ASSIGNED" } });
const mkShift = (userId: string, role: Role, wh: string) => prisma.workShift.create({ data: { companyId, userId, warehouseId: wh, role } });
const taskOf = (groupId: string) => prisma.workflowTask.findFirst({ where: { subjectId: groupId, type: "PLACE_GROUP" } });
const bal = (lotId: string, locKey: string) => prisma.stockBalance.findFirst({ where: { lotId, locKey } });

// обычная партия с остатком на складе (для имитации «старой операции» размещения)
async function mkWarehouseLot(qty: number): Promise<string> {
  const rcpt = await prisma.receipt.create({ data: { companyId, number: 990000 + ++seq, warehouseId: W, status: "POSTED", createdById: RUSER } });
  const rline = await prisma.receiptLine.create({ data: { companyId, receiptId: rcpt.id, itemId: lotItem, qty } });
  const lot = await prisma.lot.create({ data: { companyId, itemId: lotItem, receiptLineId: rline.id, qtyReceived: qty } });
  await prisma.$transaction((tx) => applyLotMovement(tx, { companyId, docType: "RECEIPT", docId: rcpt.id, itemId: lotItem, lotId: lot.id, qty, from: null, to: { kind: "warehouse", warehouseId: W }, createdById: RUSER }));
  return lot.id;
}
// «старая операция»: как scan.ts — assertCellNotHeldByGroup + движение партии склад→ячейку
async function oldOpPlace(cellId: string, lotId: string): Promise<string> {
  return err(() => prisma.$transaction(async (tx) => {
    await assertCellNotHeldByGroup(tx, companyId, cellId);
    const b = await tx.stockBalance.findFirst({ where: { lotId, locKey: `W:${W}`, qty: { gt: 0 } } });
    if (!b) throw new Error("нет остатка на складе");
    await applyLotMovement(tx, { companyId, docType: "CELL_ASSIGN", docId: cellId, itemId: lotItem, lotId, qty: b.qty, from: { kind: "warehouse", warehouseId: W }, to: { kind: "cell", warehouseId: W, cellId }, createdById: L1 });
  }));
}

// Пакет 9B: размещение принимает отсканированный код ячейки (QR/Code128), не сырой id
const cellQr = async (cid: string) => (await prisma.qrCode.findFirstOrThrow({ where: { type: "CELL", refId: cid } })).code;
// Пакет 11 (коррекция): начать задачу (если ещё не в работе) и получить НАЗНАЧЕННУЮ системой ячейку.
async function startAndPrepare(loader: string, groupId: string): Promise<{ taskId: string; cellId: string; cellCode: string }> {
  const t = await taskOf(groupId);
  if (!t) throw new Error("нет задачи");
  if (t.status !== "IN_PROGRESS") await startWorkflowTask(loader, companyId, t.id);
  const r = await prepareGroupPlacement({ companyId, userId: loader, taskId: t.id });
  return { taskId: t.id, cellId: r.cellId, cellCode: r.cellCode };
}
// Размещение в НАЗНАЧЕННУЮ ячейку (успех-путь).
async function placeAssigned(loader: string, groupId: string): Promise<string> {
  return err(async () => {
    const a = await startAndPrepare(loader, groupId);
    await completeGroupPlacement({ companyId, userId: loader, taskId: a.taskId, cellCode: await cellQr(a.cellId), ean: eanOf(lotItem) });
  });
}

async function provision() {
  companyId = (await prisma.company.findFirstOrThrow({ where: { slug: "rostagro" } })).id;
  W = (await prisma.warehouse.create({ data: { companyId, name: "P4 W", isActive: true } })).id;
  await ensureStandardZones(companyId, W);
  zRecv = (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: W, kind: "RECEIVING" } })).id;
  zStorage = (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: W, kind: "STORAGE" } })).id;
  zCooling = (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: W, kind: "COOLING" } })).id;
  const uom = await prisma.uom.create({ data: { companyId, name: "шт P4" } });
  lotItem = (await prisma.item.create({ data: { companyId, name: "P4 партионный", sku: "P4-LOT", uomId: uom.id, tracking: "LOT", isActive: true } })).id;
  { const code = ean13("460774000001"); await prisma.itemBarcode.create({ data: { companyId, itemId: lotItem, code, symbology: "EAN13", source: "MANUAL" } }); itemEan.set(lotItem, code); }
  unitItem = (await prisma.item.create({ data: { companyId, name: "P4 поштучный", uomId: uom.id, tracking: "UNIT", isActive: true } })).id;
  inactiveItem = (await prisma.item.create({ data: { companyId, name: "P4 неактивный", uomId: uom.id, tracking: "LOT", isActive: false } })).id;
  const demo = await prisma.company.upsert({ where: { slug: "p4-demo" }, update: {}, create: { name: "P4 Demo", slug: "p4-demo", settings: {} } });
  demoId = demo.id;
  DW = (await prisma.warehouse.create({ data: { companyId: demoId, name: "P4 DW", isActive: true } })).id;
  await ensureStandardZones(demoId, DW);
  const duom = await prisma.uom.create({ data: { companyId: demoId, name: "шт" } });
  demoItem = (await prisma.item.create({ data: { companyId: demoId, name: "demo item", uomId: duom.id, tracking: "LOT", isActive: true } })).id;
  RUSER = await mkUser("p4_r", companyId, "+79995550001", "RECEIVER", W);
  L1 = await mkUser("p4_l1", companyId, "+79995550002", "LOADER", W);
  L2 = await mkUser("p4_l2", companyId, "+79995550003", "LOADER", W);
  await mkShift(L1, "LOADER", W); // активная смена грузчика — задачи PLACE_GROUP авто-назначаются L1
}

async function cleanup() {
  const whs = [W, DW].filter(Boolean);
  // Пакет 11: брони размещения (CellReservation по taskId/handlingGroupId) — у cellId нет FK, чистим явно
  await prisma.cellReservation.deleteMany({ where: { warehouseId: { in: whs } } });
  const groups = await prisma.handlingGroup.findMany({ where: { warehouseId: { in: whs } }, select: { id: true, lotId: true } });
  const lotIds = groups.map((g) => g.lotId);
  // Пакет 11: события Ленты, порождённые тест-группами (стабильные ключи) — чистим по ключу
  await prisma.event.deleteMany({
    where: { key: { in: groups.flatMap((g) => [`group_received:${g.id}`, `group_placed:${g.id}`, `group_cooling:${g.id}`]) } },
  });
  await prisma.workflowTask.deleteMany({ where: { warehouseId: { in: whs }, type: "PLACE_GROUP" } });
  await prisma.handlingGroup.deleteMany({ where: { warehouseId: { in: whs } } });
  await prisma.stockMovement.deleteMany({ where: { OR: [{ fromZoneId: { in: [zRecv, zStorage, zCooling] } }, { toZoneId: { in: [zRecv, zStorage, zCooling] } }, { lotId: { in: lotIds } }] } });
  await prisma.stockBalance.deleteMany({ where: { lotId: { in: lotIds } } });
  if (lotIds.length) {
    const lls = await prisma.lot.findMany({ where: { id: { in: lotIds } }, select: { receiptLineId: true } });
    const rlIds = lls.map((l) => l.receiptLineId);
    await prisma.lot.deleteMany({ where: { id: { in: lotIds } } });
    const recs = await prisma.receiptLine.findMany({ where: { id: { in: rlIds } }, select: { receiptId: true } });
    await prisma.receiptLine.deleteMany({ where: { id: { in: rlIds } } });
    await prisma.receipt.deleteMany({ where: { id: { in: [...new Set(recs.map((r) => r.receiptId))] } } });
  }
  // Любые приёмки на тест-складах (createHandlingGroup + mkWarehouseLot) — полная чистка, иначе FK
  // (Receipt.warehouseId) не даст удалить склад и приёмки накопятся между прогонами.
  const whReceipts = await prisma.receipt.findMany({ where: { warehouseId: { in: whs } }, select: { id: true } });
  const whReceiptIds = whReceipts.map((r) => r.id);
  if (whReceiptIds.length) {
    const whLines = await prisma.receiptLine.findMany({ where: { receiptId: { in: whReceiptIds } }, select: { id: true } });
    const whLineIds = whLines.map((l) => l.id);
    const whLots = await prisma.lot.findMany({ where: { receiptLineId: { in: whLineIds } }, select: { id: true } });
    const whLotIds = whLots.map((l) => l.id);
    await prisma.stockMovement.deleteMany({ where: { lotId: { in: whLotIds } } });
    await prisma.stockBalance.deleteMany({ where: { lotId: { in: whLotIds } } });
    await prisma.lot.deleteMany({ where: { id: { in: whLotIds } } });
    await prisma.receiptLine.deleteMany({ where: { id: { in: whLineIds } } });
    await prisma.receipt.deleteMany({ where: { id: { in: whReceiptIds } } });
  }
  // подстраховка: любые остатки/движения на тест-складах (в т.ч. инъекции в тестах)
  await prisma.stockMovement.deleteMany({ where: { OR: [{ fromWarehouseId: { in: whs } }, { toWarehouseId: { in: whs } }] } });
  await prisma.stockBalance.deleteMany({ where: { warehouseId: { in: whs } } });
  const cells = await prisma.cell.findMany({ where: { warehouseId: { in: whs } }, select: { id: true } });
  await prisma.qrCode.deleteMany({ where: { type: { in: ["CELL", "GROUP"] }, refId: { in: cells.map((c) => c.id) } } });
  await prisma.workShift.deleteMany({ where: { userId: { in: UIDS } } });
  await prisma.cell.deleteMany({ where: { warehouseId: { in: whs } } });
  await prisma.warehouseZone.deleteMany({ where: { warehouseId: { in: whs } } });
  await prisma.user.deleteMany({ where: { id: { in: UIDS } } });
  await prisma.itemBarcode.deleteMany({ where: { itemId: { in: [lotItem, unitItem, inactiveItem] } } });
  await prisma.item.deleteMany({ where: { id: { in: [lotItem, unitItem, inactiveItem] } } });
  await prisma.warehouse.deleteMany({ where: { id: W } });
  if (demoId) {
    await prisma.item.deleteMany({ where: { companyId: demoId } });
    await prisma.uom.deleteMany({ where: { companyId: demoId } });
    await prisma.warehouseZone.deleteMany({ where: { companyId: demoId } });
    await prisma.warehouse.deleteMany({ where: { companyId: demoId } });
    await prisma.company.deleteMany({ where: { id: demoId, slug: "p4-demo" } });
  }
  await prisma.uom.deleteMany({ where: { companyId, name: "шт P4" } });
  await updateSettings(companyId, { tempThresholdX: null });
}

async function main() {
  await provision();
  const G = (temp: number, qty = 4, item = lotItem) =>
    createHandlingGroup({ companyId, warehouseId: W, itemId: item, qty, temperature: temp, acceptedById: RUSER, dedupeKey: dk() });

  console.log("1) нет X → приёмка запрещена");
  await updateSettings(companyId, { tempThresholdX: null });
  ok("без порога X приёмка отклонена", (await err(() => G(3))).includes("Порог температуры X не настроен"));

  await updateSettings(companyId, { tempThresholdX: 5 }); // X = 5°C

  console.log("2–4) маршрут по температуре (X=5, равенство → STORAGE)");
  // Пакет 9B: новая группа приёмки НЕ получает собственный GROUP QR (товар определяется EAN).
  const gNoQr = await G(3);
  ok("temp<X → AWAITING_STORAGE", gNoQr.status === "AWAITING_STORAGE");
  ok("Пакет 9B: у новой группы нет GROUP QR", (await prisma.qrCode.count({ where: { type: "GROUP", refId: gNoQr.groupId } })) === 0 && gNoQr.qrCode === null);
  ok("temp==X → AWAITING_STORAGE", (await G(5)).status === "AWAITING_STORAGE");
  ok("temp>X → AWAITING_COOLING", (await G(8)).status === "AWAITING_COOLING");

  console.log("5) количество 0/отрицательное/дробное → отказ");
  ok("qty=0 отказ", !!(await err(() => G(3, 0))));
  ok("qty<0 отказ", !!(await err(() => G(3, -2))));
  ok("qty дробное отказ", !!(await err(() => G(3, 1.5))));

  console.log("6) неактивный/чужой товар → отказ");
  ok("неактивный товар отказ", !!(await err(() => G(3, 4, inactiveItem))));
  ok("чужой товар (demo) отказ", !!(await err(() => G(3, 4, demoItem))));

  console.log("7) TrackingType=UNIT → понятный отказ");
  ok("поштучный товар — понятный отказ", (await err(() => G(3, 4, unitItem))).includes("поштучного учёта"));

  console.log("8) идемпотентность dedupeKey → одна группа/Lot/остаток/задача");
  const idk = dk();
  const g8a = await createHandlingGroup({ companyId, warehouseId: W, itemId: lotItem, qty: 4, temperature: 3, acceptedById: RUSER, dedupeKey: idk });
  const g8b = await createHandlingGroup({ companyId, warehouseId: W, itemId: lotItem, qty: 4, temperature: 3, acceptedById: RUSER, dedupeKey: idk });
  ok("повтор dedupeKey → та же группа, created=false", g8a.groupId === g8b.groupId && g8a.created && !g8b.created);
  const grp8 = await prisma.handlingGroup.findUniqueOrThrow({ where: { id: g8a.groupId } });
  ok("одна группа с этим dedupeKey", (await prisma.handlingGroup.count({ where: { companyId, dedupeKey: grp8.dedupeKey } })) === 1);
  ok("один Lot / один остаток / одна задача", (await prisma.stockBalance.count({ where: { lotId: grp8.lotId } })) === 1 && (await prisma.workflowTask.count({ where: { subjectId: g8a.groupId } })) === 1);
  // Пакет 11: событие «Приёмка группы» идемпотентно — стабильный ключ, повтор не пишет второе Event и не меняет время
  const rcvKey = `group_received:${g8a.groupId}`;
  const rEv1 = await prisma.event.findMany({ where: { companyId, type: "group_received", key: rcvKey } });
  ok("group_received: ровно одно событие (стабильный ключ)", rEv1.length === 1);
  const rT1 = rEv1[0]?.createdAt.getTime();
  await createHandlingGroup({ companyId, warehouseId: W, itemId: lotItem, qty: 4, temperature: 3, acceptedById: RUSER, dedupeKey: idk }); // точный повтор
  const rEv2 = await prisma.event.findMany({ where: { companyId, type: "group_received", key: rcvKey } });
  ok("group_received: повтор не создаёт второе событие", rEv2.length === 1);
  ok("group_received: время первого события не изменилось", rEv2[0]?.createdAt.getTime() === rT1);

  console.log("9–10) остаток в Z:<receiving> и приход null→RECEIVING в ledger");
  const b9 = await bal(grp8.lotId, `Z:${zRecv}`);
  ok("остаток в зоне RECEIVING (Z:<zoneId>)", !!b9 && b9.qty.toNumber() === 4 && b9.zoneId === zRecv);
  const mv = await prisma.stockMovement.findFirst({ where: { lotId: grp8.lotId, docType: "RECEIPT" } });
  ok("ledger: приход null→RECEIVING", !!mv && mv.fromWarehouseId === null && mv.fromCellId === null && mv.fromZoneId === null && mv.toZoneId === zRecv);

  console.log("11–12) задача LOADER: описание (время/кол-во/темп) + авто-назначение");
  const t8 = await taskOf(g8a.groupId);
  ok("задача PLACE_GROUP с описанием (кол-во и температура)", !!t8 && !!t8.description && t8.description.includes("4 шт") && t8.description.includes("3°C") && t8.description.includes("Приёмка"));
  await endShifts(L2); // все задачи идут на L1 в последовательных тестах
  const g12 = await G(3);
  const t12 = await taskOf(g12.groupId);
  ok("задача авто-назначена LOADER-смене (движок очереди)", !!t12 && t12.assignedUserId === L1 && t12.status === "ASSIGNED");

  console.log("13) STORAGE: система назначает минимальный доступный уровень; чужую ячейку отклоняет");
  const S1 = (await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["P4S1"], level: 1 }), (await prisma.cell.findFirstOrThrow({ where: { warehouseId: W, code: "P4S1" } })).id);
  const S2 = (await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["P4S2"], level: 2 }), (await prisma.cell.findFirstOrThrow({ where: { warehouseId: W, code: "P4S2" } })).id);
  const gS = await G(3);
  const a13 = await startAndPrepare(L1, gS.groupId);
  ok("система назначила минимальный уровень (P4S1)", a13.cellCode === "P4S1", a13.cellCode);
  const wrong13 = await err(async () => completeGroupPlacement({ companyId, userId: L1, taskId: a13.taskId, cellCode: await cellQr(S2), ean: eanOf(lotItem) }));
  ok("скан НЕ назначенной ячейки (S2) → отказ", wrong13.includes("не назначенная"), wrong13);
  const okPlace13 = await err(async () => completeGroupPlacement({ companyId, userId: L1, taskId: a13.taskId, cellCode: await cellQr(S1), ean: eanOf(lotItem) }));
  ok("размещение в назначенную (S1) → успех", okPlace13 === "", okPlace13);
  ok("после размещения: группа IN_STORAGE", (await prisma.handlingGroup.findUniqueOrThrow({ where: { id: gS.groupId } })).status === "IN_STORAGE");
  // Пакет 11: событие «Размещение» идемпотентно — стабильный ключ; повтор отклоняется, второе Event не пишется.
  const plKey = `group_placed:${gS.groupId}`;
  const pEv1 = await prisma.event.findMany({ where: { companyId, type: "group_placed", key: plKey } });
  ok("group_placed: ровно одно событие (стабильный ключ)", pEv1.length === 1);
  const pT1 = pEv1[0]?.createdAt.getTime();
  await err(async () => completeGroupPlacement({ companyId, userId: L1, taskId: a13.taskId, cellCode: await cellQr(S1), ean: eanOf(lotItem) }));
  const pEv2 = await prisma.event.findMany({ where: { companyId, type: "group_placed", key: plKey } });
  ok("group_placed: повтор не создаёт второе событие", pEv2.length === 1);
  ok("group_placed: время первого события не изменилось", pEv2[0]?.createdAt.getTime() === pT1);

  console.log("14) занятая ячейка исключается из назначения (следующий уровень)");
  const C1 = (await createCellsInZone({ companyId, warehouseId: W, zoneId: zCooling, codes: ["P4C1"], level: null }), (await prisma.cell.findFirstOrThrow({ where: { warehouseId: W, code: "P4C1" } })).id);
  const gS14 = await G(3);
  const a14 = await startAndPrepare(L1, gS14.groupId);
  ok("S1 занята → система назначает следующий уровень (P4S2)", a14.cellCode === "P4S2", a14.cellCode);
  ok("gS14 размещена в назначенную (S2) → успех", (await err(async () => completeGroupPlacement({ companyId, userId: L1, taskId: a14.taskId, cellCode: await cellQr(S2), ean: eanOf(lotItem) }))) === "");

  console.log("15) COOLING: система назначает COOLING-ячейку (флаг охлаждения off → простой IN_COOLING)");
  const gC = await G(8); // AWAITING_COOLING
  const aC = await startAndPrepare(L1, gC.groupId);
  ok("назначена COOLING-ячейка (P4C1)", aC.cellCode === "P4C1", aC.cellCode);
  const wrongC = await err(async () => completeGroupPlacement({ companyId, userId: L1, taskId: aC.taskId, cellCode: await cellQr(S1), ean: eanOf(lotItem) }));
  ok("скан НЕ назначенной (STORAGE) ячейки → отказ", wrongC.includes("не назначенная"), wrongC);
  ok("размещение в назначенную COOLING-ячейку → успех", (await err(async () => completeGroupPlacement({ companyId, userId: L1, taskId: aC.taskId, cellCode: await cellQr(C1), ean: eanOf(lotItem) }))) === "");
  ok("группа IN_COOLING", (await prisma.handlingGroup.findUniqueOrThrow({ where: { id: gC.groupId } })).status === "IN_COOLING");

  console.log("16) полный перенос + завершение задачи атомарны (в назначенную ячейку)");
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["P4S3"], level: 1 });
  const g16 = await G(3, 7);
  const a16 = await startAndPrepare(L1, g16.groupId);
  ok("g16 размещена в назначенную ячейку успех", (await err(async () => completeGroupPlacement({ companyId, userId: L1, taskId: a16.taskId, cellCode: await cellQr(a16.cellId), ean: eanOf(lotItem) }))) === "");
  const g16row = await prisma.handlingGroup.findUniqueOrThrow({ where: { id: g16.groupId } });
  const recvGone = await bal(g16row.lotId, `Z:${zRecv}`);
  const inCell = await bal(g16row.lotId, `C:${a16.cellId}`);
  const t16 = await taskOf(g16.groupId);
  ok("остаток полностью перенесён RECEIVING→назначенную ячейку, задача COMPLETED", (!recvGone || recvGone.qty.toNumber() === 0) && !!inCell && inCell.qty.toNumber() === 7 && t16?.status === "COMPLETED");

  console.log("17) две конкурентные группы получают РАЗНЫЕ назначенные ячейки");
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["P4S4", "P4S5"], level: 1 }); // две свободные ячейки
  await mkShift(L2, "LOADER", W); // второй грузчик
  const ga = await G(3), gb = await G(3); // две STORAGE-группы
  const ta = await taskOf(ga.groupId), tb = await taskOf(gb.groupId);
  await freeLoader(L1);
  await prisma.workflowTask.update({ where: { id: ta!.id }, data: { assignedUserId: L1, assignedShiftId: (await prisma.workShift.findFirstOrThrow({ where: { userId: L1, endedAt: null } })).id } });
  await prisma.workflowTask.update({ where: { id: tb!.id }, data: { assignedUserId: L2, assignedShiftId: (await prisma.workShift.findFirstOrThrow({ where: { userId: L2, endedAt: null } })).id } });
  await startWorkflowTask(L1, companyId, ta!.id);
  await startWorkflowTask(L2, companyId, tb!.id);
  const pa = await prepareGroupPlacement({ companyId, userId: L1, taskId: ta!.id });
  const pb = await prepareGroupPlacement({ companyId, userId: L2, taskId: tb!.id });
  ok("две группы → разные назначенные ячейки", pa.cellId !== pb.cellId, `${pa.cellCode}/${pb.cellCode}`);
  const [ra, rb] = await Promise.all([
    err(async () => completeGroupPlacement({ companyId, userId: L1, taskId: ta!.id, cellCode: await cellQr(pa.cellId), ean: eanOf(lotItem) })),
    err(async () => completeGroupPlacement({ companyId, userId: L2, taskId: tb!.id, cellCode: await cellQr(pb.cellId), ean: eanOf(lotItem) })),
  ]);
  ok("обе группы размещены в свои назначенные ячейки", ra === "" && rb === "", `ra="${ra}" rb="${rb}"`);

  console.log("18) tenant-изоляция: скан ячейки чужого склада отклоняется");
  await endShifts(L2);
  await freeLoader(L1);
  // пул свободных STORAGE-ячеек для последующих назначений (18/19/22)
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["P4S6", "P4S7", "P4S8", "P4S9"], level: 1 });
  const gT = await G(3);
  const aT = await startAndPrepare(L1, gT.groupId);
  const demoCell = (await createCellsInZone({ companyId: demoId, warehouseId: DW, zoneId: (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: DW, kind: "STORAGE" } })).id, codes: ["DWS1"], level: 1 }), (await prisma.cell.findFirstOrThrow({ where: { warehouseId: DW, code: "DWS1" } })).id);
  ok("скан ячейки чужого склада → отказ", /не код ячейки этой организации|не назначенная/.test(await err(async () => completeGroupPlacement({ companyId, userId: L1, taskId: aT.taskId, cellCode: await cellQr(demoCell), ean: eanOf(lotItem) }))));

  console.log("19) инъецированная ошибка (назначенная ячейка занята) → нет частичного состояния");
  await freeLoader(L1);
  const g19 = await G(3);
  const a19 = await startAndPrepare(L1, g19.groupId);
  // тест-манипуляция: имитируем занятие НАЗНАЧЕННОЙ ячейки посторонним остатком (гонка), минуя
  // проверку брони — прямой вставкой StockBalance. Ожидаем отказ на проверке занятости под локом.
  await prisma.stockBalance.create({ data: { companyId, itemId: lotItem, lotId: `inj-${a19.taskId}`, locKey: `C:${a19.cellId}`, warehouseId: W, cellId: a19.cellId, qty: 1 } });
  const before = await bal((await prisma.handlingGroup.findUniqueOrThrow({ where: { id: g19.groupId } })).lotId, `Z:${zRecv}`);
  const r19 = await err(async () => completeGroupPlacement({ companyId, userId: L1, taskId: a19.taskId, cellCode: await cellQr(a19.cellId), ean: eanOf(lotItem) }));
  const after = await bal((await prisma.handlingGroup.findUniqueOrThrow({ where: { id: g19.groupId } })).lotId, `Z:${zRecv}`);
  const g19row = await prisma.handlingGroup.findUniqueOrThrow({ where: { id: g19.groupId } });
  const t19row = await prisma.workflowTask.findUniqueOrThrow({ where: { id: a19.taskId } });
  ok("при отказе: остаток в RECEIVING не тронут, группа AWAITING, задача IN_PROGRESS",
    r19.includes("занята") && before?.qty.toNumber() === after?.qty.toNumber() && g19row.status === "AWAITING_STORAGE" && t19row.status === "IN_PROGRESS", r19);

  console.log("20) push не создаётся");
  ok("нет push-подписок у тест-пользователей", (await prisma.pushSubscription.count({ where: { userId: { in: UIDS } } })) === 0);

  console.log("21) «одна ячейка = одна группа»: старые операции не докладывают в ячейку с группой");
  // назначенная ячейка a16.cellId содержит g16 (IN_STORAGE) из блока 16
  const held = await err(() => prisma.$transaction((t) => assertCellNotHeldByGroup(t, companyId, a16.cellId)));
  ok("ячейка с размещённой группой → старая операция отклонена", held.includes("занята группой"), held);
  const emptyCode = "P4EMPTY";
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: [emptyCode], level: 1 });
  const emptyCell = (await prisma.cell.findFirstOrThrow({ where: { warehouseId: W, code: emptyCode } })).id;
  const freeChk = await err(() => prisma.$transaction((t) => assertCellNotHeldByGroup(t, companyId, emptyCell)));
  ok("пустая ячейка → старая операция разрешена", freeChk === "", freeChk);

  console.log("22) размещение отклоняется при несовпадении остатка в RECEIVING с количеством группы");
  await freeLoader(L1);
  const g22 = await G(3, 5);
  const a22 = await startAndPrepare(L1, g22.groupId);
  const g22row = await prisma.handlingGroup.findUniqueOrThrow({ where: { id: g22.groupId } });
  // тест-манипуляция: имитируем расхождение остатка в зоне приёмки (5 → 4)
  await prisma.stockBalance.updateMany({ where: { lotId: g22row.lotId, locKey: `Z:${zRecv}` }, data: { qty: 4 } });
  const r22 = await err(async () => completeGroupPlacement({ companyId, userId: L1, taskId: a22.taskId, cellCode: await cellQr(a22.cellId), ean: eanOf(lotItem) }));
  ok("несовпадение остатка → размещение отклонено", r22.includes("не совпадает"), r22);
  ok("после отказа: группа AWAITING, в назначенную ячейку ничего не перенесено",
    (await prisma.handlingGroup.findUniqueOrThrow({ where: { id: g22.groupId } })).status === "AWAITING_STORAGE" &&
    (await bal(g22row.lotId, `C:${a22.cellId}`)) === null);

  console.log("23) гонка: старая операция и размещение группы за назначенную ячейку — успех один");
  await freeLoader(L1);
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zCooling, codes: ["P4RACE"], level: null });
  const gRace = await G(9); // AWAITING_COOLING
  const aRace = await startAndPrepare(L1, gRace.groupId); // назначит единственную свободную COOLING-ячейку (P4RACE)
  const LL = await mkWarehouseLot(2);
  const qrCC = await cellQr(aRace.cellId);
  const [rGroup, rOld] = await Promise.all([
    err(async () => completeGroupPlacement({ companyId, userId: L1, taskId: aRace.taskId, cellCode: qrCC, ean: eanOf(lotItem) })),
    oldOpPlace(aRace.cellId, LL),
  ]);
  ok("успешна ровно одна операция (вторая отклонена)", (rGroup === "") !== (rOld === ""), `group="${rGroup}" old="${rOld}"`);
  ok("в ячейке ровно одна позиция (одна партия qty>0)", (await prisma.stockBalance.count({ where: { locKey: `C:${aRace.cellId}`, qty: { gt: 0 } } })) === 1);
  // очистка вспомогательной партии LL
  await prisma.stockMovement.deleteMany({ where: { lotId: LL } });
  await prisma.stockBalance.deleteMany({ where: { lotId: LL } });
  const llRl = (await prisma.lot.findUnique({ where: { id: LL }, select: { receiptLineId: true } }))?.receiptLineId;
  await prisma.lot.deleteMany({ where: { id: LL } });
  if (llRl) {
    const rid = (await prisma.receiptLine.findUnique({ where: { id: llRl }, select: { receiptId: true } }))?.receiptId;
    await prisma.receiptLine.deleteMany({ where: { id: llRl } });
    if (rid) await prisma.receipt.deleteMany({ where: { id: rid } });
  }
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ P4 ПРОЙДЕНЫ ✓" : `\nПРОВАЛЕНО: ${failures}`);
    process.exit(failures === 0 ? 0 : 1);
  });
