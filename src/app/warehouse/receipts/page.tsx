import Link from "next/link";
import { requireStaffPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { warehouseAccess, whereWh, allowedWarehouses } from "@/lib/warehouse-access";
import { prisma } from "@/lib/db";
import { PageHeader, Badge } from "@/components/ui";
import { DataTable, type Column } from "@/components/data-table";
import { fmtDateTime } from "@/lib/format";

// Приемка — журнал завершённых приёмок (Таблица 1). Полностью принятые заказы не исчезают.
export default async function ReceiptsPage() {
  const session = await requireStaffPage();
  const s = scoped(session);
  const access = await warehouseAccess(session);

  const orders = await prisma.supplierOrder.findMany({
    where: { companyId: s.companyId, status: "RECEIVED", ...whereWh(access) },
    include: { supplier: true },
    orderBy: { receivedAt: "desc" },
    take: 200,
  });
  const warehouses = await allowedWarehouses(session, s.companyId);
  const whById = new Map(warehouses.map((w) => [w.id, w.name]));

  // дата/время последнего назначения ячейки в приёмке заказа
  const receiptIds = orders.map((o) => o.receiptId).filter((x): x is string => !!x);
  const lastAssign = new Map<string, Date>();
  if (receiptIds.length) {
    const mv = await prisma.stockMovement.findMany({
      where: {
        companyId: s.companyId,
        docType: "RECEIPT",
        docId: { in: receiptIds },
        toCellId: { not: null },
      },
      select: { docId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    for (const m of mv) lastAssign.set(m.docId, m.createdAt);
  }

  type Row = (typeof orders)[number];
  const columns: Column<Row>[] = [
    {
      key: "date",
      header: "Дата и время",
      className: "whitespace-nowrap text-neutral-500",
      cell: (o) => {
        const dt = lastAssign.get(o.receiptId ?? "") ?? o.receivedAt;
        return dt ? fmtDateTime(dt) : "—";
      },
    },
    {
      key: "number",
      header: "Заказ",
      className: "whitespace-nowrap",
      cell: (o) => (
        <Link href={`/warehouse/receipts/${o.id}`} className="font-semibold text-brand">
          №{o.number}
        </Link>
      ),
    },
    { key: "supplier", header: "Поставщик", cell: (o) => o.supplier.name },
    { key: "wh", header: "Склад", cell: (o) => whById.get(o.warehouseId) ?? "—" },
    { key: "status", header: "Статус", cell: () => <Badge tone="green">принят</Badge> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Приемка" />
      <p className="-mt-1 text-sm text-neutral-500">
        Журнал завершённых приёмок. Заказы в работе — во вкладке «Активные».
      </p>
      <DataTable
        columns={columns}
        rows={orders}
        rowKey={(o) => o.id}
        empty="Завершённых приёмок пока нет."
        mobileCard={(o) => {
          const dt = lastAssign.get(o.receiptId ?? "") ?? o.receivedAt;
          return (
            <Link href={`/warehouse/receipts/${o.id}`} className="block">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-[#1a1a1a]">Заказ №{o.number}</span>
                <Badge tone="green">принят</Badge>
              </div>
              <div className="mt-0.5 truncate text-xs text-neutral-500">
                {o.supplier.name} · {whById.get(o.warehouseId) ?? "—"} ·{" "}
                {dt ? fmtDateTime(dt) : "—"}
              </div>
            </Link>
          );
        }}
      />
    </div>
  );
}
