import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { warehouseAccess, whereWh, allowedWarehouses } from "@/lib/warehouse-access";
import { prisma } from "@/lib/db";
import { Badge, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { DataTable, type Column } from "@/components/data-table";
import { fmtDate } from "@/lib/format";
import type { PickListStatus } from "@prisma/client";

const STATUS_RU: Record<PickListStatus, { label: string; tone: "neutral" | "green" | "orange" | "red" | "blue" }> = {
  NEW: { label: "новая", tone: "orange" },
  PICKING: { label: "в сборке", tone: "blue" },
  PICKED: { label: "собрана", tone: "blue" },
  STAGED: { label: "в зоне выдачи", tone: "blue" },
  ISSUED: { label: "выдана", tone: "green" },
  CANCELLED: { label: "отменена", tone: "red" },
};

export default async function PickListsPage() {
  const session = await requireAdminPage();
  const s = scoped(session);
  const access = await warehouseAccess(session);
  const pickLists = await prisma.pickList.findMany({
    where: { companyId: s.companyId, targetWarehouseId: null, ...whereWh(access) },
    include: { _count: { select: { lines: true } }, cells: { orderBy: { createdAt: "asc" } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const [employees, warehouses] = await Promise.all([
    s.users(),
    allowedWarehouses(session, s.companyId),
  ]);
  const userById = new Map(employees.map((u) => [u.id, u.name]));
  const whById = new Map(warehouses.map((w) => [w.id, w.name]));
  const cellIds = [...new Set(pickLists.flatMap((p) => p.cells.map((c) => c.cellId)))];
  const cellRecs = cellIds.length
    ? await prisma.cell.findMany({ where: { id: { in: cellIds } } })
    : [];
  const cellCodeById = new Map(cellRecs.map((c) => [c.id, c.code]));

  type Row = (typeof pickLists)[number];
  const columns: Column<Row>[] = [
    {
      key: "number",
      header: "№",
      className: "whitespace-nowrap",
      cell: (p) => (
        <Link href={`/warehouse/picklists/${p.id}`} className="font-semibold text-brand">
          №{p.number}
        </Link>
      ),
    },
    { key: "date", header: "Дата", className: "whitespace-nowrap", cell: (p) => fmtDate(p.createdAt) },
    { key: "target", header: "Для", cell: (p) => (p.targetEmployeeId && userById.get(p.targetEmployeeId)) ?? "—" },
    { key: "wh", header: "Склад", cell: (p) => (p.warehouseId ? whById.get(p.warehouseId) ?? "—" : "—") },
    { key: "lines", header: "Позиций", align: "right", cell: (p) => p._count.lines },
    {
      key: "cells",
      header: "Ячейки выдачи",
      className: "whitespace-nowrap font-mono text-xs",
      cell: (p) =>
        p.cells.length > 0
          ? p.cells.map((c) => cellCodeById.get(c.cellId) ?? "?").join(", ")
          : "—",
    },
    {
      key: "status",
      header: "Статус",
      cell: (p) => (
        <span className="inline-flex items-center gap-1.5">
          <Badge tone={STATUS_RU[p.status].tone}>{STATUS_RU[p.status].label}</Badge>
          {p.status === "NEW" && p._count.lines === 0 && <Badge tone="red">без позиций</Badge>}
          {p.status === "NEW" && p._count.lines > 0 && !p.savedAt && (
            <Badge tone="orange">черновик</Badge>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Заявки на сбор"
        action={
          <LinkButton href="/warehouse/picklists/new" variant="primary">
            + Заявка
          </LinkButton>
        }
      />
      <DataTable
        columns={columns}
        rows={pickLists}
        rowKey={(p) => p.id}
        empty={
          <EmptyState
            title="Заявок пока нет"
            action={
              <LinkButton href="/warehouse/picklists/new" variant="primary">
                + Заявка
              </LinkButton>
            }
          >
            Создайте первую заявку на сбор.
          </EmptyState>
        }
        mobileCard={(p) => (
          <Link href={`/warehouse/picklists/${p.id}`} className="block">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-[#1a1a1a]">Заявка №{p.number}</span>
              <span className="inline-flex items-center gap-1.5">
                {p.status === "NEW" && p._count.lines === 0 && (
                  <Badge tone="red">без позиций</Badge>
                )}
                {p.status === "NEW" && p._count.lines > 0 && !p.savedAt && (
                  <Badge tone="orange">черновик</Badge>
                )}
                <Badge tone={STATUS_RU[p.status].tone}>{STATUS_RU[p.status].label}</Badge>
              </span>
            </div>
            <div className="mt-0.5 truncate text-xs text-neutral-500">
              Для: {(p.targetEmployeeId && userById.get(p.targetEmployeeId)) ?? "—"} ·{" "}
              {p._count.lines} поз. · {fmtDate(p.createdAt)}
            </div>
            {p.cells.length > 0 && (
              <div className="mt-0.5 text-xs text-neutral-500">
                Выдача:{" "}
                <span className="font-mono font-semibold text-neutral-700">
                  {p.cells.map((c) => cellCodeById.get(c.cellId) ?? "?").join(", ")}
                </span>
              </div>
            )}
          </Link>
        )}
      />
    </div>
  );
}
