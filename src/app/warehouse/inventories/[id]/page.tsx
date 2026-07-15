import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { getAllowedWarehouse } from "@/lib/warehouse-access";
import { prisma } from "@/lib/db";
import {
  scanInventoryAction,
  setCountedQtyAction,
  submitReviewAction,
  backToCountingAction,
  cancelInventoryAction,
  postInventoryAction,
  deleteInventoryAction,
} from "@/app/actions/inventory";
import { ActionForm } from "@/components/action-form";
import { DeleteDocButton } from "@/components/delete-doc-button";
import { ScanCollect } from "@/components/scan-collect";
import { Card, CardTitle, PageTitle, Badge, EmptyState } from "@/components/ui";
import { fmtDateTime, fmtQty } from "@/lib/format";
import { Prisma } from "@prisma/client";
import { clsx } from "clsx";

export default async function InventoryPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminPage();
  const s = scoped(session);
  const { id } = await params;
  const inv = await s.inventory(id);
  const warehouse = await getAllowedWarehouse(session, s.companyId, inv.warehouseId);
  const [items, cells, units] = await Promise.all([
    prisma.item.findMany({
      where: { id: { in: [...new Set(inv.lines.map((l) => l.itemId))] } },
      include: { uom: true },
    }),
    prisma.cell.findMany({ where: { companyId: s.companyId, warehouseId: inv.warehouseId } }),
    prisma.itemUnit.findMany({
      where: { id: { in: inv.lines.map((l) => l.unitId).filter((x): x is string => !!x) } },
    }),
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const cellById = new Map(cells.map((c) => [c.id, c]));
  const unitById = new Map(units.map((u) => [u.id, u]));

  const zero = new Prisma.Decimal(0);
  const discrepancies = inv.lines.filter((l) => !(l.countedQty ?? zero).eq(l.expectedQty));
  const isCounting = inv.status === "IN_PROGRESS";
  const isReview = inv.status === "REVIEW";

  const STATUS_RU: Record<string, string> = {
    IN_PROGRESS: "подсчёт",
    REVIEW: "акт расхождений",
    POSTED: "проведена",
    CANCELLED: "отменена",
  };

  // группировка строк по ячейкам
  const byCell = new Map<string, typeof inv.lines>();
  for (const l of inv.lines) {
    const key = l.cellId ?? "";
    byCell.set(key, [...(byCell.get(key) ?? []), l]);
  }

  const linesToShow = isCounting ? [...byCell.entries()] : null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <PageTitle
        action={
          <Badge tone={inv.status === "POSTED" ? "green" : inv.status === "CANCELLED" ? "red" : "orange"}>
            {STATUS_RU[inv.status]}
          </Badge>
        }
      >
        Инвентаризация №{inv.number}
      </PageTitle>
      <p className="-mt-3 text-sm text-neutral-500">
        {warehouse.name} · {fmtDateTime(inv.createdAt)}
      </p>

      {isCounting && (
        <>
          <ScanCollect
            action={scanInventoryAction.bind(null, inv.id)}
            buttonLabel="Сканировать (ячейка / товар)"
            title={`Инвентаризация: ${warehouse.name}`}
          />
          <p className="text-sm text-neutral-500">
            Сканируйте QR ячейки — появится её ожидаемое содержимое. Сканируйте QR единиц —
            они отмечаются найденными. Для партий введите насчитанное количество вручную.
          </p>
        </>
      )}

      {isCounting && linesToShow && linesToShow.length > 0 && (
        <div className="flex flex-col gap-3">
          {linesToShow.map(([cellKey, lines]) => (
            <Card key={cellKey || "none"}>
              <CardTitle>
                {cellKey ? `Ячейка ${cellById.get(cellKey)?.code ?? ""}` : "Без ячейки / излишки"}
              </CardTitle>
              <div className="flex flex-col divide-y divide-neutral-100">
                {lines.map((l) => {
                  const item = itemById.get(l.itemId);
                  const unit = l.unitId ? unitById.get(l.unitId) : null;
                  const counted = l.countedQty;
                  return (
                    <div key={l.id} className="flex items-center justify-between gap-2 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">
                          {item?.name ?? "—"}
                          {unit ? ` · ед. №${unit.serial}` : ""}
                        </div>
                        <div className="text-xs text-neutral-500">
                          ожидается {fmtQty(l.expectedQty)} {item?.uom.name ?? ""}
                          {counted !== null && (
                            <span
                              className={clsx(
                                "ml-1 font-semibold",
                                counted.eq(l.expectedQty) ? "text-green-600" : "text-red-600",
                              )}
                            >
                              · насчитано {fmtQty(counted)}
                            </span>
                          )}
                        </div>
                      </div>
                      <ActionForm
                        action={setCountedQtyAction}
                        submitLabel="OK"
                        variant="ghost"
                        className="flex items-center gap-1.5"
                      >
                        <input type="hidden" name="lineId" value={l.id} />
                        <input
                          name="counted"
                          type="number"
                          step="0.001"
                          inputMode="decimal"
                          defaultValue={counted !== null ? counted.toString() : l.expectedQty.toString()}
                          className="w-24 rounded-lg border border-[#e4e4f0] px-2 py-1 text-sm"
                        />
                      </ActionForm>
                    </div>
                  );
                })}
              </div>
            </Card>
          ))}
        </div>
      )}

      {isCounting && inv.lines.length === 0 && (
        <EmptyState>Пока пусто — начните со сканирования первой ячейки.</EmptyState>
      )}

      {isCounting && (
        <ActionForm action={submitReviewAction} submitLabel="Завершить подсчёт → акт расхождений">
          <input type="hidden" name="inventoryId" value={inv.id} />
          <p className="text-sm text-neutral-500">
            Непроверенные места склада добавятся в акт автоматически (ненайденное = недостача).
          </p>
        </ActionForm>
      )}

      {(isReview || inv.status === "POSTED") && (
        <Card>
          <CardTitle>
            Акт расхождений ({discrepancies.length} из {inv.lines.length} строк)
          </CardTitle>
          {discrepancies.length === 0 ? (
            <p className="text-sm text-green-700">Расхождений нет — учёт сходится с фактом. ✓</p>
          ) : (
            <div className="flex flex-col divide-y divide-neutral-100">
              {discrepancies.map((l) => {
                const item = itemById.get(l.itemId);
                const unit = l.unitId ? unitById.get(l.unitId) : null;
                const counted = l.countedQty ?? zero;
                const diff = counted.sub(l.expectedQty);
                return (
                  <div key={l.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">
                      {item?.name ?? "—"}
                      {unit ? ` · ед. №${unit.serial}` : ""}
                      {l.cellId ? ` · ${cellById.get(l.cellId)?.code ?? ""}` : ""}
                    </span>
                    <span className={diff.gt(0) ? "font-semibold text-blue-600" : "font-semibold text-red-600"}>
                      {diff.gt(0) ? "+" : ""}
                      {fmtQty(diff)} {item?.uom.name ?? ""}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {isReview && (
        <>
          <ActionForm action={postInventoryAction} submitLabel="Провести корректировки" variant="danger">
            <input type="hidden" name="inventoryId" value={inv.id} />
            <p className="text-sm text-neutral-500">
              Остатки будут приведены к факту: излишки оприходуются, недостачи спишутся.
            </p>
          </ActionForm>
          <form action={backToCountingAction} className="text-center">
            <input type="hidden" name="inventoryId" value={inv.id} />
            <button type="submit" className="text-sm text-neutral-500 underline-offset-2 active:underline">
              ← Вернуться к подсчёту
            </button>
          </form>
        </>
      )}

      {(isCounting || isReview) && (
        <form action={cancelInventoryAction} className="text-center">
          <input type="hidden" name="inventoryId" value={inv.id} />
          <button type="submit" className="text-sm text-red-500 underline-offset-2 active:underline">
            Отменить инвентаризацию
          </button>
        </form>
      )}

      {inv.status !== "POSTED" && (
        <DeleteDocButton
          action={deleteInventoryAction}
          hidden={{ inventoryId: inv.id }}
          label="Удалить инвентаризацию"
          confirmText={`Удалить инвентаризацию №${inv.number}?`}
        />
      )}
    </div>
  );
}
