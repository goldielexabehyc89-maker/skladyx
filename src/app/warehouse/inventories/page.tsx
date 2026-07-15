import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { allowedWarehouses, warehouseAccess, whereWh } from "@/lib/warehouse-access";
import { prisma } from "@/lib/db";
import { PageShell } from "@/components/page-shell";
import { LinkButton, StatusBadge } from "@/components/ui";
import { DataTable, type Column } from "@/components/data-table";
import { INVENTORY_STATUS } from "@/lib/statuses";
import { fmtDate } from "@/lib/format";

export default async function InventoriesPage() {
  const session = await requireAdminPage();
  const s = scoped(session);
  const access = await warehouseAccess(session);
  const warehouses = await allowedWarehouses(session, s.companyId);
  const inventories = await prisma.inventory.findMany({
    where: { companyId: s.companyId, ...whereWh(access) },
    include: { _count: { select: { lines: true } } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const whById = new Map(warehouses.map((w) => [w.id, w.name]));

  type Row = (typeof inventories)[number];
  const columns: Column<Row>[] = [
    {
      key: "number",
      header: "№",
      className: "whitespace-nowrap",
      cell: (inv) => (
        <Link href={`/warehouse/inventories/${inv.id}`} className="font-semibold text-brand">
          №{inv.number}
        </Link>
      ),
    },
    { key: "date", header: "Дата", className: "whitespace-nowrap text-neutral-500", cell: (inv) => fmtDate(inv.createdAt) },
    { key: "wh", header: "Склад", cell: (inv) => whById.get(inv.warehouseId) ?? "—" },
    { key: "lines", header: "Строк", align: "right", cell: (inv) => inv._count.lines },
    {
      key: "status",
      header: "Статус",
      cell: (inv) => <StatusBadge status={INVENTORY_STATUS[inv.status]} />,
    },
  ];

  return (
    <PageShell
      title="Инвентаризации"
      action={
        warehouses.some((w) => w.isActive) ? (
          <LinkButton href="/warehouse/inventories/new" variant="primary">
            + Инвентаризация
          </LinkButton>
        ) : undefined
      }
    >
      <DataTable
        columns={columns}
        rows={inventories}
        rowKey={(inv) => inv.id}
        minWidth="min-w-[560px]"
        empty="Инвентаризаций пока не было."
        mobileCard={(inv) => (
          <Link href={`/warehouse/inventories/${inv.id}`} className="block">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-[#1a1a1a]">
                Инвентаризация №{inv.number}
              </span>
              <StatusBadge status={INVENTORY_STATUS[inv.status]} />
            </div>
            <div className="mt-0.5 text-xs text-neutral-500">
              {whById.get(inv.warehouseId) ?? "—"} · {inv._count.lines} строк ·{" "}
              {fmtDate(inv.createdAt)}
            </div>
          </Link>
        )}
      />
    </PageShell>
  );
}
