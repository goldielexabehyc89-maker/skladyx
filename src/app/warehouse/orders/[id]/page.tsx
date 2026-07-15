import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { getAllowedWarehouse } from "@/lib/warehouse-access";
import { prisma } from "@/lib/db";
import { AddLineRow } from "./add-line-row";
import { DraftLineRow } from "./draft-line-row";
import { OrderHeaderActions } from "./header-actions";
import { DeleteDocButton } from "@/components/delete-doc-button";
import { deleteSupplierOrderAction } from "@/app/actions/supplier-orders";
import { PageHeader, Badge, EmptyState } from "@/components/ui";
import { fmtDateTime, fmtQty, fmtRub } from "@/lib/format";

const STATUS_RU: Record<string, { label: string; tone: "orange" | "blue" | "green" | "red" }> = {
  DRAFT: { label: "черновик", tone: "orange" },
  ORDERED: { label: "заказан", tone: "blue" },
  RECEIVED: { label: "принят", tone: "green" },
  CANCELLED: { label: "отменён", tone: "red" },
};

export default async function SupplierOrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireAdminPage();
  const s = scoped(session);
  const { id } = await params;
  const order = await prisma.supplierOrder.findFirst({
    where: { id, companyId: s.companyId },
    include: { lines: { orderBy: { createdAt: "asc" } }, supplier: true },
  });
  if (!order) return <EmptyState>Заказ не найден.</EmptyState>;

  const [warehouse, allItems] = await Promise.all([getAllowedWarehouse(session, s.companyId, order.warehouseId), s.items()]);
  const itemById = new Map(allItems.map((i) => [i.id, i]));
  const activeItems = allItems.filter((i) => i.isActive);
  const isAdmin = session.role === "ADMIN";
  // черновик редактирует только админ; кладовщик видит заказ и принимает его
  const editable = order.status === "DRAFT" && isAdmin;
  const isDraft = order.status === "DRAFT";
  const partial = order.status === "ORDERED" && order.lines.some((l) => l.receivedQty.gt(0));
  const st = partial ? { label: "частично принят", tone: "orange" as const } : STATUS_RU[order.status];

  const total = order.lines.reduce(
    (sum, l) => sum + (l.price ? l.price.toNumber() * l.qty.toNumber() : 0),
    0,
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2.5">
            Заказ поставщику №{order.number}
            <Badge tone={st.tone}>{st.label}</Badge>
          </span>
        }
        action={
          <OrderHeaderActions
            orderId={order.id}
            showSave={editable}
            saveDisabled={order.lines.length === 0}
            showCancel={isAdmin && !partial && (order.status === "DRAFT" || order.status === "ORDERED")}
          />
        }
      />
      <p className="-mt-1 text-sm text-neutral-500">
        {order.supplier.name} · {warehouse.name} · {fmtDateTime(order.createdAt)}
        {order.note ? ` · ${order.note}` : ""}
      </p>

      {/* Мобильный вид: карточки позиций (редактирование без горизонтального скролла) */}
      <div className="flex flex-col gap-2 lg:hidden">
        {order.lines.length === 0 && !editable && (
          <EmptyState>Позиций нет.</EmptyState>
        )}
        {order.lines.map((l) => {
          const item = itemById.get(l.itemId);
          if (editable) {
            return (
              <DraftLineRow
                key={`m-${l.id}`}
                card
                lineId={l.id}
                index={0}
                itemName={item?.name ?? "—"}
                uomName={item?.uom.name ?? ""}
                isUnit={item?.tracking === "UNIT"}
                initialQty={l.qty.toString()}
                initialPrice={l.price?.toString() ?? ""}
              />
            );
          }
          return (
            <div
              key={`m-${l.id}`}
              className="rounded-xl bg-white px-3.5 py-3 shadow-[0_2px_8px_rgba(20,20,60,0.06)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-[#1a1a1a]">
                    {item?.name ?? "—"}{" "}
                    {item?.tracking === "UNIT" && <Badge tone="blue">серийн.</Badge>}
                  </div>
                  <div className="mt-0.5 text-xs">
                    {l.lineCode ? (
                      <Link
                        href={`/warehouse/history?id=${l.lineCode}`}
                        className="font-mono text-brand underline-offset-2"
                      >
                        {l.lineCode}
                      </Link>
                    ) : (
                      <span className="text-neutral-400">—</span>
                    )}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-sm font-semibold tabular-nums">
                    {fmtQty(l.qty)}{" "}
                    <span className="text-xs font-normal text-neutral-500">
                      {item?.uom.name ?? ""}
                    </span>
                  </div>
                  <div className="text-xs tabular-nums text-neutral-500">
                    {l.price ? `${fmtRub(l.price)} · ${fmtRub(l.price.toNumber() * l.qty.toNumber())}` : "—"}
                  </div>
                </div>
              </div>
              {order.status === "ORDERED" && (
                <div
                  className={
                    "mt-1.5 text-xs font-medium " +
                    (l.receivedQty.gte(l.qty) ? "text-green-600" : "text-orange-500")
                  }
                >
                  принято {fmtQty(l.receivedQty)} из {fmtQty(l.qty)}
                </div>
              )}
            </div>
          );
        })}
        {editable && (
          <AddLineRow
            card
            orderId={order.id}
            items={activeItems.map((i) => ({
              id: i.id,
              name: i.name,
              hint: `${i.uom.name}${i.tracking === "UNIT" ? ", поштучный" : ""}`,
            }))}
          />
        )}
        {total > 0 && (
          <p className="px-1 text-right text-sm text-neutral-600">
            Итого: <b className="tabular-nums text-neutral-900">{fmtRub(total)}</b>
          </p>
        )}
      </div>

      <div className="hidden overflow-x-auto rounded-xl bg-white shadow-[0_2px_8px_rgba(20,20,60,0.06)] lg:block">
        <table className="w-full min-w-[820px] table-fixed text-sm">
          <colgroup>
            <col className="w-10" />
            <col />
            <col className="w-32" />
            <col className="w-16" />
            <col className="w-28" />
            <col className="w-32" />
            <col className="w-32" />
            {editable && <col className="w-14" />}
          </colgroup>
          <thead className="bg-neutral-50">
            <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
              <th className="px-3 py-2.5 font-medium">#</th>
              <th className="px-3 py-2.5 font-medium">Товар</th>
              <th className="px-3 py-2.5 font-medium">ID</th>
              <th className="px-3 py-2.5 font-medium">Ед.</th>
              <th className="px-3 py-2.5 text-right font-medium">Кол-во</th>
              <th className="px-3 py-2.5 text-right font-medium">Цена, ₽</th>
              <th className="px-3 py-2.5 text-right font-medium">Сумма</th>
              {editable && <th className="px-3 py-2.5" />}
            </tr>
          </thead>
          <tbody>
            {order.lines.length === 0 && !editable && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-neutral-400">
                  Позиций нет.
                </td>
              </tr>
            )}
            {order.lines.map((l, idx) => {
              const item = itemById.get(l.itemId);
              if (editable) {
                return (
                  <DraftLineRow
                    key={l.id}
                    lineId={l.id}
                    index={idx + 1}
                    itemName={item?.name ?? "—"}
                    uomName={item?.uom.name ?? ""}
                    isUnit={item?.tracking === "UNIT"}
                    initialQty={l.qty.toString()}
                    initialPrice={l.price?.toString() ?? ""}
                  />
                );
              }
              return (
                <tr key={l.id} className="border-b border-neutral-100 last:border-0">
                  <td className="px-3 py-2.5 text-neutral-400">{idx + 1}</td>
                  <td className="px-3 py-2.5 font-medium">
                    {item?.name ?? "—"}{" "}
                    {item?.tracking === "UNIT" && <Badge tone="blue">серийн.</Badge>}
                    {order.status === "ORDERED" && (
                      <span
                        className={
                          l.receivedQty.gte(l.qty)
                            ? "ml-1.5 text-xs font-normal text-green-600"
                            : "ml-1.5 text-xs font-normal text-orange-500"
                        }
                      >
                        принято {fmtQty(l.receivedQty)} из {fmtQty(l.qty)}
                      </span>
                    )}
                  </td>
                  <td className="truncate px-3 py-2.5 font-mono text-xs">
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
                  <td className="px-3 py-2.5 text-neutral-500">{item?.uom.name ?? ""}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtQty(l.qty)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {l.price ? fmtRub(l.price) : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right font-medium tabular-nums">
                    {l.price ? fmtRub(l.price.toNumber() * l.qty.toNumber()) : "—"}
                  </td>
                </tr>
              );
            })}
            {editable && (
              <AddLineRow
                orderId={order.id}
                items={activeItems.map((i) => ({
                  id: i.id,
                  name: i.name,
                  hint: `${i.uom.name}${i.tracking === "UNIT" ? ", поштучный" : ""}`,
                }))}
              />
            )}
          </tbody>
          {total > 0 && (
            <tfoot>
              <tr className="border-t border-neutral-200 bg-neutral-50">
                <td colSpan={6} className="px-3 py-2.5 text-right text-sm font-semibold">
                  Итого:
                </td>
                <td className="px-3 py-2.5 text-right text-sm font-bold tabular-nums">
                  {fmtRub(total)}
                </td>
                {editable && <td />}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {editable && (
        <p className="text-sm text-neutral-500">
          При сохранении каждой позиции присваивается ID (дата-№заказа-№строки, например
          6072026-12-1) — он станет QR-кодом товара при приёме на склад. После сохранения
          позиции не редактируются. Кнопка «Сохранить» — вверху.
        </p>
      )}

      {order.status === "ORDERED" && (
        <p className="rounded-2xl bg-white p-4 text-sm text-neutral-500 shadow-[0_2px_8px_rgba(20,20,60,0.06)]">
          Заказ сохранён. Печать этикеток и приём товара на склад — во вкладке{" "}
          <Link href={`/warehouse/receipts/${order.id}`} className="font-medium text-brand">
            «Приемки»
          </Link>
          .
        </p>
      )}

      {order.status === "RECEIVED" && (
        <p className="rounded-2xl bg-white p-4 text-sm text-green-700 shadow-[0_2px_8px_rgba(20,20,60,0.06)]">
          Заказ принят на склад «{warehouse.name}».
        </p>
      )}

      {isAdmin && !order.receiptId && !order.lines.some((l) => l.receivedQty.gt(0)) && (
        <DeleteDocButton
          action={deleteSupplierOrderAction}
          hidden={{ orderId: order.id }}
          label="Удалить заказ"
          confirmText={`Удалить заказ №${order.number}? Действие необратимо.`}
        />
      )}
    </div>
  );
}
