import Link from "next/link";
import { requireStaffPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { warehouseAccess, whereWh, allowedWarehouses } from "@/lib/warehouse-access";
import { prisma } from "@/lib/db";
import { Badge, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { DataTable, type Column } from "@/components/data-table";
import { fmtDate } from "@/lib/format";
import type { PickListStatus } from "@prisma/client";

const STATUS_RU: Record<PickListStatus, { label: string; tone: "neutral" | "green" | "orange" | "red" | "blue" }> = {
  NEW: { label: "новое", tone: "orange" },
  PICKING: { label: "в сборке", tone: "blue" },
  PICKED: { label: "собрано", tone: "blue" },
  STAGED: { label: "в зоне выдачи", tone: "blue" },
  ISSUED: { label: "перемещено", tone: "green" },
  CANCELLED: { label: "отменено", tone: "red" },
};

// Перемещения = заявки на сбор с целью-складом: тот же жизненный цикл и сканирование.
export default async function TransfersPage() {
  const session = await requireStaffPage();
  const s = scoped(session);
  const isAdmin = session.role === "ADMIN";
  const access = await warehouseAccess(session);
  const transfers = await prisma.pickList.findMany({
    where: {
      companyId: s.companyId,
      targetWarehouseId: { not: null },
      ...whereWh(access),
    },
    include: {
      _count: { select: { lines: true } },
      cells: { orderBy: { createdAt: "asc" } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const visibleTransfers = isAdmin
    ? transfers
    : transfers.filter((p) => !(p.status === "NEW" && (!p.savedAt || p._count.lines === 0)));
  const warehouses = await allowedWarehouses(session, s.companyId);
  const allWh = await prisma.warehouse.findMany({ where: { companyId: s.companyId } });
  const whById = new Map(allWh.map((w) => [w.id, w.name]));
  const cellIds = [...new Set(transfers.flatMap((p) => p.cells.map((c) => c.cellId)))];
  const cellRecs = cellIds.length
    ? await prisma.cell.findMany({ where: { id: { in: cellIds } } })
    : [];
  const cellCodeById = new Map(cellRecs.map((c) => [c.id, c.code]));

  type Row = (typeof visibleTransfers)[number];
  const columns: Column<Row>[] = [
    {
      key: "number",
      header: "№",
      className: "whitespace-nowrap",
      cell: (p) => (
        <Link
          href={isAdmin ? `/warehouse/picklists/${p.id}` : `/warehouse/active/pick/${p.id}`}
          className="font-semibold text-brand"
        >
          №{p.number}
        </Link>
      ),
    },
    { key: "date", header: "Дата", className: "whitespace-nowrap", cell: (p) => fmtDate(p.createdAt) },
    {
      key: "from",
      header: "Откуда",
      cell: (p) => (p.warehouseId ? whById.get(p.warehouseId) ?? "—" : "—"),
    },
    {
      key: "to",
      header: "Куда",
      cell: (p) => (p.targetWarehouseId ? whById.get(p.targetWarehouseId) ?? "—" : "—"),
    },
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
        title="Перемещения"
        action={
          isAdmin && warehouses.length >= 2 ? (
            <LinkButton href="/warehouse/transfers/new" variant="primary">
              + Перемещение
            </LinkButton>
          ) : undefined
        }
      />
      <DataTable
        columns={columns}
        rows={visibleTransfers}
        rowKey={(p) => p.id}
        empty={
          <EmptyState
            title="Перемещений пока нет"
            action={
              isAdmin && warehouses.length >= 2 ? (
                <LinkButton href="/warehouse/transfers/new" variant="primary">
                  + Перемещение
                </LinkButton>
              ) : undefined
            }
          >
            {warehouses.length < 2
              ? "Для перемещений нужно минимум два склада."
              : "Создайте первое перемещение между складами."}
          </EmptyState>
        }
        mobileCard={(p) => (
          <Link href={isAdmin ? `/warehouse/picklists/${p.id}` : `/warehouse/active/pick/${p.id}`} className="block">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-[#1a1a1a]">Перемещение №{p.number}</span>
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
              {(p.warehouseId && whById.get(p.warehouseId)) ?? "—"} →{" "}
              {(p.targetWarehouseId && whById.get(p.targetWarehouseId)) ?? "—"} · {p._count.lines}{" "}
              поз. · {fmtDate(p.createdAt)}
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
