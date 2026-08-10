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
  await reserveAndPlanOrder({ companyId, orderId: imp.orderId, userId: loader });

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
    await reserveAndPlanOrder({ companyId, orderId: impO.orderId, userId: pkA });
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

  const mkToken = async (userId: string, navRole: Role) => {
    const u = await prisma.user.findFirstOrThrow({ where: { companyId, id: userId }, include: { userRoles: { select: { role: true } } } });
    return createSessionToken({ userId: u.id, login: u.phone ?? u.email ?? "", name: u.name, role: navRole, roles: u.userRoles.map((r) => r.role), companyId });
  };
  const startToken = await mkToken(startRecv, "RECEIVER");      // приёмщик без смены — реальный старт смены
  const adminRecvToken = await mkToken(adminRecv, "ADMIN");     // ADMIN + активная смена RECEIVER
  const adminLoadToken = await mkToken(adminLoad, "ADMIN");     // ADMIN + активная смена LOADER
  const controllerToken = await mkToken(ctlU, "CONTROLLER");    // CONTROL_ORDER «в работе»
  const correctToken = await mkToken(correctPickerId, "PICKER"); // CORRECT_ORDER «в работе»

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
  }));
  process.exit(0);
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
