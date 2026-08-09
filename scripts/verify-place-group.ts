// Пакет 11 (коррекция): первичное размещение PLACE_GROUP с назначением ОДНОЙ конкретной ячейки.
// Сценарии: (1) STORAGE min level + code ASC; (2) идемпотентный prepare → та же ячейка, одна бронь;
// (3) чужая свободная ячейка отклоняется, движения нет; (4) назначенная ячейка завершает, бронь
// RELEASED; (5) две конкурентные группы → разные ячейки; (6) нет свободной ячейки → понятная ошибка,
// задача/группа незавершены; (7) COOLING → COOLING-ячейка; первичная бронь освобождается, резерв
// CoolingSession сохраняется; (8) старая операция не занимает назначенную ячейку; (9) отмена
// PLACE_GROUP с активной бронью запрещена. Изолированная временная компания; чистка в finally.
// Запуск (с флагами): WORKFLOW_TASKS_ENABLED=true GROUP_RECEIVING_ENABLED=true COOLING_WORKFLOW_ENABLED=true \
//   npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-place-group.ts
/* eslint-disable no-console */
import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { createHandlingGroup, prepareGroupPlacement, completeGroupPlacement } from "@/lib/group-receiving";
import { ensureStandardZones, createCellsInZone, assertCellNotHeldByGroup } from "@/lib/cells";
import { startWorkflowTask, cancelWorkflowTask } from "@/lib/workflow-tasks";
import { updateSettings } from "@/lib/settings";

const prisma = new PrismaClient();
let failures = 0;
const ok = (n: string, c: boolean, e = "") => (c ? console.log(`  ✓ ${n}`) : (failures++, console.error(`  ✗ ${n} ${e}`)));
const err = async (fn: () => Promise<unknown>): Promise<string> => { try { await fn(); return ""; } catch (e) { return (e as Error).message; } };

const SLUG = "pg-place-demo";
let companyId = "", uomId = "", itemId = "", ean = "";
let W = "", W6 = "", zStorage = "", zCooling = "";
let RUSER = "", L1 = "", L2 = "", L6 = "";
const UIDS: string[] = [];
let seq = 0;
const dk = () => `pg-${Date.now()}-${++seq}`;
function ean13(b12: string): string { let s = 0; for (let i = b12.length - 1, k = 0; i >= 0; i--, k++) s += Number(b12[i]) * (k % 2 === 0 ? 3 : 1); return b12 + String((10 - (s % 10)) % 10); }

const cellId = async (code: string) => (await prisma.cell.findFirstOrThrow({ where: { warehouseId: { in: [W, W6] }, code } })).id;
const cellQr = async (cid: string) => (await prisma.qrCode.findFirstOrThrow({ where: { type: "CELL", refId: cid } })).code;
const taskOf = (groupId: string) => prisma.workflowTask.findFirst({ where: { subjectId: groupId, type: "PLACE_GROUP" } });
const grp = (id: string) => prisma.handlingGroup.findUniqueOrThrow({ where: { id } });
const bal = (lotId: string, locKey: string) => prisma.stockBalance.findFirst({ where: { lotId, locKey } });
const G = (wh: string, temp: number, qty = 1) => createHandlingGroup({ companyId, warehouseId: wh, itemId, qty, temperature: temp, acceptedById: RUSER, dedupeKey: dk() });

async function mkUser(id: string, phone: string, role: Role, wh: string) {
  await prisma.user.deleteMany({ where: { id } });
  await prisma.user.create({ data: { id, companyId, phone, name: id, role, isActive: true, allWarehouses: false, passwordHash: await bcrypt.hash("pgpass", 10), userRoles: { create: { role } }, warehouseLinks: { create: { warehouseId: wh } } } });
  UIDS.push(id);
  return id;
}
const mkShift = (userId: string, wh: string) => prisma.workShift.create({ data: { companyId, userId, warehouseId: wh, role: "LOADER" } });
// начать задачу (если нужно) и назначить ячейку
async function startPrepare(loader: string, groupId: string) {
  const t = await taskOf(groupId);
  if (!t) throw new Error("нет задачи");
  if (t.status !== "IN_PROGRESS") await startWorkflowTask(loader, companyId, t.id);
  const r = await prepareGroupPlacement({ companyId, userId: loader, taskId: t.id });
  return { taskId: t.id, cellId: r.cellId, cellCode: r.cellCode };
}

// Полная чистка изолированной тест-компании по companyId (в т.ч. остатков от упавших прогонов).
async function cleanup() {
  const c = companyId || (await prisma.company.findFirst({ where: { slug: SLUG } }))?.id || "";
  if (!c) return;
  await prisma.cellReservation.deleteMany({ where: { companyId: c } });
  await prisma.temperatureMeasurement.deleteMany({ where: { session: { companyId: c } } }).catch(() => {});
  await prisma.coolingSession.deleteMany({ where: { companyId: c } });
  await prisma.workflowTask.deleteMany({ where: { companyId: c } });
  await prisma.handlingGroup.deleteMany({ where: { companyId: c } });
  await prisma.stockMovement.deleteMany({ where: { companyId: c } });
  await prisma.stockBalance.deleteMany({ where: { companyId: c } });
  await prisma.lot.deleteMany({ where: { companyId: c } });
  await prisma.receiptLine.deleteMany({ where: { companyId: c } });
  await prisma.receipt.deleteMany({ where: { companyId: c } });
  await prisma.qrCode.deleteMany({ where: { companyId: c } });
  await prisma.workShift.deleteMany({ where: { companyId: c } });
  await prisma.cell.deleteMany({ where: { companyId: c } });
  await prisma.warehouseZone.deleteMany({ where: { companyId: c } });
  await prisma.user.deleteMany({ where: { companyId: c } });
  await prisma.itemBarcode.deleteMany({ where: { companyId: c } });
  await prisma.item.deleteMany({ where: { companyId: c } });
  await prisma.warehouse.deleteMany({ where: { companyId: c } });
  await prisma.uom.deleteMany({ where: { companyId: c } });
  await prisma.event.deleteMany({ where: { companyId: c } });
  await prisma.company.deleteMany({ where: { id: c, slug: SLUG } });
}

async function provision() {
  await cleanup();
  companyId = (await prisma.company.create({ data: { name: "PG Place Demo", slug: SLUG, settings: {} } })).id;
  uomId = (await prisma.uom.create({ data: { companyId, name: "шт", allowFraction: false } })).id;
  itemId = (await prisma.item.create({ data: { companyId, name: "PG товар", uomId, tracking: "LOT" } })).id;
  ean = ean13("460100000001");
  await prisma.itemBarcode.create({ data: { companyId, itemId, code: ean, symbology: "EAN13", source: "MANUAL", isActive: true } });
  await updateSettings(companyId, { tempThresholdX: 5 });
  W = (await prisma.warehouse.create({ data: { companyId, name: "PG W", isActive: true, coolingRate: 2 } })).id; // R=2 для охлаждения
  await ensureStandardZones(companyId, W);
  zStorage = (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: W, kind: "STORAGE" } })).id;
  zCooling = (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: W, kind: "COOLING" } })).id;
  // STORAGE: два ур.1 (PG-B, PG-A — проверка code ASC), один ур.2 (PG-C), один ур.3 (PG-UP для резерва охлаждения)
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["PG-B", "PG-A"], level: 1 });
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["PG-C"], level: 2 });
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zStorage, codes: ["PG-UP"], level: 3 });
  await createCellsInZone({ companyId, warehouseId: W, zoneId: zCooling, codes: ["PG-COOL1"], level: null });
  // отдельный склад для сценария 6 (единственная ячейка)
  W6 = (await prisma.warehouse.create({ data: { companyId, name: "PG W6", isActive: true } })).id;
  await ensureStandardZones(companyId, W6);
  const z6 = (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: W6, kind: "STORAGE" } })).id;
  await createCellsInZone({ companyId, warehouseId: W6, zoneId: z6, codes: ["W6-ONLY"], level: 1 });
  RUSER = await mkUser("pg_r", "+79996660001", "RECEIVER", W);
  L1 = await mkUser("pg_l1", "+79996660002", "LOADER", W);
  L2 = await mkUser("pg_l2", "+79996660003", "LOADER", W);
  L6 = await mkUser("pg_l6", "+79996660004", "LOADER", W6);
  await mkShift(L1, W);
}

async function main() {
  try {
    await provision();

    console.log("1) STORAGE: минимальный уровень, затем code ASC → PG-A");
    const g1 = await G(W, 3);
    const a1 = await startPrepare(L1, g1.groupId);
    ok("назначена ячейка минимального уровня + code ASC (PG-A)", a1.cellCode === "PG-A", a1.cellCode);

    console.log("2) идемпотентный prepare → та же ячейка, ровно одна бронь");
    const a1b = await prepareGroupPlacement({ companyId, userId: L1, taskId: a1.taskId });
    ok("повтор prepare → та же ячейка", a1b.cellId === a1.cellId, `${a1b.cellCode}`);
    ok("ровно одна активная бронь по задаче", (await prisma.cellReservation.count({ where: { taskId: a1.taskId, status: "ACTIVE" } })) === 1);

    console.log("3) чужая свободная ячейка отклоняется, движения нет");
    const g1row = await grp(g1.groupId);
    const recvBefore = await bal(g1row.lotId, `Z:${(await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: W, kind: "RECEIVING" } })).id}`);
    const wrong = await err(async () => completeGroupPlacement({ companyId, userId: L1, taskId: a1.taskId, cellCode: await cellQr(await cellId("PG-B")), ean }));
    ok("скан свободной, но НЕ назначенной ячейки → отказ", wrong.includes("не назначенная"), wrong);
    const recvAfter = await bal(g1row.lotId, `Z:${(await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: W, kind: "RECEIVING" } })).id}`);
    ok("движения нет: остаток RECEIVING не изменён, группа AWAITING, бронь активна",
      recvBefore?.qty.toNumber() === recvAfter?.qty.toNumber() && (await grp(g1.groupId)).status === "AWAITING_STORAGE" && (await prisma.cellReservation.count({ where: { taskId: a1.taskId, status: "ACTIVE" } })) === 1);

    console.log("4) назначенная ячейка успешно завершает размещение, бронь RELEASED");
    const done = await err(async () => completeGroupPlacement({ companyId, userId: L1, taskId: a1.taskId, cellCode: await cellQr(a1.cellId), ean }));
    ok("размещение в назначенную ячейку → успех", done === "", done);
    ok("группа IN_STORAGE, задача COMPLETED", (await grp(g1.groupId)).status === "IN_STORAGE" && (await taskOf(g1.groupId))?.status === "COMPLETED");
    ok("бронь размещения RELEASED", (await prisma.cellReservation.count({ where: { taskId: a1.taskId, status: "ACTIVE" } })) === 0 && (await prisma.cellReservation.count({ where: { taskId: a1.taskId, status: "RELEASED" } })) === 1);

    console.log("5) две конкурентные группы → разные назначенные ячейки");
    await mkShift(L2, W);
    const g5a = await G(W, 3), g5b = await G(W, 3);
    const ta = await taskOf(g5a.groupId), tb = await taskOf(g5b.groupId);
    await prisma.workflowTask.update({ where: { id: ta!.id }, data: { assignedUserId: L1, assignedShiftId: (await prisma.workShift.findFirstOrThrow({ where: { userId: L1, endedAt: null } })).id } });
    await prisma.workflowTask.update({ where: { id: tb!.id }, data: { assignedUserId: L2, assignedShiftId: (await prisma.workShift.findFirstOrThrow({ where: { userId: L2, endedAt: null } })).id } });
    await startWorkflowTask(L1, companyId, ta!.id);
    await startWorkflowTask(L2, companyId, tb!.id);
    const pa = await prepareGroupPlacement({ companyId, userId: L1, taskId: ta!.id });
    const pb = await prepareGroupPlacement({ companyId, userId: L2, taskId: tb!.id });
    ok("две группы получили РАЗНЫЕ ячейки", pa.cellId !== pb.cellId, `${pa.cellCode}/${pb.cellCode}`);
    ok("две отдельные активные брони на разные ячейки", (await prisma.cellReservation.count({ where: { taskId: { in: [ta!.id, tb!.id] }, status: "ACTIVE" } })) === 2);

    console.log("8) старая операция не может занять назначенную ячейку");
    const held = await err(() => prisma.$transaction((t) => assertCellNotHeldByGroup(t, companyId, pa.cellId)));
    ok("старая операция на назначенную (забронированную) ячейку → отказ", held.length > 0 && (held.includes("занята группой") || held.includes("зарезервирована")), held);

    console.log("9) отмена PLACE_GROUP с активной бронью запрещена");
    const cancelErr = await err(() => cancelWorkflowTask(ta!.id));
    ok("cancelWorkflowTask с активной бронью → отказ", cancelErr.includes("нельзя отменить"), cancelErr);
    ok("задача НЕ отменена, бронь активна", (await prisma.workflowTask.findUniqueOrThrow({ where: { id: ta!.id } })).status === "IN_PROGRESS" && (await prisma.cellReservation.count({ where: { taskId: ta!.id, status: "ACTIVE" } })) === 1);

    console.log("6) нет свободной ячейки → понятная ошибка, задача/группа незавершены");
    await mkShift(L6, W6);
    // занять единственную ячейку W6-ONLY первой группой
    const g6a = await G(W6, 3);
    const a6a = await startPrepare(L6, g6a.groupId);
    ok("W6: первая группа заняла единственную ячейку (W6-ONLY)", a6a.cellCode === "W6-ONLY");
    await completeGroupPlacement({ companyId, userId: L6, taskId: a6a.taskId, cellCode: await cellQr(a6a.cellId), ean });
    const g6b = await G(W6, 3);
    const t6b = await taskOf(g6b.groupId);
    await startWorkflowTask(L6, companyId, t6b!.id);
    const noCell = await err(() => prepareGroupPlacement({ companyId, userId: L6, taskId: t6b!.id }));
    ok("нет свободной ячейки → понятная ошибка", noCell.includes("Нет свободной ячейки"), noCell);
    ok("задача IN_PROGRESS, группа AWAITING, брони нет", (await prisma.workflowTask.findUniqueOrThrow({ where: { id: t6b!.id } })).status === "IN_PROGRESS" && (await grp(g6b.groupId)).status === "AWAITING_STORAGE" && (await prisma.cellReservation.count({ where: { taskId: t6b!.id, status: "ACTIVE" } })) === 0);

    // освобождаем грузчиков L1/L2: завершаем g5a/g5b в их назначенные ячейки (одна задача на грузчика)
    await completeGroupPlacement({ companyId, userId: L1, taskId: ta!.id, cellCode: await cellQr(pa.cellId), ean });
    await completeGroupPlacement({ companyId, userId: L2, taskId: tb!.id, cellCode: await cellQr(pb.cellId), ean });

    console.log("7) COOLING: назначается COOLING-ячейка; первичная бронь освобождается, резерв CoolingSession сохраняется");
    const g7 = await G(W, 8); // > X=5 → AWAITING_COOLING
    const t7 = await taskOf(g7.groupId); // авто-назначен L1 или L2 (оба свободны)
    const l7 = t7!.assignedUserId!;
    await startWorkflowTask(l7, companyId, t7!.id);
    const a7 = await prepareGroupPlacement({ companyId, userId: l7, taskId: t7!.id });
    ok("назначена COOLING-ячейка (PG-COOL1)", a7.cellCode === "PG-COOL1", a7.cellCode);
    const d7 = await err(async () => completeGroupPlacement({ companyId, userId: l7, taskId: t7!.id, cellCode: await cellQr(a7.cellId), ean }));
    ok("размещение COOLING → успех (сессия охлаждения)", d7 === "", d7);
    ok("группа IN_COOLING", (await grp(g7.groupId)).status === "IN_COOLING");
    ok("первичная бронь размещения RELEASED", (await prisma.cellReservation.count({ where: { taskId: t7!.id, status: "ACTIVE" } })) === 0);
    const session = await prisma.coolingSession.findFirstOrThrow({ where: { handlingGroupId: g7.groupId } });
    ok("создана сессия охлаждения ACTIVE", session.status === "ACTIVE");
    ok("верхний резерв CoolingSession СОХРАНЁН (ACTIVE, sessionId задан, без handlingGroupId)",
      (await prisma.cellReservation.count({ where: { sessionId: session.id, status: "ACTIVE" } })) === 1);

    console.log(failures === 0 ? "\nPLACE-GROUP OK ✓" : `\nПРОВАЛЕНО: ${failures}`);
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error("ERR", e); try { await cleanup(); } catch {} process.exit(1); });
