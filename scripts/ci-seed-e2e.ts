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
process.env.ORDER_ISSUE_ENABLED = "true"; // finishOrderControl → авто-резерв ячейки выдачи + ISSUE_ORDER

import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { ensureStandardZones, createCellsInZone } from "@/lib/cells";
import { updateSettings } from "@/lib/settings";
import { createHandlingGroup, completeGroupPlacement, prepareGroupPlacement } from "@/lib/group-receiving";
import { startWorkflowTask, rebalanceQueuedTasks, createWorkflowTask } from "@/lib/workflow-tasks";
import { importExternalOrder, reserveAndPlanOrder, pickOrderScan } from "@/lib/external-orders";
import { scanOrderForControl, markOrderControlByScan, confirmControlLine, finishOrderControl, createControlTaskInTx } from "@/lib/order-control";
import { placeWholeOrderInIssueCell } from "@/lib/order-issue";
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
  // P3C-FIX-1: коллега-погрузчик той же роли/склада — чтобы у izLoader (ISSUE_ORDER «в работе»)
  //   рендерилось компактное действие «Передать задачу» (проверка наличия у representative LOADER-задачи).
  const izMate = await mkUser(companyId, "+79000009974", "CI Погрузчик-выдача-IZ-2", "LOADER", "CiIzMate-9974", izWh.whId);
  await prisma.workShift.create({ data: { companyId, userId: izMate, warehouseId: izWh.whId, role: "LOADER" } });
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

  // ── P3C-FIX-1: изолированная фикстура ПЕРЕДАЧИ задачи. Отдельный склад hoWh, два PICKER: hoA (ранняя
  //    смена — исполнитель) и hoB (коллега-получатель той же роли/склада). Один реальный PICK_ORDER
  //    «в работе» с активным резервом. e2e свободно мутирует эту задачу (запрос → ожидание → принятие /
  //    отклонение), не задевая основную фикстуру сборки (pickWh). Компактная карточка + компактное
  //    действие «Передать задачу» должны рендериться; при HANDOFF_PENDING — та же карточка без сканера. ──
  const hoWh = await prisma.warehouse.create({ data: { companyId, name: `CI-HANDOFF-${Date.now()}`, isActive: true, coolingRate: 2 } });
  await ensureStandardZones(companyId, hoWh.id);
  const hoStorage = await prisma.warehouseZone.findFirstOrThrow({ where: { companyId, warehouseId: hoWh.id, kind: "STORAGE" } });
  await createCellsInZone({ companyId, warehouseId: hoWh.id, zoneId: hoStorage.id, codes: ["HO-01"], level: 1 });
  const HO_EAN = ean13("460000009051"), HO_ITEM_NAME = "CI Передача-товар";
  const hoItem = await prisma.item.create({ data: { companyId, name: HO_ITEM_NAME, uomId: uom.id, tracking: "LOT" } });
  await prisma.itemBarcode.create({ data: { companyId, itemId: hoItem.id, code: HO_EAN, symbology: "EAN13", source: "MANUAL", isActive: true } });
  const hoA = await mkUser(companyId, "+79000009972", "CI Передача A", "PICKER", "CiHoA-9972", hoWh.id);
  const hoB = await mkUser(companyId, "+79000009973", "CI Передача B", "PICKER", "CiHoB-9973", hoWh.id);
  await prisma.workShift.create({ data: { companyId, userId: hoA, warehouseId: hoWh.id, role: "PICKER", startedAt: new Date(Date.now() - 60_000) } }); // ранняя → задача hoA
  await prisma.workShift.create({ data: { companyId, userId: hoB, warehouseId: hoWh.id, role: "PICKER", startedAt: new Date() } });
  const hoCell = await prisma.cell.findFirstOrThrow({ where: { companyId, warehouseId: hoWh.id, code: "HO-01" } });
  const hoReceipt = await prisma.receipt.create({ data: { companyId, number: 9965001, warehouseId: hoWh.id, status: "POSTED", postedAt: new Date(), createdById: hoA } });
  const hoRLine = await prisma.receiptLine.create({ data: { companyId, receiptId: hoReceipt.id, itemId: hoItem.id, qty: 1 } });
  const hoLot = await prisma.lot.create({ data: { companyId, itemId: hoItem.id, receiptLineId: hoRLine.id, qtyReceived: 1 } });
  await prisma.$transaction((tx) => applyLotMovement(tx, { companyId, docType: "RECEIPT", docId: hoReceipt.id, itemId: hoItem.id, lotId: hoLot.id, qty: 1, from: null, to: { kind: "cell", warehouseId: hoWh.id, cellId: hoCell.id }, createdById: hoA }));
  await prisma.handlingGroup.create({ data: { companyId, warehouseId: hoWh.id, itemId: hoItem.id, lotId: hoLot.id, qty: 1, temperature: 0, thresholdX: X, status: "IN_STORAGE", dedupeKey: "ci-ho-1", acceptedById: hoA } });
  const HO_ORDER_EXT = "EO-CI-HANDOFF";
  const impHo = await importExternalOrder({ companyId, warehouseId: hoWh.id, externalId: HO_ORDER_EXT, createdById: hoA, arrivalAt: null, lines: [{ externalLineId: "1", itemId: hoItem.id, requiredQty: 1 }] });
  await reserveAndPlanOrder({ companyId, orderId: impHo.orderId });
  let hoPt = await prisma.workflowTask.findFirst({ where: { type: "PICK_ORDER", subjectId: impHo.orderId } });
  if (hoPt && hoPt.status === "QUEUED") { await rebalanceQueuedTasks(companyId, { warehouseId: hoWh.id }); hoPt = await prisma.workflowTask.findUniqueOrThrow({ where: { id: hoPt.id } }); }
  if (!hoPt || hoPt.assignedUserId !== hoA) throw new Error(`CI handoff: PICK не назначен hoA (${hoPt?.status}/${hoPt?.assignedUserId})`);
  if (hoPt.status === "ASSIGNED") { const r = await startWorkflowTask(hoA, companyId, hoPt.id); if (r.error) throw new Error(`CI handoff start: ${r.error}`); }
  const hoAToken = await mkToken(hoA, "PICKER");
  const hoBToken = await mkToken(hoB, "PICKER");

  // ── Задача M (Этап 2): фикстура контролёра — компактный CONTROL_ORDER. Отдельный контролёр
  //    controlE2E (свой склад ctl2Wh) без остатков: A «в работе» (IN_PROGRESS, ещё НЕ отсканирован →
  //    первый шаг = скан QR заказа), B «до начала» (ASSIGNED, очередь). Заказы засеяны прямо в IN_CONTROL
  //    (без сборки/остатков) — e2e проверяет только компактные карточки, скан QR и появление шага EAN. ──
  const ctl2Wh = await prisma.warehouse.create({ data: { companyId, name: `CI-CTL2-${Date.now()}`, isActive: true, coolingRate: 2 } });
  await ensureStandardZones(companyId, ctl2Wh.id);
  const controlE2E = await mkUser(companyId, "+79000009935", "CI Контролёр e2e", "CONTROLLER", "CiCtlE2E-9935", ctl2Wh.id);
  const ctl2Shift = await prisma.workShift.create({ data: { companyId, userId: controlE2E, warehouseId: ctl2Wh.id, role: "CONTROLLER" } });
  const mkCtlOrder = async (ext: string, items: string[], start: boolean) => {
    const imp = await importExternalOrder({ companyId, warehouseId: ctl2Wh.id, externalId: ext, createdById: controlE2E, arrivalAt: null, lines: items.map((it, i) => ({ externalLineId: String(i + 1), itemId: it, requiredQty: 1 })) });
    await prisma.externalOrder.update({ where: { id: imp.orderId }, data: { status: "IN_CONTROL" } });
    const res = await prisma.$transaction((tx) => createControlTaskInTx(tx, { companyId, order: { id: imp.orderId, warehouseId: ctl2Wh.id, externalId: ext, arrivalAt: null }, dedupeKey: `ci-ctl2:${imp.orderId}` }));
    await prisma.workflowTask.update({ where: { id: res.task.id }, data: { status: "ASSIGNED", assignedUserId: controlE2E, assignedShiftId: ctl2Shift.id, assignedAt: new Date(), startedAt: null } });
    if (start) { const r = await startWorkflowTask(controlE2E, companyId, res.task.id); if (r.error) throw new Error(`CI ctl2 start: ${r.error}`); }
    return imp.orderId;
  };
  const CTL2_A_EXT = "EO-CI-CTL2-A", CTL2_B_EXT = "EO-CI-CTL2-B";
  const oCtl2A = await mkCtlOrder(CTL2_A_EXT, [ctlItemA.id, ctlItemB.id], true);  // «в работе», scanConfirmed=false
  const oCtl2B = await mkCtlOrder(CTL2_B_EXT, [ctlItemA.id], false);              // «до начала»
  const controlOrderAQr = await orderQr(oCtl2A);  // верный QR для задачи A
  const controlWrongQr = await orderQr(oCtl2B);   // валидный, но ЧУЖОЙ QR (заказ B)
  const controlE2EToken = await mkToken(controlE2E, "CONTROLLER");

  // ── Задача M (Этап 2, P2): fail-closed CONTROL_ORDER без структурированного контекста.
  //    Отдельный контролёр controlBad с двумя «повреждёнными» задачами (subjectId=null): одна в работе
  //    (текущая, без controlOrder), одна в очереди (без controlCard). Проверяем, что UI не откатывается
  //    к техкарточке и не даёт начать. Заказов/остатков не создаём. ──
  const controlBad = await mkUser(companyId, "+79000009936", "CI Контролёр bad", "CONTROLLER", "CiCtlBad-9936", ctl2Wh.id);
  const ctlBadShift = await prisma.workShift.create({ data: { companyId, userId: controlBad, warehouseId: ctl2Wh.id, role: "CONTROLLER" } });
  const mkBadControl = async (status: "IN_PROGRESS" | "ASSIGNED", key: string) =>
    prisma.workflowTask.create({ data: {
      companyId, warehouseId: ctl2Wh.id, type: "CONTROL_ORDER", requiredRole: "CONTROLLER", priority: "NORMAL",
      status, title: "Контроль заказа BROKEN-ORD-INTERNAL", subjectType: "externalOrder", subjectId: null,
      dedupeKey: key, assignedUserId: controlBad, assignedShiftId: ctlBadShift.id, assignedAt: new Date(),
      startedAt: status === "IN_PROGRESS" ? new Date() : null, availableAt: new Date(Date.now() - 1000),
    } });
  await mkBadControl("IN_PROGRESS", `ci-ctl-bad-cur:${ctl2Wh.id}`); // текущая повреждённая
  await mkBadControl("ASSIGNED", `ci-ctl-bad-que:${ctl2Wh.id}`);    // очередь повреждённая
  const controlBadToken = await mkToken(controlBad, "CONTROLLER");

  // ── Задача N: реальная фикстура размещения ISSUE_ORDER. Изолированный склад: сборка → контроль
  //    подтверждением строк (клик) → авто-резерв ОДНОЙ ячейки выдачи → ISSUE_ORDER «в работе» у своего
  //    погрузчика. Реальный сток в CONTROL, чтобы скан назначенной ячейки атомарно разместил весь заказ. ──
  const issWh = await prisma.warehouse.create({ data: { companyId, name: `CI-ISSN-${Date.now()}`, isActive: true, coolingRate: 2 } });
  await ensureStandardZones(companyId, issWh.id);
  const issStorage = await prisma.warehouseZone.findFirstOrThrow({ where: { companyId, warehouseId: issWh.id, kind: "STORAGE" } });
  const issIssueZone = await prisma.warehouseZone.findFirstOrThrow({ where: { companyId, warehouseId: issWh.id, kind: "ISSUE" } });
  await createCellsInZone({ companyId, warehouseId: issWh.id, zoneId: issStorage.id, codes: ["IN-01"], level: 1 });
  await createCellsInZone({ companyId, warehouseId: issWh.id, zoneId: issIssueZone.id, codes: ["IN-I1", "IN-I2"], level: null });
  const issItem = await prisma.item.create({ data: { companyId, name: "CI Выдача-товар N", uomId: uom.id, tracking: "LOT" } });
  const ISS_EAN = ean13("460000009301");
  await prisma.itemBarcode.create({ data: { companyId, itemId: issItem.id, code: ISS_EAN, symbology: "EAN13", source: "MANUAL", isActive: true } });
  const issPk = await mkUser(companyId, "+79000009938", "CI Сборщик выдача N", "PICKER", "CiIssPk-9938", issWh.id);
  const issCtl = await mkUser(companyId, "+79000009939", "CI Контролёр выдача N", "CONTROLLER", "CiIssCtl-9939", issWh.id);
  const issLo = await mkUser(companyId, "+79000009940", "CI Погрузчик выдача N", "LOADER", "CiIssLo-9940", issWh.id);
  await prisma.workShift.create({ data: { companyId, userId: issPk, warehouseId: issWh.id, role: "PICKER" } });
  await prisma.workShift.create({ data: { companyId, userId: issCtl, warehouseId: issWh.id, role: "CONTROLLER" } });
  const issLoShift = await prisma.workShift.create({ data: { companyId, userId: issLo, warehouseId: issWh.id, role: "LOADER" } });
  // сток: партия 3 шт в IN-01 (STORAGE)
  const issCellRow = await prisma.cell.findFirstOrThrow({ where: { companyId, warehouseId: issWh.id, code: "IN-01" } });
  const issReceipt = await prisma.receipt.create({ data: { companyId, number: 9994001, warehouseId: issWh.id, status: "POSTED", postedAt: new Date(), createdById: issPk } });
  const issLine = await prisma.receiptLine.create({ data: { companyId, receiptId: issReceipt.id, itemId: issItem.id, qty: 3 } });
  const issLot = await prisma.lot.create({ data: { companyId, itemId: issItem.id, receiptLineId: issLine.id, qtyReceived: 3 } });
  await prisma.$transaction((tx) => applyLotMovement(tx, { companyId, docType: "RECEIPT", docId: issReceipt.id, itemId: issItem.id, lotId: issLot.id, qty: 3, from: null, to: { kind: "cell", warehouseId: issWh.id, cellId: issCellRow.id }, createdById: issPk }));
  const issGroup = await prisma.handlingGroup.create({ data: { companyId, warehouseId: issWh.id, itemId: issItem.id, lotId: issLot.id, qty: 3, temperature: 0, thresholdX: X, status: "IN_STORAGE", dedupeKey: "ci-iss-n-1", acceptedById: issPk } });
  await prisma.$transaction((tx) => createQrIn(tx, { companyId, type: "GROUP", refId: issGroup.id }));
  const ISS_ORDER_EXT = "EO-CI-ISSUE-N";
  const impIss = await importExternalOrder({ companyId, warehouseId: issWh.id, externalId: ISS_ORDER_EXT, createdById: issPk, arrivalAt: null, lines: [{ externalLineId: "1", itemId: issItem.id, requiredQty: 3 }] });
  await reserveAndPlanOrder({ companyId, orderId: impIss.orderId });
  let issPt = await prisma.workflowTask.findFirst({ where: { type: "PICK_ORDER", subjectId: impIss.orderId } });
  if (issPt && issPt.status === "QUEUED") { await rebalanceQueuedTasks(companyId, { warehouseId: issWh.id }); issPt = await prisma.workflowTask.findUniqueOrThrow({ where: { id: issPt.id } }); }
  if (issPt && issPt.status === "ASSIGNED") await startWorkflowTask(issPt.assignedUserId!, companyId, issPt.id);
  // сборка
  for (let i = 0; i < 10; i++) {
    const r = await prisma.stockReservation.findFirst({ where: { orderId: impIss.orderId, status: "ACTIVE" } });
    if (!r) break;
    const cq = (await prisma.qrCode.findFirstOrThrow({ where: { type: "CELL", refId: r.cellId! } })).code;
    await pickOrderScan({ companyId, userId: issPt!.assignedUserId!, taskId: issPt!.id, cellCode: cq, ean: ISS_EAN, qty: r.qty.toNumber() });
  }
  // контроль подтверждением строк (Задача N) → CONTROL_PASSED → авто-резерв ячейки выдачи
  let issCt = await prisma.workflowTask.findFirstOrThrow({ where: { type: "CONTROL_ORDER", subjectId: impIss.orderId }, orderBy: { createdAt: "desc" } });
  if (issCt.status === "QUEUED") { await rebalanceQueuedTasks(companyId, { warehouseId: issWh.id }); issCt = await prisma.workflowTask.findUniqueOrThrow({ where: { id: issCt.id } }); }
  if (issCt.status === "ASSIGNED") await startWorkflowTask(issCtl, companyId, issCt.id);
  const issOrderQr = (await prisma.qrCode.findFirstOrThrow({ where: { companyId, type: "ORDER", refId: impIss.orderId } })).code;
  await scanOrderForControl({ companyId, userId: issCtl, taskId: issCt.id, orderCode: issOrderQr });
  for (const l of await prisma.externalOrderLine.findMany({ where: { orderId: impIss.orderId } })) await confirmControlLine({ companyId, userId: issCtl, taskId: issCt.id, lineId: l.id });
  await finishOrderControl({ companyId, userId: issCtl, taskId: issCt.id });
  // ISSUE_ORDER создана авто-резервом → детерминированно назначаем нашему погрузчику и стартуем
  const issIt = await prisma.workflowTask.findFirstOrThrow({ where: { type: "ISSUE_ORDER", subjectId: impIss.orderId }, orderBy: { createdAt: "desc" } });
  await prisma.workflowTask.update({ where: { id: issIt.id }, data: { status: "ASSIGNED", assignedUserId: issLo, assignedShiftId: issLoShift.id, assignedAt: new Date(), startedAt: null } });
  const rIssStart = await startWorkflowTask(issLo, companyId, issIt.id);
  if (rIssStart.error) throw new Error(`CI issue-N start: ${rIssStart.error}`);
  const issCell = await prisma.orderIssueCell.findFirstOrThrow({ where: { orderId: impIss.orderId, status: { not: "RELEASED" } } });
  const issAssignedCellQr = (await prisma.qrCode.findFirstOrThrow({ where: { companyId, type: "CELL", refId: issCell.cellId } })).code;
  const issAssignedCellCode = (await prisma.cell.findUniqueOrThrow({ where: { id: issCell.cellId } })).code;
  const issOtherCell = await prisma.cell.findFirstOrThrow({ where: { companyId, warehouseId: issWh.id, zone: { kind: "ISSUE" }, id: { not: issCell.cellId } } });
  const issWrongCellQr = (await prisma.qrCode.findFirstOrThrow({ where: { companyId, type: "CELL", refId: issOtherCell.id } })).code;
  const issuePlaceToken = await mkToken(issLo, "LOADER");

  // ── Задача O: реальная фикстура ВЫДАЧИ (DELIVER_ORDER «в работе»). Второй заказ доведён до размещения
  //    (реальные placements в единственной ячейке), затем DELIVER стартован у своего погрузчика. ──
  await createCellsInZone({ companyId, warehouseId: issWh.id, zoneId: issStorage.id, codes: ["IN-02", "IN-03", "IN-04"], level: 1 });
  const seedStorageGroup = async (code: string, qty: number, num: number, dk: string) => {
    const cellRow = await prisma.cell.findFirstOrThrow({ where: { companyId, warehouseId: issWh.id, code } });
    const rec = await prisma.receipt.create({ data: { companyId, number: num, warehouseId: issWh.id, status: "POSTED", postedAt: new Date(), createdById: issPk } });
    const ln = await prisma.receiptLine.create({ data: { companyId, receiptId: rec.id, itemId: issItem.id, qty } });
    const lot = await prisma.lot.create({ data: { companyId, itemId: issItem.id, receiptLineId: ln.id, qtyReceived: qty } });
    await prisma.$transaction((tx) => applyLotMovement(tx, { companyId, docType: "RECEIPT", docId: rec.id, itemId: issItem.id, lotId: lot.id, qty, from: null, to: { kind: "cell", warehouseId: issWh.id, cellId: cellRow.id }, createdById: issPk }));
    const grp = await prisma.handlingGroup.create({ data: { companyId, warehouseId: issWh.id, itemId: issItem.id, lotId: lot.id, qty, temperature: 0, thresholdX: X, status: "IN_STORAGE", dedupeKey: dk, acceptedById: issPk } });
    await prisma.$transaction((tx) => createQrIn(tx, { companyId, type: "GROUP", refId: grp.id }));
    return { cellId: cellRow.id, groupId: grp.id, lotId: lot.id };
  };
  const issPlaceLo2 = await mkUser(companyId, "+79000009941", "CI Погрузчик разм2 N", "LOADER", "CiIssPl2-9941", issWh.id);
  const issDelLo = await mkUser(companyId, "+79000009942", "CI Погрузчик выдача2 N", "LOADER", "CiIssDel-9942", issWh.id);
  const issPlaceLo2Shift = await prisma.workShift.create({ data: { companyId, userId: issPlaceLo2, warehouseId: issWh.id, role: "LOADER" } });
  const issDelShift = await prisma.workShift.create({ data: { companyId, userId: issDelLo, warehouseId: issWh.id, role: "LOADER" } });
  await seedStorageGroup("IN-02", 2, 9994002, "ci-del-n-1");
  const DEL_ORDER_EXT = "EO-CI-DELIVER-N";
  const impDel = await importExternalOrder({ companyId, warehouseId: issWh.id, externalId: DEL_ORDER_EXT, createdById: issPk, arrivalAt: null, lines: [{ externalLineId: "1", itemId: issItem.id, requiredQty: 2 }] });
  await reserveAndPlanOrder({ companyId, orderId: impDel.orderId });
  let delPt = await prisma.workflowTask.findFirst({ where: { type: "PICK_ORDER", subjectId: impDel.orderId } });
  if (delPt && delPt.status === "QUEUED") { await rebalanceQueuedTasks(companyId, { warehouseId: issWh.id }); delPt = await prisma.workflowTask.findUniqueOrThrow({ where: { id: delPt.id } }); }
  if (delPt && delPt.status === "ASSIGNED") await startWorkflowTask(delPt.assignedUserId!, companyId, delPt.id);
  for (let i = 0; i < 10; i++) { const r = await prisma.stockReservation.findFirst({ where: { orderId: impDel.orderId, status: "ACTIVE" } }); if (!r) break; const cq = (await prisma.qrCode.findFirstOrThrow({ where: { type: "CELL", refId: r.cellId! } })).code; await pickOrderScan({ companyId, userId: delPt!.assignedUserId!, taskId: delPt!.id, cellCode: cq, ean: ISS_EAN, qty: r.qty.toNumber() }); }
  let delCt = await prisma.workflowTask.findFirstOrThrow({ where: { type: "CONTROL_ORDER", subjectId: impDel.orderId }, orderBy: { createdAt: "desc" } });
  if (delCt.status === "QUEUED") { await rebalanceQueuedTasks(companyId, { warehouseId: issWh.id }); delCt = await prisma.workflowTask.findUniqueOrThrow({ where: { id: delCt.id } }); }
  if (delCt.status === "ASSIGNED") await startWorkflowTask(issCtl, companyId, delCt.id);
  const delOrderQr = (await prisma.qrCode.findFirstOrThrow({ where: { companyId, type: "ORDER", refId: impDel.orderId } })).code;
  await scanOrderForControl({ companyId, userId: issCtl, taskId: delCt.id, orderCode: delOrderQr });
  for (const l of await prisma.externalOrderLine.findMany({ where: { orderId: impDel.orderId } })) await confirmControlLine({ companyId, userId: issCtl, taskId: delCt.id, lineId: l.id });
  await finishOrderControl({ companyId, userId: issCtl, taskId: delCt.id });
  const delIssueTask = await prisma.workflowTask.findFirstOrThrow({ where: { type: "ISSUE_ORDER", subjectId: impDel.orderId }, orderBy: { createdAt: "desc" } });
  await prisma.workflowTask.update({ where: { id: delIssueTask.id }, data: { status: "ASSIGNED", assignedUserId: issPlaceLo2, assignedShiftId: issPlaceLo2Shift.id, assignedAt: new Date(), startedAt: null } });
  const rDelPlaceStart = await startWorkflowTask(issPlaceLo2, companyId, delIssueTask.id);
  if (rDelPlaceStart.error) throw new Error(`CI deliver place start: ${rDelPlaceStart.error}`);
  const delIssueCell = await prisma.orderIssueCell.findFirstOrThrow({ where: { orderId: impDel.orderId, status: { not: "RELEASED" } } });
  const delAssignedCellQr = (await prisma.qrCode.findFirstOrThrow({ where: { companyId, type: "CELL", refId: delIssueCell.cellId } })).code;
  await placeWholeOrderInIssueCell({ companyId, userId: issPlaceLo2, taskId: delIssueTask.id, orderCode: delOrderQr, cellCode: delAssignedCellQr });
  const delTask = await prisma.workflowTask.findFirstOrThrow({ where: { type: "DELIVER_ORDER", subjectId: impDel.orderId }, orderBy: { createdAt: "desc" } });
  await prisma.workflowTask.update({ where: { id: delTask.id }, data: { status: "ASSIGNED", assignedUserId: issDelLo, assignedShiftId: issDelShift.id, assignedAt: new Date(), startedAt: null } });
  const rDelStart = await startWorkflowTask(issDelLo, companyId, delTask.id);
  if (rDelStart.error) throw new Error(`CI deliver start: ${rDelStart.error}`);
  const delAssignedCellCode = (await prisma.cell.findUniqueOrThrow({ where: { id: delIssueCell.cellId } })).code;
  // «неверная ячейка» для выдачи — любая ISSUE-ячейка склада, НЕ назначенная этому заказу
  const delOtherCell = await prisma.cell.findFirstOrThrow({ where: { companyId, warehouseId: issWh.id, zone: { kind: "ISSUE" }, id: { not: delIssueCell.cellId } } });
  const delWrongCellQr = (await prisma.qrCode.findFirstOrThrow({ where: { companyId, type: "CELL", refId: delOtherCell.id } })).code;
  const deliverToken = await mkToken(issDelLo, "LOADER");

  // ── Задача O: реальная фикстура MOVE_GROUP «в работе». Группа в IN-03, бронь на IN-04. Каждый скан
  //    (исходная ячейка, EAN, целевая ячейка) проверяется сервером немедленно. ──
  const issMoveLo = await mkUser(companyId, "+79000009943", "CI Погрузчик перест N", "LOADER", "CiIssMv-9943", issWh.id);
  const issMoveShift = await prisma.workShift.create({ data: { companyId, userId: issMoveLo, warehouseId: issWh.id, role: "LOADER" } });
  const mvSeed = await seedStorageGroup("IN-03", 3, 9994003, "ci-mv-n-1");
  const mvToCell = await prisma.cell.findFirstOrThrow({ where: { companyId, warehouseId: issWh.id, code: "IN-04" } });
  const mvTaskO = await prisma.workflowTask.create({ data: { companyId, warehouseId: issWh.id, type: "MOVE_GROUP", requiredRole: "LOADER", priority: "NORMAL", status: "IN_PROGRESS", title: "Перестановка группы", subjectType: "handlingGroup", subjectId: mvSeed.groupId, dedupeKey: "ci-mv-n-task", assignedUserId: issMoveLo, assignedShiftId: issMoveShift.id, assignedAt: new Date(), startedAt: new Date(), availableAt: new Date(Date.now() - 1000) } });
  await prisma.cellReservation.create({ data: { companyId, warehouseId: issWh.id, cellId: mvToCell.id, handlingGroupId: mvSeed.groupId, taskId: mvTaskO.id, status: "ACTIVE" } });
  const moveFromCellQr = (await prisma.qrCode.findFirstOrThrow({ where: { companyId, type: "CELL", refId: mvSeed.cellId } })).code;
  const moveToCellQr = (await prisma.qrCode.findFirstOrThrow({ where: { companyId, type: "CELL", refId: mvToCell.id } })).code;
  const moveToken = await mkToken(issMoveLo, "LOADER");

  // ── ORDER-003 (Задача P2): фикстура авто-возобновления BLOCKED-заказа. Изолированный склад: нижняя
  //    ячейка занята зарезервированным заказом-заполнителем (PICK «в работе» у сборщика), целевой товар —
  //    на уровне 3 → целевой заказ BLOCKED. e2e собирает заполнитель (освобождает нижнюю ячейку), затем
  //    планировщик (SCHEDULER_INTERVAL_MS=3000) авто-возобновляет заказ → MOVE_GROUP + зависимая PICK. ──
  const blkWh = await prisma.warehouse.create({ data: { companyId, name: `CI-BLK-${Date.now()}`, isActive: true, coolingRate: 2 } });
  // ADMIN-монитор (adminRecv) должен видеть склад блок-сценария: детальная страница заказа и монитор
  // требуют доступ к складу (isWhAllowed). adminRecv не allWarehouses → явно добавляем доступ к blkWh.
  await prisma.userWarehouse.create({ data: { userId: adminRecv, warehouseId: blkWh.id } });
  await ensureStandardZones(companyId, blkWh.id);
  const blkStorage = await prisma.warehouseZone.findFirstOrThrow({ where: { companyId, warehouseId: blkWh.id, kind: "STORAGE" } });
  await createCellsInZone({ companyId, warehouseId: blkWh.id, zoneId: blkStorage.id, codes: ["BLK-L1"], level: 1 });
  await createCellsInZone({ companyId, warehouseId: blkWh.id, zoneId: blkStorage.id, codes: ["BLK-U1"], level: 3 });
  const blkItem = await prisma.item.create({ data: { companyId, name: "CI Блок-товар", uomId: uom.id, tracking: "LOT" } });
  const BLK_EAN = ean13("460000009401");
  await prisma.itemBarcode.create({ data: { companyId, itemId: blkItem.id, code: BLK_EAN, symbology: "EAN13", source: "MANUAL", isActive: true } });
  const blkPk = await mkUser(companyId, "+79000009944", "CI Сборщик блок", "PICKER", "CiBlkPk-9944", blkWh.id);
  const blkLo = await mkUser(companyId, "+79000009945", "CI Погрузчик блок", "LOADER", "CiBlkLo-9945", blkWh.id);
  await prisma.workShift.create({ data: { companyId, userId: blkPk, warehouseId: blkWh.id, role: "PICKER" } });
  await prisma.workShift.create({ data: { companyId, userId: blkLo, warehouseId: blkWh.id, role: "LOADER" } });
  const blkSeed = async (code: string, qty: number, num: number, dk: string, createdAt: Date) => {
    const cellRow = await prisma.cell.findFirstOrThrow({ where: { companyId, warehouseId: blkWh.id, code } });
    const rec = await prisma.receipt.create({ data: { companyId, number: num, warehouseId: blkWh.id, status: "POSTED", postedAt: new Date(), createdById: blkPk } });
    const ln = await prisma.receiptLine.create({ data: { companyId, receiptId: rec.id, itemId: blkItem.id, qty } });
    const lot = await prisma.lot.create({ data: { companyId, itemId: blkItem.id, receiptLineId: ln.id, qtyReceived: qty, createdAt } });
    await prisma.$transaction((tx) => applyLotMovement(tx, { companyId, docType: "RECEIPT", docId: rec.id, itemId: blkItem.id, lotId: lot.id, qty, from: null, to: { kind: "cell", warehouseId: blkWh.id, cellId: cellRow.id }, createdById: blkPk }));
    const grp = await prisma.handlingGroup.create({ data: { companyId, warehouseId: blkWh.id, itemId: blkItem.id, lotId: lot.id, qty, temperature: 0, thresholdX: X, status: "IN_STORAGE", dedupeKey: dk, acceptedById: blkPk } });
    await prisma.$transaction((tx) => createQrIn(tx, { companyId, type: "GROUP", refId: grp.id }));
    return { cellId: cellRow.id };
  };
  await blkSeed("BLK-L1", 2, 9994004, "ci-blk-fill", new Date(Date.now() - 9000)); // заполнитель нижней ячейки
  await blkSeed("BLK-U1", 3, 9994005, "ci-blk-top", new Date(Date.now() - 8000));  // целевой товар на ур.3
  // заполнитель: полностью резервирует нижнюю группу → PICK «в работе» у сборщика
  const BLK_FILL_EXT = "EO-CI-BLK-FILL";
  const impFill = await importExternalOrder({ companyId, warehouseId: blkWh.id, externalId: BLK_FILL_EXT, createdById: blkPk, arrivalAt: null, lines: [{ externalLineId: "1", itemId: blkItem.id, requiredQty: 2 }] });
  await reserveAndPlanOrder({ companyId, orderId: impFill.orderId });
  let blkFillPt = await prisma.workflowTask.findFirstOrThrow({ where: { type: "PICK_ORDER", subjectId: impFill.orderId } });
  if (blkFillPt.status === "QUEUED") { await rebalanceQueuedTasks(companyId, { warehouseId: blkWh.id }); blkFillPt = await prisma.workflowTask.findUniqueOrThrow({ where: { id: blkFillPt.id } }); }
  if (blkFillPt.status === "ASSIGNED") await startWorkflowTask(blkPk, companyId, blkFillPt.id);
  const blkFillResv = await prisma.stockReservation.findFirstOrThrow({ where: { orderId: impFill.orderId, status: "ACTIVE" } });
  const blkFillCellQr = (await prisma.qrCode.findFirstOrThrow({ where: { companyId, type: "CELL", refId: blkFillResv.cellId! } })).code;
  // целевой заказ: только верхний товар доступен → BLOCKED
  const BLK_ORDER_EXT = "EO-CI-BLK-TARGET";
  const impBlk = await importExternalOrder({ companyId, warehouseId: blkWh.id, externalId: BLK_ORDER_EXT, createdById: blkPk, arrivalAt: null, lines: [{ externalLineId: "1", itemId: blkItem.id, requiredQty: 3 }] });
  await reserveAndPlanOrder({ companyId, orderId: impBlk.orderId });
  const blkAdminToken = await mkToken(adminRecv, "ADMIN"); // ADMIN-монитор (уже существующий admin-пользователь)
  const blkPickerToken = await mkToken(blkPk, "PICKER");

  // ── P3A: многопользовательское распределение — два PICKER одной роли на одном складе. Срочная
  //    задача → раннему muA, обычная → muB. e2e проверяет изоляцию видимости (каждый видит только свои),
  //    монитор с исполнителями, выделение срочной и возврат ASSIGNED при завершении смены (второму). ──
  const muWh = await prisma.warehouse.create({ data: { companyId, name: `CI-MU-${Date.now()}`, isActive: true, coolingRate: 2 } });
  await prisma.userWarehouse.create({ data: { userId: adminRecv, warehouseId: muWh.id } }); // ADMIN-монитор видит склад
  const muA = await mkUser(companyId, "+79000009951", "P3 Сборщик A", "PICKER", "CiMuA-9951", muWh.id);
  const muB = await mkUser(companyId, "+79000009952", "P3 Сборщик B", "PICKER", "CiMuB-9952", muWh.id);
  await prisma.workShift.create({ data: { companyId, userId: muA, warehouseId: muWh.id, role: "PICKER", startedAt: new Date(Date.now() - 60_000) } }); // ранняя смена
  await prisma.workShift.create({ data: { companyId, userId: muB, warehouseId: muWh.id, role: "PICKER", startedAt: new Date() } });
  const MU_URG_TITLE = "P3 Срочная сборка A";
  const MU_NORM_TITLE = "P3 Обычная сборка B";
  await createWorkflowTask({ companyId, warehouseId: muWh.id, type: "PICK_ORDER", requiredRole: "PICKER", priority: "URGENT", title: MU_URG_TITLE, dedupeKey: "ci-mu-urg" });
  await createWorkflowTask({ companyId, warehouseId: muWh.id, type: "PICK_ORDER", requiredRole: "PICKER", priority: "NORMAL", title: MU_NORM_TITLE, dedupeKey: "ci-mu-norm" });
  await rebalanceQueuedTasks(companyId, { warehouseId: muWh.id }); // детерминированно: URGENT→muA (ранняя), NORMAL→muB
  const muUrgAssignee = (await prisma.workflowTask.findFirstOrThrow({ where: { companyId, dedupeKey: "ci-mu-urg" } })).assignedUserId;
  const muNormAssignee = (await prisma.workflowTask.findFirstOrThrow({ where: { companyId, dedupeKey: "ci-mu-norm" } })).assignedUserId;
  if (muUrgAssignee !== muA || muNormAssignee !== muB) throw new Error(`MU seed: ожидалось URGENT→muA, NORMAL→muB; получено urg=${muUrgAssignee} norm=${muNormAssignee}`);
  const muAToken = await mkToken(muA, "PICKER");
  const muBToken = await mkToken(muB, "PICKER");
  const muAdminToken = await mkToken(adminRecv, "ADMIN");

  // ── P3A.2: реальный старт/завершение смены каждой рабочей роли. Изолированный склад без задач
  //    (rebalance при старте — no-op, без побочных эффектов). У каждого пользователя одна роль и один
  //    склад → чипы формы выбраны по умолчанию, «Начать смену» сразу отправляет действие. ──
  const startWh = await prisma.warehouse.create({ data: { companyId, name: `CI-START-${Date.now()}`, isActive: true, coolingRate: 2 } });
  const startLoad = await mkUser(companyId, "+79000009961", "CI Старт-погрузчик", "LOADER", "CiStL-9961", startWh.id);
  const startPick = await mkUser(companyId, "+79000009962", "CI Старт-сборщик", "PICKER", "CiStP-9962", startWh.id);
  const startCtrl = await mkUser(companyId, "+79000009963", "CI Старт-контролёр", "CONTROLLER", "CiStC-9963", startWh.id);
  const startLoadToken = await mkToken(startLoad, "LOADER");
  const startPickToken = await mkToken(startPick, "PICKER");
  const startCtrlToken = await mkToken(startCtrl, "CONTROLLER");

  // ── P3B-FIX-2: PLACE_GROUP при 0 свободных STORAGE-ячейках. Единственная ячейка PH-1 занята стоком →
  //    старт размещения атомарно отклоняется: понятная ошибка, задача остаётся ASSIGNED (не текущая),
  //    сотрудник может завершить смену. Проверяем без 500. ──
  const phWh = await prisma.warehouse.create({ data: { companyId, name: `CI-PH-${Date.now()}`, isActive: true, coolingRate: 2 } });
  await ensureStandardZones(companyId, phWh.id);
  const phStorage = await prisma.warehouseZone.findFirstOrThrow({ where: { companyId, warehouseId: phWh.id, kind: "STORAGE" } });
  await createCellsInZone({ companyId, warehouseId: phWh.id, zoneId: phStorage.id, codes: ["PH-1"], level: 1 });
  const phItem = await prisma.item.create({ data: { companyId, name: "CI PH-товар", uomId: uom.id, tracking: "LOT" } });
  await prisma.itemBarcode.create({ data: { companyId, itemId: phItem.id, code: ean13("460000009501"), symbology: "EAN13", source: "MANUAL", isActive: true } });
  const phLoader = await mkUser(companyId, "+79000009971", "CI Погрузчик PH", "LOADER", "CiPhLo-9971", phWh.id);
  await prisma.workShift.create({ data: { companyId, userId: phLoader, warehouseId: phWh.id, role: "LOADER" } });
  // занять единственную ячейку PH-1 стоком (без пика) → 0 свободных ячеек хранения
  const phCell = await prisma.cell.findFirstOrThrow({ where: { companyId, warehouseId: phWh.id, code: "PH-1" } });
  const phRec = await prisma.receipt.create({ data: { companyId, number: 9995001, warehouseId: phWh.id, status: "POSTED", postedAt: new Date(), createdById: phLoader } });
  const phLn = await prisma.receiptLine.create({ data: { companyId, receiptId: phRec.id, itemId: phItem.id, qty: 2 } });
  const phLot = await prisma.lot.create({ data: { companyId, itemId: phItem.id, receiptLineId: phLn.id, qtyReceived: 2 } });
  await prisma.$transaction((tx) => applyLotMovement(tx, { companyId, docType: "RECEIPT", docId: phRec.id, itemId: phItem.id, lotId: phLot.id, qty: 2, from: null, to: { kind: "cell", warehouseId: phWh.id, cellId: phCell.id }, createdById: phLoader }));
  await prisma.handlingGroup.create({ data: { companyId, warehouseId: phWh.id, itemId: phItem.id, lotId: phLot.id, qty: 2, temperature: 0, thresholdX: X, status: "IN_STORAGE", dedupeKey: "ci-ph-fill", acceptedById: phLoader } });
  // целевая группа ждёт размещения → PLACE_GROUP ASSIGNED phLoader (но свободной ячейки нет)
  const phTarget = await createHandlingGroup({ companyId, warehouseId: phWh.id, itemId: phItem.id, qty: 1, temperature: 0, acceptedById: phLoader, dedupeKey: "ci-ph-target" });
  let phTask = await prisma.workflowTask.findFirstOrThrow({ where: { type: "PLACE_GROUP", subjectId: phTarget.groupId } });
  if (phTask.status === "QUEUED") { await rebalanceQueuedTasks(companyId, { warehouseId: phWh.id }); phTask = await prisma.workflowTask.findUniqueOrThrow({ where: { id: phTask.id } }); }
  const phLoaderToken = await mkToken(phLoader, "LOADER");

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
    // Задача M (Этап 2): контролёр — компактный CONTROL_ORDER, скан QR первым шагом
    controlE2EToken,                 // контролёр: A «в работе» (скан-первый) + B «до начала»
    controlOrderAExt: CTL2_A_EXT,    // № заказа A (2 поз., 2 ед.) — «в работе»
    controlOrderBExt: CTL2_B_EXT,    // № заказа B (1 поз., 1 ед.) — «до начала»
    controlOrderAId: oCtl2A,         // id заказа A (проверка неизменности БД при неверном QR)
    controlOrderAQr,                 // верный QR заказа A → зелёное подтверждение + шаг EAN
    controlWrongQr,                  // валидный QR заказа B → «не тот заказ», шаг не меняется
    controlBadToken,                 // P2 fail-closed: повреждённые CONTROL_ORDER (текущая + очередь)
    // Задача N: контроль подтверждением строк (клик) — имена товаров строк заказа EO-CI-CTRL
    ctrlItemAName: "CI Контроль-товар A",
    ctrlItemBName: "CI Контроль-товар B",
    // Задача N: размещение целого заказа в назначенную ячейку выдачи (без EAN)
    issuePlaceToken,                 // погрузчик: ISSUE_ORDER «в работе», 1 назначенная ячейка, реальный сток
    issueOrderNExt: ISS_ORDER_EXT,   // № заказа размещения
    issueOrderNQr: issOrderQr,       // верный QR заказа
    issueAssignedCellCode: issAssignedCellCode, // человекочитаемый код назначенной ячейки
    issueAssignedCellQr: issAssignedCellQr,     // QR назначенной ячейки (скан)
    issueWrongCellQr: issWrongCellQr,           // QR другой (неназначенной) ISSUE-ячейки
    // Задача O: DELIVER_ORDER «в работе» (реальные placements, единственная ячейка)
    deliverToken,                    // погрузчик выдачи
    deliverOrderNExt: DEL_ORDER_EXT, // № заказа выдачи
    deliverOrderNQr: delOrderQr,     // верный QR заказа
    deliverAssignedCellCode: delAssignedCellCode, // код ячейки выдачи
    deliverAssignedCellQr: delAssignedCellQr,     // QR ячейки выдачи (скан)
    deliverWrongCellQr: delWrongCellQr,           // QR ISSUE-ячейки, НЕ назначенной этому заказу
    // Задача O: MOVE_GROUP «в работе» — исходная/целевая ячейки, EAN товара группы
    moveToken,                       // погрузчик перестановки
    moveItemName: "CI Выдача-товар N",
    moveFromCellCode: "IN-03",
    moveToCellCode: "IN-04",
    moveFromCellQr,                  // верная исходная ячейка
    moveToCellQr,                    // верная целевая ячейка (и «неверная исходная» для from-шага)
    moveEan: ISS_EAN,                // верный EAN товара группы
    moveEanWrong: CTRL_EAN_A,        // валидный EAN другого товара → не тот товар
    // ORDER-003 (Задача P2): авто-возобновление BLOCKED-заказа планировщиком
    blkAdminToken,                   // ADMIN для монитора
    blkPickerToken,                  // сборщик заполнителя (освобождает нижнюю ячейку)
    blkWhId: blkWh.id,               // фильтр монитора по складу
    blkOrderExt: BLK_ORDER_EXT,      // № целевого BLOCKED-заказа
    blkOrderId: impBlk.orderId,      // id целевого заказа (для detail-страницы статуса)
    blkFillExt: BLK_FILL_EXT,        // № заказа-заполнителя (собрать → освободить ячейку)
    blkFillCellQr,                   // QR нижней ячейки заполнителя
    blkFillEan: BLK_EAN,             // EAN товара заполнителя
    blkFillQty: 2,                   // количество заполнителя
    // P3A: многопользовательское распределение
    muWhId: muWh.id,                 // склад мультипользовательского сценария (фильтр монитора)
    muAToken,                        // PICKER A (ранняя смена, срочная задача)
    muBToken,                        // PICKER B (обычная задача)
    muAdminToken,                    // ADMIN-монитор с доступом к muWh
    muAName: "P3 Сборщик A",         // имя исполнителя срочной (видно в мониторе)
    muBName: "P3 Сборщик B",         // имя исполнителя обычной
    muUrgTitle: MU_URG_TITLE,        // заголовок срочной задачи (видимость у A, не у B)
    muNormTitle: MU_NORM_TITLE,      // заголовок обычной задачи (видимость у B, не у A)
    // P3A.2: реальный старт/завершение смены рабочих ролей (LOADER/PICKER/CONTROLLER → задачи)
    phLoaderToken,                   // P3B-FIX-2: погрузчик с PLACE_GROUP при 0 свободных ячейках
    phWhId: phWh.id,                 // склад PH (0 свободных ячеек)
    phTargetName: "CI PH-товар",     // товар целевой группы (карточка «Разместить»)
    startLoadToken,                  // погрузчик без смены (старт → /warehouse/tasks)
    startPickToken,                  // сборщик без смены (старт → /warehouse/tasks)
    startCtrlToken,                  // контролёр без смены (старт → /warehouse/tasks)
    // P3C-FIX-1: передача задачи (изолированный PICK_ORDER «в работе», два PICKER одной роли/склада)
    hoAToken,                        // исполнитель (ранняя смена) — отправитель передачи
    hoBToken,                        // коллега той же роли/склада — получатель
    hoAName: "CI Передача A",        // имя исходного исполнителя
    hoBName: "CI Передача B",        // имя получателя (в выпадающем списке «Кому передать»)
    hoWhId: hoWh.id,                 // склад фикстуры передачи (фильтр монитора)
    hoOrderExt: HO_ORDER_EXT,        // № заказа (компактная карточка «Собрать заказ»)
    hoOrderId: impHo.orderId,        // id заказа (DB-инварианты: резерв/движения)
    hoTaskId: hoPt.id,               // id PICK_ORDER (DB: статус/assignee/startedAt)
    hoItemName: HO_ITEM_NAME,        // товар (для проверки компактной карточки)
    // (izLoaderToken уже отдаётся выше — representative LOADER: ISSUE_ORDER «в работе», теперь с коллегой izMate)
  }));
  process.exit(0);
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
