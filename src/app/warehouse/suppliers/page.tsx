import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { PageShell } from "@/components/page-shell";
import { LinkButton, Badge } from "@/components/ui";
import { DataTable, type Column } from "@/components/data-table";

export default async function SuppliersPage() {
  const session = await requireAdminPage();
  const s = scoped(session);
  const suppliers = await prisma.supplier.findMany({
    where: { companyId: s.companyId },
    include: { _count: { select: { orders: true } } },
    orderBy: { name: "asc" },
  });

  type Row = (typeof suppliers)[number];
  const columns: Column<Row>[] = [
    {
      key: "name",
      header: "Название",
      cell: (sup) => (
        <Link href={`/warehouse/suppliers/${sup.id}`} className="font-semibold text-brand">
          {sup.name}
        </Link>
      ),
    },
    { key: "phone", header: "Телефон", className: "text-neutral-500", cell: (sup) => sup.phone ?? "—" },
    { key: "orders", header: "Заказов", align: "right", cell: (sup) => sup._count.orders },
    {
      key: "status",
      header: "Статус",
      cell: (sup) =>
        sup.isActive ? <Badge tone="green">активен</Badge> : <Badge tone="red">архив</Badge>,
    },
  ];

  return (
    <PageShell
      title="Поставщики"
      action={
        <LinkButton href="/warehouse/suppliers/new" variant="primary">
          + Поставщик
        </LinkButton>
      }
    >
      <DataTable
        columns={columns}
        rows={suppliers}
        rowKey={(sup) => sup.id}
        minWidth="min-w-[560px]"
        empty="Поставщиков пока нет — добавьте первого."
        mobileCard={(sup) => (
          <Link href={`/warehouse/suppliers/${sup.id}`} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-[#1a1a1a]">
                {sup.name} {!sup.isActive && <Badge tone="red">архив</Badge>}
              </div>
              <div className="text-xs text-neutral-500">{sup.phone ?? "—"}</div>
            </div>
            <div className="shrink-0 text-sm text-neutral-500">{sup._count.orders} зак.</div>
          </Link>
        )}
      />
    </PageShell>
  );
}
