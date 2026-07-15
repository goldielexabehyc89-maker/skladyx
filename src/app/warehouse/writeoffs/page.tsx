import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { allowedWarehouses, warehouseAccess } from "@/lib/warehouse-access";
import { prisma } from "@/lib/db";
import { PageShell } from "@/components/page-shell";
import { LinkButton, StatusBadge } from "@/components/ui";
import { DataTable, type Column } from "@/components/data-table";
import { WRITEOFF_STATUS } from "@/lib/statuses";
import { fmtDate } from "@/lib/format";

export default async function WriteOffsPage() {
  const session = await requireAdminPage();
  const s = scoped(session);
  const access = await warehouseAccess(session);
  const [warehouses, users] = await Promise.all([
    allowedWarehouses(session, s.companyId),
    s.users(),
  ]);
  const writeOffs = await prisma.writeOff.findMany({
    where: {
      companyId: s.companyId,
      ...(access.all ? {} : { OR: [{ warehouseId: { in: access.ids } }, { warehouseId: null }] }),
    },
    include: { _count: { select: { lines: true } } },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 100,
  });
  const whById = new Map(warehouses.map((w) => [w.id, w.name]));
  const userById = new Map(users.map((u) => [u.id, u.name]));
  const fromLabel = (w: (typeof writeOffs)[number]) =>
    w.warehouseId
      ? (whById.get(w.warehouseId) ?? "—")
      : `с сотрудника: ${userById.get(w.employeeId ?? "") ?? "—"}`;

  type Row = (typeof writeOffs)[number];
  const columns: Column<Row>[] = [
    {
      key: "number",
      header: "№",
      className: "whitespace-nowrap",
      cell: (w) => (
        <Link href={`/warehouse/writeoffs/${w.id}`} className="font-semibold text-brand">
          №{w.number}
        </Link>
      ),
    },
    { key: "date", header: "Дата", className: "whitespace-nowrap text-neutral-500", cell: (w) => fmtDate(w.createdAt) },
    { key: "from", header: "Откуда", cell: (w) => fromLabel(w) },
    { key: "reason", header: "Причина", className: "text-neutral-500", cell: (w) => w.reason },
    { key: "lines", header: "Позиций", align: "right", cell: (w) => w._count.lines },
    { key: "status", header: "Статус", cell: (w) => <StatusBadge status={WRITEOFF_STATUS[w.status]} /> },
  ];

  return (
    <PageShell
      title="Списания"
      action={
        <LinkButton href="/warehouse/writeoffs/new" variant="primary">
          + Списание
        </LinkButton>
      }
    >
      <DataTable
        columns={columns}
        rows={writeOffs}
        rowKey={(w) => w.id}
        empty="Списаний пока нет."
        mobileCard={(w) => (
          <Link href={`/warehouse/writeoffs/${w.id}`} className="block">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-[#1a1a1a]">Списание №{w.number}</span>
              <StatusBadge status={WRITEOFF_STATUS[w.status]} />
            </div>
            <div className="mt-0.5 truncate text-xs text-neutral-500">
              {fromLabel(w)} · {w._count.lines} поз. · {fmtDate(w.createdAt)}
            </div>
            <div className="truncate text-xs text-neutral-400">Причина: {w.reason}</div>
          </Link>
        )}
      />
    </PageShell>
  );
}
