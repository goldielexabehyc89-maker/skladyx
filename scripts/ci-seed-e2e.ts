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

import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { ensureStandardZones, createCellsInZone } from "@/lib/cells";
import { updateSettings } from "@/lib/settings";
import { createHandlingGroup, completeGroupPlacement } from "@/lib/group-receiving";
import { startWorkflowTask } from "@/lib/workflow-tasks";
import { importExternalOrder, reserveAndPlanOrder } from "@/lib/external-orders";
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

  // сотрудники + смены (RECEIVER — он же логин рабочей роли для e2e; LOADER — размещение)
  const receiver = await mkUser(companyId, RECV_PHONE, "CI Приёмщик", "RECEIVER", RECV_PASS, wh.id);
  const loader = await mkUser(companyId, LOAD_PHONE, "CI Погрузчик", "LOADER", LOAD_PASS, wh.id);
  for (const [uid, role] of [[receiver, "RECEIVER"], [loader, "LOADER"]] as [string, Role][]) {
    if (!(await prisma.workShift.findFirst({ where: { userId: uid, endedAt: null } })))
      await prisma.workShift.create({ data: { companyId, userId: uid, warehouseId: wh.id, role } });
  }

  // 1) приёмка группы (движок) → RECEIPT-движение + Event «Приёмка группы»
  const grp = await createHandlingGroup({ companyId, warehouseId: wh.id, itemId: item.id, qty: QTY, temperature: 4, acceptedById: receiver, dedupeKey: "ci-e2e-recv-1" });

  // 2) размещение в STORAGE-ячейку (движок) → TRANSFER-движение + Event «Размещение» + IN_STORAGE
  const g = await prisma.handlingGroup.findUniqueOrThrow({ where: { id: grp.groupId } });
  if (g.status === "AWAITING_STORAGE") {
    const placeTask = await prisma.workflowTask.findFirstOrThrow({ where: { subjectId: grp.groupId, type: "PLACE_GROUP" } });
    await startWorkflowTask(loader, companyId, placeTask.id);
    await completeGroupPlacement({ companyId, userId: loader, taskId: placeTask.id, cellCode: cellQr.code, ean: EAN });
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
  if (g2.status === "AWAITING_STORAGE") {
    const place2 = await prisma.workflowTask.findFirstOrThrow({ where: { subjectId: grp2.groupId, type: "PLACE_GROUP" } });
    if (place2.status !== "IN_PROGRESS") {
      await prisma.workflowTask.update({ where: { id: place2.id }, data: { assignedUserId: loader, assignedShiftId: (await prisma.workShift.findFirstOrThrow({ where: { userId: loader, endedAt: null } })).id, status: "ASSIGNED" } });
      await startWorkflowTask(loader, companyId, place2.id);
    }
  }

  // проверка целостности созданного состояния
  const bal = await prisma.stockBalance.findFirstOrThrow({ where: { companyId, cellId: cell.id, itemId: item.id, qty: { gt: 0 } } });
  const resv = await prisma.stockReservation.count({ where: { companyId, status: "ACTIVE", lotId: bal.lotId } });
  const gFinal = await prisma.handlingGroup.findUniqueOrThrow({ where: { id: grp.groupId } });
  if (!gFinal || gFinal.status !== "IN_STORAGE") throw new Error(`группа не IN_STORAGE: ${gFinal?.status}`);
  if (resv < 1) throw new Error("активный резерв не создан");

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
  const adminToken = await createSessionToken({ userId: admin.id, login: admin.phone ?? admin.email ?? "", name: admin.name, role: "ADMIN", roles: admin.userRoles.map((r) => r.role), companyId });
  const workToken = await createSessionToken({ userId: work.id, login: work.phone ?? work.email ?? "", name: work.name, role: "RECEIVER", roles: work.userRoles.map((r) => r.role), companyId });
  const loaderToken = await createSessionToken({ userId: loaderU.id, login: loaderU.phone ?? loaderU.email ?? "", name: loaderU.name, role: "LOADER", roles: loaderU.userRoles.map((r) => r.role), companyId });

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
  }));
  process.exit(0);
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
