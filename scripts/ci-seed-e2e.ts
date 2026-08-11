// Пакет 11: фикстуры для browser-e2e релизного профиля. Состояние создаётся ТОЛЬКО через боевые
// движки (createHandlingGroup → completeGroupPlacement → importExternalOrder → reserveAndPlanOrder),
// без несогласованных SQL-вставок. Итог: реальные HandlingGroup(IN_STORAGE), StockBalance в ячейке,
// StockMovement (приёмка + размещение), ItemBarcode, Event (Приёмка/Размещение) и активный
// StockReservation по пользовательскому заказу. Печатает E2E_IDS (точные ожидаемые значения) в конце.
// Запуск: npx tsx --tsconfig scripts/tsconfig.verify.json scripts/ci-seed-e2e.ts
/* eslint-disable no-console */
// Флаги бизнес-процессов — движки читают process.env при вызове.
process.env.WAREHOUSE_ZONES_ENABLED = "true";
process.env.WORKFLOW_TASKS_ENABLED = "true";
process.env.GROUP_RECEIVING_ENABLED = "true";
process.env.COOLING_WORKFLOW_ENABLED = "true";
process.env.EXTERNAL_ORDER_PICKING_ENABLED = "true";
process.env.ORDER_CONTROL_ENABLED = "true"; // хук pickOrderScan создаёт CONTROL_ORDER при IN_CONTROL

import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { ensureStandardZones, createCellsInZone } from "@/lib/cells";
import { updateSettings } from "@/lib/settings";
import { createHandlingGroup, completeGroupPlacement, prepareGroupPlacement } from "@/lib/group-receiving";
import { startWorkflowTask, rebalanceQueuedTasks, createWorkflowTask } from "@/lib/workflow-tasks";
import { importExternalOrder, reserveAndPlanOrder, pickOrderScan } from "@/lib/external-orders";
import { scanOrderForControl, markOrderControlByScan, finishOrderControl } from "@/lib/order-control";
import { applyLotMovement } from "@/lib/stock";
import { createQrIn } from "@/lib/qr";
import { createSessionToken } from "@/lib/jwt";

const prisma = new PrismaClient();

function ean13(b12: string): string { let s = 0; for (let i = b12.length - 1, k = 0; i >= 0; i--, k++) s += Number(b12[i]) * (k % 2 === 0 ? 3 : 1); return b12 + String((10 - (s % 10)) % 10); }

const WH_NAME = "CI-E2E";
const CELL_CODE = "CI-A-01-01";
const CELL_CODE_2 = "CI-A-01-02";
const EAN = ean13("460000000001"); // валидная контрольная цифра
const ITEM_NAME = "CI Тест-товар";
const ORDER_EXT = "EO-CI-001";
const QTY = 1;
const X = 8;
const RECV_PHONE = "+79000009901", RECV_PASS = "CiRecv-pass-9901";
const LOAD_PHONE = "+79000009902", LOAD_PASS = "CiLoad-pass-9902";
const NOSHIFT_PHONE = "+79000009903", NOSHIFT_PASS = "CiNos-pass-9903";

async function mkUser(companyId: string, phone: string, name: string, role: Role, pass: string, warehouseId: string) {
  let u = await prisma.user.findFirst({ where: { companyId, phone } });
  if (!u) {
    u = await prisma.user.create({
      data: { companyId, phone, name, role, isActive: true, allWarehouses: false, passwordHash: await bcrypt.hash(pass, 10), userRoles: { create: { role } }, warehouseLinks: { create: { warehouseId } } },
    });
  } else {
    await prisma.user.update({ where: { id: u.id }, data: { passwordHash: await bcrypt.hash(pass, 10), isActive: true } });
    if (!(await prisma.userWarehouse.findFirst({ where: { userId: u.id, warehouseId } }))) await prisma.userWarehouse.create({ data: { userId: u.id, warehouseId } });
  }
  return u.id;
}

async function main() {
  const company = await prisma.company.findFirst({ where: { slug: process.env.SEED_COMPANY_SLUG || "rostagro" } });
  if (!company) throw new Error("Компания не найдена — сначала seed");
  const companyId = company.id;

  // склад + 7 зон + STORAGE-ячейка
  let wh = await prisma.warehouse.findFirst({ where: { companyId, name: WH_NAME } });
  if (!wh) wh = await prisma.warehouse.create({ data: { companyId, name: WH_NAME, isActive: true, coolingRate: 2 } });
  await ensureStandardZones(companyId, wh.id);
  const storage = await prisma.warehouseZone.findFirstOrThrow({ where: { companyId, warehouseId: wh.id, kind: "STORAGE" } });
  if (!(await prisma.cell.findFirst({ where: { companyId, warehouseId: wh.id, code: CELL_CODE } })))
    await createCellsInZone({ companyId, warehouseId: wh.id, zoneId: storage.id, codes: [CELL_CODE], level: 1 });
  const cell = await prisma.cell.findFirstOrThrow({ where: { companyId, warehouseId: wh.id, code: CELL_CODE } });
  const cellQr = await prisma.qrCode.findFirstOrThrow({ where: { type: "CELL", refId: cell.id } });

  // товар + EAN + порог X
  const uom = await prisma.uom.findFirstOrThrow({ where: { companyId, name: "шт" } });
  let item = await prisma.item.findFirst({ where: { companyId, name: ITEM_NAME } });
  if (!item) item = await prisma.item.create({ data: { companyId, name: ITEM_NAME, uomId: uom.id, tracking: "LOT" } });
  if (!(await prisma.itemBarcode.findFirst({ where: { companyId, code: EAN } })))
    await prisma.itemBarcode.create({ data: { companyId, itemId: item.id, code: EAN, symbology: "EAN13", source: "MANUAL", isActive: true } });
  await updateSettings(companyId, { tempThresholdX: X });

  // сотрудники + смены (RECEIVER — активная смена приёмщика; LOADER — активная смена, размещение;
  // LOADER дополнительно получает роль RECEIVER — мультироль: меню должно идти по активной смене LOADER).
  const receiver = await mkUser(companyId, RECV_PHONE, "CI Приёмщик", "RECEIVER", RECV_PASS, wh.id);
  const loader = await mkUser(companyId, LOAD_PHONE, "CI Погрузчик", "LOADER", LOAD_PASS, wh.id);
  if (!(await prisma.userRole.findFirst({ where: { userId: loader, role: "RECEIVER" } })))
    await prisma.userRole.create({ data: { userId: loader, role: "RECEIVER" } }); // мультироль
  for (const [uid, role] of [[receiver, "RECEIVER"], [loader, "LOADER"]] as [string, Role][]) {
    if (!(await prisma.workShift.findFirst({ where: { userId: uid, endedAt: null } })))
      await prisma.workShift.create({ data: { companyId, userId: uid, warehouseId: wh.id, role } });
  }
  // рабочий сотрудник БЕЗ активной смены (ROLE-003: home должен быть /warehouse/shift)
  const noShift = await mkUser(companyId, NOSHIFT_PHONE, "CI БезСмены", "PICKER", NOSHIFT_PASS, wh.id);

  // ── ROLE-003 фикстуры: реальный старт смены и ADMIN с активной рабочей сменой ──
  const addRole = async (userId: string, role: Role) => {
    if (!(await prisma.userRole.findFirst({ where: { userId, role } }))) await prisma.userRole.create({ data: { userId, role } });
  };
  const ensureShift = async (userId: string, role: Role) => {
    if (!(await prisma.workShift.findFirst({ where: { userId, endedAt: null } })))
      await prisma.workShift.create({ data: { companyId, userId, warehouseId: wh.id, role } });
  };
  // приёмщик БЕЗ смены — для e2e «реально нажать Начать смену → /warehouse/receiving» (одна роль → выбор по умолчанию)
  const startRecv = await mkUser(companyId, "+79000009904", "CI Старт-приёмщик", "RECEIVER", "CiStart-pass-9904", wh.id);
  // ADMIN + активная смена RECEIVER (меню строится по активной смене, не по назначенным ролям)
  const adminRecv = await mkUser(companyId, "+79000009905", "CI Админ-приёмщик", "ADMIN", "CiAdmR-pass-9905", wh.id);
  await addRole(adminRecv, "RECEIVER"); await ensureShift(adminRecv, "RECEIVER");
  // ADMIN + активная смена LOADER
  const adminLoad = await mkUser(companyId, "+79000009906", "CI Админ-погрузчик", "ADMIN", "CiAdmL-pass-9906", wh.id);
  await addRole(adminLoad, "LOADER"); await ensureShift(adminLoad, "LOADER");
  // Дать ADMIN-фикстурам роль ADMIN в User.role (mkUser уже поставил role=ADMIN); userRoles: ADMIN + рабочая
  await addRole(adminRecv, "ADMIN"); await addRole(adminLoad, "ADMIN");

  // 1) приёмка группы (движок) → RECEIPT-движение + Event «Приёмка группы»
  const grp = await createHandlingGroup({ companyId, warehouseId: wh.id, itemId: item.id, qty: QTY, temperature: 4, acceptedById: receiver, dedupeKey: "ci-e2e-recv-1" });

  // 2) размещение в STORAGE-ячейку (движок): система назначает ячейку (prepare) → скан назначенной →
  //    complete. На чистой БД единственная свободная STORAGE-ячейка — CELL_CODE (её и назначит prepare).
  const g = await prisma.handlingGroup.findUniqueOrThrow({ where: { id: grp.groupId } });
  if (g.status === "AWAITING_STORAGE") {
    const placeTask = await prisma.workflowTask.findFirstOrThrow({ where: { subjectId: grp.groupId, type: "PLACE_GROUP" } });
    await startWorkflowTask(loader, companyId, placeTask.id);
    const asg = await prepareGroupPlacement({ companyId, userId: loader, taskId: placeTask.id });
    const asgQr = await prisma.qrCode.findFirstOrThrow({ where: { type: "CELL", refId: asg.cellId } });
    await completeGroupPlacement({ companyId, userId: loader, taskId: placeTask.id, cellCode: asgQr.code, ean: EAN });
  }

  // 3) заказ с пользовательским номером + активный резерв (движок)
  const imp = await importExternalOrder({ companyId, warehouseId: wh.id, externalId: ORDER_EXT, createdById: loader, arrivalAt: null, lines: [{ externalLineId: "1", itemId: item.id, requiredQty: QTY }] });
  await reserveAndPlanOrder({ companyId, orderId: imp.orderId });

  // 4) вторая группа для UI-проверки НОВОГО сценария размещения: остаётся AWAITING_STORAGE с задачей
  // PLACE_GROUP «в работе» у погрузчика → экран задач должен показать «Назначенная ячейка: <код>».
  if (!(await prisma.cell.findFirst({ where: { companyId, warehouseId: wh.id, code: CELL_CODE_2 } })))
    await createCellsInZone({ companyId, warehouseId: wh.id, zoneId: storage.id, codes: [CELL_CODE_2], level: 1 });
  const grp2 = await createHandlingGroup({ companyId, warehouseId: wh.id, itemId: item.id, qty: QTY, temperature: 4, acceptedById: receiver, dedupeKey: "ci-e2e-recv-2" });
  const g2 = await prisma.handlingGroup.findUniqueOrThrow({ where: { id: grp2.groupId } });
  let placeCellCode = "", placeCellQr = "", placeWrongCellQr = "";
  if (g2.status === "AWAITING_STORAGE") {
    const place2 = await prisma.workflowTask.findFirstOrThrow({ where: { subjectId: grp2.groupId, type: "PLACE_GROUP" } });
    if (place2.status !== "IN_PROGRESS") {
      await prisma.workflowTask.update({ where: { id: place2.id }, data: { assignedUserId: loader, assignedShiftId: (await prisma.workShift.findFirstOrThrow({ where: { userId: loader, endedAt: null } })).id, status: "ASSIGNED" } });
      await startWorkflowTask(loader, companyId, place2.id);
    }
    // Пакет F e2e: бронь НЕ создаём заранее (рендер/GET её не создаёт — «Начать размещение» в браузере
    // создаст). Назначение детерминировано: единственная свободная STORAGE-ячейка минимального уровня и
    // code ASC — CELL_CODE_2 (CELL_CODE занята grp; CI-CTRL-* сортируются после «CI-A-…»). Отдаём тесту
    // код и QR назначенной ячейки для скана и QR валидной, но НЕ назначенной ячейки (CELL_CODE).
    const cell2 = await prisma.cell.findFirstOrThrow({ where: { companyId, warehouseId: wh.id, code: CELL_CODE_2 } });
    placeCellCode = CELL_CODE_2;
    placeCellQr = (await prisma.qrCode.findFirstOrThrow({ where: { type: "CELL", refId: cell2.id } })).code;
    placeWrongCellQr = (await prisma.qrCode.findFirstOrThrow({ where: { type: "CELL", refId: cell.id } })).code;
  }

  // проверка целостности созданного состояния
  const bal = await prisma.stockBalance.findFirstOrThrow({ where: { companyId, cellId: cell.id, itemId: item.id, qty: { gt: 0 } } });
  const resv = await prisma.stockReservation.count({ where: { companyId, status: "ACTIVE", lotId: bal.lotId } });
  const gFinal = await prisma.handlingGroup.findUniqueOrThrow({ where: { id: grp.groupId } });
  if (!gFinal || gFinal.status !== "IN_STORAGE") throw new Error(`группа не IN_STORAGE: ${gFinal?.status}`);
  if (resv < 1) throw new Error("активный резерв не создан");

  // ── Фикстура контроля/исправления (UI-004): живая CORRECT_ORDER (сборщик) и CONTROL_ORDER
  //    (контролёр) «в работе», чтобы browser-e2e проверил ПОШАГОВОСТЬ этих панелей. Отдельный товар
  //    и ячейки — существующие остатки/история главной фикстуры не затрагиваются. Движки те же, что
  //    в verify-order-control (доказанно детерминированы на свежей БД).
  // Два контрольных товара (для 2-строчного заказа контроля: авто-переход между строками в мастере).
  const ctlItemA = await (async () => {
    let it = await prisma.item.findFirst({ where: { companyId, name: "CI Контроль-товар A" } });
    if (!it) it = await prisma.item.create({ data: { companyId, name: "CI Контроль-товар A", uomId: uom.id, tracking: "LOT" } });
    return it;
  })();
  const ctlItemB = await (async () => {
    let it = await prisma.item.findFirst({ where: { companyId, name: "CI Контроль-товар B" } });
    if (!it) it = await prisma.item.create({ data: { companyId, name: "CI Контроль-товар B", uomId: uom.id, tracking: "LOT" } });
    return it;
  })();
  const CTRL_EAN_A = ean13("460000000201");
  const CTRL_EAN_B = ean13("460000000202");
  const eanByItem = new Map<string, string>([[ctlItemA.id, CTRL_EAN_A], [ctlItemB.id, CTRL_EAN_B]]);
  for (const [it, code] of [[ctlItemA.id, CTRL_EAN_A], [ctlItemB.id, CTRL_EAN_B]] as [string, string][])
    if (!(await prisma.itemBarcode.findFirst({ where: { companyId, code } })))
      await prisma.itemBarcode.create({ data: { companyId, itemId: it, code, symbology: "EAN13", source: "MANUAL", isActive: true } });
  const ctrlCells = ["CI-CTRL-01", "CI-CTRL-02", "CI-CTRL-03"];
  for (const code of ctrlCells)
    if (!(await prisma.cell.findFirst({ where: { companyId, warehouseId: wh.id, code } })))
      await createCellsInZone({ companyId, warehouseId: wh.id, zoneId: storage.id, codes: [code], level: 1 });
  const ctlU = await mkUser(companyId, "+79000009907", "CI Контролёр", "CONTROLLER", "CiCtl-pass-9907", wh.id);
  const pkA = await mkUser(companyId, "+79000009908", "CI Сборщик-контроль", "PICKER", "CiPk-pass-9908", wh.id);
  await ensureShift(ctlU, "CONTROLLER");
  await ensureShift(pkA, "PICKER");

  let ctrlSeq = 0;
  const seedCtrlGroup = async (itemId: string, cellCode: string, qty: number) => {
    const cellRow = await prisma.cell.findFirstOrThrow({ where: { companyId, warehouseId: wh.id, code: cellCode } });
    const number = 992000 + ++ctrlSeq;
    const receipt = await prisma.receipt.create({ data: { companyId, number, warehouseId: wh.id, status: "POSTED", postedAt: new Date(), note: "CI control seed", createdById: pkA } });
    const line = await prisma.receiptLine.create({ data: { companyId, receiptId: receipt.id, itemId, qty } });
    const lot = await prisma.lot.create({ data: { companyId, itemId, receiptLineId: line.id, qtyReceived: qty } });
    await prisma.$transaction((tx) => applyLotMovement(tx, { companyId, docType: "RECEIPT", docId: receipt.id, itemId, lotId: lot.id, qty, from: null, to: { kind: "cell", warehouseId: wh.id, cellId: cellRow.id }, createdById: pkA }));
    const grpRow = await prisma.handlingGroup.create({ data: { companyId, warehouseId: wh.id, itemId, lotId: lot.id, qty, temperature: 0, thresholdX: 5, status: "IN_STORAGE", dedupeKey: `ci-ctrl-${number}`, acceptedById: pkA } });
    await prisma.$transaction((tx) => createQrIn(tx, { companyId, type: "GROUP", refId: grpRow.id }));
  };
  const cellCodeQr = async (cellId: string) => (await prisma.qrCode.findFirstOrThrow({ where: { type: "CELL", refId: cellId } })).code;
  const groupEan = async (gid: string) => eanByItem.get((await prisma.handlingGroup.findFirstOrThrow({ where: { id: gid } })).itemId)!;
  // импорт → резерв → сборка до IN_CONTROL; lines: [{itemId, cell}]. Возвращает orderId.
  const pickToControl = async (externalId: string, lines: { itemId: string; cell: string }[]) => {
    for (const l of lines) await seedCtrlGroup(l.itemId, l.cell, 1);
    const impO = await importExternalOrder({ companyId, warehouseId: wh.id, externalId, createdById: pkA, arrivalAt: null, lines: lines.map((l, i) => ({ externalLineId: String(i + 1), itemId: l.itemId, requiredQty: 1 })) });
    await reserveAndPlanOrder({ companyId, orderId: impO.orderId });
    let pt = await prisma.workflowTask.findFirst({ where: { type: "PICK_ORDER", subjectId: impO.orderId } });
    if (pt && pt.status === "QUEUED") { await rebalanceQueuedTasks(companyId, { warehouseId: wh.id }); pt = await prisma.workflowTask.findUniqueOrThrow({ where: { id: pt.id } }); }
    const picker = pt?.assignedUserId;
    if (!pt || !picker) throw new Error(`CI control: PICK не назначен (${pt?.status})`);
    if (pt.status === "ASSIGNED") { const r = await startWorkflowTask(picker, companyId, pt.id); if (r.error) throw new Error(`CI control start PICK: ${r.error}`); }
    for (let i = 0; i < 20; i++) {
      const r = await prisma.stockReservation.findFirst({ where: { orderId: impO.orderId, status: "ACTIVE" } });
      if (!r) break;
      await pickOrderScan({ companyId, userId: picker, taskId: pt.id, cellCode: await cellCodeQr(r.cellId!), ean: await groupEan(r.handlingGroupId!), qty: r.qty.toNumber() });
    }
    return impO.orderId;
  };
  const orderQr = async (orderId: string) => (await prisma.qrCode.findFirstOrThrow({ where: { type: "ORDER", refId: orderId } })).code;
  const startCtl = async (orderId: string) => {
    let t = await prisma.workflowTask.findFirstOrThrow({ where: { type: "CONTROL_ORDER", subjectId: orderId }, orderBy: { createdAt: "desc" } });
    if (t.status === "QUEUED") { await rebalanceQueuedTasks(companyId, { warehouseId: wh.id }); t = await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } }); }
    if (t.status === "ASSIGNED") await startWorkflowTask(ctlU, companyId, t.id);
    await scanOrderForControl({ companyId, userId: ctlU, taskId: t.id, orderCode: await orderQr(orderId) });
    return t.id;
  };

  // Оба заказа собираем ПЕРВЫМИ (пока у сборщика нет срочной задачи — иначе срочная CORRECT_ORDER
  // заблокировала бы старт обычной сборки того же сборщика). Затем контроль обоих.
  // Заказ #1 (CORRECT) — 1 строка; заказ #2 (CONTROL, «в работе») — 2 строки для проверки авто-перехода.
  const o1 = await pickToControl("EO-CI-CORR", [{ itemId: ctlItemA.id, cell: ctrlCells[0] }]);
  const o2 = await pickToControl("EO-CI-CTRL", [{ itemId: ctlItemA.id, cell: ctrlCells[1] }, { itemId: ctlItemB.id, cell: ctrlCells[2] }]);

  // Заказ #1 → контроль с недостачей → FAILED → CORRECT_ORDER сборщику (пока ASSIGNED).
  const ct1 = await startCtl(o1);
  await markOrderControlByScan({ companyId, userId: ctlU, taskId: ct1, ean: CTRL_EAN_A, countedQty: 0, discrepancyType: null }); // недостача
  await finishOrderControl({ companyId, userId: ctlU, taskId: ct1 });
  const corr1 = await prisma.workflowTask.findFirstOrThrow({ where: { type: "CORRECT_ORDER", subjectId: o1 }, orderBy: { createdAt: "desc" } });
  const correctPickerId = corr1.assignedUserId!;

  // Заказ #2 → контроль «в работе» (скан заказа, без завершения): CONTROL_ORDER IN_PROGRESS у контролёра.
  await startCtl(o2);

  // Запускаем исправление сборщику → CORRECT_ORDER IN_PROGRESS (панель исправления отрисуется).
  if (corr1.status === "ASSIGNED") await startWorkflowTask(correctPickerId, companyId, corr1.id);

  // ── Фикстуры таймера/выделения срочных (TASK-007/008/009): изолированный склад CI-URG + погрузчик,
  //    чтобы не влиять на доску основного погрузчика. schedNear/schedFar — QUEUED в будущем (монитор:
  //    «Запланирована» + обратный отсчёт, форматы <суток и >суток). asgUrgent — ASSIGNED (прямой отсчёт
  //    «Ожидает начала»). CORRECT_ORDER выше даёт активную срочную «В работе».
  const urgWh = await prisma.warehouse.create({ data: { companyId, name: `CI-URG-${Date.now()}`, isActive: true } });
  const urgLoader = await mkUser(companyId, "+79000009910", "CI Срочный погрузчик", "LOADER", "CiUrg-pass-9910", urgWh.id);
  await prisma.workShift.create({ data: { companyId, userId: urgLoader, warehouseId: urgWh.id, role: "LOADER" } });
  const mkUrg = (title: string, dedupe: string, availableAt: Date) =>
    createWorkflowTask({ companyId, warehouseId: urgWh.id, type: "RETRIEVE_COOLING", requiredRole: "LOADER", priority: "URGENT", title, dedupeKey: dedupe, subjectId: `urg-${dedupe}`, availableAt });
  const schedNear = (await mkUrg("CI Срочный забор near", "ci-urg-near", new Date(Date.now() + 90 * 60_000))).task;   // < суток
  const schedFar = (await mkUrg("CI Срочный забор far", "ci-urg-far", new Date(Date.now() + 26 * 3_600_000))).task;    // > суток
  const asgUrgent = (await mkUrg("CI Срочный забор now", "ci-urg-now", new Date(Date.now() - 1_000))).task;            // назначится сразу

  // ── Фикстуры компактных карточек всех физических задач погрузчика (TASK-006 расширение): отдельный
  //    склад CI-CARDS + погрузчик с токеном; три ASSIGNED задачи (PLACE_GROUP / RETRIEVE_COOLING /
  //    MOVE_GROUP) для проверки единого формата (команда · товар · количество · маршрут).
  const cardsWh = await prisma.warehouse.create({ data: { companyId, name: `CI-CARDS-${Date.now()}`, isActive: true, coolingRate: 2 } });
  await ensureStandardZones(companyId, cardsWh.id);
  const cardsStorage = await prisma.warehouseZone.findFirstOrThrow({ where: { companyId, warehouseId: cardsWh.id, kind: "STORAGE" } });
  const cardsCooling = await prisma.warehouseZone.findFirstOrThrow({ where: { companyId, warehouseId: cardsWh.id, kind: "COOLING" } });
  await createCellsInZone({ companyId, warehouseId: cardsWh.id, zoneId: cardsStorage.id, codes: ["CD-01", "CD-02"], level: 1 });
  await createCellsInZone({ companyId, warehouseId: cardsWh.id, zoneId: cardsCooling.id, codes: ["OH-01"], level: null });
  const cardsLoader = await mkUser(companyId, "+79000009911", "CI Погрузчик-карточки", "LOADER", "CiCards-pass-9911", cardsWh.id);
  await prisma.workShift.create({ data: { companyId, userId: cardsLoader, warehouseId: cardsWh.id, role: "LOADER" } });
  // 1) PLACE_GROUP (ASSIGNED, не начата): группа AWAITING_STORAGE + задача, авто-назначенная cardsLoader.
  await createHandlingGroup({ companyId, warehouseId: cardsWh.id, itemId: item.id, qty: 2, temperature: 4, acceptedById: cardsLoader, dedupeKey: "ci-cards-place" });
  // seed-хелпер: партия в конкретной ячейке (для источника перестановки), группа IN_STORAGE.
  let cardsSeq = 0;
  const seedInCell = async (cellId: string, qty: number) => {
    const number = 993000 + ++cardsSeq;
    const receipt = await prisma.receipt.create({ data: { companyId, number, warehouseId: cardsWh.id, status: "POSTED", postedAt: new Date(), createdById: cardsLoader } });
    const line = await prisma.receiptLine.create({ data: { companyId, receiptId: receipt.id, itemId: item.id, qty } });
    const lot = await prisma.lot.create({ data: { companyId, itemId: item.id, receiptLineId: line.id, qtyReceived: qty } });
    await prisma.$transaction((tx) => applyLotMovement(tx, { companyId, docType: "RECEIPT", docId: receipt.id, itemId: item.id, lotId: lot.id, qty, from: null, to: { kind: "cell", warehouseId: cardsWh.id, cellId }, createdById: cardsLoader }));
    return prisma.handlingGroup.create({ data: { companyId, warehouseId: cardsWh.id, itemId: item.id, lotId: lot.id, qty, temperature: 0, thresholdX: X, status: "IN_STORAGE", dedupeKey: `ci-cards-g-${number}`, acceptedById: cardsLoader } });
  };
  // 2) MOVE_GROUP (ASSIGNED): группа в CD-01, бронь на CD-02 → маршрут «CD-01 → CD-02».
  const cd01 = await prisma.cell.findFirstOrThrow({ where: { companyId, warehouseId: cardsWh.id, code: "CD-01" } });
  const cd02 = await prisma.cell.findFirstOrThrow({ where: { companyId, warehouseId: cardsWh.id, code: "CD-02" } });
  const moveGroup = await seedInCell(cd01.id, 3);
  const mvTask = (await createWorkflowTask({ companyId, warehouseId: cardsWh.id, type: "MOVE_GROUP", requiredRole: "LOADER", priority: "NORMAL", title: "Перестановка группы", dedupeKey: "ci-cards-move", subjectId: moveGroup.id, availableAt: new Date(Date.now() - 1_000) })).task;
  await prisma.cellReservation.create({ data: { companyId, warehouseId: cardsWh.id, cellId: cd02.id, handlingGroupId: moveGroup.id, taskId: mvTask.id, status: "ACTIVE" } });
  // 3) RETRIEVE_COOLING (ASSIGNED): группа IN_COOLING в OH-01 + CoolingSession + задача забора.
  const ohCell = await prisma.cell.findFirstOrThrow({ where: { companyId, warehouseId: cardsWh.id, code: "OH-01" } });
  const coolRec = await prisma.receipt.create({ data: { companyId, number: 993900, warehouseId: cardsWh.id, status: "POSTED", postedAt: new Date(), createdById: cardsLoader } });
  const coolLine = await prisma.receiptLine.create({ data: { companyId, receiptId: coolRec.id, itemId: item.id, qty: 5 } });
  const coolLot = await prisma.lot.create({ data: { companyId, itemId: item.id, receiptLineId: coolLine.id, qtyReceived: 5 } });
  const coolGroup = await prisma.handlingGroup.create({ data: { companyId, warehouseId: cardsWh.id, itemId: item.id, lotId: coolLot.id, qty: 5, temperature: 20, thresholdX: X, status: "IN_COOLING", dedupeKey: "ci-cards-cool", acceptedById: cardsLoader } });
  const coolSession = await prisma.coolingSession.create({ data: { companyId, warehouseId: cardsWh.id, handlingGroupId: coolGroup.id, coolingCellId: ohCell.id, startTemp: 20, thresholdX: X, coolingRate: 2, estimatedReadyAt: new Date(Date.now() + 3_600_000), status: "ACTIVE" } });
  await createWorkflowTask({ companyId, warehouseId: cardsWh.id, type: "RETRIEVE_COOLING", requiredRole: "LOADER", priority: "URGENT", title: "Забор из охлаждения", dedupeKey: "ci-cards-cool-task", subjectId: coolSession.id, availableAt: new Date(Date.now() - 1_000) });

  // Подписанный session-токен по userId (nav-роль = активная рабочая роль). Определён здесь, т.к. нужен
  // фикстурам выдачи/охлаждения ниже; используется и в основной секции токенов.
  const mkToken = async (userId: string, navRole: Role) => {
    const u = await prisma.user.findFirstOrThrow({ where: { companyId, id: userId }, include: { userRoles: { select: { role: true } } } });
    return createSessionToken({ userId: u.id, login: u.phone ?? u.email ?? "", name: u.name, role: navRole, roles: u.userRoles.map((r) => r.role), companyId });
  };

  // ── Коррекция Задачи G: компактные карточки задач ВЫДАЧИ погрузчика (ISSUE_ORDER / DELIVER_ORDER,
  //    тоже requiredRole=LOADER). Отдельные склады/погрузчики, чтобы состояния «до начала» (ASSIGNED)
  //    и «в работе» (IN_PROGRESS) были детерминированы. Заказ/строки/ячейки выдачи создаём напрямую
  //    (рендер карточки + панели читают ExternalOrder + ExternalOrderLine + OrderIssueCell пакетно).
  const mkIssueWh = async (name: string, phone: string, userName: string) => {
    const w = await prisma.warehouse.create({ data: { companyId, name: `${name}-${Date.now()}`, isActive: true, coolingRate: 2 } });
    await ensureStandardZones(companyId, w.id);
    const zIssue = await prisma.warehouseZone.findFirstOrThrow({ where: { companyId, warehouseId: w.id, kind: "ISSUE" } });
    const ldr = await mkUser(companyId, phone, userName, "LOADER", `${phone.slice(-4)}-pass`, w.id);
    await prisma.workShift.create({ data: { companyId, userId: ldr, warehouseId: w.id, role: "LOADER" } });
    return { whId: w.id, issueZoneId: zIssue.id, loaderId: ldr };
  };
  // Создать заказ + строки + занятые ячейки выдачи + задачу (тип/статус задаём явно).
  const mkOrderTask = async (opts: {
    whId: string; issueZoneId: string; loaderId: string; externalId: string; qtys: number[];
    cellCodes: string[]; type: "ISSUE_ORDER" | "DELIVER_ORDER"; status: "ASSIGNED" | "IN_PROGRESS"; cellStatus: "RESERVED" | "PLACED";
  }) => {
    const order = await prisma.externalOrder.create({ data: { companyId, warehouseId: opts.whId, externalId: opts.externalId, status: opts.type === "ISSUE_ORDER" ? "MOVING_TO_ISSUE" : "READY_FOR_DRIVER", payloadHash: `ci-${opts.externalId}` } });
    for (let i = 0; i < opts.qtys.length; i++)
      await prisma.externalOrderLine.create({ data: { companyId, orderId: order.id, externalLineId: String(i + 1), itemId: item.id, requiredQty: opts.qtys[i] } });
    await createCellsInZone({ companyId, warehouseId: opts.whId, zoneId: opts.issueZoneId, codes: opts.cellCodes, level: null });
    for (const code of opts.cellCodes) {
      const c = await prisma.cell.findFirstOrThrow({ where: { companyId, warehouseId: opts.whId, code } });
      await prisma.orderIssueCell.create({ data: { companyId, orderId: order.id, warehouseId: opts.whId, cellId: c.id, status: opts.cellStatus, placedAt: opts.cellStatus === "PLACED" ? new Date() : null } });
    }
    const shift = await prisma.workShift.findFirstOrThrow({ where: { companyId, userId: opts.loaderId, endedAt: null } });
    await prisma.workflowTask.create({ data: {
      companyId, warehouseId: opts.whId, type: opts.type, requiredRole: "LOADER",
      priority: opts.type === "ISSUE_ORDER" ? "URGENT" : "NORMAL",
      status: opts.status, title: `${opts.type === "ISSUE_ORDER" ? "Разместить в выдаче" : "Выдать водителю"}: заказ ${opts.externalId}`,
      subjectType: "externalOrder", subjectId: order.id, dedupeKey: `ci-${opts.type}-${order.id}`,
      assignedUserId: opts.loaderId, assignedShiftId: shift.id, assignedAt: new Date(),
      startedAt: opts.status === "IN_PROGRESS" ? new Date() : null, availableAt: new Date(Date.now() - 1_000),
    } });
    return order.id;
  };
  // Склад IZ: ISSUE_ORDER «в работе» (2 ячейки) + DELIVER_ORDER «до начала» (1 ячейка).
  const izWh = await mkIssueWh("CI-ISSUE", "+79000009921", "CI Погрузчик-выдача-IZ");
  const ISSUE_WIP_EXT = "EO-ISS-701", DELIVER_WAIT_EXT = "EO-DEL-702";
  await mkOrderTask({ ...izWh, externalId: ISSUE_WIP_EXT, qtys: [4, 6, 5], cellCodes: ["IZ-01", "IZ-02"], type: "ISSUE_ORDER", status: "IN_PROGRESS", cellStatus: "PLACED" });
  await mkOrderTask({ ...izWh, externalId: DELIVER_WAIT_EXT, qtys: [3, 7], cellCodes: ["IZ-09"], type: "DELIVER_ORDER", status: "ASSIGNED", cellStatus: "PLACED" });
  const izLoaderToken = await mkToken(izWh.loaderId, "LOADER");
  // Склад DV: DELIVER_ORDER «в работе» (1 ячейка) + ISSUE_ORDER «до начала» (1 ячейка).
  const dvWh = await mkIssueWh("CI-DELIVER", "+79000009922", "CI Погрузчик-выдача-DV");
  const DELIVER_WIP_EXT = "EO-DEL-801", ISSUE_WAIT_EXT = "EO-ISS-802";
  await mkOrderTask({ ...dvWh, externalId: DELIVER_WIP_EXT, qtys: [8, 2], cellCodes: ["DV-01"], type: "DELIVER_ORDER", status: "IN_PROGRESS", cellStatus: "PLACED" });
  await mkOrderTask({ ...dvWh, externalId: ISSUE_WAIT_EXT, qtys: [9], cellCodes: ["DV-09"], type: "ISSUE_ORDER", status: "ASSIGNED", cellStatus: "RESERVED" });
  const dvLoaderToken = await mkToken(dvWh.loaderId, "LOADER");

  // ── Коррекция Задачи G (P2): engine-совместимые сессии охлаждения для браузерного замера. Замер
  //    (prepareCoolingRetrieval) требует ACTIVE-сессию + ACTIVE-резерв с sessionId. Флаг охлаждения при
  //    seed не включён, поэтому воспроизводим состояние startCoolingInTx напрямую: COOLING-ячейка (скан),
  //    STORAGE l1 (цель ≤X), STORAGE l3 (верхний резерв под sessionId), RETRIEVE_COOLING «в работе».
  let coolRecSeq = 9970000; // высокая база номеров приёмок для фикстур охлаждения (без коллизий с другими)
  const seedCoolingSession = async (name: string, phone: string, userName: string, coolCode: string, targetCode: string, placeStock = false) => {
    const w = await prisma.warehouse.create({ data: { companyId, name: `${name}-${Date.now()}`, isActive: true, coolingRate: 2 } });
    await ensureStandardZones(companyId, w.id);
    const zStorage = await prisma.warehouseZone.findFirstOrThrow({ where: { companyId, warehouseId: w.id, kind: "STORAGE" } });
    const zCool = await prisma.warehouseZone.findFirstOrThrow({ where: { companyId, warehouseId: w.id, kind: "COOLING" } });
    await createCellsInZone({ companyId, warehouseId: w.id, zoneId: zCool.id, codes: [coolCode], level: null });
    await createCellsInZone({ companyId, warehouseId: w.id, zoneId: zStorage.id, codes: [targetCode], level: 1 });        // цель забора ≤X
    await createCellsInZone({ companyId, warehouseId: w.id, zoneId: zStorage.id, codes: [`${targetCode}-R3`], level: 3 }); // верхний резерв
    const ldr = await mkUser(companyId, phone, userName, "LOADER", `${phone.slice(-4)}-pass`, w.id);
    await prisma.workShift.create({ data: { companyId, userId: ldr, warehouseId: w.id, role: "LOADER" } });
    const coolCell = await prisma.cell.findFirstOrThrow({ where: { companyId, warehouseId: w.id, code: coolCode } });
    const reserveCell = await prisma.cell.findFirstOrThrow({ where: { companyId, warehouseId: w.id, code: `${targetCode}-R3` } });
    const rec = await prisma.receipt.create({ data: { companyId, number: ++coolRecSeq, warehouseId: w.id, status: "POSTED", postedAt: new Date(), createdById: ldr } });
    const line = await prisma.receiptLine.create({ data: { companyId, receiptId: rec.id, itemId: item.id, qty: 5 } });
    const lot = await prisma.lot.create({ data: { companyId, itemId: item.id, receiptLineId: line.id, qtyReceived: 5 } });
    // Задача I (UI-тест фазы размещения): реальный остаток в COOLING-ячейке, чтобы финальное
    // placeCoolingRetrieval смогло выполнить ровно одно движение (COOLING → STORAGE-цель).
    if (placeStock)
      await prisma.$transaction((tx) => applyLotMovement(tx, { companyId, docType: "RECEIPT", docId: rec.id, itemId: item.id, lotId: lot.id, qty: 5, from: null, to: { kind: "cell", warehouseId: w.id, cellId: coolCell.id }, createdById: ldr }));
    const group = await prisma.handlingGroup.create({ data: { companyId, warehouseId: w.id, itemId: item.id, lotId: lot.id, qty: 5, temperature: 20, thresholdX: X, status: "IN_COOLING", dedupeKey: `ci-cool-${name}`, acceptedById: ldr } });
    const session = await prisma.coolingSession.create({ data: { companyId, warehouseId: w.id, handlingGroupId: group.id, coolingCellId: coolCell.id, startTemp: 20, thresholdX: X, coolingRate: 2, estimatedReadyAt: new Date(Date.now() + 3_600_000), status: "ACTIVE" } });
    const shift = await prisma.workShift.findFirstOrThrow({ where: { companyId, userId: ldr, endedAt: null } });
    const task = await prisma.workflowTask.create({ data: {
      companyId, warehouseId: w.id, type: "RETRIEVE_COOLING", requiredRole: "LOADER", priority: "URGENT", status: "IN_PROGRESS",
      title: "Забор из охлаждения", subjectType: "CoolingSession", subjectId: session.id, dedupeKey: `ci-cool-task-${session.id}`,
      assignedUserId: ldr, assignedShiftId: shift.id, assignedAt: new Date(), startedAt: new Date(), availableAt: new Date(Date.now() - 1_000),
    } });
    // Верхний резерв под sessionId (как в startCoolingInTx) — обязателен для замера.
    await prisma.cellReservation.create({ data: { companyId, warehouseId: w.id, cellId: reserveCell.id, handlingGroupId: group.id, sessionId: session.id, taskId: task.id, status: "ACTIVE" } });
    const coolQr = (await prisma.qrCode.findFirstOrThrow({ where: { type: "CELL", refId: coolCell.id } })).code;
    const targetCell = await prisma.cell.findFirstOrThrow({ where: { companyId, warehouseId: w.id, code: targetCode } });
    const targetQr = (await prisma.qrCode.findFirstOrThrow({ where: { type: "CELL", refId: targetCell.id } })).code;
    return { token: await mkToken(ldr, "LOADER"), coolQr, targetQr, whId: w.id };
  };
  const coolLeq = await seedCoolingSession("CI-COOL-LEQ", "+79000009931", "CI Охлаждение ≤X", "OHL-01", "SL-01");
  const coolGt = await seedCoolingSession("CI-COOL-GT", "+79000009932", "CI Охлаждение >X", "OHG-01", "SG-01");
  // Задача I: отдельная сессия для UI-теста шага/кнопки (с реальным остатком → полный проход до размещения).
  const coolUi = await seedCoolingSession("CI-COOL-UI", "+79000009933", "CI Охлаждение UI", "OHU-01", "SU-01", true);

  // ── Задача M (Этап 1): фикстура сборщика — PICK_ORDER «в работе», 2 позиции, детерминированные резервы.
  //    Отдельные товары/склад (изоляция FIFO): резервы точно в PK-01 (товар А) и PK-02 (товар Б). ──
  const pickWh = await prisma.warehouse.create({ data: { companyId, name: `CI-PICK-${Date.now()}`, isActive: true, coolingRate: 2 } });
  await ensureStandardZones(companyId, pickWh.id);
  const pickStorage = await prisma.warehouseZone.findFirstOrThrow({ where: { companyId, warehouseId: pickWh.id, kind: "STORAGE" } });
  await createCellsInZone({ companyId, warehouseId: pickWh.id, zoneId: pickStorage.id, codes: ["PK-01", "PK-02", "PK-09"], level: 1 });
  const PICK_EAN_A = ean13("460000009001"), PICK_EAN_B = ean13("460000009002");
  const mkPickItem = async (name: string, ean: string) => {
    const it = await prisma.item.create({ data: { companyId, name, uomId: uom.id, tracking: "LOT" } });
    await prisma.itemBarcode.create({ data: { companyId, itemId: it.id, code: ean, symbology: "EAN13", source: "MANUAL", isActive: true } });
    return it.id;
  };
  const PICK_ITEM_A_NAME = "CI Сборка А", PICK_ITEM_B_NAME = "CI Сборка Б";
  const pickItemA = await mkPickItem(PICK_ITEM_A_NAME, PICK_EAN_A);
  const pickItemB = await mkPickItem(PICK_ITEM_B_NAME, PICK_EAN_B);
  const pickE2E = await mkUser(companyId, "+79000009934", "CI Сборщик e2e", "PICKER", "CiPickE2E-9934", pickWh.id);
  await prisma.workShift.create({ data: { companyId, userId: pickE2E, warehouseId: pickWh.id, role: "PICKER" } });
  let pickSeq = 9960000;
  const seedPickStock = async (itemId: string, cellCode: string, qty: number) => {
    const cellRow = await prisma.cell.findFirstOrThrow({ where: { companyId, warehouseId: pickWh.id, code: cellCode } });
    const receipt = await prisma.receipt.create({ data: { companyId, number: ++pickSeq, warehouseId: pickWh.id, status: "POSTED", postedAt: new Date(), createdById: pickE2E } });
    const line = await prisma.receiptLine.create({ data: { companyId, receiptId: receipt.id, itemId, qty } });
    const lot = await prisma.lot.create({ data: { companyId, itemId, receiptLineId: line.id, qtyReceived: qty } });
    await prisma.$transaction((tx) => applyLotMovement(tx, { companyId, docType: "RECEIPT", docId: receipt.id, itemId, lotId: lot.id, qty, from: null, to: { kind: "cell", warehouseId: pickWh.id, cellId: cellRow.id }, createdById: pickE2E }));
    await prisma.handlingGroup.create({ data: { companyId, warehouseId: pickWh.id, itemId, lotId: lot.id, qty, temperature: 0, thresholdX: X, status: "IN_STORAGE", dedupeKey: `ci-pick-${pickSeq}`, acceptedById: pickE2E } });
  };
  await seedPickStock(pickItemA, "PK-01", 1);
  await seedPickStock(pickItemB, "PK-02", 1);
  const PICK_ORDER_EXT = "EO-CI-PICK";
  const impPick = await importExternalOrder({ companyId, warehouseId: pickWh.id, externalId: PICK_ORDER_EXT, createdById: pickE2E, arrivalAt: null, lines: [{ externalLineId: "1", itemId: pickItemA, requiredQty: 1 }, { externalLineId: "2", itemId: pickItemB, requiredQty: 1 }] });
  await reserveAndPlanOrder({ companyId, orderId: impPick.orderId });
  let ppt = await prisma.workflowTask.findFirst({ where: { type: "PICK_ORDER", subjectId: impPick.orderId } });
  if (ppt && ppt.status === "QUEUED") { await rebalanceQueuedTasks(companyId, { warehouseId: pickWh.id }); ppt = await prisma.workflowTask.findUniqueOrThrow({ where: { id: ppt.id } }); }
  if (!ppt || ppt.assignedUserId !== pickE2E) throw new Error(`CI pick: PICK не назначен сборщику (${ppt?.status}/${ppt?.assignedUserId})`);
  if (ppt.status === "ASSIGNED") { const r = await startWorkflowTask(pickE2E, companyId, ppt.id); if (r.error) throw new Error(`CI pick start: ${r.error}`); }
  const pickCellQr = async (code: string) => (await prisma.qrCode.findFirstOrThrow({ where: { type: "CELL", refId: (await prisma.cell.findFirstOrThrow({ where: { companyId, warehouseId: pickWh.id, code } })).id } })).code;
  const pickCellAQr = await pickCellQr("PK-01"), pickCellBQr = await pickCellQr("PK-02"), pickWrongCellQr = await pickCellQr("PK-09");
  const pickOrderQrCode = (await prisma.qrCode.findFirstOrThrow({ where: { companyId, type: "ORDER", refId: impPick.orderId } })).code;
  const pickToken = await mkToken(pickE2E, "PICKER");

  // ── Задача H: монитор ADMIN — новые задачи сверху (createdAt DESC, id DESC). Сентинел создаётся
  //    ПОСЛЕДНИМ → на мониторе он должен идти выше всех ранее созданных задач. QUEUED (не назначается).
  const MONITOR_NEWEST_TITLE = "CI Монитор сентинел (новейшая)";
  await prisma.workflowTask.create({ data: {
    companyId, warehouseId: cardsWh.id, type: "PLACE_GROUP", requiredRole: "LOADER", priority: "NORMAL", status: "QUEUED",
    title: MONITOR_NEWEST_TITLE, dedupeKey: "ci-monitor-newest", availableAt: new Date(Date.now() + 48 * 3_600_000),
  } });

  // Подписанные session-токены для e2e (аутентификация инъекцией cookie skx_session — без
  // зависимости от гидрации формы логина; при TENANT_AUTH=true сессия ре-валидируется из БД по host).
  const admin = await prisma.user.findFirstOrThrow({
    where: { companyId, role: "ADMIN", isActive: true },
    include: { userRoles: { select: { role: true } } },
  });
  const work = await prisma.user.findFirstOrThrow({
    where: { companyId, id: receiver },
    include: { userRoles: { select: { role: true } } },
  });
  const loaderU = await prisma.user.findFirstOrThrow({ where: { companyId, id: loader }, include: { userRoles: { select: { role: true } } } });
  const noShiftU = await prisma.user.findFirstOrThrow({ where: { companyId, id: noShift }, include: { userRoles: { select: { role: true } } } });
  const adminToken = await createSessionToken({ userId: admin.id, login: admin.phone ?? admin.email ?? "", name: admin.name, role: "ADMIN", roles: admin.userRoles.map((r) => r.role), companyId });
  const workToken = await createSessionToken({ userId: work.id, login: work.phone ?? work.email ?? "", name: work.name, role: "RECEIVER", roles: work.userRoles.map((r) => r.role), companyId });
  const loaderToken = await createSessionToken({ userId: loaderU.id, login: loaderU.phone ?? loaderU.email ?? "", name: loaderU.name, role: "LOADER", roles: loaderU.userRoles.map((r) => r.role), companyId });
  const noShiftToken = await createSessionToken({ userId: noShiftU.id, login: noShiftU.phone ?? noShiftU.email ?? "", name: noShiftU.name, role: "PICKER", roles: noShiftU.userRoles.map((r) => r.role), companyId });

  const startToken = await mkToken(startRecv, "RECEIVER");      // приёмщик без смены — реальный старт смены
  const adminRecvToken = await mkToken(adminRecv, "ADMIN");     // ADMIN + активная смена RECEIVER
  const adminLoadToken = await mkToken(adminLoad, "ADMIN");     // ADMIN + активная смена LOADER
  const controllerToken = await mkToken(ctlU, "CONTROLLER");    // CONTROL_ORDER «в работе»
  const correctToken = await mkToken(correctPickerId, "PICKER"); // CORRECT_ORDER «в работе»
  const cardsLoaderToken = await mkToken(cardsLoader, "LOADER"); // компактные карточки PLACE/COOLING/MOVE

  console.log("CI E2E fixtures ready (through engines)");
  console.log("E2E_IDS=" + JSON.stringify({
    warehouseId: wh.id,
    cellId: cell.id,
    cellCode: CELL_CODE,
    itemName: ITEM_NAME,
    ean: EAN,
    qty: QTY,
    groupStatusLabel: "На хранении",
    orderExternalId: ORDER_EXT,
    reservedQty: QTY,
    workPhone: RECV_PHONE,
    adminToken,
    workToken,
    loaderToken,
    noShiftToken,
    startToken,
    adminRecvToken,
    adminLoadToken,
    controllerToken,
    correctToken,
    ctrlEanA: CTRL_EAN_A,
    ctrlEanB: CTRL_EAN_B,
    placeCellCode,   // cell.code назначенной ячейки grp2 (для проверки карточки «Приёмка → <код>»)
    placeCellQr,     // QR назначенной ячейки (скан правильной ячейки)
    placeWrongCellQr, // QR валидной, но НЕ назначенной ячейки (скан неверной ячейки)
    schedNearTitle: schedNear.title,  // QUEUED в будущем (<суток): «Запланирована» + «До активации»
    schedFarTitle: schedFar.title,    // QUEUED в будущем (>суток): формат «N д …»
    asgUrgentTitle: asgUrgent.title,  // ASSIGNED срочная: «Ожидает начала»
    cardsLoaderToken,                 // TASK-006 расширение: компактные карточки PLACE/COOLING/MOVE
    // Коррекция Задачи G: полный охват LOADER — карточки выдачи + браузерный замер охлаждения
    izLoaderToken,                    // ISSUE_ORDER «в работе» + DELIVER_ORDER «до начала»
    dvLoaderToken,                    // DELIVER_ORDER «в работе» + ISSUE_ORDER «до начала»
    issueWipExt: ISSUE_WIP_EXT,       // номер заказа ISSUE «в работе» (3 поз., 15 шт, ячейки IZ-01/IZ-02)
    deliverWaitExt: DELIVER_WAIT_EXT, // номер заказа DELIVER «до начала» (2 поз., 10 шт, ячейка IZ-09)
    deliverWipExt: DELIVER_WIP_EXT,   // номер заказа DELIVER «в работе» (2 поз., 10 шт, ячейка DV-01)
    issueWaitExt: ISSUE_WAIT_EXT,     // номер заказа ISSUE «до начала» (1 поз., 9 шт, ячейка DV-09)
    thresholdX: X,                    // порог X — температуры замера ≤X (X-2) и >X (X+5)
    coolLeqToken: coolLeq.token,      // охлаждение: замер ≤X → точная целевая ячейка SL-01
    coolLeqCellQr: coolLeq.coolQr,
    coolLeqTargetCode: "SL-01",
    coolGtToken: coolGt.token,        // охлаждение: замер >X → новый срок, без ложного движения
    coolGtCellQr: coolGt.coolQr,
    coolGtWhId: coolGt.whId,          // фильтр монитора: новый запланированный забор (новый срок)
    coolUiToken: coolUi.token,        // Задача I: UI-тест шага/кнопки RETRIEVE_COOLING (полный проход)
    coolUiCellQr: coolUi.coolQr,
    coolUiWhId: coolUi.whId,          // подсчёт StockMovement (ровно одно движение при финальном размещении)
    coolUiCoolCode: "OHU-01",         // Задача K: код исходной COOLING-ячейки (на кнопке фазы вывоза)
    coolUiTargetCode: "SU-01",
    coolUiTargetQr: coolUi.targetQr,  // QR назначенной STORAGE-ячейки для финального скана размещения
    // Задача M (Этап 1): сборщик — авторитетный скан + количество-в-подтверждении + компактная карточка + QR
    pickToken,
    pickOrderId: impPick.orderId,
    pickOrderExt: PICK_ORDER_EXT,
    pickWhId: pickWh.id,
    pickCellACode: "PK-01",
    pickCellBCode: "PK-02",
    pickItemAName: PICK_ITEM_A_NAME,
    pickItemBName: PICK_ITEM_B_NAME,
    pickEanA: PICK_EAN_A,          // верный EAN шага 1 (товар А в PK-01)
    pickEanB: PICK_EAN_B,          // верный EAN шага 2 (товар Б в PK-02)
    pickEanWrong: PICK_EAN_B,      // валидный EAN заказа, но не тот товар для шага 1 → ошибка
    pickCellAQr,                   // верная ячейка шага 1
    pickCellBQr,                   // валидная зарезервированная ячейка, но НЕ следующая → ошибка на шаге 1
    pickWrongCellQr,               // валидная ячейка склада без резерва заказа
    pickOrderQrCode,               // ORDER-QR: код для проверки /q/<code>
    monitorNewestTitle: MONITOR_NEWEST_TITLE, // Задача H: сентинел «новые сверху» в мониторе ADMIN
    asgUrgentTitleForSort: asgUrgent.title,   // более старая задача — для проверки порядка (новее выше)
  }));
  process.exit(0);
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
