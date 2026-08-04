// Проверка Этапа 5/Пакет 5 (охлаждение + срочный забор). Движок напрямую (tsx + prisma).
// Требует COOLING_WORKFLOW_ENABLED=true в окружении (иначе completeGroupPlacement не стартует
// сессию). Только dev-БД; тест-данные удаляются в finally.
// Запуск: COOLING_WORKFLOW_ENABLED=true npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-cooling.ts
/* eslint-disable no-console */
import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { createHandlingGroup, completeGroupPlacement } from "@/lib/group-receiving";
import { completeCoolingRetrieval, estimateReadyAt } from "@/lib/cooling";
import { ensureStandardZones, createCellsInZone, assertCellNotHeldByGroup } from "@/lib/cells";
import { startWorkflowTask, rebalanceQueuedTasks } from "@/lib/workflow-tasks";
import { updateSettings } from "@/lib/settings";

const prisma = new PrismaClient();
let failures = 0;
const ok = (n: string, c: boolean, e = "") => (c ? console.log(`  ✓ ${n}`) : (failures++, console.error(`  ✗ ${n} ${e}`)));
const err = async (fn: () => Promise<unknown>) => { try { await fn(); return ""; } catch (e) { return (e as Error).message; } };

let companyId = "", demoId = "", W = "", DW = "";
let zRecv = "", zStorage = "", zCooling = "";
let S1 = "", S2 = "", S3 = "", S3b = "", C1 = "", C2 = "";
let lotItem = "", RUSER = "", L1 = "", L2 = "";
const UIDS: string[] = [];
let seq = 0;
const dk = () => `p5-${Date.now()}-${++seq}`;

async function mkUser(id: string, cid: string, phone: string, role: Role, wh: string) {
  await prisma.user.deleteMany({ where: { id } });
  await prisma.user.create({ data: { id, companyId: cid, phone, name: id, role, isActive: true, allWarehouses: false, passwordHash: await bcrypt.hash("p5", 10), userRoles: { create: { role } }, warehouseLinks: { create: { warehouseId: wh } } } });
  UIDS.push(id);
  return id;
}
const mkShift = (userId: string, role: Role, wh: string) => prisma.workShift.create({ data: { companyId, userId, warehouseId: wh, role } });
const cellId = async (code: string, wh = W) => (await prisma.cell.findFirstOrThrow({ where: { warehouseId: wh, code } })).id;
const placeTaskOf = (groupId: string) => prisma.workflowTask.findFirst({ where: { subjectId: groupId, type: "PLACE_GROUP" } });
const retrieveTaskOf = (sessionId: string) => prisma.workflowTask.findFirst({ where: { subjectId: sessionId, type: "RETRIEVE_COOLING", status: { in: ["QUEUED", "ASSIGNED", "IN_PROGRESS"] } }, orderBy: { createdAt: "desc" } });
const bal = (lotId: string, locKey: string) => prisma.stockBalance.findFirst({ where: { lotId, locKey } });

const mkGroup = (temp: number, qty = 4) => createHandlingGroup({ companyId, warehouseId: W, itemId: lotItem, qty, temperature: temp, acceptedById: RUSER, dedupeKey: dk() });
// поставить группу в ячейку через реальный поток (PLACE_GROUP: назначить→начать→завершить)
async function place(loader: string, groupId: string, cell: string): Promise<string> {
  const t = await placeTaskOf(groupId);
  if (!t) return "нет задачи размещения";
  await startWorkflowTask(loader, companyId, t.id);
  return err(() => completeGroupPlacement({ companyId, userId: loader, taskId: t.id, cellId: cell }));
}
// активировать наступившую отложенную задачу (тест: сдвигаем срок в прошлое) и назначить
async function makeDue(taskId: string) {
  await prisma.workflowTask.update({ where: { id: taskId }, data: { availableAt: new Date(Date.now() - 60_000) } });
  await rebalanceQueuedTasks(companyId);
}
// выполнить срочный забор с фактической температурой
async function retrieve(loader: string, sessionId: string, temp: number): Promise<string> {
  const t = await retrieveTaskOf(sessionId);
  if (!t) return "нет задачи забора";
  await makeDue(t.id);
  await startWorkflowTask(loader, companyId, t.id);
  return err(() => completeCoolingRetrieval({ companyId, userId: loader, taskId: t.id, temperature: temp }));
}

async function provision() {
  companyId = (await prisma.company.findFirstOrThrow({ where: { slug: "rostagro" } })).id;
  W = (await prisma.warehouse.create({ data: { companyId, name: "P5 W", isActive: true, coolingRate: 2 } })).id; // R=2°C/час
  await ensureStandardZones(companyId, W);
  zRecv = (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: W, kind: "RECEIVING" } })).id;
  zStorage = (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: W, kind: "STORAGE" } })).id;
  zCooling = (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: W, kind: "COOLING" } })).id;
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["P5-S1"], level: 1 });
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["P5-S2"], level: 2 });
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["P5-S3A"], level: 3 });
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["P5-S3B"], level: 3 });
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zCooling, codes: ["P5-C1", "P5-C2"], level: null });
  S1 = await cellId("P5-S1"); S2 = await cellId("P5-S2"); S3 = await cellId("P5-S3A"); S3b = await cellId("P5-S3B");
  C1 = await cellId("P5-C1"); C2 = await cellId("P5-C2");
  const uom = await prisma.uom.create({ data: { companyId, name: "шт P5" } });
  lotItem = (await prisma.item.create({ data: { companyId, name: "P5 товар", sku: "P5-LOT", uomId: uom.id, tracking: "LOT", isActive: true } })).id;
  const demo = await prisma.company.upsert({ where: { slug: "p5-demo" }, update: {}, create: { name: "P5 Demo", slug: "p5-demo", settings: {} } });
  demoId = demo.id;
  DW = (await prisma.warehouse.create({ data: { companyId: demoId, name: "P5 DW", isActive: true, coolingRate: 2 } })).id;
  await ensureStandardZones(demoId, DW);
  RUSER = await mkUser("p5_r", companyId, "+79996660001", "RECEIVER", W);
  L1 = await mkUser("p5_l1", companyId, "+79996660002", "LOADER", W);
  L2 = await mkUser("p5_l2", companyId, "+79996660003", "LOADER", W);
  await updateSettings(companyId, { tempThresholdX: 5 }); // X=5°C
  await mkShift(L1, "LOADER", W);
}

async function cleanup() {
  const whs = [W, DW].filter(Boolean);
  await prisma.cellReservation.deleteMany({ where: { warehouseId: { in: whs } } });
  const sessions = await prisma.coolingSession.findMany({ where: { warehouseId: { in: whs } }, select: { id: true } });
  await prisma.temperatureMeasurement.deleteMany({ where: { sessionId: { in: sessions.map((s) => s.id) } } });
  await prisma.coolingSession.deleteMany({ where: { warehouseId: { in: whs } } });
  const groups = await prisma.handlingGroup.findMany({ where: { warehouseId: { in: whs } }, select: { lotId: true } });
  const lotIds = groups.map((g) => g.lotId);
  await prisma.workflowTask.deleteMany({ where: { warehouseId: { in: whs } } });
  await prisma.handlingGroup.deleteMany({ where: { warehouseId: { in: whs } } });
  await prisma.stockMovement.deleteMany({ where: { lotId: { in: lotIds } } });
  await prisma.stockBalance.deleteMany({ where: { lotId: { in: lotIds } } });
  if (lotIds.length) {
    const rls = (await prisma.lot.findMany({ where: { id: { in: lotIds } }, select: { receiptLineId: true } })).map((l) => l.receiptLineId);
    await prisma.lot.deleteMany({ where: { id: { in: lotIds } } });
    const recs = [...new Set((await prisma.receiptLine.findMany({ where: { id: { in: rls } }, select: { receiptId: true } })).map((r) => r.receiptId))];
    await prisma.receiptLine.deleteMany({ where: { id: { in: rls } } });
    await prisma.receipt.deleteMany({ where: { id: { in: recs } } });
  }
  const cs = (await prisma.cell.findMany({ where: { warehouseId: { in: whs } }, select: { id: true } })).map((c) => c.id);
  await prisma.qrCode.deleteMany({ where: { type: { in: ["CELL", "GROUP"] }, refId: { in: cs } } });
  await prisma.workShift.deleteMany({ where: { userId: { in: UIDS } } });
  await prisma.cell.deleteMany({ where: { warehouseId: { in: whs } } });
  await prisma.warehouseZone.deleteMany({ where: { warehouseId: { in: whs } } });
  await prisma.user.deleteMany({ where: { id: { in: UIDS } } });
  await prisma.item.deleteMany({ where: { id: lotItem } });
  await prisma.warehouse.deleteMany({ where: { id: W } });
  if (demoId) {
    await prisma.warehouseZone.deleteMany({ where: { companyId: demoId } });
    await prisma.warehouse.deleteMany({ where: { companyId: demoId } });
    await prisma.company.deleteMany({ where: { id: demoId, slug: "p5-demo" } });
  }
  await prisma.uom.deleteMany({ where: { companyId, name: "шт P5" } });
  await updateSettings(companyId, { tempThresholdX: null });
}

async function main() {
  await provision();

  console.log("1) формула срока охлаждения");
  const t0 = new Date(0);
  ok("estimateReadyAt = start + (temp-X)/R часов", estimateReadyAt(t0, 9, 5, 2).getTime() === 2 * 3_600_000);
  ok("готовая (temp<=X) → срок = сейчас", estimateReadyAt(t0, 5, 5, 2).getTime() === 0);

  console.log("2) нет сессии для группы <= X");
  const gLow = await mkGroup(3);
  ok("temp<=X → AWAITING_STORAGE", gLow.status === "AWAITING_STORAGE");
  ok("размещение в STORAGE успешно", (await place(L1, gLow.groupId, S1)) === "");
  ok("сессия охлаждения НЕ создана", (await prisma.coolingSession.count({ where: { handlingGroupId: gLow.groupId } })) === 0);

  console.log("3) группа > X: сессия + резерв уровня 3+ (min level→code) + отложенная срочная задача");
  const gHot = await mkGroup(9);
  ok("temp>X → AWAITING_COOLING", gHot.status === "AWAITING_COOLING");
  ok("размещение в COOLING успешно", (await place(L1, gHot.groupId, C1)) === "");
  const session = await prisma.coolingSession.findFirst({ where: { handlingGroupId: gHot.groupId } });
  ok("сессия ACTIVE со снимками X=5,R=2, coolingCell=C1", !!session && session.status === "ACTIVE" && session.thresholdX.toNumber() === 5 && session.coolingRate.toNumber() === 2 && session.coolingCellId === C1);
  ok("группа IN_COOLING, остаток в C1", (await prisma.handlingGroup.findUniqueOrThrow({ where: { id: gHot.groupId } })).status === "IN_COOLING" && !!(await bal((await prisma.handlingGroup.findUniqueOrThrow({ where: { id: gHot.groupId } })).lotId, `C:${C1}`)));
  const reservation = await prisma.cellReservation.findFirst({ where: { sessionId: session!.id, status: "ACTIVE" } });
  const resCell = reservation ? await prisma.cell.findUnique({ where: { id: reservation.cellId } }) : null;
  ok("резерв на STORAGE-ячейке уровня 3 (мин. уровень, затем код → P5-S3A)", !!resCell && resCell.level === 3 && resCell.code === "P5-S3A");
  const rt = await retrieveTaskOf(session!.id);
  ok("отложенная задача RETRIEVE_COOLING URGENT с availableAt в будущем", !!rt && rt.priority === "URGENT" && rt.requiredRole === "LOADER" && !!rt.availableAt && rt.availableAt.getTime() > Date.now());

  console.log("10) старая операция и прямое размещение не занимают зарезервированную ячейку");
  const oldOpErr = await err(() => prisma.$transaction((tx) => assertCellNotHeldByGroup(tx, companyId, reservation!.cellId)));
  ok("assertCellNotHeldByGroup на резерв-ячейке → отказ", oldOpErr.includes("зарезервирована под охлаждение"));
  const gDirect = await mkGroup(3); // AWAITING_STORAGE, L1 сейчас свободен (rt ещё QUEUED/будущее)
  ok("прямое размещение STORAGE-группы в зарезервированную ячейку → отказ", (await place(L1, gDirect.groupId, reservation!.cellId)).includes("зарезервирована"));
  ok("gDirect размещена в свободную STORAGE-ячейку (S2)", (await place(L1, gDirect.groupId, S2)) === "");

  console.log("6) отложенная задача НЕ назначается раньше срока");
  await rebalanceQueuedTasks(companyId);
  const rtEarly = await prisma.workflowTask.findUniqueOrThrow({ where: { id: rt!.id } });
  ok("после rebalance задача всё ещё QUEUED и без исполнителя", rtEarly.status === "QUEUED" && rtEarly.assignedUserId === null);

  console.log("7) после срока — назначается как URGENT");
  await makeDue(rt!.id);
  const rtDue = await prisma.workflowTask.findUniqueOrThrow({ where: { id: rt!.id } });
  ok("наступившая задача назначена LOADER (ASSIGNED, URGENT)", rtDue.status === "ASSIGNED" && rtDue.assignedUserId === L1 && rtDue.priority === "URGENT");

  console.log("8) повторный замер > X создаёт следующий цикл (резерв сохранён)");
  const before = await prisma.temperatureMeasurement.count({ where: { sessionId: session!.id } });
  ok("замер >X: успех", (await retrieve(L1, session!.id, 7)) === "");
  const s8 = await prisma.coolingSession.findUniqueOrThrow({ where: { id: session!.id } });
  const g8 = await prisma.handlingGroup.findUniqueOrThrow({ where: { id: gHot.groupId } });
  ok("группа осталась IN_COOLING, сессия ACTIVE, есть новый замер", g8.status === "IN_COOLING" && s8.status === "ACTIVE" && (await prisma.temperatureMeasurement.count({ where: { sessionId: session!.id } })) === before + 1);
  const rt2 = await retrieveTaskOf(session!.id);
  ok("создан следующий отложенный RETRIEVE_COOLING (URGENT, будущее)", !!rt2 && rt2.id !== rt!.id && rt2.priority === "URGENT" && !!rt2.availableAt);
  ok("резерв сохранён (ACTIVE)", (await prisma.cellReservation.count({ where: { sessionId: session!.id, status: "ACTIVE" } })) === 1);

  console.log("9) замер <= X: атомарный вывоз всей группы в резерв");
  const reservedCellId = reservation!.cellId;
  ok("замер <=X: успех", (await retrieve(L1, session!.id, 4)) === "");
  const g9 = await prisma.handlingGroup.findUniqueOrThrow({ where: { id: gHot.groupId } });
  ok("группа IN_STORAGE", g9.status === "IN_STORAGE");
  ok("вся группа в зарезервированной ячейке, COOLING-ячейка пуста", !!(await bal(g9.lotId, `C:${reservedCellId}`)) && !(await bal(g9.lotId, `C:${C1}`)));
  ok("сессия COMPLETED, резерв RELEASED, задача COMPLETED", (await prisma.coolingSession.findUniqueOrThrow({ where: { id: session!.id } })).status === "COMPLETED" && (await prisma.cellReservation.count({ where: { sessionId: session!.id, status: "ACTIVE" } })) === 0 && (await prisma.workflowTask.findUniqueOrThrow({ where: { id: rt2!.id } })).status === "COMPLETED");

  console.log("4) запрет охлаждения без R");
  await prisma.warehouse.update({ where: { id: W }, data: { coolingRate: null } });
  const gNoR = await mkGroup(9);
  const noRErr = await place(L1, gNoR.groupId, C2);
  ok("без R → размещение в охлаждение отклонено", noRErr.includes("скорость охлаждения"));
  ok("без частичных изменений: нет сессии, группа AWAITING_COOLING, C2 пуста", (await prisma.coolingSession.count({ where: { handlingGroupId: gNoR.groupId } })) === 0 && (await prisma.handlingGroup.findUniqueOrThrow({ where: { id: gNoR.groupId } })).status === "AWAITING_COOLING" && !(await bal((await prisma.handlingGroup.findUniqueOrThrow({ where: { id: gNoR.groupId } })).lotId, `C:${C2}`)));
  await prisma.warehouse.update({ where: { id: W }, data: { coolingRate: 2 } });

  console.log("5) запрет охлаждения без свободной резерв-ячейки уровня 3+");
  // занимаем оба уровня-3 активными бронями (S3 уже освобождён после сценария 9 → снова свободен)
  const r1 = await prisma.cellReservation.create({ data: { companyId, warehouseId: W, cellId: S3, status: "ACTIVE" } });
  const r2 = await prisma.cellReservation.create({ data: { companyId, warehouseId: W, cellId: S3b, status: "ACTIVE" } });
  const noResErr = await place(L1, gNoR.groupId, C2);
  ok("нет свободной ячейки ур.3+ → отклонено", noResErr.includes("уровня 3+"));
  ok("без частичных изменений: нет сессии, группа AWAITING_COOLING", (await prisma.coolingSession.count({ where: { handlingGroupId: gNoR.groupId } })) === 0 && (await prisma.handlingGroup.findUniqueOrThrow({ where: { id: gNoR.groupId } })).status === "AWAITING_COOLING");
  await prisma.cellReservation.deleteMany({ where: { id: { in: [r1.id, r2.id] } } });

  console.log("11) две конкурентные сессии не резервируют одну ячейку");
  // оставим свободной только одну ячейку ур.3 (S3b), S3 займём бронёй
  const rHold = await prisma.cellReservation.create({ data: { companyId, warehouseId: W, cellId: S3, status: "ACTIVE" } });
  await mkShift(L2, "LOADER", W);
  const gc1 = await mkGroup(9), gc2 = await mkGroup(9);
  // назначим PLACE_GROUP-задачи разным грузчикам и начнём
  const pt1 = await placeTaskOf(gc1.groupId), pt2 = await placeTaskOf(gc2.groupId);
  await prisma.workflowTask.update({ where: { id: pt1!.id }, data: { assignedUserId: L1, assignedShiftId: (await prisma.workShift.findFirstOrThrow({ where: { userId: L1, endedAt: null } })).id } });
  await prisma.workflowTask.update({ where: { id: pt2!.id }, data: { assignedUserId: L2, assignedShiftId: (await prisma.workShift.findFirstOrThrow({ where: { userId: L2, endedAt: null } })).id } });
  await startWorkflowTask(L1, companyId, pt1!.id);
  await startWorkflowTask(L2, companyId, pt2!.id);
  const [rc1, rc2] = await Promise.all([
    err(() => completeGroupPlacement({ companyId, userId: L1, taskId: pt1!.id, cellId: C1 })),
    err(() => completeGroupPlacement({ companyId, userId: L2, taskId: pt2!.id, cellId: C2 })),
  ]);
  ok("успешна ровно одна сессия охлаждения (вторая — нет свободного резерва)", (rc1 === "") !== (rc2 === ""), `rc1="${rc1}" rc2="${rc2}"`);
  ok("на единственной свободной ячейке ур.3 — ровно одна активная бронь", (await prisma.cellReservation.count({ where: { cellId: S3b, status: "ACTIVE" } })) === 1);
  await prisma.cellReservation.deleteMany({ where: { id: rHold.id } });

  console.log("12) tenant-изоляция");
  const foreign = await err(() => createHandlingGroup({ companyId, warehouseId: DW, itemId: lotItem, qty: 4, temperature: 9, acceptedById: RUSER, dedupeKey: dk() }));
  ok("приёмка на чужой склад → отказ", !!foreign);
  const foreignRetr = await err(() => completeCoolingRetrieval({ companyId: demoId, userId: L1, taskId: rt2!.id, temperature: 4 }));
  ok("забор чужой сессии (другой companyId) → отказ", !!foreignRetr);

  console.log("13) push не создаётся");
  ok("нет push-подписок у тест-пользователей", (await prisma.pushSubscription.count({ where: { userId: { in: UIDS } } })) === 0);
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ P5 ПРОЙДЕНЫ ✓" : `\nПРОВАЛЕНО: ${failures}`);
    process.exit(failures === 0 ? 0 : 1);
  });
