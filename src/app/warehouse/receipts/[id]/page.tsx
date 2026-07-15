import { Printer } from "lucide-react";
import Link from "next/link";
import { requireStaffPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { getAllowedWarehouse } from "@/lib/warehouse-access";
import { prisma } from "@/lib/db";
import { ReceiveScreen } from "./receive-screen";
import { DeleteDocButton } from "@/components/delete-doc-button";
import { deleteReceiptAction } from "@/app/actions/supplier-orders";
import { PageTitle, Badge, DownloadButton, EmptyState } from "@/components/ui";
import { fmtDate, fmtQty, fmtRub } from "@/lib/format";

// Приемка конкретного заказа поставщику (id = id заказа): печать этикеток,
// приём сканированием «товар → ячейка», прогресс по позициям. ADMIN + STOREKEEPER.
export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireStaffPage();
  const s = scoped(session);
  const { id } = await params;
  const order = await prisma.supplierOrder.findFirst({
    where: { id, companyId: s.companyId },
    include: { lines: { orderBy: { createdAt: "asc" } }, supplier: true },
  });
  if (!order) return <EmptyState>Заказ не найден.</EmptyState>;

  const warehouse = await getAllowedWarehouse(session, s.companyId, order.warehouseId);
  const items = await prisma.item.findMany({
    where: { id: { in: order.lines.map((l) => l.itemId) } },
    include: { uom: true },
  });
  const itemById = new Map(items.map((i) => [i.id, i]));
  const canReceive = order.status === "ORDERED";
  const partiallyReceived = canReceive && order.lines.some((l) => l.receivedQty.gt(0));

  // Для поштучных позиций — какие серийные номера уже приняты (по созданным единицам).
  const unitLineIds = order.lines
    .filter((l) => itemById.get(l.itemId)?.tracking === "UNIT")
    .map((l) => l.id);
  const receiptLines = unitLineIds.length
    ? await prisma.receiptLine.findMany({
        where: { companyId: s.companyId, orderLineId: { in: unitLineIds } },
        select: { id: true, orderLineId: true },
      })
    : [];
  const orderLineByReceiptLine = new Map(receiptLines.map((rl) => [rl.id, rl.orderLineId!]));
  const receivedUnits = receiptLines.length
    ? await prisma.itemUnit.findMany({
        where: { companyId: s.companyId, receiptLineId: { in: receiptLines.map((r) => r.id) } },
        select: { receiptLineId: true, serial: true },
      })
    : [];
  const receivedSerialsByLine = new Map<string, number[]>();
  for (const u of receivedUnits) {
    const orderLineId = orderLineByReceiptLine.get(u.receiptLineId);
    if (!orderLineId) continue;
    const arr = receivedSerialsByLine.get(orderLineId) ?? [];
    arr.push(u.serial);
    receivedSerialsByLine.set(orderLineId, arr);
  }

  const total = order.lines.reduce(
    (sum, l) => sum + (l.price ? l.price.toNumber() * l.qty.toNumber() : 0),
    0,
  );

  return (
    <div className="flex flex-col gap-4">
      <PageTitle
        action={
          <Badge
            tone={
              order.status === "RECEIVED"
                ? "green"
                : partiallyReceived
                  ? "orange"
                  : canReceive
                    ? "blue"
                    : "neutral"
            }
          >
            {order.status === "RECEIVED"
              ? "принят"
              : partiallyReceived
                ? "частично принят"
                : canReceive
                  ? "к приёмке"
                  : order.status === "DRAFT"
                    ? "черновик"
                    : "отменён"}
          </Badge>
        }
      >
        Приемка · заказ №{order.number}
      </PageTitle>
      <p className="-mt-3 text-sm text-neutral-500">
        {order.supplier.name} · {warehouse.name} ·{" "}
        {order.orderedAt ? fmtDate(order.orderedAt) : fmtDate(order.createdAt)}
      </p>

      {order.status === "DRAFT" && (
        <EmptyState>Заказ ещё не сохранён — приёмка недоступна.</EmptyState>
      )}

      {/* Мобильный вид: карточки позиций (без горизонтального скролла) */}
      <div className="flex flex-col gap-2 lg:hidden">
        {order.lines.map((l) => {
          const item = itemById.get(l.itemId);
          const full = l.receivedQty.gte(l.qty);
          const started = l.receivedQty.gt(0);
          return (
            <div
              key={l.id}
              className="rounded-xl bg-white px-3.5 py-3 shadow-[0_2px_8px_rgba(20,20,60,0.06)]"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-[#1a1a1a]">
                    {item?.name ?? "—"}{" "}
                    {item?.tracking === "UNIT" && <Badge tone="blue">серийн.</Badge>}
                  </div>
                  <div className="mt-0.5 text-xs text-neutral-500">
                    {l.lineCode ? (
                      <Link
                        href={`/warehouse/history?id=${l.lineCode}`}
                        className="font-mono text-brand underline-offset-2"
                      >
                        {l.lineCode}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-sm tabular-nums text-neutral-500">
                    заказано {fmtQty(l.qty)} {item?.uom.name ?? ""}
                  </div>
                  <div
                    className={
                      "text-sm font-semibold tabular-nums " +
                      (full ? "text-green-600" : started ? "text-orange-500" : "text-neutral-400")
                    }
                  >
                    принято {fmtQty(l.receivedQty)}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {total > 0 && (
          <p className="px-1 text-right text-sm text-neutral-500">
            Сумма заказа: <b className="text-neutral-900">{fmtRub(total)}</b>
          </p>
        )}
      </div>

      <div className="hidden overflow-x-auto rounded-xl bg-white shadow-[0_2px_8px_rgba(20,20,60,0.06)] lg:block">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-neutral-50">
            <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
              <th className="px-3 py-2.5 font-medium">ID</th>
              <th className="px-3 py-2.5 font-medium">Товар</th>
              <th className="px-3 py-2.5 font-medium">Ед.</th>
              <th className="px-3 py-2.5 text-right font-medium">Заказано</th>
              <th className="px-3 py-2.5 text-right font-medium">Принято</th>
            </tr>
          </thead>
          <tbody>
            {order.lines.map((l) => {
              const item = itemById.get(l.itemId);
              const full = l.receivedQty.gte(l.qty);
              return (
                <tr key={l.id} className="border-b border-neutral-100 last:border-0">
                  <td className="px-3 py-2.5 font-mono text-xs">
                    {l.lineCode ? (
                      <Link
                        href={`/warehouse/history?id=${l.lineCode}`}
                        className="text-brand underline-offset-2 hover:underline"
                      >
                        {l.lineCode}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2.5 font-medium">
                    {item?.name ?? "—"}{" "}
                    {item?.tracking === "UNIT" && <Badge tone="blue">серийн.</Badge>}
                  </td>
                  <td className="px-3 py-2.5 text-neutral-500">{item?.uom.name ?? ""}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtQty(l.qty)}</td>
                  <td
                    className={
                      "px-3 py-2.5 text-right font-medium tabular-nums " +
                      (full
                        ? "text-green-600"
                        : l.receivedQty.gt(0)
                          ? "text-orange-500"
                          : "text-neutral-400")
                    }
                  >
                    {fmtQty(l.receivedQty)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          {total > 0 && (
            <tfoot>
              <tr className="border-t border-neutral-200 bg-neutral-50">
                <td colSpan={4} className="px-3 py-2.5 text-right text-sm font-semibold">
                  Сумма заказа:
                </td>
                <td className="px-3 py-2.5 text-right text-sm font-bold tabular-nums">
                  {fmtRub(total)}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {canReceive && (
        <>
          <DownloadButton href={`/warehouse/print/labels/pdf?order=${order.id}`}>
            <Printer size={18} /> Печать этикеток заказа
          </DownloadButton>
          <p className="-mt-2 text-sm text-neutral-500">
            Распечатайте и наклейте этикетки на товар, затем принимайте сканированием: QR товара →
            QR ячейки склада «{warehouse.name}». Когда все позиции приняты, приёмка закроется сама.
          </p>
          <ReceiveScreen
            orderId={order.id}
            orderNumber={order.number}
            lines={order.lines.map((l) => {
              const item = itemById.get(l.itemId);
              return {
                id: l.id,
                code: l.lineCode,
                name: item?.name ?? "—",
                uom: item?.uom.name ?? "",
                qty: l.qty.toNumber(),
                receivedQty: l.receivedQty.toNumber(),
                tracking: item?.tracking === "UNIT" ? ("UNIT" as const) : ("LOT" as const),
                receivedSerials: receivedSerialsByLine.get(l.id) ?? [],
              };
            })}
          />
        </>
      )}

      {order.status === "RECEIVED" && (
        <DownloadButton href={`/warehouse/print/labels/pdf?order=${order.id}`}>
          <Printer size={18} /> Печать этикеток заказа
        </DownloadButton>
      )}

      {session.role === "ADMIN" && order.receiptId && (
        <DeleteDocButton
          action={deleteReceiptAction}
          hidden={{ orderId: order.id }}
          label="Удалить приёмку"
          confirmText={`Удалить приёмку заказа №${order.number}? Принятый товар будет убран с остатков, заказ вернётся в ожидание приёмки.`}
        />
      )}
    </div>
  );
}
