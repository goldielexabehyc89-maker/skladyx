import { requireAdminPage } from "@/lib/auth";
import { createSupplierAction } from "@/app/actions/suppliers";
import { ActionForm } from "@/components/action-form";
import { FormPageShell } from "@/components/page-shell";
import { Card, Field } from "@/components/ui";

export default async function NewSupplierPage() {
  await requireAdminPage();
  return (
    <FormPageShell title="Новый поставщик">
      <Card>
        <ActionForm action={createSupplierAction} submitLabel="Добавить поставщика">
          <Field label="Название" name="name" required placeholder="ООО «СтройБаза»" />
          <Field label="Телефон (необязательно)" name="phone" />
          <Field label="Заметка (необязательно)" name="note" />
        </ActionForm>
      </Card>
    </FormPageShell>
  );
}
