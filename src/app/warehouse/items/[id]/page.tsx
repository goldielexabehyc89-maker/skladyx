import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { updateItemAction, deleteItemAction } from "@/app/actions/items";
import { DeleteDocButton } from "@/components/delete-doc-button";
import { ActionForm } from "@/components/action-form";
import { Card, CardTitle, ChipSelect, Field, Badge, SelectField } from "@/components/ui";
import { PageShell } from "@/components/page-shell";
import { ItemBarcodes } from "../item-barcodes";

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminPage();
  const s = scoped(session);
  const { id } = await params;
  const item = await s.item(id);
  const uoms = await s.uoms();
  const barcodes = await prisma.itemBarcode.findMany({
    where: { itemId: item.id, companyId: s.companyId },
    orderBy: { createdAt: "asc" },
  });
  const apiItem = item.source === "API";

  return (
    <div className="mx-auto w-full max-w-2xl">
      <PageShell
        title={
          <span className="flex items-center gap-2.5">
            {item.name}
            <Badge tone={item.tracking === "UNIT" ? "blue" : "neutral"}>
              {item.tracking === "UNIT" ? "серийный" : "обычный"}
            </Badge>
          </span>
        }
      >

      <Card className="lg:max-w-2xl">
        <CardTitle>Карточка товара</CardTitle>
        <ActionForm action={updateItemAction} submitLabel="Сохранить" variant="ghost">
          <input type="hidden" name="id" value={item.id} />
          <Field label="Наименование" name="name" required defaultValue={item.name} />
          <SelectField label="Единица измерения" name="uomId" defaultValue={item.uomId}>
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
              defaultValue={item.tracking}
              options={[
                { value: "LOT", label: "Обычный" },
                { value: "UNIT", label: "Серийный" },
              ]}
            />
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isActive" defaultChecked={item.isActive} className="h-5 w-5" />
            Товар активен
          </label>
        </ActionForm>
        {apiItem && <p className="mt-2 text-xs text-neutral-400">Товар из интеграции — ключевые поля только для чтения (сервер отклонит изменения).</p>}
      </Card>

      <Card className="lg:max-w-2xl">
        <CardTitle>Штрихкоды EAN</CardTitle>
        <ItemBarcodes
          itemId={item.id}
          readOnly={apiItem}
          barcodes={barcodes.map((b) => ({ id: b.id, code: b.code, symbology: b.symbology, isActive: b.isActive, source: b.source }))}
        />
      </Card>

      <DeleteDocButton
        action={deleteItemAction}
        hidden={{ id: item.id }}
        label="Удалить товар"
        confirmText={`Удалить товар «${item.name}»? Действие необратимо.`}
      />
      </PageShell>
    </div>
  );
}
