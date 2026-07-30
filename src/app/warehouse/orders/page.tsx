import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { hasRole } from "@/lib/roles";
import { scoped } from "@/lib/tenant";
import { allowedWarehouses, warehouseAccess, whereWh } from "@/lib/warehouse-access";
import { prisma } from "@/lib/db";
import { Badge, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { DataTable, type Column } from "@/components/data-table";
import { fmtDate, fmtRub } from "@/lib/format";

const STATUS_RU: Record<string, { label: string; tone: "orange" | "blue" | "green" | "red" }> = {
  DRAFT: { label: "черновик", tone: "orange" },
  ORDERED: { label: "заказан", tone: "blue" },
  RECEIVED: { label: "принят", tone: "green" },
  CANCELLED: { label: "отменён", tone: "red" },
};

export default async function SupplierOrdersPage() {
  const session = await requireAdminPage();
  const isAdmin = hasRole(session, "ADMIN");
  const s = scoped(session);
  const access = await warehouseAccess(session);
  const orders = await prisma.supplierOrder.findMany({
    where: { companyId: s.companyId, ...whereWh(access) },
    include: { supplier: true, lines: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const warehouses = await allowedWarehouses(session, s.companyId);
  const whById = new Map(warehouses.map((w) => [w.id, w.name]));

  type Row = (typeof orders)[number];
  const columns: Column<Row>[] = [
    {
      key: "number",
      header: "№",
      className: "whitespace-nowrap",
      cell: (o) => (
        <Link href={`/warehouse/orders/${o.id}`} className="font-semibold text-brand">
          №{o.number}
        </Link>
      ),
    },
    { key: "date", header: "Дата", className: "whitespace-nowrap", cell: (o) => fmtDate(o.createdAt) },
    { key: "supplier", header: "Поставщик", cell: (o) => o.supplier.name },
    { key: "wh", header: "Склад", cell: (o) => whById.get(o.warehouseId) ?? "—" },
    { key: "lines", header: "Позиций", align: "right", cell: (o) => o.lines.length },
    {
      key: "total",
      header: "Сумма",
      align: "right",
      className: "whitespace-nowrap tabular-nums",
      cell: (o) => {
        const total = o.lines.reduce(
          (sum, l) => sum + (l.price ? l.price.toNumber() * l.qty.toNumber() : 0),
          0,
        );
        return total > 0 ? fmtRub(total) : "—";
      },
    },
    {
      key: "status",
      header: "Статус",
      cell: (o) => {
        const partial = o.status === "ORDERED" && o.lines.some((l) => l.receivedQty.gt(0));
        const st = partial
          ? { label: "частично принят", tone: "orange" as const }
          : STATUS_RU[o.status];
        return <Badge tone={st.tone}>{st.label}</Badge>;
      },
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Заказы поставщикам"
        action={
          isAdmin ? (
            <LinkButton href="/warehouse/orders/new" variant="primary">
              + Заказ
            </LinkButton>
          ) : undefined
        }
      />
      <DataTable
        columns={columns}
        rows={orders}
        rowKey={(o) => o.id}
        minWidth="min-w-[720px]"
        empty={
          <EmptyState
            title="Заказов пока нет"
            action={
              <LinkButton href="/warehouse/orders/new" variant="primary">
                + Заказ
              </LinkButton>
            }
          >
            Создайте первый заказ поставщику.
          </EmptyState>
        }
        mobileCard={(o) => {
          const partial = o.status === "ORDERED" && o.lines.some((l) => l.receivedQty.gt(0));
          const st = partial
            ? { label: "частично принят", tone: "orange" as const }
            : STATUS_RU[o.status];
          const total = o.lines.reduce(
            (sum, l) => sum + (l.price ? l.price.toNumber() * l.qty.toNumber() : 0),
            0,
          );
          return (
            <Link href={`/warehouse/orders/${o.id}`} className="block">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-[#1a1a1a]">Заказ №{o.number}</span>
                <Badge tone={st.tone}>{st.label}</Badge>
              </div>
              <div className="mt-0.5 truncate text-xs text-neutral-500">
                {o.supplier.name} · {whById.get(o.warehouseId) ?? "—"} · {fmtDate(o.createdAt)}
              </div>
              <div className="mt-0.5 text-xs text-neutral-500">
                {o.lines.length} поз.
                {total > 0 && (
                  <>
                    {" · "}
                    <span className="font-semibold tabular-nums text-neutral-700">
                      {fmtRub(total)}
                    </span>
                  </>
                )}
              </div>
            </Link>
          );
        }}
      />
    </div>
  );
}
