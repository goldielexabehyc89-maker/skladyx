import { Printer } from "lucide-react";
import { redirect } from "next/navigation";
import { requireWarehouseViewerPage } from "@/lib/auth";
import { hasAnyRole, warehouseZonesEnabled } from "@/lib/roles";
import { scoped } from "@/lib/tenant";
import { warehouseAccess, isWhAllowed } from "@/lib/warehouse-access";
import { ZONE_KIND_TONE } from "@/lib/zones";
import { prisma } from "@/lib/db";
import { PageShell } from "@/components/page-shell";
import { Badge, Card, CardTitle, DownloadButton, EmptyState, LinkButton } from "@/components/ui";
import { fmtDateTime, fmtQty } from "@/lib/format";
import type { HandlingGroupStatus } from "@prisma/client";

const GROUP_STATE: Record<HandlingGroupStatus, { label: string; tone: "neutral" | "blue" | "green" | "orange" }> = {
  IN_RECEIVING: { label: "В приёмке", tone: "neutral" },
  AWAITING_STORAGE: { label: "Ждёт размещения", tone: "orange" },
  AWAITING_COOLING: { label: "Ждёт охлаждения", tone: "orange" },
  IN_STORAGE: { label: "На хранении", tone: "green" },
  IN_COOLING: { label: "В охлаждении", tone: "blue" },
};

const MOVE_RU: Record<string, string> = {
  RECEIPT: "Приёмка",
  CELL_ASSIGN: "Назначение ячейки",
  TRANSFER: "Перемещение",
  WRITEOFF: "Списание",
  PICKLIST: "Сборка",
  ISSUE: "Выдача",
  ISSUE_CONFIRM: "Подтверждение",
  INVENTORY: "Корректировка",
};

// Пакет 11: экран ячейки на новой модели — read-only для рабочих ролей (обязательная
// проверка доступа к складу). Содержимое: товар, EAN, количество, состояние группы,
// резерв заказа. Без поштучных единиц, заявок-сборки и старых QR партий.
export default async function CellPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireWarehouseViewerPage();
  const s = scoped(session);
  const canPrint = hasAnyRole(session, ["ADMIN", "STOREKEEPER"]);
  const { id } = await params;
  const cell = await prisma.cell.findFirst({
    where: { id, companyId: s.companyId },
    include: { warehouse: true, zone: true },
  });
  const zonesOn = warehouseZonesEnabled();
  if (!cell) return <EmptyState>Ячейка не найдена.</EmptyState>;
  if (!isWhAllowed(await warehouseAccess(session), cell.warehouseId)) redirect("/warehouse");

  const balances = await prisma.stockBalance.findMany({
    where: { companyId: s.companyId, cellId: cell.id, qty: { gt: 0 } },
  });
  const lotIds = [...new Set(balances.map((b) => b.lotId))];
  const itemIds = [...new Set(balances.map((b) => b.itemId))];

  const movements = await prisma.stockMovement.findMany({
    where: { companyId: s.companyId, OR: [{ fromCellId: cell.id }, { toCellId: cell.id }] },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  const mvItemIds = [...new Set(movements.map((m) => m.itemId))];

  const [items, barcodes, groups, reservations, users] = await Promise.all([
    prisma.item.findMany({
      where: { id: { in: [...new Set([...itemIds, ...mvItemIds])] } },
      include: { uom: true },
    }),
    prisma.itemBarcode.findMany({
      where: { companyId: s.companyId, itemId: { in: itemIds }, isActive: true },
      orderBy: { createdAt: "asc" },
      select: { itemId: true, code: true },
    }),
    prisma.handlingGroup.findMany({ where: { companyId: s.companyId, lotId: { in: lotIds } }, select: { lotId: true, status: true } }),
    prisma.stockReservation.findMany({
      where: { companyId: s.companyId, status: "ACTIVE", cellId: cell.id, lotId: { in: lotIds } },
      select: { lotId: true, qty: true, order: { select: { externalId: true } } },
    }),
    prisma.user.findMany({
      where: { id: { in: [...new Set(movements.map((m) => m.createdById))] } },
      select: { id: true, name: true },
    }),
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const eanByItem = new Map<string, string>();
  for (const b of barcodes) if (!eanByItem.has(b.itemId)) eanByItem.set(b.itemId, b.code);
  const groupByLot = new Map(groups.map((g) => [g.lotId, g.status]));
  const userById = new Map(users.map((u) => [u.id, u.name]));

  const resByLot = new Map<string, { qty: number; orders: Set<string> }>();
  for (const r of reservations) {
    if (!r.lotId) continue;
    const e = resByLot.get(r.lotId) ?? { qty: 0, orders: new Set<string>() };
    e.qty += r.qty.toNumber();
    if (r.order?.externalId) e.orders.add(r.order.externalId);
    resByLot.set(r.lotId, e);
  }

  const isEmpty = balances.length === 0;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageShell
        title="Ячейка"
        action={
          canPrint ? (
            <DownloadButton href={`/warehouse/print/labels/pdf?cell=${cell.id}`}>
              <Printer size={18} /> QR ячейки
            </DownloadButton>
          ) : undefined
        }
      >
        {/* Шапка ячейки */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white px-4 py-4 shadow-[0_2px_8px_rgba(20,20,60,0.06)]">
          <div>
            <div className="font-mono text-3xl font-bold leading-none text-[#1a1a1a]">{cell.code}</div>
            <div className="mt-1.5 text-sm text-neutral-500">{cell.warehouse.name}</div>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            {zonesOn && cell.zone ? (
              <Badge tone={ZONE_KIND_TONE[cell.zone.kind]}>
                {cell.zone.name}
                {cell.level != null ? ` · ур. ${cell.level}` : ""}
              </Badge>
            ) : (
              <Badge tone={cell.isStaging ? "blue" : "neutral"}>
                {cell.isStaging ? "зона выдачи" : "ячейка хранения"}
              </Badge>
            )}
            {!cell.isActive && <Badge tone="red">отключена</Badge>}
          </div>
        </div>

        {/* Содержимое */}
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-neutral-500">
            Содержимое {!isEmpty && `(${balances.length})`}
          </h2>
          {isEmpty ? (
            <EmptyState>Ячейка пуста.</EmptyState>
          ) : (
            balances.map((b) => {
              const item = itemById.get(b.itemId);
              const ean = eanByItem.get(b.itemId);
              const gs = groupByLot.get(b.lotId);
              const g = gs ? GROUP_STATE[gs] : null;
              const res = resByLot.get(b.lotId);
              return (
                <div key={b.id} className="rounded-xl bg-white px-3.5 py-3 shadow-[0_2px_8px_rgba(20,20,60,0.06)]">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-[#1a1a1a]">{item?.name ?? "—"}</div>
                      {ean && <div className="mt-0.5 font-mono text-xs text-neutral-500">{ean}</div>}
                      {g && <span className={`mt-1 inline-flex rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${toneCls(g.tone)}`}>{g.label}</span>}
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-base font-bold tabular-nums">
                        {fmtQty(b.qty)} <span className="text-xs font-normal text-neutral-500">{item?.uom.name ?? ""}</span>
                      </div>
                      {res && res.qty > 0 && (
                        <div className="text-xs tabular-nums text-orange-600">
                          резерв заказа {fmtQty(res.qty)}
                          {res.orders.size > 0 ? ` · ${[...res.orders].join(", ")}` : ""}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
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
                        <span className={incoming ? "text-green-600" : "text-orange-600"}>{incoming ? "→" : "←"}</span>{" "}
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

function toneCls(tone: "neutral" | "blue" | "green" | "orange"): string {
  switch (tone) {
    case "blue":
      return "bg-blue-100 text-blue-700";
    case "green":
      return "bg-green-100 text-green-700";
    case "orange":
      return "bg-amber-100 text-amber-700";
    default:
      return "bg-neutral-100 text-neutral-600";
  }
}
