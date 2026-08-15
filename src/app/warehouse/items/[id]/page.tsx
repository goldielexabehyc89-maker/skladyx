import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { updateItemAction, deleteItemAction } from "@/app/actions/items";
import { DeleteDocButton } from "@/components/delete-doc-button";
import { ActionForm } from "@/components/action-form";
import { Card, CardTitle, Field, Badge } from "@/components/ui";
import { PageShell } from "@/components/page-shell";
import { ItemBarcodes } from "../item-barcodes";
import { parseEan } from "@/lib/ean";
import { eanBarcodeSvg, eanFileName } from "@/lib/ean-barcode";

// Пакет 9B: карточка EAN-центрична — название, EAN, источник, внешний идентификатор, статус.
// Товар source=API полностью read-only (правка/удаление/перепривязка EAN недоступны — блокируется
// и на сервере). Ручной товар редактируется для тестового наполнения (название + статус); единица
// измерения и tracking скрыты (назначены автоматически при создании).
export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminPage();
  const s = scoped(session);
  const { id } = await params;
  const item = await s.item(id);
  const barcodes = await prisma.itemBarcode.findMany({
    where: { itemId: item.id, companyId: s.companyId },
    orderBy: { createdAt: "asc" },
  });
  const apiItem = item.source === "API";
  const activeEans = barcodes.filter((b) => b.isActive).map((b) => b.code);
  const eanText = activeEans.length ? activeEans.join(", ") : "нет EAN";

  // ITEM-EAN-001: сканируемые SVG-штрихкоды генерируем на сервере (read-only, без записей) ТОЛЬКО для
  // активного EAN активного товара. Архивный товар / неактивный EAN этикетки не получают.
  const svgByCode: Record<string, string> = {};
  const fileNameByCode: Record<string, string> = {};
  if (item.isActive) {
    for (const b of barcodes) {
      if (!b.isActive || !parseEan(b.code)) continue;
      try {
        svgByCode[b.code] = eanBarcodeSvg(b.code);
        fileNameByCode[b.code] = eanFileName(item.name, b.code);
      } catch {
        /* повреждённый EAN не рендерим как этикетку */
      }
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl">
      <PageShell
        title={
          <span className="flex items-center gap-2.5">
            {item.name}
            <Badge tone={apiItem ? "blue" : "neutral"}>{apiItem ? "из интеграции" : "ручной"}</Badge>
          </span>
        }
      >
        <Card className="lg:max-w-2xl">
          <CardTitle>Карточка товара</CardTitle>
          {apiItem ? (
            // Товар из интеграции — всё только для чтения.
            <div className="flex flex-col gap-2 text-sm">
              <div><span className="text-neutral-500">Наименование:</span> <b>{item.name}</b></div>
              <div><span className="text-neutral-500">EAN:</span> <span className="font-mono">{eanText}</span></div>
              <div><span className="text-neutral-500">Источник:</span> API (интеграция)</div>
              <div><span className="text-neutral-500">Внешний идентификатор:</span> {item.externalId ?? "—"}</div>
              <div><span className="text-neutral-500">Статус:</span> {item.isActive ? "активен" : "архив"}</div>
              <p className="mt-1 text-xs text-neutral-400">Товар из интеграции — только для чтения. Редактирование, удаление и перепривязка EAN недоступны (отсутствие в API-синхронизации не удаляет и не деактивирует товар).</p>
            </div>
          ) : (
            <ActionForm action={updateItemAction} submitLabel="Сохранить" variant="ghost">
              <input type="hidden" name="id" value={item.id} />
              <Field label="Наименование" name="name" required defaultValue={item.name} />
              <div className="flex flex-col gap-1 text-sm">
                <div><span className="text-neutral-500">EAN:</span> <span className="font-mono">{eanText}</span> <span className="text-xs text-neutral-400">(управление ниже)</span></div>
                <div><span className="text-neutral-500">Источник:</span> ручной</div>
                {item.externalId && <div><span className="text-neutral-500">Внешний идентификатор:</span> {item.externalId}</div>}
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="isActive" defaultChecked={item.isActive} className="h-5 w-5" />
                Товар активен
              </label>
            </ActionForm>
          )}
        </Card>

        <Card className="lg:max-w-2xl">
          <CardTitle>Штрихкоды EAN</CardTitle>
          <ItemBarcodes
            itemId={item.id}
            readOnly={apiItem}
            barcodes={barcodes.map((b) => ({ id: b.id, code: b.code, symbology: b.symbology, isActive: b.isActive, source: b.source }))}
            svgByCode={svgByCode}
            fileNameByCode={fileNameByCode}
          />
        </Card>

        {!apiItem && (
          <DeleteDocButton
            action={deleteItemAction}
            hidden={{ id: item.id }}
            label="Удалить товар"
            confirmText={`Удалить товар «${item.name}»? Действие необратимо.`}
          />
        )}
      </PageShell>
    </div>
  );
}
