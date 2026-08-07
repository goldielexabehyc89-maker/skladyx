import { requireWarehouseViewerPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { warehouseAccess } from "@/lib/warehouse-access";
import { PageHeader, EmptyState } from "@/components/ui";
import { fmtDateTime, fmtQty } from "@/lib/format";
import type { Prisma, MovementDocType, ZoneKind } from "@prisma/client";

// Пакет 11: журнал складских движений на новой модели (StockMovement + зоны/ячейки).
// По умолчанию показывает последние движения БЕЗ обязательного поиска. Фильтры:
// дата, операция, товар/EAN, зона, ячейка, сотрудник, группа/заказ. Read-only,
// строго по складам пользователя. Источник — append-only журнал, хранится бессрочно.

const TAKE = 200;

// Операции для фильтра (человеческие подписи → docType журнала).
const OP_OPTIONS: { value: MovementDocType; label: string }[] = [
  { value: "RECEIPT", label: "Приёмка" },
  { value: "TRANSFER", label: "Перемещение / размещение" },
  { value: "PICKLIST", label: "Сборка заказа" },
  { value: "ISSUE", label: "Выдача" },
  { value: "INVENTORY", label: "Корректировка / контроль" },
  { value: "WRITEOFF", label: "Списание" },
  { value: "CELL_ASSIGN", label: "Назначение ячейки" },
  { value: "ISSUE_CONFIRM", label: "Подтверждение получения" },
];
const OP_VALUES = new Set(OP_OPTIONS.map((o) => o.value));

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{
    op?: string;
    q?: string;
    zone?: string;
    cell?: string;
    emp?: string;
    order?: string; // пользовательский номер заказа (ExternalOrder.externalId)
    group?: string; // связывание цепочки группы (HandlingGroup.id → lotId), для deep-link
    from?: string;
    to?: string;
  }>;
}) {
  const session = await requireWarehouseViewerPage();
  const s = scoped(session);
  const access = await warehouseAccess(session);
  const sp = await searchParams;

  const opq = (sp.op ?? "").trim();
  const op = OP_VALUES.has(opq as MovementDocType) ? (opq as MovementDocType) : "";
  const q = (sp.q ?? "").trim();
  const zoneq = (sp.zone ?? "").trim();
  const cellq = (sp.cell ?? "").trim();
  const empq = (sp.emp ?? "").trim();
  const orderq = (sp.order ?? "").trim();
  const groupq = (sp.group ?? "").trim();
  const fromq = (sp.from ?? "").trim();
  const toq = (sp.to ?? "").trim();

  // Справочники для селектов (по доступным складам).
  const [zones, employees] = await Promise.all([
    prisma.warehouseZone.findMany({
      where: { companyId: s.companyId, isActive: true, ...(access.all ? {} : { warehouseId: { in: access.ids } }) },
      orderBy: [{ warehouseId: "asc" }, { sortOrder: "asc" }],
      select: { id: true, name: true, kind: true },
    }),
    prisma.user.findMany({
      where: { companyId: s.companyId, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  // Разбор товара/EAN → множество itemId.
  let itemFilterIds: string[] | null = null;
  if (q) {
    const [byEan, byName] = await Promise.all([
      prisma.itemBarcode.findMany({ where: { companyId: s.companyId, code: q }, select: { itemId: true } }),
      prisma.item.findMany({ where: { companyId: s.companyId, name: { contains: q, mode: "insensitive" } }, select: { id: true } }),
    ]);
    itemFilterIds = [...new Set([...byEan.map((b) => b.itemId), ...byName.map((i) => i.id)])];
  }
  // Ячейка по коду → cellId.
  let cellFilterIds: string[] | null = null;
  if (cellq) {
    const cells = await prisma.cell.findMany({
      where: { companyId: s.companyId, code: { contains: cellq, mode: "insensitive" } },
      select: { id: true },
    });
    cellFilterIds = cells.map((c) => c.id);
  }
  // Заказ по ПОЛЬЗОВАТЕЛЬСКОМУ номеру (ExternalOrder.externalId) → docId движений сборки/контроля/выдачи.
  let orderFilterIds: string[] | null = null;
  if (orderq) {
    const orders = await prisma.externalOrder.findMany({
      where: { companyId: s.companyId, externalId: { contains: orderq, mode: "insensitive" } },
      select: { id: true },
    });
    orderFilterIds = orders.map((o) => o.id);
  }
  // Цепочка группы: HandlingGroup.id → lotId. Все движения этой партии (приёмка Receipt.id и
  // последующие движения группы) связаны общим lotId — так связываются приёмка и размещение.
  let groupLotId: string | null | undefined;
  if (groupq) {
    const g = await prisma.handlingGroup.findFirst({ where: { id: groupq, companyId: s.companyId }, select: { lotId: true } });
    groupLotId = g?.lotId ?? null;
  }

  const and: Prisma.StockMovementWhereInput[] = [{ companyId: s.companyId }];
  if (!access.all) and.push({ OR: [{ fromWarehouseId: { in: access.ids } }, { toWarehouseId: { in: access.ids } }] });
  if (op) and.push({ docType: op });
  if (itemFilterIds) and.push({ itemId: { in: itemFilterIds } });
  if (zoneq) and.push({ OR: [{ fromZoneId: zoneq }, { toZoneId: zoneq }] });
  if (cellFilterIds) and.push({ OR: [{ fromCellId: { in: cellFilterIds } }, { toCellId: { in: cellFilterIds } }] });
  if (empq) and.push({ createdById: empq });
  if (orderFilterIds) and.push({ docId: { in: orderFilterIds } });
  if (groupLotId) and.push({ lotId: groupLotId });
  if (fromq) { const d = new Date(fromq); if (!Number.isNaN(d.getTime())) and.push({ createdAt: { gte: d } }); }
  if (toq) { const d = new Date(toq); if (!Number.isNaN(d.getTime())) { d.setHours(23, 59, 59, 999); and.push({ createdAt: { lte: d } }); } }

  const noHits =
    (q && itemFilterIds && itemFilterIds.length === 0) ||
    (cellq && cellFilterIds && cellFilterIds.length === 0) ||
    (orderq && orderFilterIds && orderFilterIds.length === 0) ||
    (groupq && !groupLotId);
  const movements = noHits
    ? []
    : await prisma.stockMovement.findMany({ where: { AND: and }, orderBy: { createdAt: "desc" }, take: TAKE });

  // Справочники для отображения строк.
  const itemIds = [...new Set(movements.map((m) => m.itemId))];
  const userIds = [...new Set(movements.map((m) => m.createdById))];
  const cellIds = [...new Set(movements.flatMap((m) => [m.fromCellId, m.toCellId]).filter((x): x is string => !!x))];
  const zoneIds = [...new Set(movements.flatMap((m) => [m.fromZoneId, m.toZoneId]).filter((x): x is string => !!x))];
  const whIds = [...new Set(movements.flatMap((m) => [m.fromWarehouseId, m.toWarehouseId]).filter((x): x is string => !!x))];
  const empIds = [...new Set(movements.flatMap((m) => [m.fromEmployeeId, m.toEmployeeId]).filter((x): x is string => !!x))];

  const [items, users, cells, zoneRows, whs] = await Promise.all([
    prisma.item.findMany({ where: { id: { in: itemIds } }, include: { uom: true } }),
    prisma.user.findMany({ where: { id: { in: [...new Set([...userIds, ...empIds])] } }, select: { id: true, name: true } }),
    prisma.cell.findMany({ where: { id: { in: cellIds } }, select: { id: true, code: true } }),
    prisma.warehouseZone.findMany({ where: { id: { in: zoneIds } }, select: { id: true, name: true, kind: true } }),
    prisma.warehouse.findMany({ where: { id: { in: whIds } }, select: { id: true, name: true } }),
  ]);
  const hItem = new Map(items.map((i) => [i.id, i]));
  const hUser = new Map(users.map((u) => [u.id, u.name]));
  const hCell = new Map(cells.map((c) => [c.id, c.code]));
  const hZone = new Map(zoneRows.map((z) => [z.id, z]));
  const hWh = new Map(whs.map((w) => [w.id, w.name]));

  type Mv = (typeof movements)[number];
  const side = (m: Mv, dir: "from" | "to"): string => {
    const cellId = dir === "from" ? m.fromCellId : m.toCellId;
    const zoneId = dir === "from" ? m.fromZoneId : m.toZoneId;
    const empId = dir === "from" ? m.fromEmployeeId : m.toEmployeeId;
    const whId = dir === "from" ? m.fromWarehouseId : m.toWarehouseId;
    if (cellId) return `${hCell.get(cellId) ?? "ячейка"}`;
    if (zoneId) { const z = hZone.get(zoneId); return z ? z.name : "зона"; }
    if (empId) return hUser.get(empId) ?? "сотрудник";
    if (whId) return `${hWh.get(whId) ?? "склад"} (без ячейки)`;
    return dir === "from" && m.docType === "RECEIPT" ? "поставщик" : "—";
  };
  const zoneKind = (id: string | null): ZoneKind | null => (id ? hZone.get(id)?.kind ?? null : null);
  const eventLabel = (m: Mv): string => {
    const fromK = zoneKind(m.fromZoneId);
    const toK = zoneKind(m.toZoneId);
    switch (m.docType) {
      case "RECEIPT":
        return "Приёмка";
      case "TRANSFER":
        if (toK === "COOLING") return "В охлаждение";
        if (fromK === "COOLING") return "Размещение после охлаждения";
        if (fromK === "RECEIVING" && m.toCellId) return "Размещение";
        if (toK === "CONTROL") return "На контроль";
        if (toK === "ISSUE") return "В зону выдачи";
        if (fromK === "ISSUE") return "Возврат из зоны выдачи";
        return "Перемещение";
      case "PICKLIST":
        return "Сборка заказа";
      case "ISSUE":
        return "Выдача";
      case "ISSUE_CONFIRM":
        return "Подтверждение получения";
      case "INVENTORY":
        return "Корректировка (контроль)";
      case "WRITEOFF":
        return "Списание";
      case "CELL_ASSIGN":
        return "Назначение ячейки";
      default:
        return m.docType;
    }
  };

  const rows = movements.map((m) => {
    const item = hItem.get(m.itemId);
    return {
      key: m.id,
      at: m.createdAt,
      event: eventLabel(m),
      item: item?.name ?? "—",
      qty: `${fmtQty(m.qty)} ${item?.uom.name ?? ""}`,
      route: `${side(m, "from")} → ${side(m, "to")}`,
      who: hUser.get(m.createdById) ?? "—",
    };
  });

  const inputCls = "min-h-11 w-full rounded-xl border border-[#e4e4f0] px-3 py-2 text-sm outline-none focus:border-brand";

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="История" />
      <p className="-mt-1 text-sm text-neutral-500">
        Складские движения — приёмка, размещение, охлаждение, сборка, контроль, выдача. Хранится бессрочно.
      </p>

      <form data-realtime-ignore-dirty className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <input name="q" defaultValue={q} placeholder="Товар или EAN" className={inputCls} />
        <select name="op" defaultValue={op} className={inputCls}>
          <option value="">Все операции</option>
          {OP_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select name="zone" defaultValue={zoneq} className={inputCls}>
          <option value="">Все зоны</option>
          {zones.map((z) => (
            <option key={z.id} value={z.id}>{z.name}</option>
          ))}
        </select>
        <input name="cell" defaultValue={cellq} placeholder="Ячейка (код)" className={inputCls} />
        <select name="emp" defaultValue={empq} className={inputCls}>
          <option value="">Все сотрудники</option>
          {employees.map((u) => (
            <option key={u.id} value={u.id}>{u.name}</option>
          ))}
        </select>
        <input name="order" defaultValue={orderq} placeholder="Заказ (номер)" className={inputCls} />
        {groupq && <input type="hidden" name="group" value={groupq} />}
        <label className="flex items-center gap-2 text-xs text-neutral-500">
          <span className="shrink-0">с</span>
          <input type="date" name="from" defaultValue={fromq} className={inputCls} />
        </label>
        <label className="flex items-center gap-2 text-xs text-neutral-500">
          <span className="shrink-0">по</span>
          <input type="date" name="to" defaultValue={toq} className={inputCls} />
        </label>
        <button
          type="submit"
          className="min-h-11 rounded-xl border border-[#e4e4f0] bg-white px-4 text-sm font-medium active:bg-neutral-100"
        >
          Применить
        </button>
      </form>

      {rows.length === 0 ? (
        <EmptyState>Движений не найдено.</EmptyState>
      ) : (
        <>
          {/* Мобильный вид */}
          <div className="flex flex-col gap-2 lg:hidden">
            {rows.map((h) => (
              <div key={h.key} className="rounded-xl bg-white px-3.5 py-3 shadow-[0_2px_8px_rgba(20,20,60,0.06)]">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-[#1a1a1a]">{h.event}</span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">{h.qty}</span>
                </div>
                <div className="mt-0.5 truncate text-sm text-neutral-700">{h.item}</div>
                <div className="mt-0.5 truncate text-xs text-neutral-600">{h.route}</div>
                <div className="mt-0.5 text-[11px] text-neutral-400">{fmtDateTime(h.at)} · {h.who}</div>
              </div>
            ))}
          </div>

          {/* Десктоп */}
          <div className="hidden overflow-x-auto rounded-xl bg-white shadow-[0_2px_8px_rgba(20,20,60,0.06)] lg:block">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="bg-neutral-50">
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                  <th className="px-3 py-2.5 font-medium">Дата и время</th>
                  <th className="px-3 py-2.5 font-medium">Событие</th>
                  <th className="px-3 py-2.5 font-medium">Товар</th>
                  <th className="px-3 py-2.5 font-medium">Откуда → куда</th>
                  <th className="px-3 py-2.5 font-medium">Кто</th>
                  <th className="px-3 py-2.5 text-right font-medium">Кол-во</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((h) => (
                  <tr key={h.key} className="border-b border-neutral-100 last:border-0">
                    <td className="whitespace-nowrap px-3 py-2.5 text-neutral-500">{fmtDateTime(h.at)}</td>
                    <td className="px-3 py-2.5 font-medium">{h.event}</td>
                    <td className="px-3 py-2.5 text-neutral-700">{h.item}</td>
                    <td className="px-3 py-2.5 text-neutral-600">{h.route}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-neutral-600">{h.who}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{h.qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {movements.length >= TAKE && (
            <p className="text-center text-xs text-neutral-400">
              Показаны последние {TAKE} движений. Уточните фильтры, чтобы увидеть более ранние.
            </p>
          )}
        </>
      )}
    </div>
  );
}
