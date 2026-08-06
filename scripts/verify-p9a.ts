// Проверка Этапа 5/Пакет 9A (настройки, фиксация 7 зон, ячейки, этикетки, основа EAN, сканер).
// Движок напрямую (tsx + prisma). Только dev-БД; тест-данные удаляются в finally.
// Запуск: npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-p9a.ts
/* eslint-disable no-console */
// Бизнес-флаги НЕ выставляем — проверяем, что X/R сохраняются и при выключенных флагах.
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { applyLotMovement } from "@/lib/stock";
import { ensureStandardZones, createCellsBatch, renameCell, deleteCell, setCellActive } from "@/lib/cells";
import { addItemBarcode, setItemBarcodeActive, findItemByEan } from "@/lib/barcodes";
import { parseEan, eanChecksumValid, classifyScan, parseInternalCode } from "@/lib/ean";
import { code128Png } from "@/lib/code128";
import { updateSettings, getSettings } from "@/lib/settings";
import { buildLabels } from "@/app/warehouse/print/labels/build-labels";
import { ZONE_KINDS } from "@/lib/zones";
import { readBarcodesFromImageFile } from "zxing-wasm/reader";

const prisma = new PrismaClient();
let failures = 0;
const ok = (n: string, c: boolean, e = "") => (c ? console.log(`  ✓ ${n}`) : (failures++, console.error(`  ✗ ${n} ${e}`)));
const err = async (fn: () => Promise<unknown>) => { try { await fn(); return ""; } catch (e) { return (e as Error).message; } };

let companyId = "", demoId = "", W = "", DW = "", admin = "", itemA = "", itemB = "", uomId = "";
const now = new Date();
let seq = 0;

// контрольная цифра EAN из тела (7 или 12 цифр)
function eanCheck(body: string): string {
  let sum = 0;
  for (let i = body.length - 1, k = 0; i >= 0; i--, k++) sum += Number(body[i]) * (k % 2 === 0 ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
}
const mkEan13 = (b12: string) => b12 + eanCheck(b12);
const mkEan8 = (b7: string) => b7 + eanCheck(b7);

async function seedLotInCell(cellId: string): Promise<string> {
  const number = 900000 + ++seq;
  const receipt = await prisma.receipt.create({ data: { companyId, number, warehouseId: W, status: "POSTED", postedAt: now, createdById: admin } });
  const line = await prisma.receiptLine.create({ data: { companyId, receiptId: receipt.id, itemId: itemA, qty: 3 } });
  const lot = await prisma.lot.create({ data: { companyId, itemId: itemA, receiptLineId: line.id, qtyReceived: 3 } });
  await prisma.$transaction((tx) => applyLotMovement(tx, { companyId, docType: "RECEIPT", docId: receipt.id, itemId: itemA, lotId: lot.id, qty: 3, from: null, to: { kind: "cell", warehouseId: W, cellId }, createdById: admin }));
  return lot.id;
}

async function provision() {
  companyId = (await prisma.company.findFirstOrThrow({ where: { slug: "rostagro" } })).id;
  W = (await prisma.warehouse.create({ data: { companyId, name: "P9A W", isActive: true } })).id;
  await ensureStandardZones(companyId, W);
  const uom = await prisma.uom.create({ data: { companyId, name: "шт P9A" } });
  uomId = uom.id;
  itemA = (await prisma.item.create({ data: { companyId, name: "P9A товар A", sku: "P9A-A", uomId, tracking: "LOT", isActive: true } })).id;
  itemB = (await prisma.item.create({ data: { companyId, name: "P9A товар B", sku: "P9A-B", uomId, tracking: "LOT", isActive: true } })).id;
  admin = (await prisma.user.create({ data: { id: "p9a_adm", companyId, phone: "+79995580001", name: "p9a", role: "ADMIN", isActive: true, passwordHash: await bcrypt.hash("p9a", 10), userRoles: { create: { role: "ADMIN" } } } })).id;
  const demo = await prisma.company.upsert({ where: { slug: "p9a-demo" }, update: {}, create: { name: "P9A Demo", slug: "p9a-demo", settings: {} } });
  demoId = demo.id;
  DW = (await prisma.warehouse.create({ data: { companyId: demoId, name: "P9A DW", isActive: true } })).id;
  await ensureStandardZones(demoId, DW);
}

const zoneOf = async (kind: string) => (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: W, kind: kind as never } })).id;

async function cleanup() {
  await prisma.itemBarcode.deleteMany({ where: { companyId: { in: [companyId, demoId] } } });
  const cs = (await prisma.cell.findMany({ where: { warehouseId: { in: [W, DW] } }, select: { id: true } })).map((c) => c.id);
  const groups = await prisma.handlingGroup.findMany({ where: { warehouseId: W }, select: { id: true, lotId: true } });
  const lotIds = groups.map((g) => g.lotId);
  await prisma.cellReservation.deleteMany({ where: { warehouseId: W } });
  await prisma.coolingSession.deleteMany({ where: { warehouseId: W } });
  await prisma.handlingGroup.deleteMany({ where: { warehouseId: W } });
  const allLots = await prisma.lot.findMany({ where: { companyId, itemId: { in: [itemA, itemB] } }, select: { id: true, receiptLineId: true } });
  const lids = [...new Set([...lotIds, ...allLots.map((l) => l.id)])];
  if (lids.length) {
    await prisma.stockMovement.deleteMany({ where: { lotId: { in: lids } } });
    await prisma.stockBalance.deleteMany({ where: { lotId: { in: lids } } });
  }
  const rls = allLots.map((l) => l.receiptLineId);
  await prisma.lot.deleteMany({ where: { id: { in: lids } } });
  const recs = [...new Set((await prisma.receiptLine.findMany({ where: { id: { in: rls } }, select: { receiptId: true } })).map((r) => r.receiptId))];
  await prisma.receiptLine.deleteMany({ where: { id: { in: rls } } });
  await prisma.receipt.deleteMany({ where: { id: { in: recs } } });
  await prisma.qrCode.deleteMany({ where: { type: "CELL", refId: { in: cs } } });
  await prisma.cell.deleteMany({ where: { warehouseId: { in: [W, DW] } } });
  await prisma.warehouseZone.deleteMany({ where: { warehouseId: { in: [W, DW] } } });
  await prisma.userRole.deleteMany({ where: { userId: "p9a_adm" } });
  await prisma.user.deleteMany({ where: { id: "p9a_adm" } });
  await prisma.item.deleteMany({ where: { companyId, name: { startsWith: "P9A " } } });
  await prisma.warehouse.deleteMany({ where: { id: { in: [W, DW] } } });
  if (demoId) await prisma.company.deleteMany({ where: { id: demoId, slug: "p9a-demo" } });
  await prisma.uom.deleteMany({ where: { id: uomId } });
}

async function main() {
  await provision();

  console.log("1) склад получает ровно семь системных зон (по одной каждого kind)");
  const zones = await prisma.warehouseZone.findMany({ where: { warehouseId: W } });
  ok("ровно 7 зон", zones.length === 7, `n=${zones.length}`);
  ok("по одной зоне каждого kind", ZONE_KINDS.every((k) => zones.filter((z) => z.kind === k).length === 1));

  console.log("2) зоны невозможно добавить/дублировать (unique warehouseId+kind на сервере)");
  const eDup = await err(() => prisma.warehouseZone.create({ data: { companyId, warehouseId: W, code: "STORAGE-2", name: "Ещё хранение", kind: "STORAGE" } }));
  ok("вторая зона того же kind отклонена БД (unique)", eDup.length > 0, eDup.slice(0, 40));
  ok("после отказа по-прежнему 7 зон", (await prisma.warehouseZone.count({ where: { warehouseId: W } })) === 7);

  console.log("3) ручное создание ячейки (STORAGE, уровень)");
  const storage = await zoneOf("STORAGE");
  const r3 = await createCellsBatch({ companyId, warehouseId: W, zoneId: storage, items: [{ code: "A-01", level: 1 }] });
  ok("ручная ячейка создана (created=1)", r3.created === 1 && r3.skipped.length === 0);
  const c3 = await prisma.cell.findFirstOrThrow({ where: { warehouseId: W, code: "A-01" } });
  ok("уровень=1, привязана к зоне, есть QR", c3.level === 1 && c3.zoneId === storage && !!(await prisma.qrCode.findFirst({ where: { type: "CELL", refId: c3.id } })));

  console.log("4) массовое создание с уровнями (диапазон мест × уровней)");
  const r4 = await createCellsBatch({ companyId, warehouseId: W, zoneId: storage, items: [1, 2].flatMap((lv) => ["B-01", "B-02"].map((p) => ({ code: `${p}-У${lv}`, level: lv }))) });
  ok("создано 4 ячейки (2 места × 2 уровня)", r4.created === 4);
  const r4b = await createCellsBatch({ companyId, warehouseId: W, zoneId: storage, items: [{ code: "B-01-У1", level: 1 }, { code: "B-99", level: 1 }] });
  ok("повтор: существующие пропущены (created=1, skipped=1)", r4b.created === 1 && r4b.skipped.length === 1);

  console.log("5) виртуальная зона — ячейки запрещены");
  const recvZone = await zoneOf("RECEIVING");
  const eVirt = await err(() => createCellsBatch({ companyId, warehouseId: W, zoneId: recvZone, items: [{ code: "R-01", level: null }] }));
  ok("ячейка в виртуальной зоне (RECEIVING) отклонена", /виртуальн/.test(eVirt), eVirt);

  console.log("6) STORAGE без уровня — отклонено");
  const eNoLvl = await err(() => createCellsBatch({ companyId, warehouseId: W, zoneId: storage, items: [{ code: "S-X", level: null }] }));
  ok("STORAGE без уровня отклонён", /уровень/i.test(eNoLvl) && (await prisma.cell.count({ where: { warehouseId: W, code: "S-X" } })) === 0, eNoLvl);

  console.log("7) COOLING/ISSUE/BUFFER с уровнем — отклонено");
  const coolZone = await zoneOf("COOLING");
  const eLvl = await err(() => createCellsBatch({ companyId, warehouseId: W, zoneId: coolZone, items: [{ code: "K-01", level: 2 }] }));
  ok("не-STORAGE с уровнем отклонён", /только для зоны хранения/.test(eLvl), eLvl);
  const rIssue = await createCellsBatch({ companyId, warehouseId: W, zoneId: await zoneOf("ISSUE"), items: [{ code: "I-01", level: null }] });
  ok("ISSUE-ячейка без уровня создаётся, isStaging=true", rIssue.created === 1 && (await prisma.cell.findFirstOrThrow({ where: { warehouseId: W, code: "I-01" } })).isStaging === true);

  console.log("8) использованная ячейка не переименовывается/не удаляется");
  await seedLotInCell(c3.id); // теперь A-01 использована и занята (qty>0)
  const eRen = await err(() => renameCell(companyId, c3.id, "A-01X"));
  ok("переименование использованной ячейки отклонено", /использов/.test(eRen), eRen);
  const eDel = await err(() => deleteCell(companyId, c3.id));
  ok("удаление использованной ячейки отклонено", /использов/.test(eDel), eDel);
  // неиспользованную — можно
  await renameCell(companyId, (await prisma.cell.findFirstOrThrow({ where: { warehouseId: W, code: "B-99" } })).id, "B-100");
  ok("неиспользованная ячейка переименована", !!(await prisma.cell.findFirst({ where: { warehouseId: W, code: "B-100" } })));
  const freeCell = await prisma.cell.findFirstOrThrow({ where: { warehouseId: W, code: "B-02-У1" } });
  await deleteCell(companyId, freeCell.id);
  ok("неиспользованная ячейка удалена вместе с QR", (await prisma.cell.count({ where: { id: freeCell.id } })) === 0 && (await prisma.qrCode.count({ where: { type: "CELL", refId: freeCell.id } })) === 0);

  console.log("9) занятая ячейка не деактивируется");
  const eAct = await err(() => setCellActive(companyId, c3.id, false));
  ok("деактивация занятой ячейки отклонена", /деактивир/.test(eAct), eAct);
  const emptyCell = await prisma.cell.findFirstOrThrow({ where: { warehouseId: W, code: "I-01" } });
  await setCellActive(companyId, emptyCell.id, false);
  ok("пустую ячейку деактивировать можно", (await prisma.cell.findFirstOrThrow({ where: { id: emptyCell.id } })).isActive === false);

  console.log("10) несколько EAN у одного товара");
  const ean1 = mkEan13("460000000000"), ean2 = mkEan8("4600001");
  await addItemBarcode({ companyId, itemId: itemA, code: ean1 });
  await addItemBarcode({ companyId, itemId: itemA, code: ean2 });
  ok("у товара A два активных EAN (13 и 8)", (await prisma.itemBarcode.count({ where: { itemId: itemA, isActive: true } })) === 2);

  console.log("11) один EAN нельзя назначить двум товарам");
  const eColl = await err(() => addItemBarcode({ companyId, itemId: itemB, code: ean1 }));
  ok("коллизия EAN отклонена (без перепривязки)", /другому товару/.test(eColl), eColl);
  ok("EAN остался у товара A", (await prisma.itemBarcode.findFirstOrThrow({ where: { companyId, code: ean1 } })).itemId === itemA);

  console.log("12) неверная контрольная цифра EAN отклоняется");
  const badEan = "460000000001"; // 12 цифр, не 13; и контрольная неверна как EAN
  ok("parseEan отклоняет неверную длину/цифру", parseEan(badEan) === null && !eanChecksumValid("4600000000009"));
  const eBad = await err(() => addItemBarcode({ companyId, itemId: itemB, code: "4600000000009" }));
  ok("addItemBarcode отклоняет неверный EAN", /Неверный EAN/.test(eBad), eBad);

  console.log("13) inactive EAN/Item не принимается для новых операций");
  ok("активный EAN находит активный товар", (await findItemByEan(companyId, ean1))?.item.id === itemA);
  const bc1 = await prisma.itemBarcode.findFirstOrThrow({ where: { companyId, code: ean1 } });
  await setItemBarcodeActive(companyId, bc1.id, false);
  ok("деактивированный EAN не находится", (await findItemByEan(companyId, ean1)) === null);
  await setItemBarcodeActive(companyId, bc1.id, true);
  await prisma.item.update({ where: { id: itemA }, data: { isActive: false } });
  ok("EAN неактивного товара не принимается", (await findItemByEan(companyId, ean1)) === null);
  await prisma.item.update({ where: { id: itemA }, data: { isActive: true } });

  console.log("14) tenant-изоляция EAN и зон");
  ok("EAN не виден другой организации", (await findItemByEan(demoId, ean2)) === null);
  const demoStorage = (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: DW, kind: "STORAGE" } })).id;
  const eTenZone = await err(() => createCellsBatch({ companyId, warehouseId: W, zoneId: demoStorage, items: [{ code: "TEN-1", level: 1 }] }));
  ok("зона чужого склада не применима к своему", eTenZone.length > 0 && (await prisma.cell.count({ where: { warehouseId: W, code: "TEN-1" } })) === 0);

  console.log("15) QR и Code 128 — один и тот же внутренний код (одинаковый payload)");
  const { labels } = await buildLabels(companyId, { cell: c3.id });
  const cellQr = (await prisma.qrCode.findFirstOrThrow({ where: { type: "CELL", refId: c3.id } })).code;
  ok("этикетка ячейки содержит её внутренний код", labels.length === 1 && labels[0].code === cellQr);
  // РЕАЛЬНАЯ считываемость: генерим Code 128 через bwip-js и декодируем ZXing (zxing-wasm) обратно
  const png = await code128Png(cellQr, 3);
  const decoded = await readBarcodesFromImageFile(new Blob([new Uint8Array(png)]), { formats: ["Code128"], tryHarder: true } as never);
  ok("Code 128 декодируется ZXing обратно в ТОТ ЖЕ внутренний код", decoded[0]?.text === cellQr, JSON.stringify(decoded.map((d) => d.text)));
  ok("внутренний код парсится как internal, а не как EAN", classifyScan(cellQr).kind === "internal" && parseInternalCode(cellQr) === cellQr);
  ok("валидный EAN классифицируется как ean, не как internal", classifyScan(ean2).kind === "ean" && parseInternalCode(ean2) === null);

  console.log("16) X и R сохраняются при выключенных бизнес-флагах");
  await updateSettings(companyId, { tempThresholdX: 4 });
  ok("порог X сохранён (company settings)", (await getSettings(companyId)).tempThresholdX === 4);
  await prisma.warehouse.update({ where: { id: W }, data: { coolingRate: 2.5 } });
  ok("скорость R сохранена (warehouse)", Number((await prisma.warehouse.findFirstOrThrow({ where: { id: W } })).coolingRate) === 2.5);

  console.log("17) снимок активной CoolingSession не меняется при смене настроек X/R");
  await createCellsBatch({ companyId, warehouseId: W, zoneId: coolZone, items: [{ code: "K-COOL", level: null }] });
  const coolCellId = (await prisma.cell.findFirstOrThrow({ where: { warehouseId: W, code: "K-COOL" } })).id;
  const lotForGroup = await seedLotInCell((await prisma.cell.findFirstOrThrow({ where: { warehouseId: W, code: "B-02-У2" } })).id);
  const group = await prisma.handlingGroup.create({ data: { companyId, warehouseId: W, itemId: itemA, lotId: lotForGroup, qty: 3, temperature: 8, thresholdX: 4, status: "IN_COOLING", dedupeKey: `p9a-cool-${++seq}`, acceptedById: admin } });
  const cool = await prisma.coolingSession.create({ data: { companyId, warehouseId: W, handlingGroupId: group.id, coolingCellId: coolCellId, startTemp: 8, thresholdX: 4, coolingRate: 2.5, estimatedReadyAt: now, status: "ACTIVE" } });
  await updateSettings(companyId, { tempThresholdX: -18 });
  await prisma.warehouse.update({ where: { id: W }, data: { coolingRate: 9.9 } });
  const coolAfter = await prisma.coolingSession.findFirstOrThrow({ where: { id: cool.id } });
  ok("снимок X/R активной сессии не переписан сменой настроек", Number(coolAfter.thresholdX) === 4 && Number(coolAfter.coolingRate) === 2.5);

  console.log("18) API-товар: EAN read-only (добавление/деактивация запрещены), учёт остаётся");
  const apiItem = await prisma.item.create({ data: { companyId, name: "P9A API товар", sku: "P9A-API", uomId, tracking: "LOT", isActive: true, source: "API", externalId: "ext-1" } });
  const apiEan = mkEan13("461000000000");
  await prisma.itemBarcode.create({ data: { companyId, itemId: apiItem.id, code: apiEan, symbology: "EAN13", source: "API", externalId: "ext-bc-1" } });
  const eApiAdd = await err(() => addItemBarcode({ companyId, itemId: apiItem.id, code: mkEan13("461000000001") }));
  ok("[18] добавление EAN API-товару отклонено", /интеграции/.test(eApiAdd), eApiAdd);
  const apiBc = await prisma.itemBarcode.findFirstOrThrow({ where: { companyId, code: apiEan } });
  const eApiDeact = await err(() => setItemBarcodeActive(companyId, apiBc.id, false));
  ok("[18] деактивация API-EAN отклонена", /интеграции/.test(eApiDeact), eApiDeact);
  ok("[18] активный API-EAN находит активный API-товар (учёт работает)", (await findItemByEan(companyId, apiEan))?.item.id === apiItem.id);
  // cleanup API-item создаётся здесь; общий cleanup удалит по companyId

  console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ P9A ПРОЙДЕНЫ ✓" : `\nПРОВАЛ: ${failures} проверок`);
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => {
    await cleanup().catch((e) => console.error("cleanup:", e));
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });
