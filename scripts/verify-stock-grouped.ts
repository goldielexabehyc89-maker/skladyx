// Пакет 11 (коррекция ревью): регрессия группового режима «Остатков».
// [P1] резерв учитывается строго по совпадению (lotId, sourceLocKey) с выборкой текущего фильтра
//      (резерв из другой зоны/склада не попадает в строку);
// [P2] серверная пагинация: корректное число страниц, стабильный порядок, отсутствие дублей,
//      верные суммы qty/резерва.
// Изолированная временная компания; тест-данные удаляются в finally. Только dev-БД.
// Запуск: npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-stock-grouped.ts
/* eslint-disable no-console */
import { PrismaClient } from "@prisma/client";
import { stockGroupedCount, stockGroupedPage, type StockGroupFilter } from "@/lib/stock-query";

const prisma = new PrismaClient();
let failures = 0;
const ok = (n: string, c: boolean, e = "") => (c ? console.log(`  ✓ ${n}`) : (failures++, console.error(`  ✗ ${n} ${e}`)));

const SLUG = "sq-grouped-demo";
let companyId = "", uomId = "";
let Wa = "", Wb = "", zoneA = "", zoneB = "", cellA = "", cellB = "", cellB2 = "";

async function cleanup() {
  if (!companyId) return;
  await prisma.stockReservation.deleteMany({ where: { companyId } });
  await prisma.externalOrderLine.deleteMany({ where: { companyId } });
  await prisma.externalOrder.deleteMany({ where: { companyId } });
  await prisma.stockBalance.deleteMany({ where: { companyId } });
  await prisma.cell.deleteMany({ where: { companyId } });
  await prisma.warehouseZone.deleteMany({ where: { companyId } });
  await prisma.itemBarcode.deleteMany({ where: { companyId } });
  await prisma.item.deleteMany({ where: { companyId } });
  await prisma.warehouse.deleteMany({ where: { companyId } });
  await prisma.uom.deleteMany({ where: { companyId } });
  await prisma.company.deleteMany({ where: { id: companyId, slug: SLUG } });
}

async function mkBalance(itemId: string, lotId: string, warehouseId: string, cellId: string, qty: number) {
  await prisma.stockBalance.create({
    data: { companyId, itemId, lotId, locKey: `C:${cellId}`, warehouseId, cellId, qty },
  });
}
async function mkReservation(itemId: string, lotId: string, cellId: string, qty: number, dedupeKey: string) {
  const order = await prisma.externalOrder.create({
    data: { companyId, warehouseId: Wa, externalId: `EO-${dedupeKey}`, payloadHash: dedupeKey, status: "READY_TO_PICK" },
  });
  const line = await prisma.externalOrderLine.create({
    data: { companyId, orderId: order.id, externalLineId: "1", itemId, requiredQty: qty },
  });
  await prisma.stockReservation.create({
    data: { companyId, orderId: order.id, lineId: line.id, lotId, sourceLocKey: `C:${cellId}`, cellId, qty, status: "ACTIVE", dedupeKey },
  });
}

async function provision() {
  await cleanup();
  const company = await prisma.company.create({ data: { name: "SQ Grouped Demo", slug: SLUG, settings: {} } });
  companyId = company.id;
  uomId = (await prisma.uom.create({ data: { companyId, name: "шт", allowFraction: false } })).id;
  Wa = (await prisma.warehouse.create({ data: { companyId, name: "SQ-Wa", isActive: true } })).id;
  Wb = (await prisma.warehouse.create({ data: { companyId, name: "SQ-Wb", isActive: true } })).id;
  zoneA = (await prisma.warehouseZone.create({ data: { companyId, warehouseId: Wa, code: "A", name: "Зона A", kind: "STORAGE" } })).id;
  zoneB = (await prisma.warehouseZone.create({ data: { companyId, warehouseId: Wa, code: "B", name: "Зона B", kind: "COOLING" } })).id;
  const zoneB2 = (await prisma.warehouseZone.create({ data: { companyId, warehouseId: Wb, code: "S", name: "Зона Wb", kind: "STORAGE" } })).id;
  cellA = (await prisma.cell.create({ data: { companyId, warehouseId: Wa, code: "SQ-A1", zoneId: zoneA, level: 1 } })).id;
  cellB = (await prisma.cell.create({ data: { companyId, warehouseId: Wa, code: "SQ-B1", zoneId: zoneB } })).id;
  cellB2 = (await prisma.cell.create({ data: { companyId, warehouseId: Wb, code: "SQ-WB1", zoneId: zoneB2, level: 1 } })).id;
}

async function main() {
  try {
    await provision();

    // ── [P1] один товар в двух зонах, активный резерв только в зоне A ──
    const itemX = (await prisma.item.create({ data: { companyId, name: "SQ Товар X", uomId, tracking: "LOT" } })).id;
    await mkBalance(itemX, "sqA", Wa, cellA, 10); // зона A
    await mkBalance(itemX, "sqB", Wa, cellB, 5); // зона B
    await mkReservation(itemX, "sqA", cellA, 3, "sq-res-A"); // резерв ТОЛЬКО в зоне A

    const baseA: StockGroupFilter = { companyId, warehouseId: Wa, allowedWarehouseIds: null, qItemIds: null };
    const noFilter = await stockGroupedPage(baseA, 1, 50);
    ok("[P1] без зоны: один товар", (await stockGroupedCount(baseA)) === 1 && noFilter.length === 1);
    ok("[P1] без зоны: qty=15, резерв=3 (общий)", noFilter[0]?.qty === 15 && noFilter[0]?.reserved === 3, JSON.stringify(noFilter[0]));

    const zAF: StockGroupFilter = { ...baseA, zoneId: zoneA, zoneCellIds: [cellA] };
    const zA = await stockGroupedPage(zAF, 1, 50);
    ok("[P1] зона A: qty=10, резерв=3", zA[0]?.qty === 10 && zA[0]?.reserved === 3, JSON.stringify(zA[0]));

    const zBF: StockGroupFilter = { ...baseA, zoneId: zoneB, zoneCellIds: [cellB] };
    const zB = await stockGroupedPage(zBF, 1, 50);
    ok("[P1] зона B: qty=5, резерв=0 (чужой резерв не попадает)", zB[0]?.qty === 5 && zB[0]?.reserved === 0, JSON.stringify(zB[0]));

    // ── [P2] 51 товар, серверная пагинация ──
    const N = 51;
    const ids: string[] = [];
    for (let i = 1; i <= N; i++) {
      const name = `SQ-Y${String(i).padStart(3, "0")}`;
      const id = (await prisma.item.create({ data: { companyId, name, uomId, tracking: "LOT" } })).id;
      ids.push(id);
      await mkBalance(id, `sqY${i}`, Wb, cellB2, i); // qty = i
    }
    // резерв на первом и последнем товаре (для проверки сумм и распределения по страницам)
    await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: Wb } });
    const mkResWb = async (itemId: string, lotId: string, qty: number, dk: string) => {
      const order = await prisma.externalOrder.create({ data: { companyId, warehouseId: Wb, externalId: `EO-${dk}`, payloadHash: dk, status: "READY_TO_PICK" } });
      const line = await prisma.externalOrderLine.create({ data: { companyId, orderId: order.id, externalLineId: "1", itemId, requiredQty: qty } });
      await prisma.stockReservation.create({ data: { companyId, orderId: order.id, lineId: line.id, lotId, sourceLocKey: `C:${cellB2}`, cellId: cellB2, qty, status: "ACTIVE", dedupeKey: dk } });
    };
    await mkResWb(ids[0], "sqY1", 2, "sq-wb-1"); // Y001 → резерв 2 (страница 1)
    await mkResWb(ids[N - 1], `sqY${N}`, 4, "sq-wb-51"); // Y051 → резерв 4 (страница 2)

    const fB: StockGroupFilter = { companyId, warehouseId: Wb, allowedWarehouseIds: null, qItemIds: null };
    const total = await stockGroupedCount(fB);
    ok("[P2] всего уникальных товаров = 51", total === N, String(total));
    const pageCount = Math.ceil(total / 50);
    ok("[P2] число страниц = 2 (page size 50)", pageCount === 2, String(pageCount));

    const p1 = await stockGroupedPage(fB, 1, 50);
    const p2 = await stockGroupedPage(fB, 2, 50);
    ok("[P2] страница 1 = 50 строк, страница 2 = 1 строка", p1.length === 50 && p2.length === 1, `${p1.length}/${p2.length}`);
    ok("[P2] стабильный порядок по имени (страница 1 начинается с SQ-Y001)", p1[0]?.name === "SQ-Y001" && p1[49]?.name === "SQ-Y050", `${p1[0]?.name}..${p1[49]?.name}`);
    ok("[P2] страница 2 — SQ-Y051", p2[0]?.name === "SQ-Y051", p2[0]?.name);
    const p1set = new Set(p1.map((r) => r.itemId));
    ok("[P2] на странице 2 нет дублей страницы 1", !p1.some((r) => r.itemId === p2[0]?.itemId) && !p1set.has(p2[0]?.itemId ?? ""));
    const sumQty = [...p1, ...p2].reduce((s, r) => s + r.qty, 0);
    ok("[P2] сумма qty по страницам = 1326 (Σ1..51)", sumQty === (N * (N + 1)) / 2, String(sumQty));
    const sumRes = [...p1, ...p2].reduce((s, r) => s + r.reserved, 0);
    ok("[P2] сумма резервов = 6 (2 на Y001 + 4 на Y051)", sumRes === 6, String(sumRes));
    ok("[P2] резерв Y001 на стр.1 = 2", p1.find((r) => r.name === "SQ-Y001")?.reserved === 2);
    ok("[P2] резерв Y051 на стр.2 = 4", p2[0]?.reserved === 4);

    console.log(failures === 0 ? "\nSTOCK GROUPED OK ✓" : `\nПРОВАЛЕНО: ${failures}`);
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error("ERR", e); try { await cleanup(); } catch {} process.exit(1); });
