import { requireAdminPage } from "@/lib/auth";
import { createItemAction } from "@/app/actions/items";
import { ActionForm } from "@/components/action-form";
import { FormPageShell } from "@/components/page-shell";
import { Card, Field } from "@/components/ui";

// Пакет 9B: ручное создание товара для тестового наполнения (до подключения интеграции РостАгро).
// Товар определяется заводским EAN; единица «шт» и tracking LOT назначаются автоматически на сервере,
// выбор единицы измерения и UNIT/LOT пользователю не показывается.
export default async function NewItemPage() {
  await requireAdminPage();

  return (
    <FormPageShell title="Новый товар">
      <Card>
        <ActionForm action={createItemAction} submitLabel="Создать товар">
          <Field label="Наименование" name="name" required placeholder="напр. Сырок глазированный 40 г" />
          <Field
            label="Заводской EAN (8 или 13 цифр)"
            name="ean"
            required
            inputMode="numeric"
            placeholder="напр. 4607750000010"
          />
          <Field label="SKU / внешний код (необязательно)" name="sku" placeholder="необязательно" />
          <p className="text-xs text-neutral-400">
            Единица измерения «шт» и партионный учёт назначаются автоматически. EAN — главный
            идентификатор товара; контрольная цифра проверяется при сохранении.
          </p>
        </ActionForm>
      </Card>
    </FormPageShell>
  );
}
