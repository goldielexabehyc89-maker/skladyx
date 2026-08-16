// R1/TENANT-001: двухорганизационная изоляция + cross-tenant защита ядра остатков (engine, blocking).
// Движок напрямую (tsx + prisma), только dev/CI-БД. Организация A = РостАгро (реальная, чистим только
// СВОИ добавленные строки по сохранённым id), организация B = throwaway с УНИКАЛЬНЫМ slug `r1-tenant-iso`
// (чистим целиком по companyId; общий `demo` не трогаем). Проверяем: одинаковый телефон в разных орг.;
// изоляция товаров/EAN/складов/ячеек/задач/заказов/QR/файлов; scheduler не смешивает орг.; cross-tenant
// lotId/cellId/itemId/unitId/userId → StockError без движений и изменения остатков; QR РостАгро — тот же URL.
// Запуск: npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-tenant-isolation.ts
/* eslint-disable no-console */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { applyLotMovement, moveUnit, StockError } from "@/lib/stock";
import { scoped, CompanyForbiddenError } from "@/lib/tenant";
import { createWorkflowTask, rebalanceQueuedTasks } from "@/lib/workflow-tasks";
import { createQrIn } from "@/lib/qr";
import { ensureStandardZones, createCellsInZone } from "@/lib/cells";
import { baseUrlFromHost } from "@/lib/tenant-host";
import type { SessionData } from "@/lib/jwt";

const prisma = new PrismaClient();
let failures = 0;
const ok = (n: string, c: boolean, e = "") => (c ? console.log(`  ✓ ${n}`) : (failures++, console.error(`  ✗ ${n} ${e}`)));
const threw = async (fn: () => Promise<unknown>, kind: "stock" | "forbidden"): Promise<boolean> => {
  try { await fn(); return false; } catch (e) { return kind === "stock" ? e instanceof StockError : e instanceof CompanyForbiddenError; }
};
const sess = (companyId: string, userId: string): SessionData => ({ userId, login: "iso", name: "iso", role: "ADMIN", roles: ["ADMIN"], companyId });

const ISO_SLUG = "r1-tenant-iso";
const SHARED_PHONE = "+79990001111"; // одинаковый телефон в обеих орг. — допустимо (@@unique([companyId,phone]))

interface OrgIds {
  companyId: string; uomId: string; whId: string; cellId: string; itemId: string; ean: string;
  userId: string; receiptId: string; lineId: string; lotId: string; unitId: string;
  orderId: string; taskId: string; qrCode: string; attachmentId: string;
}

let A: OrgIds, B: OrgIds; let isoCompanyId = "";

function eanOf(body: string): string { let s = 0; for (let i = body.length - 1, k = 0; i >= 0; i--, k++) s += Number(body[i]) * (k % 2 === 0 ? 3 : 1); return body + String((10 - (s % 10)) % 10); }

async function seedOrg(companyId: string, tag: string, recNo: number, ean: string): Promise<OrgIds> {
  const uom = await prisma.uom.create({ data: { companyId, name: `R1ISO-${tag}-uom` } });
  const wh = await prisma.warehouse.create({ data: { companyId, name: `R1ISO-${tag}-WH`, isActive: true } });
  await ensureStandardZones(companyId, wh.id);
  const zStorage = await prisma.warehouseZone.findFirstOrThrow({ where: { companyId, warehouseId: wh.id, kind: "STORAGE" } });
  await createCellsInZone({ companyId, warehouseId: wh.id, zoneId: zStorage.id, codes: [`R1-${tag}-01`], level: 1 });
  const cell = await prisma.cell.findFirstOrThrow({ where: { companyId, warehouseId: wh.id, code: `R1-${tag}-01` } });
  const item = await prisma.item.create({ data: { companyId, name: `R1ISO-${tag}-item`, uomId: uom.id, tracking: "LOT", isActive: true } });
  await prisma.itemBarcode.create({ data: { companyId, itemId: item.id, code: ean, symbology: "EAN13", source: "MANUAL", isActive: true } });
  const user = await prisma.user.create({ data: { companyId, phone: SHARED_PHONE, name: `R1ISO ${tag}`, role: "ADMIN", isActive: true, passwordHash: await bcrypt.hash("r1iso", 10), userRoles: { create: { role: "ADMIN" } } } });
  const receipt = await prisma.receipt.create({ data: { companyId, number: recNo, warehouseId: wh.id, status: "POSTED", postedAt: new Date(), createdById: user.id } });
  const line = await prisma.receiptLine.create({ data: { companyId, receiptId: receipt.id, itemId: item.id, qty: 5 } });
  const lot = await prisma.lot.create({ data: { companyId, itemId: item.id, receiptLineId: line.id, qtyReceived: 5 } });
  await prisma.$transaction((tx) => applyLotMovement(tx, { companyId, docType: "RECEIPT", docId: receipt.id, itemId: item.id, lotId: lot.id, qty: 5, from: null, to: { kind: "cell", warehouseId: wh.id, cellId: cell.id }, createdById: user.id }));
  const unit = await prisma.itemUnit.create({ data: { companyId, itemId: item.id, receiptLineId: line.id, serial: 1, status: "IN_STOCK", warehouseId: wh.id, cellId: cell.id } });
  const order = await prisma.externalOrder.create({ data: { companyId, warehouseId: wh.id, externalId: `R1ISO-${tag}-ORDER`, status: "IMPORTED", payloadHash: `r1iso-${tag}` } });
  const task = await createWorkflowTask({ companyId, warehouseId: wh.id, type: "PICK_ORDER", requiredRole: "PICKER", priority: "NORMAL", title: `R1ISO ${tag} task`, dedupeKey: `r1iso-${tag}-task` });
  const qrCode = await prisma.$transaction((tx) => createQrIn(tx, { companyId, type: "ORDER", refId: order.id }));
  const att = await prisma.attachment.create({ data: { companyId, ownerType: "receipt", ownerId: `r1iso-${tag}-owner`, fileName: `R1ISO-${tag}.png`, mime: "image/png", size: 10, storedPath: `r1iso/${tag}.png`, uploadedById: user.id } });
  return { companyId, uomId: uom.id, whId: wh.id, cellId: cell.id, itemId: item.id, ean, userId: user.id, receiptId: receipt.id, lineId: line.id, lotId: lot.id, unitId: unit.id, orderId: order.id, taskId: task.task.id, qrCode, attachmentId: att.id };
}

async function provision() {
  const rost = await prisma.company.findFirstOrThrow({ where: { slug: "rostagro" } });
  const iso = await prisma.company.upsert({ where: { slug: ISO_SLUG }, update: {}, create: { name: "R1 Tenant Iso", slug: ISO_SLUG, settings: {} } });
  isoCompanyId = iso.id;
  A = await seedOrg(rost.id, "A", 9980001, eanOf("460000111000"));
  B = await seedOrg(iso.id, "B", 9980002, eanOf("460000222000"));
}

async function main() {
  console.log("verify-tenant-isolation — две организации: изоляция данных + cross-tenant stock");
  await provision();

  // 1) одинаковый телефон у сотрудников разных организаций — допустимо, но это РАЗНЫЕ пользователи
  const sharedUsers = await prisma.user.findMany({ where: { phone: SHARED_PHONE, id: { in: [A.userId, B.userId] } } });
  ok("одинаковый телефон в разных орг. → два разных User", sharedUsers.length === 2 && A.userId !== B.userId && sharedUsers[0].companyId !== sharedUsers[1].companyId);

  // 2) изоляция данных: чужая строка не видна по своему companyId; своя — видна
  const isolated = async (label: string, byOwn: Promise<unknown>, byReal: Promise<unknown>) => {
    ok(`изоляция ${label}: чужая строка не видна по своему companyId`, (await byOwn) === null && (await byReal) !== null);
  };
  await isolated("товар (item)", prisma.item.findFirst({ where: { id: B.itemId, companyId: A.companyId } }), prisma.item.findFirst({ where: { id: B.itemId, companyId: B.companyId } }));
  await isolated("склад (warehouse)", prisma.warehouse.findFirst({ where: { id: B.whId, companyId: A.companyId } }), prisma.warehouse.findFirst({ where: { id: B.whId, companyId: B.companyId } }));
  await isolated("ячейка (cell)", prisma.cell.findFirst({ where: { id: B.cellId, companyId: A.companyId } }), prisma.cell.findFirst({ where: { id: B.cellId, companyId: B.companyId } }));
  await isolated("задача (workflowTask)", prisma.workflowTask.findFirst({ where: { id: B.taskId, companyId: A.companyId } }), prisma.workflowTask.findFirst({ where: { id: B.taskId, companyId: B.companyId } }));
  await isolated("заказ (externalOrder)", prisma.externalOrder.findFirst({ where: { id: B.orderId, companyId: A.companyId } }), prisma.externalOrder.findFirst({ where: { id: B.orderId, companyId: B.companyId } }));
  await isolated("файл (attachment)", prisma.attachment.findFirst({ where: { id: B.attachmentId, companyId: A.companyId } }), prisma.attachment.findFirst({ where: { id: B.attachmentId, companyId: B.companyId } }));
  await isolated("единица (itemUnit)", prisma.itemUnit.findFirst({ where: { id: B.unitId, companyId: A.companyId } }), prisma.itemUnit.findFirst({ where: { id: B.unitId, companyId: B.companyId } }));
  await isolated("партия (lot)", prisma.lot.findFirst({ where: { id: B.lotId, companyId: A.companyId } }), prisma.lot.findFirst({ where: { id: B.lotId, companyId: B.companyId } }));
  // EAN и QR — по своим ключам (code)
  ok("изоляция EAN: чужой EAN не виден по своему companyId", (await prisma.itemBarcode.findFirst({ where: { code: B.ean, companyId: A.companyId } })) === null && (await prisma.itemBarcode.findFirst({ where: { code: B.ean, companyId: B.companyId } })) !== null);
  ok("изоляция QR: чужой QR не виден по своему companyId", (await prisma.qrCode.findFirst({ where: { code: B.qrCode, companyId: A.companyId } })) === null && (await prisma.qrCode.findFirst({ where: { code: B.qrCode, companyId: B.companyId } })) !== null);

  // 2b) app-слой scoped(): чужой объект → CompanyForbiddenError
  ok("scoped(A).item(чужой) → CompanyForbiddenError", await threw(() => scoped(sess(A.companyId, A.userId)).item(B.itemId), "forbidden"));
  ok("scoped(B).warehouse(чужой) → CompanyForbiddenError", await threw(() => scoped(sess(B.companyId, B.userId)).warehouse(A.whId), "forbidden"));

  // 3) scheduler не смешивает организации
  const bTaskBefore = await prisma.workflowTask.findUniqueOrThrow({ where: { id: B.taskId } });
  await rebalanceQueuedTasks(A.companyId);
  const bTaskAfter = await prisma.workflowTask.findUniqueOrThrow({ where: { id: B.taskId } });
  ok("rebalanceQueuedTasks(A) не трогает задачу B", bTaskAfter.status === bTaskBefore.status && bTaskAfter.assignedUserId === bTaskBefore.assignedUserId);

  // 4) cross-tenant защита stock.ts — чужие ссылки → StockError без движений/изменения остатков
  const smCount = async () => prisma.stockMovement.count({ where: { companyId: { in: [A.companyId, B.companyId] } } });
  const bBal = async () => (await prisma.stockBalance.findFirst({ where: { lotId: B.lotId }, select: { qty: true } }))?.qty.toString() ?? "0";
  const aBal = async () => (await prisma.stockBalance.findFirst({ where: { lotId: A.lotId }, select: { qty: true } }))?.qty.toString() ?? "0";
  const sm0 = await smCount(), bb0 = await bBal(), ab0 = await aBal();

  // 4a) companyId=A, чужая партия/ячейка/товар (B) → StockError
  ok("applyLotMovement: чужая партия/ячейка (B) под companyId=A → StockError", await threw(() => prisma.$transaction((tx) => applyLotMovement(tx, { companyId: A.companyId, docType: "TRANSFER", docId: "x", itemId: B.itemId, lotId: B.lotId, qty: 1, from: { kind: "cell", warehouseId: B.whId, cellId: B.cellId }, to: null, createdById: A.userId })), "stock"));
  // 4b) companyId=A, своя партия, но чужой пользователь (B) → StockError
  ok("applyLotMovement: чужой createdById (B) под companyId=A → StockError", await threw(() => prisma.$transaction((tx) => applyLotMovement(tx, { companyId: A.companyId, docType: "TRANSFER", docId: "x", itemId: A.itemId, lotId: A.lotId, qty: 1, from: { kind: "cell", warehouseId: A.whId, cellId: A.cellId }, to: null, createdById: B.userId })), "stock"));
  // 4c) moveUnit: чужая единица (B) под companyId=A → StockError
  const bUnit = await prisma.itemUnit.findUniqueOrThrow({ where: { id: B.unitId } });
  ok("moveUnit: чужая единица (B) под companyId=A → StockError", await threw(() => prisma.$transaction((tx) => moveUnit(tx, { companyId: A.companyId, docType: "TRANSFER", docId: "x", unit: bUnit, to: { kind: "warehouse", warehouseId: A.whId }, status: "IN_STOCK", createdById: A.userId })), "stock"));

  ok("cross-tenant отказы не создали движений", (await smCount()) === sm0, `${sm0} -> ${await smCount()}`);
  ok("остатки A и B не изменились", (await bBal()) === bb0 && (await aBal()) === ab0, `A ${ab0}->${await aBal()} B ${bb0}->${await bBal()}`);

  // 5) корректная операция (своя партия/ячейка/пользователь) по-прежнему проходит — защита не ломает штатное
  await prisma.$transaction((tx) => applyLotMovement(tx, { companyId: A.companyId, docType: "TRANSFER", docId: "ok", itemId: A.itemId, lotId: A.lotId, qty: 1, from: { kind: "cell", warehouseId: A.whId, cellId: A.cellId }, to: { kind: "warehouse", warehouseId: A.whId }, createdById: A.userId }));
  ok("корректная операция A (своя) выполнилась (движение создано)", (await smCount()) === sm0 + 1);

  // 6) QR РостАгро до/после — тот же рабочий URL (чистый билдер домена)
  ok("baseUrlFromHost(rostagro.skladyx.ru) === https://rostagro.skladyx.ru", baseUrlFromHost("rostagro.skladyx.ru") === "https://rostagro.skladyx.ru");
  ok("baseUrlFromHost(staging-rostagro.skladyx.ru) === https://staging-rostagro.skladyx.ru", baseUrlFromHost("staging-rostagro.skladyx.ru") === "https://staging-rostagro.skladyx.ru");
  ok("baseUrlFromHost(localhost:3000) === http://localhost:3000", baseUrlFromHost("localhost:3000") === "http://localhost:3000");

  console.log(failures === 0 ? "\nVERIFY-TENANT-ISOLATION OK ✓" : `\nПРОВАЛЕНО: ${failures}`);
}

async function cleanupOrgA() {
  if (!A) return;
  // РостАгро: удаляем ТОЛЬКО свои добавленные строки по сохранённым id (реальные данные не трогаем).
  await prisma.stockMovement.deleteMany({ where: { lotId: A.lotId } });
  await prisma.stockMovement.deleteMany({ where: { unitId: A.unitId } });
  await prisma.stockBalance.deleteMany({ where: { lotId: A.lotId } });
  await prisma.itemUnit.deleteMany({ where: { id: A.unitId } });
  await prisma.lot.deleteMany({ where: { id: A.lotId } });
  await prisma.receiptLine.deleteMany({ where: { receiptId: A.receiptId } });
  await prisma.receipt.deleteMany({ where: { id: A.receiptId } });
  await prisma.workflowTask.deleteMany({ where: { id: A.taskId } });
  // событие task_created нашей задачи (по стабильному body=title, не трогая реальные события РостАгро)
  await prisma.event.deleteMany({ where: { companyId: A.companyId, body: "R1ISO A task" } });
  await prisma.qrCode.deleteMany({ where: { refId: A.orderId, type: "ORDER" } });
  await prisma.externalOrder.deleteMany({ where: { id: A.orderId } });
  await prisma.attachment.deleteMany({ where: { id: A.attachmentId } });
  await prisma.itemBarcode.deleteMany({ where: { itemId: A.itemId } });
  await prisma.item.deleteMany({ where: { id: A.itemId } });
  await prisma.cell.deleteMany({ where: { warehouseId: A.whId } });
  await prisma.warehouseZone.deleteMany({ where: { warehouseId: A.whId } });
  await prisma.warehouse.deleteMany({ where: { id: A.whId } });
  await prisma.userRole.deleteMany({ where: { userId: A.userId } });
  await prisma.user.deleteMany({ where: { id: A.userId } });
  await prisma.uom.deleteMany({ where: { id: A.uomId } });
}

async function cleanupOrgB() {
  if (!isoCompanyId) return;
  const cid = isoCompanyId;
  // Throwaway-организация r1-tenant-iso: удаляем ВСЁ по companyId + саму организацию (guard: id + slug).
  await prisma.event.deleteMany({ where: { companyId: cid } });
  await prisma.stockMovement.deleteMany({ where: { companyId: cid } });
  await prisma.stockBalance.deleteMany({ where: { companyId: cid } });
  await prisma.itemUnit.deleteMany({ where: { companyId: cid } });
  await prisma.lot.deleteMany({ where: { companyId: cid } });
  await prisma.receiptLine.deleteMany({ where: { companyId: cid } });
  await prisma.receipt.deleteMany({ where: { companyId: cid } });
  await prisma.workflowTask.deleteMany({ where: { companyId: cid } });
  await prisma.qrCode.deleteMany({ where: { companyId: cid } });
  await prisma.externalOrder.deleteMany({ where: { companyId: cid } });
  await prisma.attachment.deleteMany({ where: { companyId: cid } });
  await prisma.itemBarcode.deleteMany({ where: { companyId: cid } });
  await prisma.item.deleteMany({ where: { companyId: cid } });
  await prisma.cell.deleteMany({ where: { companyId: cid } });
  await prisma.warehouseZone.deleteMany({ where: { companyId: cid } });
  await prisma.warehouse.deleteMany({ where: { companyId: cid } });
  await prisma.userRole.deleteMany({ where: { user: { companyId: cid } } });
  await prisma.user.deleteMany({ where: { companyId: cid } });
  await prisma.uom.deleteMany({ where: { companyId: cid } });
  await prisma.company.deleteMany({ where: { id: cid, slug: ISO_SLUG } });
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => {
    try { await cleanupOrgA(); } catch (e) { console.error("cleanup A:", e); }
    try { await cleanupOrgB(); } catch (e) { console.error("cleanup B:", e); }
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });
