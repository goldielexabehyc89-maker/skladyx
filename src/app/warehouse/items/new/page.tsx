import { requireAdminPage } from "@/lib/auth";
import { FormPageShell } from "@/components/page-shell";
import { Card } from "@/components/ui";
import { ItemCreateForm } from "../item-create-form";

// Пакет 9B/10: ручное создание товара по заводскому EAN (единица «шт» и tracking LOT назначаются
// автоматически). Форма управляемая — при ошибке введённые поля сохраняются; при успехе сервер
// делает redirect на /warehouse/items.
export default async function NewItemPage() {
  await requireAdminPage();

  return (
    <FormPageShell title="Новый товар">
      <Card>
        <ItemCreateForm />
      </Card>
    </FormPageShell>
  );
}
