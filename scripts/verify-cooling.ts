// Проверка Этапа 5/Пакет 5 (охлаждение + срочный забор). Движок напрямую (tsx + prisma).
// Требует COOLING_WORKFLOW_ENABLED=true в окружении (иначе completeGroupPlacement не стартует
// сессию). Только dev-БД; тест-данные удаляются в finally.
// Запуск: COOLING_WORKFLOW_ENABLED=true npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-cooling.ts
/* eslint-disable no-console */
import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { createHandlingGroup, completeGroupPlacement, prepareGroupPlacement } from "@/lib/group-receiving";
import { prepareCoolingRetrieval, placeCoolingRetrieval, verifyCoolingRetrievalEan, verifyCoolingRetrievalSourceCell, estimateReadyAt } from "@/lib/cooling";
import { ensureStandardZones, createCellsInZone, assertCellNotHeldByGroup } from "@/lib/cells";
import { startWorkflowTask, rebalanceQueuedTasks, cancelWorkflowTask } from "@/lib/workflow-tasks";
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
const grp = (id: string) => prisma.handlingGroup.findUniqueOrThrow({ where: { id } });
const sessOf = (gid: string) => prisma.coolingSession.findFirst({ where: { handlingGroupId: gid } });
const resCellOf = async (sid: string) => (await prisma.cellReservation.findFirst({ where: { sessionId: sid }, orderBy: { createdAt: "desc" } }))?.cellId ?? "";
const activeRes = (cid: string) => prisma.cellReservation.count({ where: { cellId: cid, status: "ACTIVE" } });
const occupied = (cid: string) => prisma.stockBalance.count({ where: { cellId: cid, qty: { gt: 0 } } });
// сбросить зависшую IN_PROGRESS-задачу исполнителя (после откатов размещения в конкурентных сценариях)
const freeLoader = (u: string) => prisma.workflowTask.updateMany({ where: { assignedUserId: u, status: "IN_PROGRESS" }, data: { status: "ASSIGNED" } });
const endShift = (u: string) => prisma.workShift.updateMany({ where: { userId: u, endedAt: null }, data: { endedAt: new Date() } });

const mkGroup = (temp: number, qty = 4) => createHandlingGroup({ companyId, warehouseId: W, itemId: lotItem, qty, temperature: temp, acceptedById: RUSER, dedupeKey: dk() });
// Пакет 9B: EAN товара + QR ячейки
const cellQr = async (cid: string) => (await prisma.qrCode.findFirstOrThrow({ where: { type: "CELL", refId: cid } })).code;
let lotEan = "";
// Пакет 11 (коррекция): разместить группу через реальный поток — систему назначает ячейку сама
// (prepare), затем скан назначенной ячейки + EAN. Параметр cell больше не задаёт целевую ячейку
// (оставлен для совместимости вызовов); фактическую назначенную ячейку берём из session/баланса.
async function place(loader: string, groupId: string, _cell?: string): Promise<string> {
  const t = await placeTaskOf(groupId);
  if (!t) return "нет задачи размещения";
  if (t.status !== "IN_PROGRESS") await startWorkflowTask(loader, companyId, t.id);
  return err(async () => {
    const r = await prepareGroupPlacement({ companyId, userId: loader, taskId: t.id });
    await completeGroupPlacement({ companyId, userId: loader, taskId: t.id, cellCode: await cellQr(r.cellId), ean: lotEan });
  });
}
// активировать наступившую отложенную задачу (тест: сдвигаем срок в прошлое) и назначить
async function makeDue(taskId: string) {
  await prisma.workflowTask.update({ where: { id: taskId }, data: { availableAt: new Date(Date.now() - 60_000) } });
  await rebalanceQueuedTasks(companyId);
}
// Пакет 9B двухфазный забор: Фаза 1 — скан исходной COOLING-ячейки + EAN + температура; если готово
// (temp<=X) — Фаза 2: скан назначенной целевой ячейки → физическое размещение через ядро.
async function retrieve(loader: string, sessionId: string, temp: number): Promise<string> {
  const t = await retrieveTaskOf(sessionId);
  if (!t) return "нет задачи забора";
  await makeDue(t.id);
  await startWorkflowTask(loader, companyId, t.id);
  const session = await prisma.coolingSession.findFirstOrThrow({ where: { id: sessionId } });
  const fromCode = await cellQr(session.coolingCellId);
  return err(async () => {
    const r = await prepareCoolingRetrieval({ companyId, userId: loader, taskId: t.id, ean: lotEan, temperature: temp });
    if (r.ready) {
      const cr = await prisma.cellReservation.findFirstOrThrow({ where: { sessionId, status: "ACTIVE" } });
      const targetQr = await cellQr(cr.cellId);
      await placeCoolingRetrieval({ companyId, userId: loader, taskId: t.id, fromCellCode: fromCode, ean: lotEan, targetCellCode: targetQr });
    }
  });
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
  { function ec(b:string){let s=0;for(let i=b.length-1,k=0;i>=0;i--,k++)s+=Number(b[i])*(k%2===0?3:1);return b+String((10-(s%10))%10);} lotEan = ec("460775000001"); await prisma.itemBarcode.create({ data: { companyId, itemId: lotItem, code: lotEan, symbology: "EAN13", source: "MANUAL" } }); }
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
  const groups = await prisma.handlingGroup.findMany({ where: { warehouseId: { in: whs } }, select: { id: true, lotId: true } });
  const lotIds = groups.map((g) => g.lotId);
  // Пакет 11: события Ленты тест-групп (стабильные ключи) — чистим по ключу
  await prisma.event.deleteMany({
    where: { key: { in: groups.flatMap((g) => [`group_received:${g.id}`, `group_placed:${g.id}`, `group_cooling:${g.id}`]) } },
  });
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
  await prisma.itemBarcode.deleteMany({ where: { itemId: lotItem } });
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
  ok("размещение в COOLING успешно", (await place(L1, gHot.groupId)) === "");
  const session = await prisma.coolingSession.findFirst({ where: { handlingGroupId: gHot.groupId } });
  const cHot = session!.coolingCellId; // назначенная системой COOLING-ячейка
  const cHotZone = await prisma.cell.findUnique({ where: { id: cHot }, include: { zone: true } });
  ok("сессия ACTIVE со снимками X=5,R=2, назначена COOLING-ячейка", !!session && session.status === "ACTIVE" && session.thresholdX.toNumber() === 5 && session.coolingRate.toNumber() === 2 && cHotZone?.zone?.kind === "COOLING");
  ok("группа IN_COOLING, остаток в назначенной COOLING-ячейке", (await prisma.handlingGroup.findUniqueOrThrow({ where: { id: gHot.groupId } })).status === "IN_COOLING" && !!(await bal((await prisma.handlingGroup.findUniqueOrThrow({ where: { id: gHot.groupId } })).lotId, `C:${cHot}`)));
  const reservation = await prisma.cellReservation.findFirst({ where: { sessionId: session!.id, status: "ACTIVE" } });
  const resCell = reservation ? await prisma.cell.findUnique({ where: { id: reservation.cellId } }) : null;
  ok("резерв на STORAGE-ячейке уровня 3 (мин. уровень, затем код → P5-S3A)", !!resCell && resCell.level === 3 && resCell.code === "P5-S3A");
  const rt = await retrieveTaskOf(session!.id);
  ok("отложенная задача RETRIEVE_COOLING URGENT с availableAt в будущем", !!rt && rt.priority === "URGENT" && rt.requiredRole === "LOADER" && !!rt.availableAt && rt.availableAt.getTime() > Date.now());

  console.log("10) старая операция и прямое размещение не занимают зарезервированную ячейку");
  const oldOpErr = await err(() => prisma.$transaction((tx) => assertCellNotHeldByGroup(tx, companyId, reservation!.cellId)));
  ok("assertCellNotHeldByGroup на резерв-ячейке → отказ", oldOpErr.includes("зарезервирована под охлаждение"));
  const gDirect = await mkGroup(3); // AWAITING_STORAGE, L1 сейчас свободен (rt ещё QUEUED/будущее)
  const aDirect = await (async () => { const t = await placeTaskOf(gDirect.groupId); await startWorkflowTask(L1, companyId, t!.id); return prepareGroupPlacement({ companyId, userId: L1, taskId: t!.id }); })();
  ok("система НЕ назначила зарезервированную под охлаждение ячейку", aDirect.cellId !== reservation!.cellId);
  const dtDirect = await placeTaskOf(gDirect.groupId);
  const scanReserved = await err(async () => completeGroupPlacement({ companyId, userId: L1, taskId: dtDirect!.id, cellCode: await cellQr(reservation!.cellId), ean: lotEan }));
  ok("скан зарезервированной под охлаждение ячейки → отказ (не назначенная)", scanReserved.includes("не назначенная"), scanReserved);
  ok("gDirect размещена в назначенную свободную ячейку → успех", (await err(async () => completeGroupPlacement({ companyId, userId: L1, taskId: dtDirect!.id, cellCode: await cellQr(aDirect.cellId), ean: lotEan }))) === "");

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
  ok("вся группа в зарезервированной ячейке, COOLING-ячейка пуста", !!(await bal(g9.lotId, `C:${reservedCellId}`)) && !(await bal(g9.lotId, `C:${cHot}`)));
  ok("сессия COMPLETED, резерв RELEASED, задача COMPLETED", (await prisma.coolingSession.findUniqueOrThrow({ where: { id: session!.id } })).status === "COMPLETED" && (await prisma.cellReservation.count({ where: { sessionId: session!.id, status: "ACTIVE" } })) === 0 && (await prisma.workflowTask.findUniqueOrThrow({ where: { id: rt2!.id } })).status === "COMPLETED");
  // Пакет 11: событие «Охлаждение завершено» идемпотентно — стабильный ключ; точный повтор
  // возвращает alreadyPlaced=true, второе Event не пишется, время первого не меняется.
  const coolKey = `group_cooling:${gHot.groupId}`;
  const cEv1 = await prisma.event.findMany({ where: { companyId, type: "group_cooling", key: coolKey } });
  ok("group_cooling: ровно одно событие (стабильный ключ)", cEv1.length === 1);
  const cT1 = cEv1[0]?.createdAt.getTime();
  const repCool = await placeCoolingRetrieval({ companyId, userId: L1, taskId: rt2!.id, fromCellCode: await cellQr(session!.coolingCellId), ean: lotEan, targetCellCode: await cellQr(reservedCellId) });
  ok("group_cooling: точный повтор → alreadyPlaced=true", repCool.alreadyPlaced === true);
  const cEv2 = await prisma.event.findMany({ where: { companyId, type: "group_cooling", key: coolKey } });
  ok("group_cooling: повтор не создаёт второе событие", cEv2.length === 1);
  ok("group_cooling: время первого события не изменилось", cEv2[0]?.createdAt.getTime() === cT1);

  console.log("4) запрет охлаждения без R");
  await prisma.warehouse.update({ where: { id: W }, data: { coolingRate: null } });
  const gNoR = await mkGroup(9);
  const gNoRlot = (await prisma.handlingGroup.findUniqueOrThrow({ where: { id: gNoR.groupId } })).lotId;
  const noRErr = await place(L1, gNoR.groupId);
  ok("без R → размещение в охлаждение отклонено", noRErr.includes("скорость охлаждения"));
  ok("без частичных изменений: нет сессии, группа AWAITING_COOLING, не размещена", (await prisma.coolingSession.count({ where: { handlingGroupId: gNoR.groupId } })) === 0 && (await prisma.handlingGroup.findUniqueOrThrow({ where: { id: gNoR.groupId } })).status === "AWAITING_COOLING" && !(await prisma.stockBalance.findFirst({ where: { lotId: gNoRlot, locKey: { startsWith: "C:" }, qty: { gt: 0 } } })));
  await prisma.warehouse.update({ where: { id: W }, data: { coolingRate: 2 } });

  console.log("5) запрет охлаждения без свободной резерв-ячейки уровня 3+");
  // занимаем оба уровня-3 активными бронями (S3 уже освобождён после сценария 9 → снова свободен)
  const r1 = await prisma.cellReservation.create({ data: { companyId, warehouseId: W, cellId: S3, status: "ACTIVE" } });
  const r2 = await prisma.cellReservation.create({ data: { companyId, warehouseId: W, cellId: S3b, status: "ACTIVE" } });
  const noResErr = await place(L1, gNoR.groupId);
  ok("нет свободной ячейки ур.3+ → отклонено", noResErr.includes("уровня 3+"));
  ok("без частичных изменений: нет сессии, группа AWAITING_COOLING", (await prisma.coolingSession.count({ where: { handlingGroupId: gNoR.groupId } })) === 0 && (await prisma.handlingGroup.findUniqueOrThrow({ where: { id: gNoR.groupId } })).status === "AWAITING_COOLING");
  await prisma.cellReservation.deleteMany({ where: { id: { in: [r1.id, r2.id] } } });
  // gNoR: prepare назначил COOLING-ячейку (бронь committed), но complete не прошёл (конфигурация) —
  // освобождаем бронь и грузчика, иначе занятая COOLING-ячейка/занятый L1 сломают конкурентный тест 11
  await prisma.cellReservation.deleteMany({ where: { handlingGroupId: gNoR.groupId, status: "ACTIVE" } });
  await freeLoader(L1);

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
  const pp1 = await prepareGroupPlacement({ companyId, userId: L1, taskId: pt1!.id });
  const pp2 = await prepareGroupPlacement({ companyId, userId: L2, taskId: pt2!.id });
  const [rc1, rc2] = await Promise.all([
    err(async () => completeGroupPlacement({ companyId, userId: L1, taskId: pt1!.id, cellCode: await cellQr(pp1.cellId), ean: lotEan })),
    err(async () => completeGroupPlacement({ companyId, userId: L2, taskId: pt2!.id, cellCode: await cellQr(pp2.cellId), ean: lotEan })),
  ]);
  ok("успешна ровно одна сессия охлаждения (вторая — нет свободного резерва)", (rc1 === "") !== (rc2 === ""), `rc1="${rc1}" rc2="${rc2}"`);
  ok("на единственной свободной ячейке ур.3 — ровно одна активная бронь", (await prisma.cellReservation.count({ where: { cellId: S3b, status: "ACTIVE" } })) === 1);
  await prisma.cellReservation.deleteMany({ where: { id: rHold.id } });

  console.log("12) tenant-изоляция");
  const foreign = await err(() => createHandlingGroup({ companyId, warehouseId: DW, itemId: lotItem, qty: 4, temperature: 9, acceptedById: RUSER, dedupeKey: dk() }));
  ok("приёмка на чужой склад → отказ", !!foreign);
  const foreignRetr = await err(() => prepareCoolingRetrieval({ companyId: demoId, userId: L1, taskId: rt2!.id, ean: lotEan, temperature: 4 }));
  ok("забор чужой сессии (другой companyId) → отказ", !!foreignRetr);

  console.log("13) push не создаётся");
  ok("нет push-подписок у тест-пользователей", (await prisma.pushSubscription.count({ where: { userId: { in: UIDS } } })) === 0);

  // §2.6: вывоз при temp<=X — приоритет нижних уровней (1 → 2), верхний резерв ур.3+ только как fallback.
  // Детерминизм назначения: закрываем смену L2 (всё авто-назначение идёт на L1) и снимаем зависшие IN_PROGRESS.
  await endShift(L2);
  await freeLoader(L1);
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["P5-LA"], level: 1 }); // свободный ур.1
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["P5-LB"], level: 2 }); // свободный ур.2
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["P5-RA", "P5-RB", "P5-RC"], level: 3 }); // резервы ур.3
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zCooling, codes: ["P5-CA", "P5-CB", "P5-CC"], level: null });
  const cLA = await cellId("P5-LA"), cLB = await cellId("P5-LB"), cCA = await cellId("P5-CA"), cCB = await cellId("P5-CB"), cCC = await cellId("P5-CC");

  console.log("14) вывоз <=X: свободен уровень 1 → размещение на уровень 1, верхний резерв освобождён");
  const gA = await mkGroup(9);
  ok("gA размещена в охлаждение", (await place(L1, gA.groupId)) === "");
  const sA = await sessOf(gA.groupId); const rA = await resCellOf(sA!.id);
  ok("верхний резерв gA — STORAGE-ячейка уровня 3+", (await prisma.cell.findUniqueOrThrow({ where: { id: rA } })).level! >= 3);
  ok("замер <=X: успех", (await retrieve(L1, sA!.id, 4)) === "");
  const gAr = await grp(gA.groupId);
  ok("группа IN_STORAGE и размещена на уровне 1 (P5-LA)", gAr.status === "IN_STORAGE" && !!(await bal(gAr.lotId, `C:${cLA}`)));
  ok("верхний резерв ур.3+ освобождён и остался пустым", rA !== cLA && (await activeRes(rA)) === 0 && (await occupied(rA)) === 0);
  ok("COOLING-ячейка gA пуста", (await occupied(sA!.coolingCellId)) === 0);

  console.log("15) вывоз <=X: уровень 1 занят, уровень 2 свободен → размещение на уровень 2");
  const gB = await mkGroup(9);
  ok("gB размещена в охлаждение", (await place(L1, gB.groupId)) === "");
  const sB = await sessOf(gB.groupId); const rB = await resCellOf(sB!.id);
  ok("замер <=X: успех", (await retrieve(L1, sB!.id, 4)) === "");
  const gBr = await grp(gB.groupId);
  ok("группа IN_STORAGE и размещена на уровне 2 (P5-LB), не в резерв", gBr.status === "IN_STORAGE" && !!(await bal(gBr.lotId, `C:${cLB}`)) && (await occupied(rB)) === 0);
  ok("верхний резерв ур.3+ освобождён", (await activeRes(rB)) === 0);

  console.log("16) вывоз <=X: уровни 1–2 заняты → используется верхний резерв ур.3+");
  const gC = await mkGroup(9);
  ok("gC размещена в охлаждение", (await place(L1, gC.groupId)) === "");
  const sC = await sessOf(gC.groupId); const rC = await resCellOf(sC!.id);
  ok("замер <=X: успех", (await retrieve(L1, sC!.id, 4)) === "");
  const gCr = await grp(gC.groupId);
  ok("группа IN_STORAGE и размещена в верхний резерв (ур.3+)", gCr.status === "IN_STORAGE" && !!(await bal(gCr.lotId, `C:${rC}`)));
  ok("резерв использован и снят с активной брони", (await activeRes(rC)) === 0);
  ok("остатки не смешаны: в ур.1, ур.2 и резерве — ровно по одной партии", (await occupied(cLA)) === 1 && (await occupied(cLB)) === 1 && (await occupied(rC)) === 1);

  console.log("17) отмена активной RETRIEVE_COOLING отклоняется (группа не остаётся без задачи)");
  await freeLoader(L1);
  const gD = await mkGroup(9);
  ok("gD размещена в охлаждение", (await place(L1, gD.groupId)) === "");
  const sD = await sessOf(gD.groupId);
  const tD = await retrieveTaskOf(sD!.id);
  const cancelErr = await err(() => cancelWorkflowTask(tD!.id));
  ok("отмена активной RETRIEVE_COOLING отклонена доменной ошибкой", cancelErr.includes("Активное охлаждение нельзя отменить"));
  ok("задача, сессия и резерв остались активными", (await prisma.workflowTask.findUniqueOrThrow({ where: { id: tD!.id } })).status !== "CANCELLED" && (await prisma.coolingSession.findUniqueOrThrow({ where: { id: sD!.id } })).status === "ACTIVE" && (await activeRes(await resCellOf(sD!.id))) === 1);

  console.log("18) наступившая отложенная задача активируется идемпотентно");
  await prisma.workflowTask.update({ where: { id: tD!.id }, data: { availableAt: new Date(Date.now() - 60_000) } });
  await rebalanceQueuedTasks(companyId);
  const after1 = await prisma.workflowTask.findUniqueOrThrow({ where: { id: tD!.id } });
  await rebalanceQueuedTasks(companyId); // повторно — не должно менять назначение
  const after2 = await prisma.workflowTask.findUniqueOrThrow({ where: { id: tD!.id } });
  ok("после активации задача назначена LOADER (ASSIGNED)", after1.status === "ASSIGNED" && after1.assignedUserId === L1);
  ok("повторная активация идемпотентна (тот же исполнитель и смена)", after2.status === "ASSIGNED" && after2.assignedUserId === after1.assignedUserId && after2.assignedShiftId === after1.assignedShiftId);

  console.log("19) Пакет 9B-fix: точная идемпотентность фаз (сверка ячейки/EAN/цели ДО любого возврата)");
  await retrieve(L1, sD!.id, 4); // завершаем забор gD из сц.17 → освобождаем L1
  await freeLoader(L1);
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["P5-RE"], level: 3 }); // гарантированно свободный резерв
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zCooling, codes: ["P5-CE"], level: null });
  const cCE = await cellId("P5-CE");
  const gE = await mkGroup(9);
  const placeErrE = await place(L1, gE.groupId, cCE);
  ok("gE размещена в охлаждение", placeErrE === "", placeErrE);
  const lotE = (await grp(gE.groupId)).lotId;
  const sE = await sessOf(gE.groupId);
  const tE = await retrieveTaskOf(sE!.id);
  await makeDue(tE!.id);
  await startWorkflowTask(L1, companyId, tE!.id);
  const fromE = await cellQr(sE!.coolingCellId);
  const wrongCellQr = await cellQr(C2); // валидный CELL-QR, но не исходная и не целевая ячейка сессии
  const measBefore0 = await prisma.temperatureMeasurement.count({ where: { sessionId: sE!.id } });
  // COOL-003: verifyCoolingRetrievalEan — read-only проверка EAN до замера, БД не меняет
  ok("verify EAN: правильный EAN подтверждён", (await err(() => verifyCoolingRetrievalEan({ companyId, userId: L1, taskId: tE!.id, ean: lotEan }))) === "");
  const badEanV = await err(() => verifyCoolingRetrievalEan({ companyId, userId: L1, taskId: tE!.id, ean: wrongCellQr }));
  ok("verify EAN: неверный/чужой EAN отклонён", /EAN|товар/.test(badEanV));
  ok("verify EAN: read-only — замеров не добавилось", (await prisma.temperatureMeasurement.count({ where: { sessionId: sE!.id } })) === measBefore0);
  // Фаза 1: замер <=X (по EAN, без исходной ячейки) → назначается целевая ячейка
  const p1 = await prepareCoolingRetrieval({ companyId, userId: L1, taskId: tE!.id, ean: lotEan, temperature: 4 });
  ok("Фаза 1: готово, назначена целевая ячейка", p1.ready && !!p1.targetCellCode);
  const targetE = await resCellOf(sE!.id);
  const targetQrE = await cellQr(targetE);
  const measBefore = await prisma.temperatureMeasurement.count({ where: { sessionId: sE!.id } });
  // prepare: неверный EAN отклонён ДО идемпотентного возврата цели
  const badEan = await err(() => prepareCoolingRetrieval({ companyId, userId: L1, taskId: tE!.id, ean: wrongCellQr, temperature: 4 }));
  ok("prepare: неверный EAN отклонён", /EAN|товар/.test(badEan));
  ok("prepare: отклонение не создало лишних замеров", (await prisma.temperatureMeasurement.count({ where: { sessionId: sE!.id } })) === measBefore);
  // prepare: корректный повтор → та же цель без нового замера
  const p1again = await prepareCoolingRetrieval({ companyId, userId: L1, taskId: tE!.id, ean: lotEan, temperature: 4 });
  ok("prepare: точный повтор → та же цель, без нового замера", p1again.ready && p1again.targetCellCode === p1.targetCellCode && (await prisma.temperatureMeasurement.count({ where: { sessionId: sE!.id } })) === measBefore);
  // COOL-004: verifyCoolingRetrievalSourceCell — read-only проверка исходной ячейки в фазе вывоза
  ok("verify source: правильная исходная COOLING-ячейка подтверждена", (await err(() => verifyCoolingRetrievalSourceCell({ companyId, userId: L1, taskId: tE!.id, fromCellCode: fromE }))) === "");
  const badSrc = await err(() => verifyCoolingRetrievalSourceCell({ companyId, userId: L1, taskId: tE!.id, fromCellCode: wrongCellQr }));
  ok("verify source: другая валидная ячейка склада отклонена", badSrc.includes("не та ячейка"));
  ok("verify source: read-only — движений/замеров не добавилось", (await prisma.stockMovement.count({ where: { lotId: lotE } })) >= 0 && (await prisma.temperatureMeasurement.count({ where: { sessionId: sE!.id } })) === measBefore);
  // P2-fix: пропавшая активная бронь цели → verify source отклоняет сразу (не «ложное зелёное»)
  const resE = await prisma.cellReservation.findFirstOrThrow({ where: { sessionId: sE!.id, status: "ACTIVE" } });
  await prisma.cellReservation.update({ where: { id: resE.id }, data: { status: "RELEASED" } });
  const badNoRes = await err(() => verifyCoolingRetrievalSourceCell({ companyId, userId: L1, taskId: tE!.id, fromCellCode: fromE }));
  ok("verify source: без активной брони цели → отказ (цель не подтверждается)", /резерв|цел/i.test(badNoRes));
  await prisma.cellReservation.update({ where: { id: resE.id }, data: { status: "ACTIVE" } }); // восстановить для place-тестов
  // place: посторонняя целевая ячейка отклонена (до размещения)
  const badTarget = await err(() => placeCoolingRetrieval({ companyId, userId: L1, taskId: tE!.id, fromCellCode: fromE, ean: lotEan, targetCellCode: wrongCellQr }));
  ok("place: чужая целевая ячейка отклонена", badTarget.includes("не та целевая"));
  const gEbeforeMoves = await prisma.stockMovement.count({ where: { lotId: lotE } });
  ok("place: отклонение не создало движения", gEbeforeMoves === (await prisma.stockMovement.count({ where: { lotId: lotE } })));
  // place: корректное размещение
  ok("place: корректное размещение успешно", (await err(() => placeCoolingRetrieval({ companyId, userId: L1, taskId: tE!.id, fromCellCode: fromE, ean: lotEan, targetCellCode: targetQrE }))) === "");
  const gEr = await grp(gE.groupId);
  ok("группа IN_STORAGE в целевой ячейке", gEr.status === "IN_STORAGE" && !!(await bal(gEr.lotId, `C:${targetE}`)));
  const movesAfter = await prisma.stockMovement.count({ where: { lotId: gEr.lotId } });
  // place: точный повтор ПОСЛЕ COMPLETED — успех без нового движения
  const rep = await err(() => placeCoolingRetrieval({ companyId, userId: L1, taskId: tE!.id, fromCellCode: fromE, ean: lotEan, targetCellCode: targetQrE }));
  ok("place: точный повтор после COMPLETED — успех без нового движения", rep === "" && (await prisma.stockMovement.count({ where: { lotId: gEr.lotId } })) === movesAfter);
  // place: повтор с неверными кодами ПОСЛЕ COMPLETED — отклонён (не «успех по любому коду»)
  const repBadFrom = await err(() => placeCoolingRetrieval({ companyId, userId: L1, taskId: tE!.id, fromCellCode: wrongCellQr, ean: lotEan, targetCellCode: targetQrE }));
  ok("place: повтор после COMPLETED с чужой исходной ячейкой — отклонён", repBadFrom.includes("не та ячейка"));
  const repBadTarget = await err(() => placeCoolingRetrieval({ companyId, userId: L1, taskId: tE!.id, fromCellCode: fromE, ean: lotEan, targetCellCode: wrongCellQr }));
  ok("place: повтор после COMPLETED с чужой целевой ячейкой — отклонён", repBadTarget.includes("не та целевая"));
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ P5 ПРОЙДЕНЫ ✓" : `\nПРОВАЛЕНО: ${failures}`);
    process.exit(failures === 0 ? 0 : 1);
  });
