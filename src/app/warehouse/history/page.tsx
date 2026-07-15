import Link from "next/link";
import { requireStaffPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { PageHeader, Badge, EmptyState } from "@/components/ui";
import { fmtDateTime, fmtQty } from "@/lib/format";

// История конкретной партии/единицы по её ID (QR-коду): заказ поставщику →
// приёмка → ячейки → зона выдачи → выдача/перемещение/списание. Источник —
// append-only журнал движений, хранится бессрочно.
export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const session = await requireStaffPage();
  const s = scoped(session);
  const sp = await searchParams;
  const idq = (sp.id ?? "").trim();

  let found: {
    itemName: string;
    uom: string;
    kindLabel: string; // «партия» / «единица №N»
    status?: string;
  } | null = null;
  let notReceived = false;
  // серийная позиция заказа по базовому ID: у каждой единицы своя история
  let unitChoices: string[] = [];
  interface HistRow {
    key: string;
    at: Date;
    event: string;
    route: string;
    who: string;
    qty: string;
  }
  const history: HistRow[] = [];

  if (idq) {
    const qr = await prisma.qrCode.findFirst({
      where: { companyId: s.companyId, code: idq, type: { in: ["LOT", "UNIT"] } },
    });
    // строка заказа по ID (для партии lineCode = ID; для единицы — без суффикса №)
    const base = idq.includes("-") ? idq.slice(0, idq.lastIndexOf("-")) : idq;
    const orderLine = await prisma.supplierOrderLine.findFirst({
      where: { companyId: s.companyId, lineCode: { in: [idq, base] } },
      include: { order: { include: { supplier: true } } },
    });

    let itemId: string | null = null;
    let unitSerial: number | null = null;
    if (qr?.type === "LOT") {
      const lot = await prisma.lot.findFirst({ where: { id: qr.refId, companyId: s.companyId } });
      itemId = lot?.itemId ?? null;
    } else if (qr?.type === "UNIT") {
      const unit = await prisma.itemUnit.findFirst({
        where: { id: qr.refId, companyId: s.companyId },
      });
      itemId = unit?.itemId ?? null;
      unitSerial = unit?.serial ?? null;
    } else if (orderLine) {
      itemId = orderLine.itemId;
      const rl = await prisma.receiptLine.findFirst({
        where: { companyId: s.companyId, orderLineId: orderLine.id },
        select: { id: true },
      });
      const units = rl
        ? await prisma.itemUnit.findMany({
            where: { receiptLineId: rl.id },
            orderBy: { serial: "asc" },
            select: { serial: true },
          })
        : [];
      if (units.length > 0 && orderLine.lineCode) {
        unitChoices = units.map((u) => `${orderLine.lineCode}-${u.serial}`);
      } else {
        notReceived = true;
      }
    }

    if (itemId) {
      const item = await prisma.item.findFirst({
        where: { id: itemId, companyId: s.companyId },
        include: { uom: true },
      });
      const movements = qr
        ? await prisma.stockMovement.findMany({
            where: {
              companyId: s.companyId,
              ...(qr.type === "LOT" ? { lotId: qr.refId } : { unitId: qr.refId }),
            },
            orderBy: { createdAt: "desc" },
            take: 300,
          })
        : [];

      const userIds = [
        ...new Set(
          [
            ...movements.map((m) => m.createdById),
            ...movements.map((m) => m.toEmployeeId),
            ...movements.map((m) => m.fromEmployeeId),
            ...(orderLine ? [orderLine.order.createdById] : []),
          ].filter((x): x is string => !!x),
        ),
      ];
      const cellIds = [
        ...new Set(
          movements.flatMap((m) => [m.fromCellId, m.toCellId]).filter((x): x is string => !!x),
        ),
      ];
      const whIds = [
        ...new Set(
          movements
            .flatMap((m) => [m.fromWarehouseId, m.toWarehouseId])
            .filter((x): x is string => !!x),
        ),
      ];
      const [users, cells, whs] = await Promise.all([
        prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
        prisma.cell.findMany({
          where: { id: { in: cellIds } },
          select: { id: true, code: true, isStaging: true },
        }),
        prisma.warehouse.findMany({ where: { id: { in: whIds } }, select: { id: true, name: true } }),
      ]);
      const hUser = new Map(users.map((u) => [u.id, u.name]));
      const hCell = new Map(cells.map((c) => [c.id, c]));
      const hWh = new Map(whs.map((w) => [w.id, w.name]));

      const locLabel = (m: (typeof movements)[number], side: "from" | "to"): string => {
        const cellId = side === "from" ? m.fromCellId : m.toCellId;
        const empId = side === "from" ? m.fromEmployeeId : m.toEmployeeId;
        const whId = side === "from" ? m.fromWarehouseId : m.toWarehouseId;
        if (empId) return hUser.get(empId) ?? "сотрудник";
        if (cellId) {
          const c = hCell.get(cellId);
          return c ? `${c.code}${c.isStaging ? " (выдача)" : ""}` : "ячейка";
        }
        if (whId) return `${hWh.get(whId) ?? "склад"} (без ячейки)`;
        return side === "from" && m.docType === "RECEIPT" ? "поставщик" : "—";
      };
      const eventLabel = (m: (typeof movements)[number]): string => {
        if (m.docType === "PICKLIST") {
          const toStaging = m.toCellId ? hCell.get(m.toCellId)?.isStaging : false;
          const fromStaging = m.fromCellId ? hCell.get(m.fromCellId)?.isStaging : false;
          if (toStaging) return "В ячейку выдачи";
          if (fromStaging) return "Возврат из зоны выдачи";
          return "Сборка заявки";
        }
        if (m.docType === "ISSUE") {
          if (m.fromEmployeeId && !m.toEmployeeId) return "Возврат выдачи (отмена)";
          return m.toPending ? "Выдача (ждёт подтверждения)" : "Выдача сотруднику";
        }
        const EVENTS: Record<string, string> = {
          RECEIPT: "Приёмка на склад",
          CELL_ASSIGN: "Назначение ячейки",
          TRANSFER: "Перемещение на склад",
          WRITEOFF: "Списание",
          ISSUE_CONFIRM: "Получение подтверждено",
          INVENTORY: "Инвентаризация",
        };
        return EVENTS[m.docType] ?? m.docType;
      };

      if (orderLine) {
        history.push({
          key: `o-${orderLine.id}`,
          at: orderLine.order.createdAt,
          event: `Заказ поставщику №${orderLine.order.number}`,
          route: orderLine.order.supplier.name,
          who: hUser.get(orderLine.order.createdById) ?? "—",
          qty: `${fmtQty(orderLine.qty)} ${item?.uom.name ?? ""}`,
        });
      }
      for (const m of movements) {
        history.push({
          key: `m-${m.id}`,
          at: m.createdAt,
          event: eventLabel(m),
          route: `${locLabel(m, "from")} → ${locLabel(m, "to")}`,
          who: hUser.get(m.createdById) ?? "—",
          qty: `${fmtQty(m.qty)} ${item?.uom.name ?? ""}`,
        });
      }
      history.sort((a, b) => b.at.getTime() - a.at.getTime());

      found = {
        itemName: item?.name ?? "—",
        uom: item?.uom.name ?? "",
        kindLabel:
          qr?.type === "UNIT"
            ? `единица №${unitSerial ?? "—"}`
            : unitChoices.length > 0
              ? "позиция заказа (серийный товар)"
              : qr
                ? "партия"
                : "позиция заказа",
      };
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="История" />
      <p className="-mt-1 text-sm text-neutral-500">
        Полная история партии или единицы по её ID — от заказа поставщику до выдачи.
        Хранится бессрочно.
      </p>

      <form data-realtime-ignore-dirty className="flex gap-2">
        <input
          name="id"
          defaultValue={idq}
          placeholder="ID товара, например 7072026-5-1 или 7072026-5-1-2"
          className="min-h-11 w-full rounded-xl border border-[#e4e4f0] px-3 py-2 font-mono text-sm outline-none focus:border-brand"
        />
        <button
          type="submit"
          className="min-h-11 rounded-xl border border-[#e4e4f0] bg-white px-4 text-sm font-medium active:bg-neutral-100"
        >
          Найти
        </button>
      </form>

      {idq && !found && <EmptyState>ID «{idq}» не найден.</EmptyState>}

      {found && (
        <>
          <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-white px-5 py-3 shadow-[0_2px_8px_rgba(20,20,60,0.06)]">
            <span className="text-base font-bold text-[#1a1a1a]">{found.itemName}</span>
            <span className="rounded-md bg-[#eef0f8] px-2 py-0.5 font-mono text-xs font-semibold text-[#667eea]">
              {idq}
            </span>
            <Badge tone="neutral">{found.kindLabel}</Badge>
            {notReceived && <Badge tone="orange">ещё не принят на склад</Badge>}
          </div>

          {unitChoices.length > 0 && (
            <div className="rounded-2xl bg-white px-5 py-4 shadow-[0_2px_8px_rgba(20,20,60,0.06)]">
              <p className="text-sm text-neutral-600">
                Серийный товар — у каждой единицы своя история, выберите единицу:
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {unitChoices.map((code) => (
                  <Link
                    key={code}
                    href={`/warehouse/history?id=${code}`}
                    className="rounded-md bg-[#eef0f8] px-2 py-1 font-mono text-xs font-semibold text-[#667eea] active:opacity-70"
                  >
                    {code}
                  </Link>
                ))}
              </div>
            </div>
          )}

          {history.length === 0 ? (
            <EmptyState>Движений пока нет.</EmptyState>
          ) : (
            <>
            {/* Мобильный вид: карточки событий */}
            <div className="flex flex-col gap-2 lg:hidden">
              {history.map((h) => (
                <div
                  key={`m-${h.key}`}
                  className="rounded-xl bg-white px-3.5 py-3 shadow-[0_2px_8px_rgba(20,20,60,0.06)]"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold text-[#1a1a1a]">{h.event}</span>
                    <span className="shrink-0 text-sm font-semibold tabular-nums">{h.qty}</span>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-neutral-600">{h.route}</div>
                  <div className="mt-0.5 text-[11px] text-neutral-400">
                    {fmtDateTime(h.at)} · {h.who}
                  </div>
                </div>
              ))}
            </div>

            <div className="hidden overflow-x-auto rounded-xl bg-white shadow-[0_2px_8px_rgba(20,20,60,0.06)] lg:block">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-neutral-50">
                  <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                    <th className="px-3 py-2.5 font-medium">Дата и время</th>
                    <th className="px-3 py-2.5 font-medium">Событие</th>
                    <th className="px-3 py-2.5 font-medium">Откуда → куда</th>
                    <th className="px-3 py-2.5 font-medium">Кто</th>
                    <th className="px-3 py-2.5 text-right font-medium">Кол-во</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.key} className="border-b border-neutral-100 last:border-0">
                      <td className="whitespace-nowrap px-3 py-2.5 text-neutral-500">
                        {fmtDateTime(h.at)}
                      </td>
                      <td className="px-3 py-2.5 font-medium">{h.event}</td>
                      <td className="px-3 py-2.5 text-neutral-600">{h.route}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-neutral-600">{h.who}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">
                        {h.qty}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
