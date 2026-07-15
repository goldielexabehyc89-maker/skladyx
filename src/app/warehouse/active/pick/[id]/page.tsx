import { Printer } from "lucide-react";
import { requireStaffPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { getAllowedWarehouse } from "@/lib/warehouse-access";
import { prisma } from "@/lib/db";
import { undoPickAction } from "@/app/actions/picklists";
import { CollectScreen, type CollectLine } from "./collect-screen";
import { IssueScreen } from "./issue-screen";
import { PageTitle, Badge, LinkButton, EmptyState, Card, CardTitle } from "@/components/ui";
import { fmtDate, fmtQty } from "@/lib/format";

const STATUS_RU: Record<string, string> = {
  NEW: "к сборке",
  PICKING: "в сборке",
  PICKED: "собрана",
  STAGED: "в зоне выдачи",
  ISSUED: "выдана",
  CANCELLED: "отменена",
};

// Сборка заявки кладовщиком: сканы товаров (позиции помечаются «проверен»),
// затем скан ячейки выдачи перемещает проверенное в неё (можно частями в разные
// ячейки). Когда всё проверено и размещено — заявка сама уходит в зону выдачи,
// дальше выдача сотруднику. Открывается из «Активных». ADMIN + STOREKEEPER.
export default async function PickCollectPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireStaffPage();
  const s = scoped(session);
  const { id } = await params;
  const pickList = await s.pickList(id);
  const isTransfer = !!pickList.targetWarehouseId;
  const target = pickList.targetEmployeeId ? await s.user(pickList.targetEmployeeId) : null;
  const targetWh = pickList.targetWarehouseId
    ? await prisma.warehouse.findFirst({
        where: { id: pickList.targetWarehouseId, companyId: s.companyId },
      })
    : null;
  const warehouse = pickList.warehouseId
    ? await getAllowedWarehouse(session, s.companyId, pickList.warehouseId).catch(() => null)
    : null;
  const { status } = pickList;
  const isPicking = status === "NEW" || status === "PICKING";
  const lines = pickList.lines;

  const lotIds = lines.map((l) => l.lotId).filter((x): x is string => !!x);
  const unitIds = lines.map((l) => l.unitId).filter((x): x is string => !!x);
  const cellIds = [
    ...new Set(
      [
        ...lines.map((l) => l.cellId),
        ...lines.flatMap((l) => l.fulfillments.map((f) => f.toCellId)),
        ...pickList.cells.map((c) => c.cellId),
      ].filter((x): x is string => !!x),
    ),
  ];
  const [items, cells, qrs, unitRecs] = await Promise.all([
    prisma.item.findMany({ where: { id: { in: lines.map((l) => l.itemId) } }, include: { uom: true } }),
    prisma.cell.findMany({ where: { id: { in: cellIds } } }),
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
    prisma.itemUnit.findMany({ where: { id: { in: unitIds } }, select: { id: true, serial: true } }),
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const cellById = new Map(cells.map((c) => [c.id, c]));
  const codeByLot = new Map(qrs.filter((q) => q.type === "LOT").map((q) => [q.refId, q.code]));
  const codeByUnit = new Map(qrs.filter((q) => q.type === "UNIT").map((q) => [q.refId, q.code]));
  const serialByUnit = new Map(unitRecs.map((u) => [u.id, u.serial]));

  const stagedOf = (l: (typeof lines)[number]): string[] => [
    ...new Set(
      l.fulfillments
        .map((f) => f.toCellId)
        .filter((x): x is string => !!x)
        .map((cid) => cellById.get(cid)?.code ?? "?"),
    ),
  ];

  const collectLines: CollectLine[] = lines.map((l) => {
    const item = itemById.get(l.itemId);
    const code = l.lotId ? codeByLot.get(l.lotId) : l.unitId ? codeByUnit.get(l.unitId) : null;
    const serial = l.unitId ? serialByUnit.get(l.unitId) : null;
    return {
      id: l.id,
      code: code ?? null,
      name: (item?.name ?? "—") + (serial ? ` №${serial}` : ""),
      uom: item?.uom.name ?? "",
      qtyRequested: l.qtyRequested.toNumber(),
      qtyPicked: l.qtyPicked.toNumber(),
      sourceCell: l.cellId ? (cellById.get(l.cellId)?.code ?? "ячейка") : "—",
      stagedCells: stagedOf(l),
      done: l.qtyPicked.gte(l.qtyRequested),
      // проверено полностью и всё уже в ячейках выдачи
      placed:
        l.qtyPicked.gte(l.qtyRequested) &&
        l.fulfillments.length > 0 &&
        l.fulfillments.every((f) => !!f.toCellId),
    };
  });

  const doneCount = lines.filter((l) => l.qtyPicked.gte(l.qtyRequested)).length;
  // назначенные ячейки выдачи (по порядку назначения) и текущая
  const assignedCells = pickList.cells.map((c) => cellById.get(c.cellId)?.code ?? "?");
  // проверенные, но ещё не размещённые в ячейку выдачи штуки
  const hasUnplaced = lines.some((l) => l.fulfillments.some((f) => !f.toCellId));

  return (
    <div className="flex flex-col gap-4">
      <PageTitle
        action={
          <Badge tone={status === "ISSUED" ? "green" : status === "CANCELLED" ? "red" : "blue"}>
            {STATUS_RU[status]}
          </Badge>
        }
      >
        {status === "STAGED" || status === "ISSUED" ? "Выдача" : "Сборка"} ·{" "}
        {isTransfer ? "перемещение" : "заявка"} №{pickList.number}
      </PageTitle>
      <p className="-mt-3 text-sm text-neutral-500">
        {isTransfer ? "На склад" : "Для"}: <b>{isTransfer ? (targetWh?.name ?? "—") : (target?.name ?? "—")}</b> ·{" "}
        {warehouse?.name ?? "склад не указан"} · {fmtDate(pickList.createdAt)}
        {assignedCells.length > 0 ? ` · ячейки выдачи: ${assignedCells.join(", ")}` : ""}
      </p>
      <p className="-mt-2 text-sm text-neutral-500">
        Проверено позиций: <b className="text-neutral-900">{doneCount} из {lines.length}</b>
      </p>

      {lines.length === 0 ? (
        <EmptyState>В заявке нет позиций.</EmptyState>
      ) : (
        <>
        {/* Мобильный вид: карточки позиций (без горизонтального скролла) */}
        <div className="flex flex-col gap-2 lg:hidden">
          {collectLines.map((l) => {
            const staged = l.stagedCells.length > 0;
            const cells = staged ? l.stagedCells : l.sourceCell !== "—" ? [l.sourceCell] : [];
            return (
              <div
                key={l.id}
                className="rounded-xl bg-white px-3.5 py-3 shadow-[0_2px_8px_rgba(20,20,60,0.06)]"
              >
                <div className="flex items-stretch justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-[#1a1a1a]">{l.name}</div>
                    <div className="mt-0.5 text-xs text-neutral-500">
                      {l.qtyRequested} {l.uom}
                      {l.code ? ` · ${l.code}` : ""}
                    </div>
                    <div className="mt-1">
                      <span
                        className={
                          "text-sm font-semibold tabular-nums " +
                          (l.done ? "text-green-600" : "text-orange-500")
                        }
                      >
                        проверено {fmtQty(l.qtyPicked)} / {fmtQty(l.qtyRequested)}
                      </span>
                    </div>
                  </div>
                  {cells.length > 0 && (
                    <div
                      className={
                        "flex shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg px-3 py-1.5 " +
                        (staged ? "bg-[#e9ecfb]" : "bg-white ring-1 ring-inset ring-neutral-200")
                      }
                    >
                      <span
                        className={
                          "text-[10px] uppercase tracking-wide " +
                          (staged ? "text-[#4c5fd7]" : "text-neutral-400")
                        }
                      >
                        {staged ? "выдача" : "лежит"}
                      </span>
                      {cells.map((c) => (
                        <span
                          key={c}
                          className={
                            "font-mono text-xl font-bold leading-tight " +
                            (staged ? "text-[#4c5fd7]" : "text-neutral-800")
                          }
                        >
                          {c}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="hidden overflow-x-auto rounded-xl bg-white shadow-[0_2px_8px_rgba(20,20,60,0.06)] lg:block">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-neutral-50">
              <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                <th className="px-3 py-2.5 font-medium">ID</th>
                <th className="px-3 py-2.5 font-medium">Товар</th>
                <th className="px-3 py-2.5 font-medium">Где лежит</th>
                <th className="px-3 py-2.5 font-medium">Ячейка выдачи</th>
                <th className="px-3 py-2.5 font-medium">Ед.</th>
                <th className="px-3 py-2.5 text-right font-medium">Проверено</th>
              </tr>
            </thead>
            <tbody>
              {collectLines.map((l) => (
                <tr key={l.id} className="border-b border-neutral-100 last:border-0">
                  <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs">{l.code ?? "—"}</td>
                  <td className="px-3 py-2.5 font-medium">
                    {l.done && <span className="text-green-600">✓ </span>}
                    {l.name}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-neutral-600">
                    {l.stagedCells.length > 0 ? "—" : l.sourceCell}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-[#667eea]">
                    {l.stagedCells.length > 0 ? l.stagedCells.join(", ") : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-neutral-500">{l.uom}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    <span className={l.done ? "text-green-600" : "text-orange-500"}>
                      {fmtQty(l.qtyPicked)} / {fmtQty(l.qtyRequested)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}

      {isPicking && lines.length > 0 && (
        <CollectScreen
          pickListId={pickList.id}
          pickNumber={pickList.number}
          kindLabel={isTransfer ? "перемещение" : "заявка"}
          lines={collectLines}
          hasUnplaced={hasUnplaced}
        />
      )}

      {isPicking && lines.some((l) => l.fulfillments.length > 0) && (
        <Card>
          <CardTitle>Отменить отсканированное</CardTitle>
          <div className="flex flex-col gap-1.5">
            {lines.flatMap((l) =>
              l.fulfillments.map((f) => (
                <div key={f.id} className="flex items-center justify-between text-sm">
                  <span className="text-neutral-600">
                    {itemById.get(l.itemId)?.name ?? "—"}: {fmtQty(f.qty)}
                    {f.toCellId ? ` → ${cellById.get(f.toCellId)?.code ?? "?"}` : ""}
                  </span>
                  <form action={undoPickAction}>
                    <input type="hidden" name="fulfillmentId" value={f.id} />
                    <button type="submit" className="text-sm text-red-400 underline-offset-2 active:underline">
                      отменить
                    </button>
                  </form>
                </div>
              )),
            )}
          </div>
        </Card>
      )}

      {status === "STAGED" && (
        <>
          <IssueScreen
            pickListId={pickList.id}
            pickNumber={pickList.number}
            kindLabel={isTransfer ? "перемещение" : "заявка"}
            targetName={isTransfer ? (targetWh?.name ?? "—") : (target?.name ?? "—")}
            lines={collectLines}
          />
          <LinkButton href={`/warehouse/print/labels?picklist=${pickList.id}`}>
            <Printer size={18} /> Этикетка на короб заявки
          </LinkButton>
        </>
      )}
    </div>
  );
}
