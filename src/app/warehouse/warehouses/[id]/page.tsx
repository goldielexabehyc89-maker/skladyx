import { Printer } from "lucide-react";
import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { getAllowedWarehouse } from "@/lib/warehouse-access";
import { updateWarehouseAction, createCellsAction } from "@/app/actions/warehouses";
import { ActionForm } from "@/components/action-form";
import { Card, CardTitle, Field, Badge, EmptyState, DownloadButton } from "@/components/ui";
import { PageShell } from "@/components/page-shell";
import { CellTile } from "../cell-tile";

export default async function WarehousePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminPage();
  const s = scoped(session);
  const { id } = await params;
  const warehouse = await getAllowedWarehouse(session, s.companyId, id);
  const cells = await s.cells(id);

  return (
    <div className="mx-auto w-full max-w-3xl">
    <PageShell
      title={
        <span className="flex items-center gap-2.5">
          {warehouse.name}
          {!warehouse.isActive && <Badge tone="red">неактивен</Badge>}
        </span>
      }
      action={
        cells.length > 0 ? (
          <DownloadButton href={`/warehouse/print/labels/pdf?cells=${warehouse.id}`}>
            <Printer size={18} /> QR ячеек
          </DownloadButton>
        ) : undefined
      }
    >

      <Card>
        <CardTitle>Ячейки ({cells.length})</CardTitle>
        {cells.length === 0 ? (
          <EmptyState>Ячеек нет — создайте диапазон ниже.</EmptyState>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {cells.map((c) => (
              <CellTile
                key={c.id}
                cell={{ id: c.id, code: c.code, isStaging: c.isStaging, isActive: c.isActive }}
              />
            ))}
          </div>
        )}
      </Card>

      <Card className="lg:max-w-2xl">
        <CardTitle>Добавить ячейки (диапазон)</CardTitle>
        <ActionForm action={createCellsAction} submitLabel="Создать ячейки">
          <input type="hidden" name="warehouseId" value={warehouse.id} />
          <Field label="Префикс" name="prefix" required placeholder="А-" />
          <div className="grid grid-cols-2 gap-3">
            <Field label="С номера" name="from" type="number" required inputMode="numeric" placeholder="1" />
            <Field label="По номер" name="to" type="number" required inputMode="numeric" placeholder="20" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isStaging" className="h-5 w-5" />
            Ячейки зоны выдачи (для собранных заявок)
          </label>
          <p className="text-xs text-neutral-400">
            Одна ячейка — это диапазон из одного номера, например «Б-» с 1 по 1.
          </p>
        </ActionForm>
      </Card>

      <Card className="lg:max-w-2xl">
        <CardTitle>Настройки склада</CardTitle>
        <ActionForm action={updateWarehouseAction} submitLabel="Сохранить" variant="ghost">
          <input type="hidden" name="id" value={warehouse.id} />
          <Field label="Название" name="name" required defaultValue={warehouse.name} />
          <Field label="Адрес" name="address" defaultValue={warehouse.address ?? ""} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isActive" defaultChecked={warehouse.isActive} className="h-5 w-5" />
            Склад активен
          </label>
        </ActionForm>
      </Card>
    </PageShell>
    </div>
  );
}
