import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { getSettings } from "@/lib/settings";
import { updateCompanySettingsAction } from "@/app/actions/settings";
import { ActionForm } from "@/components/action-form";
import { Card, CardTitle, Field, PageTitle } from "@/components/ui";

// Пакет 9A: настройки склада — понятные разделы. Температура X и формат этикетки настраиваются ВСЕГДА
// (независимо от бизнес-флагов). Ячейки/зоны — на странице склада; EAN — в карточке номенклатуры.
export default async function SettingsPage() {
  const session = await requireAdminPage();
  const s = scoped(session);
  const settings = await getSettings(s.companyId);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <PageTitle>Настройки</PageTitle>

      <Card className="lg:max-w-2xl">
        <CardTitle>Склад · процессы, температура, этикетки</CardTitle>
        <ActionForm action={updateCompanySettingsAction} submitLabel="Сохранить настройки">
          {/* — Раздел: процессы — */}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="directIssueEnabled" defaultChecked={settings.directIssueEnabled} className="mt-0.5 h-5 w-5" />
            <span><b>Прямая выдача</b> — кладовщик сканирует товары подряд и назначает сотрудника, минуя заявку.</span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="issueConfirmationRequired" defaultChecked={settings.issueConfirmationRequired} className="mt-0.5 h-5 w-5" />
            <span><b>Подтверждение получения</b> — после выдачи товар «ждёт подтверждения», пока сотрудник не подтвердит.</span>
          </label>

          {/* — Раздел: температура — */}
          <div className="border-t border-[#eee] pt-3">
            <div className="mb-1 text-sm font-semibold">Температура</div>
            <Field
              label="Порог температуры X, °C"
              name="tempThresholdX"
              type="number"
              inputMode="decimal"
              step="0.1"
              defaultValue={settings.tempThresholdX === null ? "" : String(settings.tempThresholdX)}
            />
            <p className="mt-1 text-xs text-neutral-400">
              Настройка организации. Пусто — групповая приёмка не активируется. При приёмке: ≤ X → хранение, выше X → охлаждение.
              Скорость охлаждения R задаётся отдельно на странице каждого склада.
            </p>
          </div>

          {/* — Раздел: этикетки — */}
          <div className="border-t border-[#eee] pt-3">
            <div className="mb-1 text-sm font-semibold">Этикетки ячеек</div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Ширина, мм" name="labelWidthMm" type="number" inputMode="numeric" defaultValue={String(settings.labelWidthMm)} />
              <Field label="Высота, мм" name="labelHeightMm" type="number" inputMode="numeric" defaultValue={String(settings.labelHeightMm)} />
            </div>
            <label className="mt-2 flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-neutral-500">Формат кода на этикетке ячейки</span>
              <select name="cellLabelFormat" defaultValue={settings.cellLabelFormat} className="rounded-lg border border-[#e4e4f0] px-3 py-2 text-sm">
                <option value="QR">Только QR</option>
                <option value="CODE128">Только Code 128</option>
                <option value="BOTH">QR + Code 128</option>
              </select>
            </label>
            <p className="mt-1 text-xs text-neutral-400">
              QR и Code 128 кодируют один и тот же внутренний код ячейки. База и складская логика от формата не зависят.
            </p>
          </div>
        </ActionForm>
      </Card>

      <Card className="lg:max-w-2xl">
        <CardTitle>Ячейки и зоны</CardTitle>
        <p className="text-sm text-neutral-500">
          Семь системных зон фиксированы. Ячейки (ручное и массовое создание, уровни хранения, печать этикеток) — на странице склада.
        </p>
        <Link href="/warehouse/warehouses" className="mt-2 inline-block text-sm text-brand underline-offset-2 hover:underline">
          → Склады и ячейки
        </Link>
      </Card>

      <Card className="lg:max-w-2xl">
        <CardTitle>Номенклатура и EAN</CardTitle>
        <p className="text-sm text-neutral-500">
          Товары и их штрихкоды EAN-8/EAN-13 (несколько на товар, деактивация) — в карточке товара.
        </p>
        <Link href="/warehouse/items" className="mt-2 inline-block text-sm text-brand underline-offset-2 hover:underline">
          → Номенклатура
        </Link>
      </Card>
    </div>
  );
}
