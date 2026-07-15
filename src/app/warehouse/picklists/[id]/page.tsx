import { ClipboardList, Trash2 } from "lucide-react";
import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { getAllowedWarehouse } from "@/lib/warehouse-access";
import { prisma } from "@/lib/db";
import { cancelPickListAction, removePickLineAction, savePickListAction } from "@/app/actions/picklists";
import { ActionForm } from "@/components/action-form";
import { PickAddRow, type Placement } from "./pick-add-row";
import { DeleteDocButton } from "@/components/delete-doc-button";
import { deletePickListAction } from "@/app/actions/picklists";
import { PageHeader, Badge, LinkButton, Button, EmptyState } from "@/components/ui";
import { fmtDate, fmtQty } from "@/lib/format";

const STATUS_RU: Record<string, string> = {
  NEW: "новая",
  PICKING: "в сборке",
  PICKED: "собрана",
  STAGED: "в зоне выдачи",
  ISSUED: "выдана",
  CANCELLED: "отменена",
};

export default async function PickListPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminPage();
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
  const isEditable = status === "NEW";
  const isPicking = status === "NEW" || status === "PICKING";

  const lines = pickList.lines;
  const lineLotIds = lines.map((l) => l.lotId).filter((x): x is string => !!x);
  const lineUnitIds = lines.map((l) => l.unitId).filter((x): x is string => !!x);

  // остатки склада для добавления позиций (когда заявка новая)
  const balances = isEditable && pickList.warehouseId
    ? await prisma.stockBalance.findMany({
        where: {
          companyId: s.companyId,
          warehouseId: pickList.warehouseId,
          cellId: { not: null },
          employeeId: null,
          qty: { gt: 0 },
        },
      })
    : [];
  const stockUnits = isEditable && pickList.warehouseId
    ? await prisma.itemUnit.findMany({
        where: {
          companyId: s.companyId,
          warehouseId: pickList.warehouseId,
          status: "IN_STOCK",
          cellId: { not: null },
        },
      })
    : [];

  const allLotIds = [...new Set([...lineLotIds, ...balances.map((b) => b.lotId)])];
  const allUnitIds = [...new Set([...lineUnitIds, ...stockUnits.map((u) => u.id)])];
  const allItemIds = [
    ...new Set([
      ...lines.map((l) => l.itemId),
      ...balances.map((b) => b.itemId),
      ...stockUnits.map((u) => u.itemId),
    ]),
  ];
  const allCellIds = [
    ...new Set(
      [
        ...lines.map((l) => l.cellId),
        ...lines.flatMap((l) => l.fulfillments.map((f) => f.toCellId)),
        ...balances.map((b) => b.cellId),
        ...stockUnits.map((u) => u.cellId),
      ].filter((x): x is string => !!x),
    ),
  ];

  const [items, cells, qrs, lotRecs, unitRecs] = await Promise.all([
    prisma.item.findMany({ where: { id: { in: allItemIds } }, include: { uom: true } }),
    prisma.cell.findMany({ where: { id: { in: allCellIds } } }),
    prisma.qrCode.findMany({
      where: {
        companyId: s.companyId,
        OR: [
          { type: "LOT", refId: { in: allLotIds } },
          { type: "UNIT", refId: { in: allUnitIds } },
        ],
      },
      select: { type: true, refId: true, code: true },
    }),
    prisma.lot.findMany({ where: { id: { in: allLotIds } }, select: { id: true, receiptLineId: true } }),
    prisma.itemUnit.findMany({
      where: { id: { in: allUnitIds } },
      select: { id: true, receiptLineId: true, serial: true },
    }),
  ]);

  const itemById = new Map(items.map((i) => [i.id, i]));
  const cellById = new Map(cells.map((c) => [c.id, c]));
  const codeByLot = new Map(qrs.filter((q) => q.type === "LOT").map((q) => [q.refId, q.code]));
  const codeByUnit = new Map(qrs.filter((q) => q.type === "UNIT").map((q) => [q.refId, q.code]));
  const serialByUnit = new Map(unitRecs.map((u) => [u.id, u.serial]));

  // заказ поставщика по партии/единице (через строку приёмки → строку заказа)
  const receiptLineIds = [
    ...new Set([...lotRecs.map((l) => l.receiptLineId), ...unitRecs.map((u) => u.receiptLineId)]),
  ];
  const receiptLines = await prisma.receiptLine.findMany({
    where: { companyId: s.companyId, id: { in: receiptLineIds } },
    select: { id: true, orderLineId: true },
  });
  const olIds = receiptLines.map((r) => r.orderLineId).filter((x): x is string => !!x);
  const orderLines = olIds.length
    ? await prisma.supplierOrderLine.findMany({
        where: { id: { in: olIds } },
        select: { id: true, orderId: true },
      })
    : [];
  const orders = orderLines.length
    ? await prisma.supplierOrder.findMany({
        where: { id: { in: orderLines.map((o) => o.orderId) } },
        select: { id: true, number: true },
      })
    : [];
  const orderNumById = new Map(orders.map((o) => [o.id, o.number]));
  const orderIdByLine = new Map(orderLines.map((o) => [o.id, o.orderId]));
  const orderNumByReceiptLine = new Map<string, number>();
  for (const rl of receiptLines) {
    if (!rl.orderLineId) continue;
    const oid = orderIdByLine.get(rl.orderLineId);
    const num = oid ? orderNumById.get(oid) : undefined;
    if (num != null) orderNumByReceiptLine.set(rl.id, num);
  }
  const recLineByLot = new Map(lotRecs.map((l) => [l.id, l.receiptLineId]));
  const recLineByUnit = new Map(unitRecs.map((u) => [u.id, u.receiptLineId]));

  function orderNumFor(lotId: string | null, unitId: string | null): string {
    const rl = lotId ? recLineByLot.get(lotId) : unitId ? recLineByUnit.get(unitId) : undefined;
    const num = rl ? orderNumByReceiptLine.get(rl) : undefined;
    return num != null ? `№${num}` : "—";
  }

  // позиции заявки для таблицы
  const rows = lines.map((l) => {
    const item = itemById.get(l.itemId);
    const code = l.lotId ? codeByLot.get(l.lotId) : l.unitId ? codeByUnit.get(l.unitId) : null;
    const serial = l.unitId ? serialByUnit.get(l.unitId) : null;
    return {
      id: l.id,
      order: orderNumFor(l.lotId, l.unitId),
      code: code ?? "—",
      name: (item?.name ?? "—") + (serial ? ` №${serial}` : ""),
      // если товар уже перемещён в ячейку выдачи — показываем её, а не ячейку хранения
      where: (() => {
        const staged = [
          ...new Set(
            l.fulfillments
              .map((f) => f.toCellId)
              .filter((x): x is string => !!x)
              .map((cid) => cellById.get(cid)?.code ?? "?"),
          ),
        ];
        if (staged.length > 0) return staged.join(", ");
        return l.cellId ? (cellById.get(l.cellId)?.code ?? "ячейка") : "—";
      })(),
      uom: item?.uom.name ?? "",
      qtyRequested: fmtQty(l.qtyRequested),
      qtyPicked: fmtQty(l.qtyPicked),
      done: l.qtyPicked.gte(l.qtyRequested),
    };
  });

  // варианты для add-row
  const addedLotCell = new Set(lines.filter((l) => l.lotId).map((l) => `${l.lotId}:${l.cellId}`));
  const addedUnits = new Set(lines.filter((l) => l.unitId).map((l) => l.unitId));
  // остатки, зарезервированные другими активными заявками, не предлагать
  const otherLines = isEditable
    ? await prisma.pickLine.findMany({
        where: {
          companyId: s.companyId,
          pickListId: { not: pickList.id },
          pickList: { status: { in: ["NEW", "PICKING"] } },
        },
        select: { lotId: true, unitId: true, cellId: true, qtyRequested: true, qtyPicked: true },
      })
    : [];
  const reservedUnits = new Set(
    otherLines.filter((l) => l.unitId).map((l) => l.unitId as string),
  );
  const reservedLotCell = new Map<string, number>();
  for (const l of otherLines) {
    if (!l.lotId || !l.cellId) continue;
    const rem = l.qtyRequested.sub(l.qtyPicked).toNumber();
    if (rem <= 0) continue;
    const key = `${l.lotId}#${l.cellId}`;
    reservedLotCell.set(key, (reservedLotCell.get(key) ?? 0) + rem);
  }
  const placements: Placement[] = [];
  for (const b of balances) {
    if (!b.cellId || addedLotCell.has(`${b.lotId}:${b.cellId}`)) continue;
    const item = itemById.get(b.itemId);
    const cell = cellById.get(b.cellId);
    if (cell?.isStaging) continue; // не предлагать резерв (ячейку выдачи)
    const avail = b.qty.toNumber() - (reservedLotCell.get(`${b.lotId}#${b.cellId}`) ?? 0);
    if (avail <= 0) continue; // весь остаток в резерве других заявок
    const code = codeByLot.get(b.lotId) ?? "—";
    const name = item?.name ?? "—";
    const where = cell?.code ?? "—";
    placements.push({
      ref: `L:${b.lotId}:${b.cellId}`,
      kind: "LOT",
      code,
      name,
      qtyLabel: `${fmtQty(avail)} ${item?.uom.name ?? ""}`,
      where,
      uom: item?.uom.name ?? "",
      maxQty: avail,
      search: `${name} ${code} ${where}`.toLowerCase(),
    });
  }
  for (const u of stockUnits) {
    if (addedUnits.has(u.id)) continue;
    if (reservedUnits.has(u.id)) continue; // резерв другой заявки
    const item = itemById.get(u.itemId);
    const cell = u.cellId ? cellById.get(u.cellId) : null;
    if (cell?.isStaging) continue; // не предлагать резерв (ячейку выдачи)
    const code = codeByUnit.get(u.id) ?? "—";
    const name = `${item?.name ?? "—"} №${u.serial}`;
    const where = cell?.code ?? "—";
    placements.push({
      ref: `U:${u.id}`,
      kind: "UNIT",
      code,
      name,
      qtyLabel: `1 ${item?.uom.name ?? ""}`,
      where,
      uom: item?.uom.name ?? "",
      maxQty: 1,
      search: `${name} ${code} ${where}`.toLowerCase(),
    });
  }

  // назначенные ячейки зоны выдачи (по порядку назначения)
  const assignedCellRecs = pickList.cells.length
    ? await prisma.cell.findMany({
        where: { id: { in: pickList.cells.map((c) => c.cellId) } },
      })
    : [];
  const stagingCodeById = new Map(assignedCellRecs.map((c) => [c.id, c.code]));
  const assignedCells = pickList.cells.map((c) => stagingCodeById.get(c.cellId) ?? "?");

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2.5">
            {isTransfer ? "Перемещение" : "Заявка на сбор"} №{pickList.number}
            {status === "NEW" && !pickList.savedAt ? (
              <Badge tone="orange">черновик</Badge>
            ) : (
              <Badge tone={status === "ISSUED" ? "green" : status === "CANCELLED" ? "red" : "blue"}>
                {STATUS_RU[status]}
              </Badge>
            )}
          </span>
        }
        action={
          <div className="flex items-center gap-2">
            {isPicking && (
              <form action={cancelPickListAction}>
                <input type="hidden" name="pickListId" value={pickList.id} />
                <Button type="submit" variant="ghost">
                  Отменить
                </Button>
              </form>
            )}
            {isEditable &&
              (lines.length > 0 ? (
                <form action={savePickListAction}>
                  <input type="hidden" name="pickListId" value={pickList.id} />
                  <Button type="submit" variant="primary">
                    Сохранить
                  </Button>
                </form>
              ) : (
                <Button type="button" variant="primary" disabled>
                  Сохранить
                </Button>
              ))}
          </div>
        }
      />
      <p className="-mt-2 text-sm text-neutral-500">
        {isTransfer ? "На склад" : "Для"}: <b>{isTransfer ? (targetWh?.name ?? "—") : (target?.name ?? "—")}</b> · {warehouse?.name ?? "склад не указан"} ·{" "}
        {fmtDate(pickList.createdAt)}
        {pickList.note ? ` · ${pickList.note}` : ""}
        {assignedCells.length > 0 ? ` · ячейки выдачи: ${assignedCells.join(", ")}` : ""}
      </p>

      {lines.length === 0 && !isEditable ? (
        <EmptyState>Позиций нет.</EmptyState>
      ) : (
        <>
        {/* Мобильный вид: карточки позиций */}
        <div className="flex flex-col gap-2 lg:hidden">
          {rows.map((r) => (
            <div
              key={`m-${r.id}`}
              className="rounded-xl bg-white px-3.5 py-3 shadow-[0_2px_8px_rgba(20,20,60,0.06)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-[#1a1a1a]">
                    {r.done && <span className="text-green-600">✓ </span>}
                    {r.name}
                  </div>
                  <div className="mt-0.5 text-xs text-neutral-500">
                    <span className="font-mono">{r.code}</span>
                    {r.order !== "—" ? ` · заказ ${r.order}` : ""}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <div className="text-sm font-semibold tabular-nums">
                    {isPicking && !isEditable ? (
                      <span className={r.done ? "text-green-600" : "text-orange-500"}>
                        {r.qtyPicked} / {r.qtyRequested}
                      </span>
                    ) : (
                      r.qtyRequested
                    )}{" "}
                    <span className="text-xs font-normal text-neutral-500">{r.uom}</span>
                  </div>
                  {isEditable && (
                    <form action={removePickLineAction}>
                      <input type="hidden" name="lineId" value={r.id} />
                      <button
                        type="submit"
                        title="Удалить позицию"
                        className="-mr-1 p-1.5 text-neutral-400 active:text-red-500"
                      >
                        <Trash2 size={17} />
                      </button>
                    </form>
                  )}
                </div>
              </div>
              <div className="mt-1 text-xs text-neutral-500">
                Где: <span className="font-mono font-semibold text-neutral-700">{r.where}</span>
              </div>
            </div>
          ))}
          {isEditable && <PickAddRow card pickListId={pickList.id} placements={placements} />}
        </div>

        {/* Десктоп: таблица */}
        <div className="hidden overflow-x-auto rounded-xl bg-white shadow-[0_2px_8px_rgba(20,20,60,0.06)] lg:block">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-neutral-50">
              <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                <th className="px-3 py-2.5 font-medium">Товар</th>
                <th className="px-3 py-2.5 font-medium">ID</th>
                <th className="px-3 py-2.5 font-medium">Заказ</th>
                <th className="px-3 py-2.5 font-medium">Где</th>
                <th className="px-3 py-2.5 font-medium">Склад</th>
                <th className="px-3 py-2.5 font-medium">Ед.</th>
                <th className="px-3 py-2.5 text-right font-medium">Кол-во</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-neutral-100 last:border-0">
                  <td className="px-3 py-2.5 font-medium">
                    {r.done && <span className="text-green-600">✓ </span>}
                    {r.name}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs">{r.code}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-neutral-600">{r.order}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-neutral-600">{r.where}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-neutral-500">
                    {warehouse?.name ?? "—"}
                  </td>
                  <td className="px-3 py-2.5 text-neutral-500">{r.uom}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {isPicking && !isEditable ? (
                      <span className={r.done ? "text-green-600" : "text-orange-500"}>
                        {r.qtyPicked} / {r.qtyRequested}
                      </span>
                    ) : (
                      r.qtyRequested
                    )}
                  </td>
                  <td className="px-1 py-2.5 text-center">
                    {isEditable && (
                      <form action={removePickLineAction}>
                        <input type="hidden" name="lineId" value={r.id} />
                        <button
                          type="submit"
                          title="Удалить позицию"
                          className="p-1.5 text-neutral-400 hover:text-red-500"
                        >
                          <Trash2 size={16} />
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
              {isEditable && <PickAddRow pickListId={pickList.id} placements={placements} />}
            </tbody>
          </table>
        </div>
        </>
      )}

      {isEditable && !pickList.savedAt && lines.length > 0 && (
        <p className="-mt-1 text-sm text-amber-600">
          Черновик: кладовщики увидят документ и получат уведомление после «Сохранить».
        </p>
      )}

      {isEditable && placements.length === 0 && lines.length === 0 && (
        <p className="text-sm text-neutral-500">
          На складе «{warehouse?.name ?? "—"}» нет остатков для сбора.
        </p>
      )}

      {!isEditable && lines.length > 0 && status !== "ISSUED" && status !== "CANCELLED" && (
        <LinkButton href={`/warehouse/active/pick/${pickList.id}`} variant="primary">
          <ClipboardList size={18} /> Перейти к сборке (во «Активных»)
        </LinkButton>
      )}

      {(status === "NEW" || status === "CANCELLED") && (
        <DeleteDocButton
          action={deletePickListAction}
          hidden={{ pickListId: pickList.id }}
          label="Удалить заявку"
          confirmText={`Удалить заявку №${pickList.number}? Действие необратимо.`}
        />
      )}
    </div>
  );
}
