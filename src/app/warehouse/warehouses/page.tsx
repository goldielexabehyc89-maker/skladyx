import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { allowedWarehouses, warehouseAccess } from "@/lib/warehouse-access";
import { prisma } from "@/lib/db";
import { PageShell } from "@/components/page-shell";
import { LinkButton, Badge } from "@/components/ui";
import { DataTable, type Column } from "@/components/data-table";

export default async function WarehousesPage() {
  const session = await requireAdminPage();
  const s = scoped(session);
  const warehouses = await allowedWarehouses(session, s.companyId);
  const canCreate = (await warehouseAccess(session)).all;
  const cellCounts = await prisma.cell.groupBy({
    by: ["warehouseId"],
    where: { companyId: s.companyId, isActive: true },
    _count: true,
  });
  const countByWh = new Map(cellCounts.map((c) => [c.warehouseId, c._count]));

  type Row = (typeof warehouses)[number];
  const columns: Column<Row>[] = [
    {
      key: "name",
      header: "Название",
      cell: (w) => (
        <Link href={`/warehouse/warehouses/${w.id}`} className="font-semibold text-brand">
          {w.name}
        </Link>
      ),
    },
    { key: "address", header: "Адрес", className: "text-neutral-500", cell: (w) => w.address ?? "—" },
    { key: "cells", header: "Ячеек", align: "right", cell: (w) => countByWh.get(w.id) ?? 0 },
    {
      key: "status",
      header: "Статус",
      cell: (w) =>
        w.isActive ? <Badge tone="green">активен</Badge> : <Badge tone="red">неактивен</Badge>,
    },
  ];

  return (
    <PageShell
      title="Склады и ячейки"
      action={
        canCreate ? (
          <LinkButton href="/warehouse/warehouses/new" variant="primary">
            + Склад
          </LinkButton>
        ) : undefined
      }
    >
      <DataTable
        columns={columns}
        rows={warehouses}
        rowKey={(w) => w.id}
        minWidth="min-w-[560px]"
        empty="Складов пока нет — создайте первый."
        mobileCard={(w) => (
          <Link href={`/warehouse/warehouses/${w.id}`} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-[#1a1a1a]">
                {w.name} {!w.isActive && <Badge tone="red">неактивен</Badge>}
              </div>
              {w.address && <div className="truncate text-xs text-neutral-500">{w.address}</div>}
            </div>
            <div className="shrink-0 text-sm text-neutral-500">{countByWh.get(w.id) ?? 0} яч.</div>
          </Link>
        )}
      />
    </PageShell>
  );
}
