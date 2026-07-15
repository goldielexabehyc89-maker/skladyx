import Link from "next/link";
import { requireStaffPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { warehouseAccess, whereWh } from "@/lib/warehouse-access";
import { prisma } from "@/lib/db";
import { PageTitle, EmptyState, Badge } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

// Зона выдачи: собранные заявки, ждущие выдачи сотруднику.
export default async function StagingPage() {
  const session = await requireStaffPage();
  const s = scoped(session);
  const access = await warehouseAccess(session);
  const pickLists = await prisma.pickList.findMany({
    where: { companyId: s.companyId, status: "STAGED", ...whereWh(access) },
    include: { _count: { select: { lines: true } }, cells: { orderBy: { createdAt: "asc" } } },
    orderBy: { stagedAt: "asc" },
  });
  const users = await s.users();
  const cells = await prisma.cell.findMany({
    where: {
      id: {
        in: [
          ...new Set(
            pickLists.flatMap((p) => [
              ...p.cells.map((c) => c.cellId),
              ...(p.stagingCellId ? [p.stagingCellId] : []),
            ]),
          ),
        ],
      },
    },
    include: { warehouse: true },
  });
  const userById = new Map(users.map((u) => [u.id, u.name]));
  const allWh = await prisma.warehouse.findMany({ where: { companyId: s.companyId } });
  const anyWhById = new Map(allWh.map((w) => [w.id, w.name]));
  const cellById = new Map(cells.map((c) => [c.id, c]));

  return (
    <div className="flex flex-col gap-4">
      <PageTitle>Зона выдачи</PageTitle>

      {pickLists.length === 0 ? (
        <EmptyState>Собранных заявок, ждущих выдачи, нет.</EmptyState>
      ) : (
        <div className="flex flex-col gap-2">
          {pickLists.map((p) => {
            const codes = (p.cells.length
              ? p.cells.map((c) => cellById.get(c.cellId)?.code)
              : [p.stagingCellId ? cellById.get(p.stagingCellId)?.code : null]
            ).filter((x): x is string => !!x);
            return (
              <Link
                key={p.id}
                href={`/warehouse/active/pick/${p.id}`}
                className="flex items-center justify-between rounded-2xl bg-white p-4 shadow-[0_2px_8px_rgba(20,20,60,0.06)] active:bg-neutral-50"
              >
                <div>
                  <div className="font-semibold">
                    {p.targetWarehouseId
                      ? `Перемещение №${p.number} — на ${anyWhById.get(p.targetWarehouseId) ?? "—"}`
                      : `Заявка №${p.number} — ${(p.targetEmployeeId && userById.get(p.targetEmployeeId)) ?? "—"}`}
                  </div>
                  <div className="text-sm text-neutral-500">
                    {p._count.lines} поз. · в зоне с {p.stagedAt ? fmtDateTime(p.stagedAt) : "—"}
                  </div>
                </div>
                <Badge tone="blue">{codes.length > 0 ? codes.join(", ") : "ячейка"}</Badge>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
