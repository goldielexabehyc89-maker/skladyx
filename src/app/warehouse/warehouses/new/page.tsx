import { requireAdminPage } from "@/lib/auth";
import { warehouseAccess } from "@/lib/warehouse-access";
import { createWarehouseAction } from "@/app/actions/warehouses";
import { ActionForm } from "@/components/action-form";
import { FormPageShell } from "@/components/page-shell";
import { Card, Field, EmptyState } from "@/components/ui";

export default async function NewWarehousePage() {
  const session = await requireAdminPage();
  const canCreate = (await warehouseAccess(session)).all;

  return (
    <FormPageShell title="Новый склад">
      {!canCreate ? (
        <EmptyState>Создавать склады может только администратор с доступом ко всем складам.</EmptyState>
      ) : (
        <Card>
          <ActionForm action={createWarehouseAction} submitLabel="Создать склад">
            <Field label="Название" name="name" required placeholder="Основной склад" />
            <Field label="Адрес (необязательно)" name="address" placeholder="г. Москва, ул. …" />
          </ActionForm>
        </Card>
      )}
    </FormPageShell>
  );
}
