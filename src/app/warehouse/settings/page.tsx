import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { getSettings } from "@/lib/settings";
import {
  legacyWarehouseUiEnabled,
  groupReceivingEnabled,
  coolingWorkflowEnabled,
  externalOrderPickingEnabled,
  orderControlEnabled,
  orderIssueEnabled,
  integrationApiEnabled,
} from "@/lib/roles";
import { updateCompanySettingsAction, updateWarehouseRateAction } from "@/app/actions/settings";
import { getLaunchReadiness } from "@/lib/launch-readiness";
import { ActionForm } from "@/components/action-form";
import { Card, CardTitle, Field, PageTitle, Badge } from "@/components/ui";

// Пакет 9A/10: настройки запуска. Температура X и формат этикетки — всегда. При скрытом старом
// интерфейсе (LEGACY_WAREHOUSE_UI_ENABLED=false) старые настройки прямой выдачи/подтверждения не
// показываем (и не сбрасываем — action правит их только при наличии секции). Read-only блок
// «Готовность к запуску» — без кнопок включения бизнес-процессов.
export default async function SettingsPage() {
  const session = await requireAdminPage();
  const s = scoped(session);
  const companyId = s.companyId;
  const settings = await getSettings(companyId);
  const legacyUi = legacyWarehouseUiEnabled();

  // Пакет 10 (коррекция): готовность считается строго по единственному активному складу.
  const readiness = await getLaunchReadiness(companyId, settings.tempThresholdX);
  const singleWarehouse = readiness.singleWarehouse;
  const checks = readiness.checks;

  const businessFlags: { label: string; on: boolean }[] = [
    { label: "Групповая приёмка", on: groupReceivingEnabled() },
    { label: "Охлаждение", on: coolingWorkflowEnabled() },
    { label: "Сборка заказов", on: externalOrderPickingEnabled() },
    { label: "Контроль заказа", on: orderControlEnabled() },
    { label: "Размещение и выдача", on: orderIssueEnabled() },
  ];

  const apiOn = integrationApiEnabled();
  const apiTokenSet = !!(process.env.INTEGRATION_API_TOKEN && process.env.INTEGRATION_API_TOKEN.length > 0);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <PageTitle>Настройки</PageTitle>

      <Card className="lg:max-w-2xl">
        <CardTitle>Склад · температура и этикетки</CardTitle>
        <ActionForm action={updateCompanySettingsAction} submitLabel="Сохранить настройки">
          {/* — Раздел: процессы (только при видимом старом интерфейсе) — */}
          {legacyUi && (
            <>
              <input type="hidden" name="legacySettingsPresent" value="1" />
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="directIssueEnabled" defaultChecked={settings.directIssueEnabled} className="mt-0.5 h-5 w-5" />
                <span><b>Прямая выдача</b> — кладовщик сканирует товары подряд и назначает сотрудника, минуя заявку.</span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="issueConfirmationRequired" defaultChecked={settings.issueConfirmationRequired} className="mt-0.5 h-5 w-5" />
                <span><b>Подтверждение получения</b> — после выдачи товар «ждёт подтверждения», пока сотрудник не подтвердит.</span>
              </label>
            </>
          )}

          {/* — Раздел: температура — */}
          <div className={legacyUi ? "border-t border-[#eee] pt-3" : ""}>
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
              Скорость охлаждения R задаётся ниже для активного склада.
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

      {/* — Скорость охлаждения R для единственного активного склада — */}
      {singleWarehouse && (
        <Card className="lg:max-w-2xl">
          <CardTitle>Скорость охлаждения R · {singleWarehouse.name}</CardTitle>
          <ActionForm action={updateWarehouseRateAction} submitLabel="Сохранить R" variant="ghost">
            <input type="hidden" name="id" value={singleWarehouse.id} />
            <Field
              label="R, °C/час (пусто — не задана)"
              name="coolingRate"
              type="number"
              inputMode="decimal"
              step="0.1"
              defaultValue={singleWarehouse.coolingRate == null ? "" : String(singleWarehouse.coolingRate)}
            />
            <p className="mt-1 text-xs text-neutral-400">
              Per-warehouse. Нужна для охлаждения (расчёт срока готовности). При заполнении строго больше 0.
            </p>
          </ActionForm>
        </Card>
      )}

      {/* — Read-only: Готовность к запуску — */}
      <Card className="lg:max-w-2xl">
        <CardTitle>Готовность к запуску</CardTitle>
        <div className="flex flex-col gap-1.5">
          {checks.map((c) => (
            <div key={c.label} className="flex items-center justify-between gap-3 rounded-lg bg-[#f7f8fc] px-3 py-2 text-sm">
              <span className="min-w-0">
                {c.label}
                <span className="ml-1.5 text-xs text-neutral-400">{c.detail}</span>
              </span>
              <Badge tone={c.ok ? "green" : "red"}>{c.ok ? "готово" : "нет"}</Badge>
            </div>
          ))}
        </div>

        <div className="mt-4 border-t border-[#eee] pt-3">
          <div className="mb-1.5 text-sm font-semibold">Интеграция (нейтральный API)</div>
          <div className="flex flex-col gap-1.5 text-sm">
            <div className="flex items-center justify-between gap-3 rounded-lg bg-[#f7f8fc] px-3 py-2">
              <span>REST-API интеграции</span>
              <Badge tone={apiOn ? "green" : "neutral"}>{apiOn ? "включён" : "выключен"}</Badge>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg bg-[#f7f8fc] px-3 py-2">
              <span>Токен интеграции</span>
              <Badge tone={apiTokenSet ? "green" : "neutral"}>{apiTokenSet ? "задан" : "не задан"}</Badge>
            </div>
          </div>
          <p className="mt-1 text-xs text-neutral-400">
            Организация определяется по адресу (host). Формат конкретной 1С не зашит — адаптер будет тонким преобразователем контракта.
          </p>
        </div>

        <div className="mt-4 border-t border-[#eee] pt-3">
          <div className="mb-1.5 text-sm font-semibold">Бизнес-процессы</div>
          <div className="flex flex-col gap-1.5 text-sm">
            {businessFlags.map((f) => (
              <div key={f.label} className="flex items-center justify-between gap-3 rounded-lg bg-[#f7f8fc] px-3 py-2">
                <span className="min-w-0 truncate">{f.label}</span>
                <Badge tone={f.on ? "green" : "neutral"}>{f.on ? "включён" : "выключен"}</Badge>
              </div>
            ))}
          </div>
          <p className="mt-1 text-xs text-neutral-400">
            Только просмотр. Набор процессов настраивается на сервере, не из интерфейса.
          </p>
        </div>
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
