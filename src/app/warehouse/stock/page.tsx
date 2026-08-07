import Link from "next/link";
import { requireWarehouseViewerPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { allowedWarehouses, warehouseAccess, isWhAllowed } from "@/lib/warehouse-access";
import { prisma } from "@/lib/db";
import { EmptyState, FilterBar, FilterSubmit, SelectField } from "@/components/ui";
import { PageShell } from "@/components/page-shell";
import { DataTable, type Column } from "@/components/data-table";
import { fmtQty } from "@/lib/format";
import { StockTable, type StockRow } from "./stock-table";
import { stockGroupedCount, stockGroupedPage, type StockGroupFilter } from "@/lib/stock-query";
import type { Prisma, HandlingGroupStatus } from "@prisma/client";

// Пакет 11: остатки на новой модели — StockBalance + зоны/ячейки + состояние группы
// (HandlingGroup) + резерв заказа (StockReservation). Без закупочной стоимости, заказов
// поставщику, заявок-сборки, поштучных единиц и «у сотрудников». Строка = размещение партии.
// Фильтры (склад/зона/товар/EAN/ячейка) и пагинация — на уровне БД: строки текущей страницы
// (или агрегаты по товару) не загружают весь StockBalance в память.
const PAGE_SIZE = 50;
const NONE = "__none__"; // сентинел «ничего не найдено» для where

const GROUP_STATE: Record<HandlingGroupStatus, { label: string; tone: StockRow["groupTone"] }> = {
  IN_RECEIVING: { label: "В приёмке", tone: "neutral" },
  AWAITING_STORAGE: { label: "Ждёт размещения", tone: "orange" },
  AWAITING_COOLING: { label: "Ждёт охлаждения", tone: "orange" },
  IN_STORAGE: { label: "На хранении", tone: "green" },
  IN_COOLING: { label: "В охлаждении", tone: "blue" },
};

export default async function StockPage({
  searchParams,
}: {
  searchParams: Promise<{ warehouse?: string; zone?: string; grouped?: string; q?: string; page?: string }>;
}) {
  const session = await requireWarehouseViewerPage();
  const s = scoped(session);
  const sp = await searchParams;
  const access = await warehouseAccess(session);
  const grouped = sp.grouped === "1";
  const q = (sp.q ?? "").trim();

  // ── единый набор резолвленных фильтров (для плоского where и группового raw одновременно) ──
  // склад: конкретный (после проверки доступа; NONE → «нет доступа»), либо ограничение доступа.
  const warehouseId = sp.warehouse ? (isWhAllowed(access, sp.warehouse) ? sp.warehouse : NONE) : undefined;
  const allowedWarehouseIds = access.all ? null : access.ids;
  // зона: ячейки выбранной зоны (для условия zoneId ИЛИ cellId в ячейках зоны).
  let zoneCellIds: string[] = [];
  if (sp.zone) zoneCellIds = (await prisma.cell.findMany({ where: { companyId: s.companyId, zoneId: sp.zone }, select: { id: true } })).map((c) => c.id);
  // поиск: товар/EAN → itemId, код ячейки → cellId, название зоны → zoneId. null — поиск не задан.
  let qItemIds: string[] | null = null;
  let qCellIds: string[] = [];
  let qZoneIds: string[] = [];
  if (q) {
    const [byEan, byName, qCells, qZones] = await Promise.all([
      prisma.itemBarcode.findMany({ where: { companyId: s.companyId, code: { contains: q, mode: "insensitive" } }, select: { itemId: true } }),
      prisma.item.findMany({ where: { companyId: s.companyId, name: { contains: q, mode: "insensitive" } }, select: { id: true } }),
      prisma.cell.findMany({ where: { companyId: s.companyId, code: { contains: q, mode: "insensitive" } }, select: { id: true } }),
      prisma.warehouseZone.findMany({ where: { companyId: s.companyId, name: { contains: q, mode: "insensitive" } }, select: { id: true } }),
    ]);
    qItemIds = [...new Set([...byEan.map((b) => b.itemId), ...byName.map((i) => i.id)])];
    qCellIds = qCells.map((c) => c.id);
    qZoneIds = qZones.map((z) => z.id);
  }

  // Плоский where (Prisma) из тех же резолвленных множеств.
  const and: Prisma.StockBalanceWhereInput[] = [{ companyId: s.companyId, qty: { gt: 0 }, employeeId: null }];
  if (warehouseId !== undefined) and.push({ warehouseId });
  else if (allowedWarehouseIds) and.push({ warehouseId: { in: allowedWarehouseIds } });
  if (sp.zone) and.push({ OR: [{ zoneId: sp.zone }, { cellId: { in: zoneCellIds } }] });
  if (qItemIds != null) {
    const or: Prisma.StockBalanceWhereInput[] = [];
    if (qItemIds.length) or.push({ itemId: { in: qItemIds } });
    if (qCellIds.length) or.push({ cellId: { in: qCellIds } });
    if (qZoneIds.length) or.push({ zoneId: { in: qZoneIds } });
    and.push(or.length ? { OR: or } : { id: NONE });
  }
  const where: Prisma.StockBalanceWhereInput = { AND: and };

  // Структурированный фильтр для группового режима (тот же смысл, серверная агрегация/резерв).
  const groupFilter: StockGroupFilter = {
    companyId: s.companyId,
    ...(warehouseId !== undefined ? { warehouseId } : {}),
    allowedWarehouseIds,
    ...(sp.zone ? { zoneId: sp.zone, zoneCellIds } : {}),
    qItemIds,
    qCellIds,
    qZoneIds,
  };

  // справочники для селектов фильтра (склады/зоны доступа)
  const [warehouses, zones] = await Promise.all([
    allowedWarehouses(session, s.companyId),
    prisma.warehouseZone.findMany({
      where: { companyId: s.companyId, isActive: true, ...(access.all ? {} : { warehouseId: { in: access.ids } }) },
      orderBy: [{ warehouseId: "asc" }, { sortOrder: "asc" }],
      select: { id: true, name: true },
    }),
  ]);

  const inputCls = "min-h-11 w-full rounded-xl border border-[#e4e4f0] px-3 py-2 text-base outline-none focus:border-brand";

  // ── общая пагинация ──
  let totalRows = 0;
  let page = 1;
  let grpRows: { name: string; ean: string; uom: string; qty: number; reserved: number }[] = [];
  let rows: StockRow[] = [];

  if (grouped) {
    // Групповой режим: серверная пагинация + корректный резерв (по совпадению lotId/sourceLocKey
    // с выборкой) — src/lib/stock-query.ts. EAN/uom подгружаются только для товаров страницы.
    totalRows = await stockGroupedCount(groupFilter);
    const pageCount = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
    page = Math.min(Math.max(1, Number(sp.page) || 1), pageCount);
    const pageAgg = await stockGroupedPage(groupFilter, page, PAGE_SIZE);
    const pageItemIds = pageAgg.map((a) => a.itemId);
    const [items, barcodes] = await Promise.all([
      prisma.item.findMany({ where: { id: { in: pageItemIds } }, include: { uom: true } }),
      prisma.itemBarcode.findMany({ where: { companyId: s.companyId, itemId: { in: pageItemIds }, isActive: true }, orderBy: { createdAt: "asc" }, select: { itemId: true, code: true } }),
    ]);
    const uomByItem = new Map(items.map((i) => [i.id, i.uom.name]));
    const eanByItem = new Map<string, string>();
    for (const b of barcodes) if (!eanByItem.has(b.itemId)) eanByItem.set(b.itemId, b.code);
    grpRows = pageAgg.map((a) => ({
      name: a.name,
      ean: eanByItem.get(a.itemId) ?? "",
      uom: uomByItem.get(a.itemId) ?? "",
      qty: a.qty,
      reserved: a.reserved,
    }));
  } else {
    totalRows = await prisma.stockBalance.count({ where });
    const pageCount = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
    page = Math.min(Math.max(1, Number(sp.page) || 1), pageCount);
    const pageBalances = await prisma.stockBalance.findMany({
      where,
      orderBy: [{ itemId: "asc" }, { id: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    });
    const itemIds = [...new Set(pageBalances.map((b) => b.itemId))];
    const lotIds = [...new Set(pageBalances.map((b) => b.lotId))];
    const cellIds = [...new Set(pageBalances.map((b) => b.cellId).filter((x): x is string => !!x))];
    const balZoneIds = pageBalances.map((b) => b.zoneId).filter((x): x is string => !!x);
    const [items, barcodes, cells, groups, reservations] = await Promise.all([
      prisma.item.findMany({ where: { id: { in: itemIds } }, include: { uom: true } }),
      prisma.itemBarcode.findMany({ where: { companyId: s.companyId, itemId: { in: itemIds }, isActive: true }, orderBy: { createdAt: "asc" }, select: { itemId: true, code: true } }),
      prisma.cell.findMany({ where: { id: { in: cellIds } }, select: { id: true, code: true, zoneId: true } }),
      prisma.handlingGroup.findMany({ where: { companyId: s.companyId, lotId: { in: lotIds } }, select: { lotId: true, status: true } }),
      prisma.stockReservation.findMany({ where: { companyId: s.companyId, status: "ACTIVE", lotId: { in: lotIds } }, select: { lotId: true, sourceLocKey: true, qty: true, order: { select: { externalId: true } } } }),
    ]);
    const cellZoneIds = cells.map((c) => c.zoneId).filter((x): x is string => !!x);
    const zoneRows = await prisma.warehouseZone.findMany({ where: { id: { in: [...new Set([...balZoneIds, ...cellZoneIds])] } }, select: { id: true, name: true } });
    const itemById = new Map(items.map((i) => [i.id, i]));
    const eanByItem = new Map<string, string>();
    for (const b of barcodes) if (!eanByItem.has(b.itemId)) eanByItem.set(b.itemId, b.code);
    const cellById = new Map(cells.map((c) => [c.id, c]));
    const zoneName = new Map(zoneRows.map((z) => [z.id, z.name]));
    const groupByLot = new Map(groups.map((g) => [g.lotId, g.status]));
    const resByKey = new Map<string, { qty: number; orders: Set<string> }>();
    for (const r of reservations) {
      const key = `${r.lotId}#${r.sourceLocKey ?? ""}`;
      const e = resByKey.get(key) ?? { qty: 0, orders: new Set<string>() };
      e.qty += r.qty.toNumber();
      if (r.order?.externalId) e.orders.add(r.order.externalId);
      resByKey.set(key, e);
    }
    const whName = new Map(warehouses.map((w) => [w.id, w.name]));
    rows = pageBalances.map((b) => {
      const item = itemById.get(b.itemId);
      const cell = b.cellId ? cellById.get(b.cellId) : null;
      const gs = groupByLot.get(b.lotId);
      const g = gs ? GROUP_STATE[gs] : null;
      const res = resByKey.get(`${b.lotId}#${b.locKey}`);
      return {
        name: item?.name ?? "—",
        ean: eanByItem.get(b.itemId) ?? "",
        where: cell ? cell.code : b.zoneId ? zoneName.get(b.zoneId) ?? "зона" : "без ячейки",
        warehouse: b.warehouseId ? whName.get(b.warehouseId) ?? "" : "",
        groupState: g?.label ?? "",
        groupTone: g?.tone ?? "neutral",
        qty: fmtQty(b.qty),
        uom: item?.uom.name ?? "",
        reserved: res && res.qty > 0 ? fmtQty(res.qty) : "",
        reservedOrders: res ? [...res.orders].join(", ") : "",
      } satisfies StockRow;
    });
  }

  // totalRows и page уже вычислены в ветке (серверная пагинация); grpRows — уже страница.
  const pageCount = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));

  const qs = (p: number) => {
    const params = new URLSearchParams();
    if (sp.warehouse) params.set("warehouse", sp.warehouse);
    if (sp.zone) params.set("zone", sp.zone);
    if (grouped) params.set("grouped", "1");
    if (q) params.set("q", q);
    if (p > 1) params.set("page", String(p));
    const str = params.toString();
    return str ? `/warehouse/stock?${str}` : "/warehouse/stock";
  };
  const pageNums: number[] = [];
  for (let p = Math.max(1, page - 2); p <= Math.min(pageCount, page + 2); p++) pageNums.push(p);

  return (
    <PageShell title="Остатки">
      <FilterBar>
        <div className="grid w-full grid-cols-1 gap-2 sm:flex sm:flex-1">
          <SelectField name="warehouse" defaultValue={sp.warehouse ?? ""} className="text-sm sm:flex-1">
            <option value="">Все склады</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </SelectField>
          <SelectField name="zone" defaultValue={sp.zone ?? ""} className="text-sm sm:flex-1">
            <option value="">Все зоны</option>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>{z.name}</option>
            ))}
          </SelectField>
        </div>
        <div className="flex w-full gap-2 sm:flex-1">
          <input name="q" defaultValue={q} placeholder="Поиск по товару, EAN или ячейке…" className={inputCls} />
          <FilterSubmit />
        </div>
        <label className="flex w-full items-center gap-2 text-sm text-neutral-600">
          <input type="checkbox" name="grouped" value="1" defaultChecked={grouped} className="h-5 w-5" />
          Группировать по товарам — общее количество по названию
        </label>
      </FilterBar>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-neutral-500">
        <span>Строк: <b className="text-neutral-900">{totalRows}</b></span>
      </div>

      {totalRows === 0 ? (
        <EmptyState>По выбранным фильтрам остатков нет.</EmptyState>
      ) : grouped ? (
        <DataTable
          columns={
            [
              { key: "name", header: "Товар", cell: (g) => <span className="font-medium">{g.name}</span> },
              { key: "ean", header: "EAN", className: "font-mono text-xs text-neutral-500", cell: (g) => g.ean || "—" },
              { key: "uom", header: "Ед.", className: "text-neutral-500", cell: (g) => g.uom },
              { key: "qty", header: "Кол-во", align: "right", className: "tabular-nums", cell: (g) => fmtQty(g.qty) },
              {
                key: "reserved",
                header: "Резерв заказа",
                align: "right",
                className: "tabular-nums text-orange-600",
                cell: (g) => (g.reserved > 0 ? fmtQty(g.reserved) : ""),
              },
            ] satisfies Column<(typeof grpRows)[number]>[]
          }
          rows={grpRows}
          rowKey={(g) => `${g.name}#${g.uom}`}
          minWidth="min-w-[560px]"
          mobileCard={(g) => (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{g.name}</div>
                {g.ean && <div className="font-mono text-xs text-neutral-400">{g.ean}</div>}
              </div>
              <div className="shrink-0 text-right">
                <div className="text-base font-bold tabular-nums">
                  {fmtQty(g.qty)} <span className="text-xs font-normal text-neutral-500">{g.uom}</span>
                </div>
                {g.reserved > 0 && (
                  <div className="text-sm tabular-nums text-orange-600">резерв {fmtQty(g.reserved)} {g.uom}</div>
                )}
              </div>
            </div>
          )}
        />
      ) : (
        <StockTable rows={rows} />
      )}

      {pageCount > 1 && (
        <div className="flex items-center justify-center gap-1.5 text-sm">
          {page > 1 && (
            <Link href={qs(page - 1)} className="rounded-lg border border-[#e4e4f0] bg-white px-3 py-1.5">←</Link>
          )}
          {pageNums[0] > 1 && (
            <>
              <Link href={qs(1)} className="rounded-lg border border-[#e4e4f0] bg-white px-3 py-1.5">1</Link>
              {pageNums[0] > 2 && <span className="px-1 text-neutral-400">…</span>}
            </>
          )}
          {pageNums.map((p) => (
            <Link
              key={p}
              href={qs(p)}
              className={"rounded-lg px-3 py-1.5 " + (p === page ? "bg-brand font-semibold text-white" : "border border-[#e4e4f0] bg-white")}
            >
              {p}
            </Link>
          ))}
          {pageNums[pageNums.length - 1] < pageCount && (
            <>
              {pageNums[pageNums.length - 1] < pageCount - 1 && <span className="px-1 text-neutral-400">…</span>}
              <Link href={qs(pageCount)} className="rounded-lg border border-[#e4e4f0] bg-white px-3 py-1.5">{pageCount}</Link>
            </>
          )}
          {page < pageCount && (
            <Link href={qs(page + 1)} className="rounded-lg border border-[#e4e4f0] bg-white px-3 py-1.5">→</Link>
          )}
        </div>
      )}
    </PageShell>
  );
}
