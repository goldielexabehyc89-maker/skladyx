// Проверка Этапа 5/Пакет 3 (зоны, уровни, backfill, policy). Движок и policy тестируются
// напрямую (tsx + prisma). Только dev-БД; тест-данные удаляются в finally.
// Запуск: npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-zones.ts
/* eslint-disable no-console */
import { PrismaClient } from "@prisma/client";
import { ensureStandardZones, createCellsInZone, changeCellZone } from "@/lib/cells";
import { isVirtualZoneKind, isPhysicalZoneKind } from "@/lib/zones";
import {
  storageOrder,
  isPickableLevel,
  isCoolingFallbackLevel,
  needsMoveDown,
  pickStorageCell,
} from "@/lib/placement";

const prisma = new PrismaClient();
let failures = 0;
const ok = (n: string, c: boolean, e = "") => (c ? console.log(`  ✓ ${n}`) : (failures++, console.error(`  ✗ ${n} ${e}`)));

let companyId = "", demoId = "", W1 = "", WB = "", DW = "";

async function cleanup() {
  // тест-строки ledger (маркер z-item) — у StockBalance/ItemUnit нет FK, чистим по маркеру
  await prisma.stockBalance.deleteMany({ where: { itemId: "z-item" } });
  await prisma.itemUnit.deleteMany({ where: { itemId: "z-item" } });
  const whIds = [W1, WB, DW].filter(Boolean);
  if (whIds.length) {
    const cellIds = (await prisma.cell.findMany({ where: { warehouseId: { in: whIds } }, select: { id: true } })).map((c) => c.id);
    if (cellIds.length) await prisma.qrCode.deleteMany({ where: { type: "CELL", refId: { in: cellIds } } });
    await prisma.cell.deleteMany({ where: { warehouseId: { in: whIds } } });
    await prisma.warehouseZone.deleteMany({ where: { warehouseId: { in: whIds } } });
    await prisma.warehouse.deleteMany({ where: { id: { in: [W1, WB].filter(Boolean) } } });
  }
  if (demoId) {
    await prisma.warehouseZone.deleteMany({ where: { companyId: demoId } });
    await prisma.warehouse.deleteMany({ where: { companyId: demoId } });
    await prisma.company.deleteMany({ where: { id: demoId, slug: "zones-demo" } });
  }
}

async function main() {
  const rost = await prisma.company.findFirstOrThrow({ where: { slug: "rostagro" } });
  companyId = rost.id;
  W1 = (await prisma.warehouse.create({ data: { companyId, name: "Z1 wh", isActive: true } })).id;
  const demo = await prisma.company.upsert({ where: { slug: "zones-demo" }, update: {}, create: { name: "Zones Demo", slug: "zones-demo", settings: {} } });
  demoId = demo.id;
  DW = (await prisma.warehouse.create({ data: { companyId: demoId, name: "ZD wh", isActive: true } })).id;

  console.log("1) стандартные зоны склада");
  await ensureStandardZones(companyId, W1);
  const zones = await prisma.warehouseZone.findMany({ where: { warehouseId: W1 } });
  ok("создано 7 стандартных зон", zones.length === 7, `got ${zones.length}`);
  ok("3 виртуальные + 4 физические", zones.filter((z) => isVirtualZoneKind(z.kind)).length === 3 && zones.filter((z) => isPhysicalZoneKind(z.kind)).length === 4);
  const storage = zones.find((z) => z.kind === "STORAGE")!;
  const issue = zones.find((z) => z.kind === "ISSUE")!;
  const receiving = zones.find((z) => z.kind === "RECEIVING")!;

  console.log("2) STORAGE требует уровень >= 1");
  let errNoLevel = "";
  try { await createCellsInZone({ companyId, warehouseId: W1, zoneId: storage.id, codes: ["Z-01"], level: null }); } catch (e) { errNoLevel = (e as Error).message; }
  ok("STORAGE без уровня отклонён, ячейка не создана", !!errNoLevel && (await prisma.cell.count({ where: { warehouseId: W1, code: "Z-01" } })) === 0, errNoLevel);
  const n = await createCellsInZone({ companyId, warehouseId: W1, zoneId: storage.id, codes: ["Z-01", "Z-02"], level: 2 });
  ok("STORAGE с уровнем создаёт ячейки", n === 2);
  const zc = await prisma.cell.findFirst({ where: { warehouseId: W1, code: "Z-01" } });
  ok("STORAGE-ячейка: level=2, isStaging=false, привязана к зоне", zc?.level === 2 && zc?.isStaging === false && zc?.zoneId === storage.id);

  console.log("3) ISSUE синхронизируется с isStaging=true");
  await createCellsInZone({ companyId, warehouseId: W1, zoneId: issue.id, codes: ["I-01"], level: null });
  const ic = await prisma.cell.findFirst({ where: { warehouseId: W1, code: "I-01" } });
  ok("ISSUE-ячейка: isStaging=true, level=null", ic?.isStaging === true && ic?.level === null);

  console.log("4) запрет ячеек в виртуальной зоне");
  let errVirt = "";
  try { await createCellsInZone({ companyId, warehouseId: W1, zoneId: receiving.id, codes: ["R-01"], level: null }); } catch (e) { errVirt = (e as Error).message; }
  ok("ячейка в виртуальной зоне (RECEIVING) отклонена", !!errVirt && (await prisma.cell.count({ where: { warehouseId: W1, code: "R-01" } })) === 0);

  console.log("5) смена зоны ячейки");
  await changeCellZone({ companyId, cellId: ic!.id, zoneId: storage.id, level: 3 });
  const ic2 = await prisma.cell.findUnique({ where: { id: ic!.id } });
  ok("ISSUE→STORAGE: isStaging=false, level=3", ic2?.isStaging === false && ic2?.level === 3 && ic2?.zoneId === storage.id);
  let errCV = "";
  try { await changeCellZone({ companyId, cellId: ic!.id, zoneId: receiving.id, level: null }); } catch (e) { errCV = (e as Error).message; }
  ok("смена в виртуальную зону отклонена", !!errCV);
  let errCL = "";
  try { await changeCellZone({ companyId, cellId: ic!.id, zoneId: storage.id, level: null }); } catch (e) { errCL = (e as Error).message; }
  ok("смена в STORAGE без уровня отклонена", !!errCL);

  console.log("5b) занятая ячейка: смену зоны запрещаем, пустую — разрешаем");
  const zoneOf = async (id: string) => (await prisma.cell.findUnique({ where: { id } }))?.zoneId ?? null;
  // ic сейчас в STORAGE, level=3, пустая. Занимаем партионным товаром.
  await prisma.stockBalance.create({ data: { companyId, itemId: "z-item", lotId: "z-lot", locKey: `C:${ic!.id}`, warehouseId: W1, cellId: ic!.id, qty: 5 } });
  let errLot = "";
  try { await changeCellZone({ companyId, cellId: ic!.id, zoneId: issue.id, level: null }); } catch (e) { errLot = (e as Error).message; }
  ok("занята партией → смена зоны отклонена нужным текстом", /занятой или зарезервированной/.test(errLot), errLot);
  ok("после отказа зона не изменилась (осталась STORAGE)", (await zoneOf(ic!.id)) === storage.id);
  await prisma.stockBalance.deleteMany({ where: { cellId: ic!.id } });
  // Занимаем поштучным товаром (ItemUnit).
  await prisma.itemUnit.create({ data: { companyId, itemId: "z-item", receiptLineId: "z-rl", serial: 1, warehouseId: W1, cellId: ic!.id, status: "IN_STOCK" } });
  let errUnit = "";
  try { await changeCellZone({ companyId, cellId: ic!.id, zoneId: issue.id, level: null }); } catch (e) { errUnit = (e as Error).message; }
  ok("занята единицей → смена зоны отклонена", /занятой или зарезервированной/.test(errUnit), errUnit);
  await prisma.itemUnit.deleteMany({ where: { cellId: ic!.id } });
  // Пустую ячейку переносим в ISSUE — isStaging синхронизируется в true, level → null.
  await changeCellZone({ companyId, cellId: ic!.id, zoneId: issue.id, level: null });
  const icE = await prisma.cell.findUnique({ where: { id: ic!.id } });
  ok("пустая ячейка перенесена в ISSUE: zoneId=ISSUE, isStaging=true, level=null", icE?.zoneId === issue.id && icE?.isStaging === true && icE?.level === null);

  console.log("6) tenant-изоляция зон");
  await ensureStandardZones(demoId, DW);
  const demoStorage = await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: DW, kind: "STORAGE" } });
  let errTen = "";
  try { await createCellsInZone({ companyId, warehouseId: W1, zoneId: demoStorage.id, codes: ["X-01"], level: 1 }); } catch (e) { errTen = (e as Error).message; }
  ok("зона другой организации не применима к своему складу", !!errTen && (await prisma.cell.count({ where: { warehouseId: W1, code: "X-01" } })) === 0);
  let errTen2 = "";
  try { await createCellsInZone({ companyId: demoId, warehouseId: W1, zoneId: storage.id, codes: ["X-02"], level: 1 }); } catch (e) { errTen2 = (e as Error).message; }
  ok("своя зона с чужим companyId отклонена", !!errTen2 && (await prisma.cell.count({ where: { warehouseId: W1, code: "X-02" } })) === 0);

  console.log("7) backfill isStaging (логика миграции)");
  WB = (await prisma.warehouse.create({ data: { companyId, name: "ZB wh", isActive: true } })).id;
  await prisma.cell.create({ data: { companyId, warehouseId: WB, code: "S-1", isStaging: false } });
  await prisma.cell.create({ data: { companyId, warehouseId: WB, code: "G-1", isStaging: true } });
  await ensureStandardZones(companyId, WB); // как в миграции — стандартные зоны склада
  await prisma.$executeRaw`UPDATE "Cell" c SET "zoneId" = z."id" FROM "WarehouseZone" z WHERE z."warehouseId" = c."warehouseId" AND z."kind" = 'ISSUE' AND c."isStaging" = true AND c."zoneId" IS NULL AND c."warehouseId" = ${WB}`;
  await prisma.$executeRaw`UPDATE "Cell" c SET "zoneId" = z."id" FROM "WarehouseZone" z WHERE z."warehouseId" = c."warehouseId" AND z."kind" = 'STORAGE' AND c."isStaging" = false AND c."zoneId" IS NULL AND c."warehouseId" = ${WB}`;
  const sCell = await prisma.cell.findFirst({ where: { warehouseId: WB, code: "S-1" }, include: { zone: true } });
  const gCell = await prisma.cell.findFirst({ where: { warehouseId: WB, code: "G-1" }, include: { zone: true } });
  ok("isStaging=false → зона STORAGE", sCell?.zone?.kind === "STORAGE", `got ${sCell?.zone?.kind}`);
  ok("isStaging=true → зона ISSUE", gCell?.zone?.kind === "ISSUE", `got ${gCell?.zone?.kind}`);

  console.log("8) policy размещения по уровням");
  ok("storageOrder: 1→2→3 (уник., по возрастанию)", JSON.stringify(storageOrder([3, 1, 2, 2, 1])) === JSON.stringify([1, 2, 3]));
  ok("сборщик берёт только уровни 1–2", isPickableLevel(1) && isPickableLevel(2) && !isPickableLevel(3) && !isPickableLevel(null));
  ok("cooling fallback только 3+", !isCoolingFallbackLevel(2) && isCoolingFallbackLevel(3) && isCoolingFallbackLevel(5));
  ok("move-down только для источника 3+", !needsMoveDown(1) && !needsMoveDown(2) && needsMoveDown(3));
  const pick = pickStorageCell([{ level: 3, code: "C" }, { level: 1, code: "B" }, { level: 1, code: "A" }, { level: null, code: "Z" }]);
  ok("pickStorageCell: нижний уровень, затем code (A)", pick?.code === "A", `got ${pick?.code}`);
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ P3 ПРОЙДЕНЫ ✓" : `\nПРОВАЛЕНО: ${failures}`);
    process.exit(failures === 0 ? 0 : 1);
  });
