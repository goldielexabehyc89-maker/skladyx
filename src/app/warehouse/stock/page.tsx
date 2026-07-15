import Link from "next/link";
import { requireStaffPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { allowedWarehouses, warehouseAccess, isWhAllowed } from "@/lib/warehouse-access";
import { prisma } from "@/lib/db";
import { EmptyState, FilterBar, FilterSubmit, SelectField } from "@/components/ui";
import { PageShell } from "@/components/page-shell";
import { DataTable, type Column } from "@/components/data-table";
import { fmtQty, fmtRub, fmtDateTime } from "@/lib/format";
import { StockTable, type StockRow } from "./stock-table";

// Остатки плоской таблицей: строка = одно текущее размещение. Резерв (в ячейке выдачи
// или за сотрудником) выносится в отдельную колонку. Пагинация по 50 строк.
const PAGE_SIZE = 50;

export default async function StockPage({
  searchParams,
}: {
  searchParams: Promise<{ warehouse?: string; zone?: string; problem?: string; grouped?: string; q?: string; page?: string }>;
}) {
  const session = await requireStaffPage();
  const s = scoped(session);
  const sp = await searchParams;
  const access = await warehouseAccess(session);

  // Товар «за сотрудником» не привязан к складу (он уехал со склада), поэтому
  // при доступе не ко всем складам показываем ТМЦ сотрудников этих складов.
  let scopeEmployeeIds: string[] = [];
  if (!access.all) {
    const [links, allWhUsers] = await Promise.all([
      prisma.userWarehouse.findMany({
        where: { warehouseId: { in: access.ids } },
        select: { userId: true },
      }),
      prisma.user.findMany({
        where: { companyId: s.companyId, allWarehouses: true },
        select: { id: true },
      }),
    ]);
    scopeEmployeeIds = [...new Set([...links.map((l) => l.userId), ...allWhUsers.map((u) => u.id)])];
  }
  const whFilter = sp.warehouse
    ? isWhAllowed(access, sp.warehouse)
      ? { warehouseId: sp.warehouse }
      : { warehouseId: "__none__" }
    : access.all
      ? {}
      : { OR: [{ warehouseId: { in: access.ids } }, { employeeId: { in: scopeEmployeeIds } }] };
  const [warehouses, users] = await Promise.all([await allowedWarehouses(session, s.companyId), s.users()]);
  // складская зона: склад приёмки (по умолчанию) / зона выдачи / у сотрудников / общее
  const ZONES = ["receiving", "staging", "employees", "all"] as const;
  type Zone = (typeof ZONES)[number];
  const zone: Zone = ZONES.includes(sp.zone as Zone) ? (sp.zone as Zone) : "receiving";
  // проблемные фильтры: без ячейки / только резерв
  const problem = sp.problem === "nocell" || sp.problem === "reserve" ? sp.problem : "";
  const grouped = sp.grouped === "1";

  const balances = await prisma.stockBalance.findMany({
    where: {
      companyId: s.companyId,
      qty: { gt: 0 },
      ...whFilter,
    },
  });
  const units = await prisma.itemUnit.findMany({
    where: {
      companyId: s.companyId,
      status: { in: ["IN_STOCK", "PICKED", "ISSUE_PENDING", "ISSUED"] },
      ...whFilter,
    },
  });

  // Резерв: несобранные позиции активных заявок на сбор. Товар физически
  // остаётся в ячейке хранения, но в таблице попадает в колонку «Резерв».
  const activePickLines = await prisma.pickLine.findMany({
    where: { companyId: s.companyId, pickList: { status: { in: ["NEW", "PICKING"] } } },
    select: {
      lotId: true,
      unitId: true,
      cellId: true,
      qtyRequested: true,
      qtyPicked: true,
      // проверенное, но не размещённое, физически ещё в ячейке хранения: тоже резерв
      fulfillments: { select: { qty: true, toCellId: true } },
    },
  });
  const pickReservedUnits = new Set(
    activePickLines
      .filter((l) => l.unitId && !l.fulfillments.some((fu) => fu.toCellId))
      .map((l) => l.unitId as string),
  );
  const lotCellReserve = new Map<string, number>();
  for (const l of activePickLines) {
    if (!l.lotId || !l.cellId) continue;
    const placed = l.fulfillments
      .filter((fu) => fu.toCellId)
      .reduce((sum, fu) => sum + fu.qty.toNumber(), 0);
    const rem = l.qtyRequested.toNumber() - placed;
    if (rem <= 0) continue;
    const key = `${l.lotId}#${l.cellId}`;
    lotCellReserve.set(key, (lotCellReserve.get(key) ?? 0) + rem);
  }

  const itemIds = [...new Set([...balances.map((b) => b.itemId), ...units.map((u) => u.itemId)])];
  const lotIds = [...new Set(balances.map((b) => b.lotId))];
  const unitIds = units.map((u) => u.id);
  const cellIds = [
    ...new Set(
      [...balances.map((b) => b.cellId), ...units.map((u) => u.cellId)].filter(
        (x): x is string => !!x,
      ),
    ),
  ];

  const [items, lots, cells, qrs, movements] = await Promise.all([
    prisma.item.findMany({ where: { id: { in: itemIds } }, include: { uom: true } }),
    prisma.lot.findMany({ where: { id: { in: lotIds } } }),
    prisma.cell.findMany({ where: { id: { in: cellIds } } }),
    prisma.qrCode.findMany({
      where: {
        companyId: s.companyId,
        OR: [
          { type: "LOT", refId: { in: lotIds } },
          { type: "UNIT", refId: { in: unitIds } },
        ],
      },
      select: { type: true, refId: true, code: true },
    }),
    prisma.stockMovement.findMany({
      where: {
        companyId: s.companyId,
        OR: [{ lotId: { in: lotIds } }, { unitId: { in: unitIds } }],
      },
      select: {
        createdAt: true,
        lotId: true,
        unitId: true,
        toCellId: true,
        toWarehouseId: true,
        toEmployeeId: true,
        toPending: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  // связь партии/единицы → заказ поставщика (через строку приемки → строку заказа)
  const receiptLineIds = [
    ...new Set([...lots.map((l) => l.receiptLineId), ...units.map((u) => u.receiptLineId)]),
  ];
  const receiptLines = await prisma.receiptLine.findMany({
    where: { companyId: s.companyId, id: { in: receiptLineIds } },
    select: { id: true, orderLineId: true },
  });
  const orderLineIds = receiptLines
    .map((r) => r.orderLineId)
    .filter((x): x is string => !!x);
  const orderLines = orderLineIds.length
    ? await prisma.supplierOrderLine.findMany({
        where: { id: { in: orderLineIds } },
        select: { id: true, orderId: true },
      })
    : [];
  const orders = orderLines.length
    ? await prisma.supplierOrder.findMany({
        where: { id: { in: orderLines.map((o) => o.orderId) } },
        select: { id: true, number: true },
      })
    : [];
  const orderNumById = new Map(orders.map((o) => [o.id, o.number]));
  const orderIdByLine = new Map(orderLines.map((o) => [o.id, o.orderId]));
  const orderNumByReceiptLine = new Map<string, number>();
  for (const rl of receiptLines) {
    if (!rl.orderLineId) continue;
    const oid = orderIdByLine.get(rl.orderLineId);
    const num = oid ? orderNumById.get(oid) : undefined;
    if (num != null) orderNumByReceiptLine.set(rl.id, num);
  }

  const itemById = new Map(items.map((i) => [i.id, i]));
  const lotById = new Map(lots.map((l) => [l.id, l]));
  const cellById = new Map(cells.map((c) => [c.id, c]));
  const whById = new Map(warehouses.map((w) => [w.id, w.name]));
  const userById = new Map(users.map((u) => [u.id, u.name]));
  const codeByLot = new Map(qrs.filter((q) => q.type === "LOT").map((q) => [q.refId, q.code]));
  const codeByUnit = new Map(qrs.filter((q) => q.type === "UNIT").map((q) => [q.refId, q.code]));

  function toSig(x: {
    toCellId?: string | null;
    toEmployeeId?: string | null;
    toWarehouseId?: string | null;
    toPending?: boolean;
  }): string | null {
    if (x.toCellId) return `C:${x.toCellId}`;
    if (x.toEmployeeId) return `E:${x.toEmployeeId}:${x.toPending ? 1 : 0}`;
    if (x.toWarehouseId) return `W:${x.toWarehouseId}`;
    return null;
  }
  const placedAt = new Map<string, Date>();
  for (const m of movements) {
    const sig = toSig(m);
    const ent = m.lotId ?? m.unitId;
    if (!sig || !ent) continue;
    placedAt.set(`${ent}#${sig}`, m.createdAt);
  }

  // «Где» без склада: код ячейки / сотрудник / без ячейки
  function whereLabel(b: {
    cellId?: string | null;
    employeeId?: string | null;
    pending?: boolean;
  }): string {
    if (b.employeeId)
      return `${userById.get(b.employeeId) ?? "сотрудник"}${b.pending ? " · ждёт подтв." : ""}`;
    if (b.cellId) return cellById.get(b.cellId)?.code ?? "ячейка";
    return "без ячейки";
  }

  interface Raw {
    time: Date | null;
    order: number | null;
    id: string;
    name: string;
    where: string;
    warehouse: string;
    uom: string;
    qty: number;
    zone: "receiving" | "staging" | "employees";
    pickReserved: boolean; // зарезервировано заявкой на сбор (товар ещё в ячейке хранения)
    value: number;
  }
  const raw: Raw[] = [];

  for (const b of balances) {
    const item = itemById.get(b.itemId);
    const lot = lotById.get(b.lotId);
    if (!item) continue;
    const qty = b.qty.toNumber();
    const pending = b.locKey.startsWith("EP:");
    const stagingCell = b.cellId ? cellById.get(b.cellId)?.isStaging : false;
    const rowZone: Raw["zone"] = b.employeeId ? "employees" : stagingCell ? "staging" : "receiving";
    const sig = b.cellId
      ? `C:${b.cellId}`
      : b.employeeId
        ? `E:${b.employeeId}:${pending ? 1 : 0}`
        : b.warehouseId
          ? `W:${b.warehouseId}`
          : null;
    // часть остатка, зарезервированная активными заявками на сбор
    const pickRes =
      rowZone === "receiving" && b.cellId
        ? Math.min(qty, lotCellReserve.get(`${b.lotId}#${b.cellId}`) ?? 0)
        : 0;
    const base = {
      time: (sig && placedAt.get(`${b.lotId}#${sig}`)) || lot?.createdAt || null,
      order: orderNumByReceiptLine.get(lot?.receiptLineId ?? "") ?? null,
      id: codeByLot.get(b.lotId) ?? "—",
      name: item.name,
      where: whereLabel({ ...b, pending }),
      warehouse: b.employeeId ? "" : (whById.get(b.warehouseId ?? "") ?? ""),
      uom: item.uom.name,
    };
    const price = lot?.price ? lot.price.toNumber() : 0;
    if (pickRes > 0 && pickRes < qty) {
      // делим строку: свободная часть и резерв заявки
      raw.push({ ...base, zone: rowZone, qty: qty - pickRes, pickReserved: false, value: price * (qty - pickRes) });
      raw.push({ ...base, zone: rowZone, qty: pickRes, pickReserved: true, value: price * pickRes });
    } else {
      raw.push({ ...base, zone: rowZone, qty, pickReserved: pickRes > 0 && pickRes >= qty, value: price * qty });
    }
  }
  for (const u of units) {
    const item = itemById.get(u.itemId);
    if (!item) continue;
    const pending = u.status === "ISSUE_PENDING";
    const stagingCell = u.cellId ? cellById.get(u.cellId)?.isStaging : false;
    const rowZone: Raw["zone"] = u.employeeId ? "employees" : stagingCell ? "staging" : "receiving";
    const pickReserved =
      pickReservedUnits.has(u.id) ||
      (u.status === "PICKED" && rowZone === "receiving"); // страховка: PICKED вне зоны выдачи
    const sig = u.cellId
      ? `C:${u.cellId}`
      : u.employeeId
        ? `E:${u.employeeId}:${pending ? 1 : 0}`
        : u.warehouseId
          ? `W:${u.warehouseId}`
          : null;
    raw.push({
      time: (sig && placedAt.get(`${u.id}#${sig}`)) || u.createdAt,
      order: orderNumByReceiptLine.get(u.receiptLineId) ?? null,
      id: codeByUnit.get(u.id) ?? "—",
      name: item.name,
      where: whereLabel({ ...u, pending }),
      warehouse: u.employeeId ? "" : (whById.get(u.warehouseId ?? "") ?? ""),
      uom: item.uom.name,
      qty: 1,
      zone: rowZone,
      pickReserved,
      value: u.price ? u.price.toNumber() : 0,
    });
  }

  let filtered = zone === "all" ? raw : raw.filter((r) => r.zone === zone);
  if (sp.q) {
    const q = sp.q.toLowerCase();
    filtered = filtered.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q) ||
        r.where.toLowerCase().includes(q),
    );
  }
  filtered.sort((a, b) => (b.time?.getTime() ?? 0) - (a.time?.getTime() ?? 0));

  // что считать резервом в текущей зоне: на складе приёмки — резерв заявок;
  // в «Общем» — заявки + зона выдачи + сотрудники; в остальных зонах резерва нет
  const isReserve = (r: (typeof raw)[number]): boolean =>
    zone === "all"
      ? r.zone !== "receiving" || r.pickReserved
      : zone === "receiving"
        ? r.pickReserved
        : false;

  // проблемные фильтры
  if (problem === "nocell") filtered = filtered.filter((r) => r.where === "без ячейки");
  if (problem === "reserve") filtered = filtered.filter((r) => isReserve(r));

  // групповой вид: суммируем по товару, вне зависимости от id/даты/ячейки
  interface GroupRow {
    name: string;
    uom: string;
    qty: number;
    reserve: number;
    value: number;
  }
  const groupRows: GroupRow[] = [];
  if (grouped) {
    const byKey = new Map<string, GroupRow>();
    for (const r of filtered) {
      const key = `${r.name}#${r.uom}`;
      const g = byKey.get(key) ?? { name: r.name, uom: r.uom, qty: 0, reserve: 0, value: 0 };
      if (isReserve(r)) g.reserve += r.qty;
      else g.qty += r.qty;
      g.value += r.value;
      byKey.set(key, g);
    }
    groupRows.push(...[...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, "ru")));
  }

  const totalValue = filtered.reduce((sum, r) => sum + r.value, 0);
  const totalRows = grouped ? groupRows.length : filtered.length;
  const pageCount = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number(sp.page) || 1), pageCount);
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const pageGroupRows = groupRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const rows: StockRow[] = pageRows.map((r) => ({
    time: r.time ? fmtDateTime(r.time) : "—",
    order: r.order != null ? `№${r.order}` : "—",
    id: r.id,
    name: r.name,
    where: r.where,
    warehouse: r.warehouse,
    uom: r.uom,
    qty: isReserve(r) ? null : `${fmtQty(r.qty)}`,
    reserve: isReserve(r) ? `${fmtQty(r.qty)}` : null,
    value: r.value > 0 ? fmtRub(r.value) : "",
  }));

  const qs = (p: number) => {
    const params = new URLSearchParams();
    if (sp.warehouse) params.set("warehouse", sp.warehouse);
    if (zone !== "receiving") params.set("zone", zone);
    if (problem) params.set("problem", problem);
    if (grouped) params.set("grouped", "1");
    if (sp.q) params.set("q", sp.q);
    if (p > 1) params.set("page", String(p));
    const str = params.toString();
    return str ? `/warehouse/stock?${str}` : "/warehouse/stock";
  };
  // окно номеров страниц вокруг текущей
  const pageNums: number[] = [];
  for (let p = Math.max(1, page - 2); p <= Math.min(pageCount, page + 2); p++) pageNums.push(p);

  // ссылка с изменённым одним параметром (для чипов зон и проблем)
  const chipHref = (patch: { zone?: Zone; problem?: string }) => {
    const params = new URLSearchParams();
    const z = patch.zone ?? zone;
    const pr = patch.problem !== undefined ? patch.problem : problem;
    if (sp.warehouse) params.set("warehouse", sp.warehouse);
    if (z !== "receiving") params.set("zone", z);
    if (pr) params.set("problem", pr);
    if (grouped) params.set("grouped", "1");
    if (sp.q) params.set("q", sp.q);
    const str = params.toString();
    return str ? `/warehouse/stock?${str}` : "/warehouse/stock";
  };
  const ZONE_CHIPS: { value: Zone; label: string }[] = [
    { value: "receiving", label: "Склад приёмки" },
    { value: "staging", label: "Зона выдачи" },
    { value: "employees", label: "У сотрудников" },
    { value: "all", label: "Общее" },
  ];
  const chipCls = (active: boolean, warn = false) =>
    "shrink-0 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-sm font-semibold transition " +
    (active
      ? warn
        ? "border-amber-500 bg-amber-500 text-white"
        : "border-[#1a1a1a] bg-[#1a1a1a] text-white"
      : "border-[#e4e4f0] bg-white text-[#555] active:bg-neutral-100");

  return (
    <PageShell title="Остатки">
      {/* Складская зона — чипами, рядом проблемные фильтры */}
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {ZONE_CHIPS.map((z) => (
          <Link key={z.value} href={chipHref({ zone: z.value })} className={chipCls(zone === z.value)}>
            {z.label}
          </Link>
        ))}
        <span className="mx-1 shrink-0 border-l border-[#e4e4f0]" />
        <Link
          href={chipHref({ problem: problem === "nocell" ? "" : "nocell" })}
          className={chipCls(problem === "nocell", true)}
        >
          Без ячейки
        </Link>
        <Link
          href={chipHref({ problem: problem === "reserve" ? "" : "reserve" })}
          className={chipCls(problem === "reserve", true)}
        >
          Резерв
        </Link>
      </div>

      <FilterBar>
        <div className="grid w-full grid-cols-1 gap-2 sm:flex sm:flex-1">
          <SelectField name="warehouse" defaultValue={sp.warehouse ?? ""} className="text-sm sm:flex-1">
            <option value="">Все склады</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </SelectField>
          {zone !== "receiving" && <input type="hidden" name="zone" value={zone} />}
          {problem && <input type="hidden" name="problem" value={problem} />}
        </div>
        <div className="flex w-full gap-2 sm:flex-1">
          <input
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="Поиск по товару, ID или ячейке…"
            className="min-h-11 w-full rounded-xl border border-[#e4e4f0] px-3 py-2 text-base outline-none focus:border-brand"
          />
          <FilterSubmit />
        </div>
        <label className="flex w-full items-center gap-2 text-sm text-neutral-600">
          <input type="checkbox" name="grouped" value="1" defaultChecked={grouped} className="h-5 w-5" />
          Группировать по товарам — общее количество по названию
        </label>
      </FilterBar>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-neutral-500">
        <span>
          Строк: <b className="text-neutral-900">{totalRows}</b>
        </span>
        {totalValue > 0 && (
          <span>
            Стоимость по закупке: <b className="text-neutral-900">{fmtRub(totalValue)}</b>
          </span>
        )}
      </div>

      {totalRows === 0 ? (
        <EmptyState>По выбранным фильтрам остатков нет.</EmptyState>
      ) : grouped ? (
        <DataTable
          columns={
            [
              { key: "name", header: "Товар", cell: (g) => <span className="font-medium">{g.name}</span> },
              { key: "uom", header: "Ед.", className: "text-neutral-500", cell: (g) => g.uom },
              {
                key: "qty",
                header: "Кол-во",
                align: "right",
                className: "tabular-nums",
                cell: (g) => (g.qty > 0 ? fmtQty(g.qty) : ""),
              },
              {
                key: "reserve",
                header: "Резерв",
                align: "right",
                className: "tabular-nums text-orange-600",
                cell: (g) => (g.reserve > 0 ? fmtQty(g.reserve) : ""),
              },
              {
                key: "value",
                header: "Сумма",
                align: "right",
                className: "tabular-nums text-neutral-500",
                cell: (g) => (g.value > 0 ? fmtRub(g.value) : "—"),
              },
            ] satisfies Column<GroupRow>[]
          }
          rows={pageGroupRows}
          rowKey={(g) => `${g.name}#${g.uom}`}
          minWidth="min-w-[560px]"
          mobileCard={(g) => (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{g.name}</div>
                {g.value > 0 && (
                  <div className="text-xs text-neutral-400">{fmtRub(g.value)}</div>
                )}
              </div>
              <div className="shrink-0 text-right">
                {g.qty > 0 && (
                  <div className="text-base font-bold tabular-nums">
                    {fmtQty(g.qty)} <span className="text-xs font-normal text-neutral-500">{g.uom}</span>
                  </div>
                )}
                {g.reserve > 0 && (
                  <div className="text-sm tabular-nums text-orange-600">
                    резерв {fmtQty(g.reserve)} {g.uom}
                  </div>
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
            <Link href={qs(page - 1)} className="rounded-lg border border-[#e4e4f0] bg-white px-3 py-1.5">
              ←
            </Link>
          )}
          {pageNums[0] > 1 && (
            <>
              <Link href={qs(1)} className="rounded-lg border border-[#e4e4f0] bg-white px-3 py-1.5">
                1
              </Link>
              {pageNums[0] > 2 && <span className="px-1 text-neutral-400">…</span>}
            </>
          )}
          {pageNums.map((p) => (
            <Link
              key={p}
              href={qs(p)}
              className={
                "rounded-lg px-3 py-1.5 " +
                (p === page
                  ? "bg-brand font-semibold text-white"
                  : "border border-[#e4e4f0] bg-white")
              }
            >
              {p}
            </Link>
          ))}
          {pageNums[pageNums.length - 1] < pageCount && (
            <>
              {pageNums[pageNums.length - 1] < pageCount - 1 && (
                <span className="px-1 text-neutral-400">…</span>
              )}
              <Link href={qs(pageCount)} className="rounded-lg border border-[#e4e4f0] bg-white px-3 py-1.5">
                {pageCount}
              </Link>
            </>
          )}
          {page < pageCount && (
            <Link href={qs(page + 1)} className="rounded-lg border border-[#e4e4f0] bg-white px-3 py-1.5">
              →
            </Link>
          )}
        </div>
      )}
    </PageShell>
  );
}
