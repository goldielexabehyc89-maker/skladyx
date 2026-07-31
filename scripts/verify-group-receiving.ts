// Проверка Этапа 5/Пакет 4 (групповая приёмка + температурный контроль). Движок тестируется
// напрямую (tsx + prisma). Только dev-БД; тест-данные удаляются в finally.
// Запуск: npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-group-receiving.ts
/* eslint-disable no-console */
import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { createHandlingGroup, completeGroupPlacement, eligibleCellsForGroup } from "@/lib/group-receiving";
import { ensureStandardZones, createCellsInZone } from "@/lib/cells";
import { startWorkflowTask } from "@/lib/workflow-tasks";
import { updateSettings } from "@/lib/settings";

const prisma = new PrismaClient();
let failures = 0;
const ok = (n: string, c: boolean, e = "") => (c ? console.log(`  ✓ ${n}`) : (failures++, console.error(`  ✗ ${n} ${e}`)));
const err = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); return ""; } catch (e) { return (e as Error).message; }
};

let companyId = "", demoId = "", W = "", DW = "";
let zRecv = "", zStorage = "", zCooling = "";
let lotItem = "", unitItem = "", inactiveItem = "", demoItem = "";
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

async function place(loader: string, groupId: string, cellId: string): Promise<string> {
  const t = await taskOf(groupId);
  if (!t) return "нет задачи";
  await startWorkflowTask(loader, companyId, t.id); // ASSIGNED → IN_PROGRESS
  return err(() => completeGroupPlacement({ companyId, userId: loader, taskId: t.id, cellId }));
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
  const groups = await prisma.handlingGroup.findMany({ where: { warehouseId: { in: whs } }, select: { lotId: true } });
  const lotIds = groups.map((g) => g.lotId);
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
  const cells = await prisma.cell.findMany({ where: { warehouseId: { in: whs } }, select: { id: true } });
  await prisma.qrCode.deleteMany({ where: { type: { in: ["CELL", "GROUP"] }, refId: { in: cells.map((c) => c.id) } } });
  await prisma.workShift.deleteMany({ where: { userId: { in: UIDS } } });
  await prisma.cell.deleteMany({ where: { warehouseId: { in: whs } } });
  await prisma.warehouseZone.deleteMany({ where: { warehouseId: { in: whs } } });
  await prisma.user.deleteMany({ where: { id: { in: UIDS } } });
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
  ok("temp<X → AWAITING_STORAGE", (await G(3)).status === "AWAITING_STORAGE");
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

  console.log("13) STORAGE: выбирается минимальный доступный уровень");
  const S1 = (await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["P4S1"], level: 1 }), (await prisma.cell.findFirstOrThrow({ where: { warehouseId: W, code: "P4S1" } })).id);
  const S2 = (await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["P4S2"], level: 2 }), (await prisma.cell.findFirstOrThrow({ where: { warehouseId: W, code: "P4S2" } })).id);
  const gS = await G(3);
  const elig = await eligibleCellsForGroup(companyId, W, "AWAITING_STORAGE");
  ok("рекомендуется нижний уровень (P4S1, level 1)", elig[0]?.code === "P4S1" && elig[0]?.recommended === true);
  ok("размещение в S2 при свободной S1 → отказ", (await place(L1, gS.groupId, S2)).includes("свободная ячейка ниже"));
  ok("размещение в S1 (нижний уровень) → успех", (await place(L1, gS.groupId, S1)) === "");
  ok("после размещения: группа IN_STORAGE", (await prisma.handlingGroup.findUniqueOrThrow({ where: { id: gS.groupId } })).status === "IN_STORAGE");

  console.log("14) занятая/чужая/неверная зона → отказ");
  const gS14 = await G(3);
  ok("размещение в занятую S1 → отказ", (await place(L1, gS14.groupId, S1)).includes("занята"));
  // виртуальная зона RECEIVING как ячейка не существует; неверная зона = COOLING для STORAGE-маршрута
  const C1 = (await createCellsInZone({ companyId, warehouseId: W, zoneId: zCooling, codes: ["P4C1"], level: null }), (await prisma.cell.findFirstOrThrow({ where: { warehouseId: W, code: "P4C1" } })).id);
  ok("STORAGE-группа в COOLING-ячейку → отказ", (await place(L1, gS14.groupId, C1)).includes("зоны хранения"));
  // разместим gS14 в S2, чтобы освободить L1
  ok("gS14 размещена в S2 (следующий уровень)", (await place(L1, gS14.groupId, S2)) === "");

  console.log("15) COOLING: только пустая COOLING-ячейка");
  const gC = await G(8); // AWAITING_COOLING
  ok("COOLING-группа в STORAGE-ячейку → отказ", (await place(L1, gC.groupId, S1)).includes("зоны охлаждения"));
  ok("COOLING-группа в пустую COOLING-ячейку → успех", (await place(L1, gC.groupId, C1)) === "");
  ok("группа IN_COOLING", (await prisma.handlingGroup.findUniqueOrThrow({ where: { id: gC.groupId } })).status === "IN_COOLING");

  console.log("16) полный перенос + завершение задачи атомарны");
  const S3 = (await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["P4S3"], level: 1 }), (await prisma.cell.findFirstOrThrow({ where: { warehouseId: W, code: "P4S3" } })).id);
  const g16 = await G(3, 7);
  ok("размещение g16 в S3 успех", (await place(L1, g16.groupId, S3)) === "");
  const g16row = await prisma.handlingGroup.findUniqueOrThrow({ where: { id: g16.groupId } });
  const recvGone = await bal(g16row.lotId, `Z:${zRecv}`);
  const inCell = await bal(g16row.lotId, `C:${S3}`);
  const t16 = await taskOf(g16.groupId);
  ok("остаток полностью перенесён RECEIVING→ячейку, задача COMPLETED", (!recvGone || recvGone.qty.toNumber() === 0) && !!inCell && inCell.qty.toNumber() === 7 && t16?.status === "COMPLETED");

  console.log("17) две конкурентные попытки занять одну ячейку → успешна одна");
  const C2 = (await createCellsInZone({ companyId, warehouseId: W, zoneId: zCooling, codes: ["P4C2"], level: null }), (await prisma.cell.findFirstOrThrow({ where: { warehouseId: W, code: "P4C2" } })).id);
  await mkShift(L2, "LOADER", W); // второй грузчик
  const ga = await G(9), gb = await G(9); // две COOLING-группы
  const ta = await taskOf(ga.groupId), tb = await taskOf(gb.groupId);
  await freeLoader(L1); // на случай оставшейся IN_PROGRESS от предыдущих блоков
  // назначим/начнём: одна задача L1, другая L2 (движок балансирует; выставим явно для детерминизма)
  await prisma.workflowTask.update({ where: { id: ta!.id }, data: { assignedUserId: L1, assignedShiftId: (await prisma.workShift.findFirstOrThrow({ where: { userId: L1, endedAt: null } })).id } });
  await prisma.workflowTask.update({ where: { id: tb!.id }, data: { assignedUserId: L2, assignedShiftId: (await prisma.workShift.findFirstOrThrow({ where: { userId: L2, endedAt: null } })).id } });
  await startWorkflowTask(L1, companyId, ta!.id);
  await startWorkflowTask(L2, companyId, tb!.id);
  const [ra, rb] = await Promise.all([
    err(() => completeGroupPlacement({ companyId, userId: L1, taskId: ta!.id, cellId: C2 })),
    err(() => completeGroupPlacement({ companyId, userId: L2, taskId: tb!.id, cellId: C2 })),
  ]);
  ok("одна конкурентная попытка успешна, вторая отклонена", (ra === "") !== (rb === ""), `ra="${ra}" rb="${rb}"`);
  ok("в ячейке ровно одна группа", (await prisma.stockBalance.count({ where: { locKey: `C:${C2}`, qty: { gt: 0 } } })) === 1);

  console.log("18) tenant-изоляция");
  await endShifts(L2); // после конкурентного теста снова единственная смена — L1 (детерминизм авто-назначения)
  await freeLoader(L1);
  const gT = await G(3);
  const demoCell = (await createCellsInZone({ companyId: demoId, warehouseId: DW, zoneId: (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: DW, kind: "STORAGE" } })).id, codes: ["DWS1"], level: 1 }), (await prisma.cell.findFirstOrThrow({ where: { warehouseId: DW, code: "DWS1" } })).id);
  ok("размещение в ячейку чужого склада → отказ", (await place(L1, gT.groupId, demoCell)).includes("не найдена на этом складе"));

  console.log("19) инъецированная ошибка → нет частичного остатка/статуса/задачи");
  // повторно занятая ячейка: попытка провалится ПОСЛЕ проверок, до движения — состояние не меняется
  await freeLoader(L1);
  const g19 = await G(3);
  const before = await bal((await prisma.handlingGroup.findUniqueOrThrow({ where: { id: g19.groupId } })).lotId, `Z:${zRecv}`);
  const t19 = await taskOf(g19.groupId);
  await startWorkflowTask(L1, companyId, t19!.id);
  const r19 = await err(() => completeGroupPlacement({ companyId, userId: L1, taskId: t19!.id, cellId: S1 })); // S1 занята
  const after = await bal((await prisma.handlingGroup.findUniqueOrThrow({ where: { id: g19.groupId } })).lotId, `Z:${zRecv}`);
  const g19row = await prisma.handlingGroup.findUniqueOrThrow({ where: { id: g19.groupId } });
  const t19row = await prisma.workflowTask.findUniqueOrThrow({ where: { id: t19!.id } });
  ok("при отказе: остаток в RECEIVING не тронут, группа AWAITING, задача IN_PROGRESS",
    !!r19 && before?.qty.toNumber() === after?.qty.toNumber() && g19row.status === "AWAITING_STORAGE" && t19row.status === "IN_PROGRESS");

  console.log("20) push не создаётся");
  ok("нет push-подписок у тест-пользователей", (await prisma.pushSubscription.count({ where: { userId: { in: UIDS } } })) === 0);
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ P4 ПРОЙДЕНЫ ✓" : `\nПРОВАЛЕНО: ${failures}`);
    process.exit(failures === 0 ? 0 : 1);
  });
