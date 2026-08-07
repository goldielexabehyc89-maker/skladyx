import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

// Пакет 11 (коррекция ревью): групповой режим «Остатков» с серверной пагинацией и КОРРЕКТНЫМ
// резервом. Резерв учитывается только когда его (lotId, sourceLocKey) относится к StockBalance,
// попавшему в текущую выборку (тот же фильтр склад/зона/товар/ячейка) — резервы из другой зоны или
// склада в строку не попадают. Пагинация и агрегация — на уровне БД (COUNT DISTINCT + GROUP BY с
// ORDER BY name,itemId + LIMIT/OFFSET). Все пользовательские значения передаются параметрами
// (Prisma.sql/Prisma.join) — без конкатенации SQL-строк.

export interface StockGroupFilter {
  companyId: string;
  // конкретный склад (уже проверенный на доступ) либо "__none__" для «нет доступа»
  warehouseId?: string;
  // ограничение доступа к складам: null — все склады; массив — только эти
  allowedWarehouseIds?: string[] | null;
  zoneId?: string; // выбранная зона
  zoneCellIds?: string[]; // ячейки этой зоны
  // поиск: null — поиск не задан; иначе множества совпадений (пустые → «ничего не найдено»)
  qItemIds?: string[] | null;
  qCellIds?: string[];
  qZoneIds?: string[];
}

export interface StockGroupRow {
  itemId: string;
  name: string;
  qty: number;
  reserved: number;
}

// Условия WHERE по StockBalance (алиас sb) — единый источник и для агрегатов, и для резерва.
function balanceConditions(f: StockGroupFilter): Prisma.Sql {
  const c: Prisma.Sql[] = [
    Prisma.sql`sb."companyId" = ${f.companyId}`,
    Prisma.sql`sb.qty > 0`,
    Prisma.sql`sb."employeeId" IS NULL`,
  ];
  if (f.warehouseId !== undefined) {
    c.push(Prisma.sql`sb."warehouseId" = ${f.warehouseId}`);
  } else if (f.allowedWarehouseIds != null) {
    c.push(f.allowedWarehouseIds.length ? Prisma.sql`sb."warehouseId" IN (${Prisma.join(f.allowedWarehouseIds)})` : Prisma.sql`FALSE`);
  }
  if (f.zoneId) {
    const cells = f.zoneCellIds ?? [];
    c.push(cells.length
      ? Prisma.sql`(sb."zoneId" = ${f.zoneId} OR sb."cellId" IN (${Prisma.join(cells)}))`
      : Prisma.sql`sb."zoneId" = ${f.zoneId}`);
  }
  if (f.qItemIds != null) {
    // поиск задан: товар/EAN → itemId, код ячейки → cellId, название зоны → zoneId
    const ors: Prisma.Sql[] = [];
    if (f.qItemIds.length) ors.push(Prisma.sql`sb."itemId" IN (${Prisma.join(f.qItemIds)})`);
    if (f.qCellIds?.length) ors.push(Prisma.sql`sb."cellId" IN (${Prisma.join(f.qCellIds)})`);
    if (f.qZoneIds?.length) ors.push(Prisma.sql`sb."zoneId" IN (${Prisma.join(f.qZoneIds)})`);
    c.push(ors.length ? Prisma.sql`(${Prisma.join(ors, ` OR `)})` : Prisma.sql`FALSE`);
  }
  return Prisma.join(c, ` AND `);
}

// Число уникальных товаров в выборке (для пагинации).
export async function stockGroupedCount(f: StockGroupFilter): Promise<number> {
  const where = balanceConditions(f);
  const rows = await prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT COUNT(*)::bigint AS n FROM (
      SELECT sb."itemId" FROM "StockBalance" sb WHERE ${where} GROUP BY sb."itemId"
    ) t`);
  return Number(rows[0]?.n ?? 0n);
}

// Страница агрегатов по товару (qty из выборки, reserved — только резервы, чьи (lotId, sourceLocKey)
// относятся к StockBalance той же выборки). Стабильный порядок: name, затем itemId.
export async function stockGroupedPage(f: StockGroupFilter, page: number, pageSize: number): Promise<StockGroupRow[]> {
  const where = balanceConditions(f);
  const skip = Math.max(0, (page - 1) * pageSize);
  const agg = await prisma.$queryRaw<{ itemId: string; name: string; qty: string }[]>(Prisma.sql`
    SELECT sb."itemId" AS "itemId", i.name AS name, SUM(sb.qty)::text AS qty
    FROM "StockBalance" sb JOIN "Item" i ON i.id = sb."itemId"
    WHERE ${where}
    GROUP BY sb."itemId", i.name
    ORDER BY i.name ASC, sb."itemId" ASC
    LIMIT ${pageSize} OFFSET ${skip}`);
  const itemIds = agg.map((a) => a.itemId);
  if (itemIds.length === 0) return [];
  // резерв только для товаров страницы и только по совпадению (lotId, sourceLocKey) с выборкой
  const resRows = await prisma.$queryRaw<{ itemId: string; reserved: string }[]>(Prisma.sql`
    SELECT sb."itemId" AS "itemId", SUM(sr.qty)::text AS reserved
    FROM "StockReservation" sr
    JOIN "StockBalance" sb ON sb."lotId" = sr."lotId" AND sb."locKey" = sr."sourceLocKey"
    WHERE sr."companyId" = ${f.companyId} AND sr.status::text = 'ACTIVE'
      AND sb."itemId" IN (${Prisma.join(itemIds)})
      AND ${where}
    GROUP BY sb."itemId"`);
  const reservedByItem = new Map(resRows.map((r) => [r.itemId, Number(r.reserved)]));
  return agg.map((a) => ({ itemId: a.itemId, name: a.name, qty: Number(a.qty), reserved: reservedByItem.get(a.itemId) ?? 0 }));
}
