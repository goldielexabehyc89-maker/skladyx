import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { getSettings } from "@/lib/settings";
import { updateCompanySettingsAction } from "@/app/actions/settings";
import { ActionForm } from "@/components/action-form";
import { Card, CardTitle, Field, PageTitle } from "@/components/ui";

export default async function SettingsPage() {
  const session = await requireAdminPage();
  const s = scoped(session);
  const settings = await getSettings(s.companyId);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <PageTitle>Настройки</PageTitle>

      <Card className="lg:max-w-2xl">
        <CardTitle>Складские процессы</CardTitle>
        <ActionForm action={updateCompanySettingsAction} submitLabel="Сохранить настройки">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="directIssueEnabled"
              defaultChecked={settings.directIssueEnabled}
              className="mt-0.5 h-5 w-5"
            />
            <span>
              <b>Прямая выдача</b> — кладовщик сканирует товары подряд и назначает сотрудника,
              минуя заявку на сбор.
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="issueConfirmationRequired"
              defaultChecked={settings.issueConfirmationRequired}
              className="mt-0.5 h-5 w-5"
            />
            <span>
              <b>Подтверждение получения</b> — после выдачи товар числится «ждёт подтверждения»,
              пока сотрудник не подтвердит получение в телефоне (придёт push).
            </span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Этикетка: ширина, мм"
              name="labelWidthMm"
              type="number"
              inputMode="numeric"
              defaultValue={String(settings.labelWidthMm)}
            />
            <Field
              label="Этикетка: высота, мм"
              name="labelHeightMm"
              type="number"
              inputMode="numeric"
              defaultValue={String(settings.labelHeightMm)}
            />
          </div>
        </ActionForm>
      </Card>
    </div>
  );
}
