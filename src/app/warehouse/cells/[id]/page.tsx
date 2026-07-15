import Link from "next/link";
import { Printer } from "lucide-react";
import { redirect } from "next/navigation";
import { requireStaffPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { warehouseAccess, isWhAllowed } from "@/lib/warehouse-access";
import { prisma } from "@/lib/db";
import { PageShell } from "@/components/page-shell";
import { Badge, Card, CardTitle, DownloadButton, EmptyState, LinkButton } from "@/components/ui";
import { fmtDateTime, fmtQty } from "@/lib/format";

// Экран ячейки — рабочая страница после скана QR ячейки: код крупно, склад,
// содержимое с резервами и ссылками на историю, последние движения.
export default async function CellPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireStaffPage();
  const s = scoped(session);
  const { id } = await params;
  const cell = await prisma.cell.findFirst({
    where: { id, companyId: s.companyId },
    include: { warehouse: true },
  });
  if (!cell) return <EmptyState>Ячейка не найдена.</EmptyState>;
  if (!isWhAllowed(await warehouseAccess(session), cell.warehouseId)) redirect("/warehouse");

  const [balances, units] = await Promise.all([
    prisma.stockBalance.findMany({
      where: { companyId: s.companyId, cellId: cell.id, qty: { gt: 0 } },
    }),
    prisma.itemUnit.findMany({
      where: { companyId: s.companyId, cellId: cell.id, status: { in: ["IN_STOCK", "PICKED"] } },
      orderBy: { serial: "asc" },
    }),
  ]);
  const lotIds = balances.map((b) => b.lotId);
  const unitIds = units.map((u) => u.id);
  const itemIds = [...new Set([...balances.map((b) => b.itemId), ...units.map((u) => u.itemId)])];

  // резерв активных заявок на партии в этой ячейке (несобранное/неразмещённое)
  const reservingLines = await prisma.pickLine.findMany({
    where: {
      companyId: s.companyId,
      cellId: cell.id,
      lotId: { not: null },
      pickList: { status: { in: ["NEW", "PICKING"] } },
    },
    select: {
      lotId: true,
      qtyRequested: true,
      fulfillments: { select: { qty: true, toCellId: true } },
    },
  });
  const reserveByLot = new Map<string, number>();
  for (const rl of reservingLines) {
    if (!rl.lotId) continue;
    const placed = rl.fulfillments
      .filter((fu) => fu.toCellId)
      .reduce((sum, fu) => sum + fu.qty.toNumber(), 0);
    const rem = rl.qtyRequested.toNumber() - placed;
    if (rem > 0) reserveByLot.set(rl.lotId, (reserveByLot.get(rl.lotId) ?? 0) + rem);
  }

  const movements = await prisma.stockMovement.findMany({
    where: { companyId: s.companyId, OR: [{ fromCellId: cell.id }, { toCellId: cell.id }] },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  const mvItemIds = [...new Set(movements.map((m) => m.itemId))];
  const [items, qrs, users] = await Promise.all([
    prisma.item.findMany({
      where: { id: { in: [...new Set([...itemIds, ...mvItemIds])] } },
      include: { uom: true },
    }),
    prisma.qrCode.findMany({
      where: {
        companyId: s.companyId,
        OR: [
          { type: "LOT", refId: { in: lotIds } },
          { type: "UNIT", refId: { in: unitIds } },
        ],
      },
      select: { type: true, refId: true, code: true },
    }),
    prisma.user.findMany({
      where: { id: { in: [...new Set(movements.map((m) => m.createdById))] } },
      select: { id: true, name: true },
    }),
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const codeByLot = new Map(qrs.filter((q) => q.type === "LOT").map((q) => [q.refId, q.code]));
  const codeByUnit = new Map(qrs.filter((q) => q.type === "UNIT").map((q) => [q.refId, q.code]));
  const userById = new Map(users.map((u) => [u.id, u.name]));

  const MOVE_RU: Record<string, string> = {
    RECEIPT: "Приёмка",
    CELL_ASSIGN: "Назначение ячейки",
    TRANSFER: "Перемещение",
    WRITEOFF: "Списание",
    PICKLIST: "Сборка",
    ISSUE: "Выдача",
    ISSUE_CONFIRM: "Подтверждение",
    INVENTORY: "Инвентаризация",
  };

  const isEmpty = balances.length === 0 && units.length === 0;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageShell
        title="Ячейка"
        action={
          <DownloadButton href={`/warehouse/print/labels/pdf?cell=${cell.id}`}>
            <Printer size={18} /> QR ячейки
          </DownloadButton>
        }
      >
        {/* Шапка ячейки: код крупно */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white px-4 py-4 shadow-[0_2px_8px_rgba(20,20,60,0.06)]">
          <div>
            <div className="font-mono text-3xl font-bold leading-none text-[#1a1a1a]">
              {cell.code}
            </div>
            <div className="mt-1.5 text-sm text-neutral-500">{cell.warehouse.name}</div>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <Badge tone={cell.isStaging ? "blue" : "neutral"}>
              {cell.isStaging ? "зона выдачи" : "ячейка хранения"}
            </Badge>
            {!cell.isActive && <Badge tone="red">отключена</Badge>}
          </div>
        </div>

        {/* Содержимое */}
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-neutral-500">
            Содержимое {!isEmpty && `(${balances.length + units.length})`}
          </h2>
          {isEmpty ? (
            <EmptyState>Ячейка пуста.</EmptyState>
          ) : (
            <>
              {balances.map((b) => {
                const item = itemById.get(b.itemId);
                const code = codeByLot.get(b.lotId);
                const reserve = Math.min(b.qty.toNumber(), reserveByLot.get(b.lotId) ?? 0);
                const free = b.qty.toNumber() - reserve;
                return (
                  <div
                    key={b.id}
                    className="rounded-xl bg-white px-3.5 py-3 shadow-[0_2px_8px_rgba(20,20,60,0.06)]"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-[#1a1a1a]">
                          {item?.name ?? "—"}
                        </div>
                        <div className="mt-0.5 text-xs">
                          {code ? (
                            <Link
                              href={`/warehouse/history?id=${code}`}
                              className="font-mono text-brand underline-offset-2"
                            >
                              {code}
                            </Link>
                          ) : (
                            <span className="text-neutral-400">—</span>
                          )}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-base font-bold tabular-nums">
                          {fmtQty(b.qty)}{" "}
                          <span className="text-xs font-normal text-neutral-500">
                            {item?.uom.name ?? ""}
                          </span>
                        </div>
                        {reserve > 0 && (
                          <div className="text-xs tabular-nums text-orange-600">
                            в резерве {fmtQty(reserve)}
                            {free > 0 ? ` · свободно ${fmtQty(free)}` : ""}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {units.map((u) => {
                const item = itemById.get(u.itemId);
                const code = codeByUnit.get(u.id);
                return (
                  <div
                    key={u.id}
                    className="rounded-xl bg-white px-3.5 py-3 shadow-[0_2px_8px_rgba(20,20,60,0.06)]"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-[#1a1a1a]">
                          {item?.name ?? "—"} №{u.serial}
                        </div>
                        <div className="mt-0.5 text-xs">
                          {code ? (
                            <Link
                              href={`/warehouse/history?id=${code}`}
                              className="font-mono text-brand underline-offset-2"
                            >
                              {code}
                            </Link>
                          ) : (
                            <span className="text-neutral-400">—</span>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <div className="text-base font-bold tabular-nums">
                          1{" "}
                          <span className="text-xs font-normal text-neutral-500">
                            {item?.uom.name ?? "шт"}
                          </span>
                        </div>
                        {u.status === "PICKED" && <Badge tone="orange">резерв заявки</Badge>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>

        {/* Последние движения */}
        {movements.length > 0 && (
          <Card>
            <CardTitle>Последние движения</CardTitle>
            <div className="flex flex-col divide-y divide-neutral-100">
              {movements.map((m) => {
                const item = itemById.get(m.itemId);
                const incoming = m.toCellId === cell.id;
                return (
                  <div key={m.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        <span className={incoming ? "text-green-600" : "text-orange-600"}>
                          {incoming ? "→" : "←"}
                        </span>{" "}
                        {MOVE_RU[m.docType] ?? m.docType} · {item?.name ?? "—"}
                      </div>
                      <div className="text-xs text-neutral-400">
                        {fmtDateTime(m.createdAt)} · {userById.get(m.createdById) ?? "—"}
                      </div>
                    </div>
                    <div className="shrink-0 text-sm font-semibold tabular-nums">
                      {incoming ? "+" : "−"}
                      {fmtQty(m.qty)} {item?.uom.name ?? ""}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        <LinkButton href={`/warehouse/warehouses/${cell.warehouseId}`}>
          Все ячейки склада «{cell.warehouse.name}»
        </LinkButton>
      </PageShell>
    </div>
  );
}
