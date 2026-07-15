import { Trash2 } from "lucide-react";
import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { getAllowedWarehouse } from "@/lib/warehouse-access";
import { prisma } from "@/lib/db";
import {
  addWriteOffLineByScanAction,
  setWriteOffLineQtyAction,
  removeWriteOffLineAction,
  postWriteOffAction,
  deleteWriteOffAction,
} from "@/app/actions/writeoffs";
import { ActionForm } from "@/components/action-form";
import { DeleteDocButton } from "@/components/delete-doc-button";
import { ScanCollect } from "@/components/scan-collect";
import { Card, CardTitle, PageTitle, Badge, EmptyState } from "@/components/ui";
import { fmtDateTime, fmtQty, fmtRub } from "@/lib/format";

export default async function WriteOffPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminPage();
  const s = scoped(session);
  const { id } = await params;
  const writeOff = await s.writeOff(id);
  const [items, units, lots] = await Promise.all([
    prisma.item.findMany({
      where: { id: { in: writeOff.lines.map((l) => l.itemId) } },
      include: { uom: true },
    }),
    prisma.itemUnit.findMany({
      where: { id: { in: writeOff.lines.map((l) => l.unitId).filter((x): x is string => !!x) } },
    }),
    prisma.lot.findMany({
      where: { id: { in: writeOff.lines.map((l) => l.lotId).filter((x): x is string => !!x) } },
    }),
  ]);
  const scopeName = writeOff.warehouseId
    ? (await getAllowedWarehouse(session, s.companyId, writeOff.warehouseId)).name
    : `с сотрудника: ${(await s.user(writeOff.employeeId!)).name}`;
  const itemById = new Map(items.map((i) => [i.id, i]));
  const unitById = new Map(units.map((u) => [u.id, u]));
  const lotById = new Map(lots.map((l) => [l.id, l]));
  const isDraft = writeOff.status === "DRAFT";

  const total = writeOff.lines.reduce((sum, l) => {
    const price = l.unitId
      ? unitById.get(l.unitId)?.price
      : l.lotId
        ? lotById.get(l.lotId)?.price
        : null;
    return sum + (price ? price.toNumber() * l.qty.toNumber() : 0);
  }, 0);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <PageTitle
        action={
          <Badge tone={isDraft ? "orange" : "green"}>{isDraft ? "черновик" : "проведено"}</Badge>
        }
      >
        Списание №{writeOff.number}
      </PageTitle>
      <p className="-mt-3 text-sm text-neutral-500">
        {scopeName} · {fmtDateTime(writeOff.createdAt)} · Причина: {writeOff.reason}
      </p>

      <Card>
        <CardTitle>Позиции ({writeOff.lines.length})</CardTitle>
        {writeOff.lines.length === 0 ? (
          <EmptyState>Сканируйте партии и единицы для списания.</EmptyState>
        ) : (
          <div className="flex flex-col divide-y divide-neutral-100">
            {writeOff.lines.map((l) => {
              const item = itemById.get(l.itemId);
              const unit = l.unitId ? unitById.get(l.unitId) : null;
              return (
                <div key={l.id} className="flex items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">
                      {item?.name ?? "—"}
                      {unit ? ` · ед. №${unit.serial}` : ""}
                    </div>
                    {isDraft && l.lotId ? (
                      <ActionForm
                        action={setWriteOffLineQtyAction}
                        submitLabel="OK"
                        variant="ghost"
                        className="mt-1 flex items-center gap-2"
                      >
                        <input type="hidden" name="lineId" value={l.id} />
                        <input
                          name="qty"
                          type="text"
                          inputMode="decimal"
                          defaultValue={l.qty.toString()}
                          className="w-28 rounded-lg border border-[#e4e4f0] px-2 py-1 text-sm"
                        />
                        <span className="text-sm text-neutral-500">{item?.uom.name}</span>
                      </ActionForm>
                    ) : (
                      <div className="text-sm text-neutral-500">
                        {fmtQty(l.qty)} {item?.uom.name ?? ""}
                      </div>
                    )}
                  </div>
                  {isDraft && (
                    <form action={removeWriteOffLineAction}>
                      <input type="hidden" name="lineId" value={l.id} />
                      <button
                        type="submit"
                        title="Удалить позицию"
                        className="p-2 text-neutral-400 active:text-red-500"
                      >
                        <Trash2 size={16} />
                      </button>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {total > 0 && (
          <p className="mt-2 text-right text-sm font-semibold">Сумма списания: {fmtRub(total)}</p>
        )}
      </Card>

      {isDraft && (
        <>
          <ScanCollect
            action={addWriteOffLineByScanAction.bind(null, writeOff.id)}
            buttonLabel="Сканировать позиции"
            title={`Списание №${writeOff.number}: сканируйте товары`}
          />
          <ActionForm action={postWriteOffAction} submitLabel="Провести списание" variant="danger">
            <input type="hidden" name="writeOffId" value={writeOff.id} />
            <p className="text-sm text-neutral-500">
              Списанный товар исчезает с остатков. Операция необратима (исправление — новой
              приемкой или инвентаризацией).
            </p>
          </ActionForm>
          <DeleteDocButton
            action={deleteWriteOffAction}
            hidden={{ writeOffId: writeOff.id }}
            label="Удалить списание"
            confirmText={`Удалить черновик списания №${writeOff.number}?`}
          />
        </>
      )}
    </div>
  );
}
