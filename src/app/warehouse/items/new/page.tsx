import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { createItemAction, createUomAction } from "@/app/actions/items";
import { ActionForm } from "@/components/action-form";
import { FormPageShell } from "@/components/page-shell";
import { Card, CardTitle, ChipSelect, Field, SelectField } from "@/components/ui";

export default async function NewItemPage() {
  const session = await requireAdminPage();
  const s = scoped(session);
  const uoms = await s.uoms();

  return (
    <FormPageShell title="Новый товар">
        <Card>
          <ActionForm action={createItemAction} submitLabel="Создать товар">
            <Field label="Наименование" name="name" required placeholder="Цемент М500, 50 кг" />
            <SelectField label="Единица измерения" name="uomId" required>
              {uoms.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </SelectField>
            <fieldset className="flex flex-col gap-2">
              <span className="text-sm font-medium text-[#555]">Тип учёта</span>
              <ChipSelect
                name="tracking"
                defaultValue="LOT"
                options={[
                  {
                    value: "LOT",
                    label: "Обычный",
                    hint: "материалы — одинаковый QR на каждую штуку",
                  },
                  {
                    value: "UNIT",
                    label: "Серийный",
                    hint: "инструмент — свой QR у каждой единицы",
                  },
                ]}
              />
            </fieldset>
          </ActionForm>
        </Card>

        <Card>
          <CardTitle>Добавить единицу измерения</CardTitle>
          <ActionForm action={createUomAction} submitLabel="Добавить" variant="ghost">
            <Field label="Название" name="name" placeholder="рулон" />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="allowFraction" className="h-5 w-5" />
              Допускает дробные количества
            </label>
          </ActionForm>
        </Card>
    </FormPageShell>
  );
}
