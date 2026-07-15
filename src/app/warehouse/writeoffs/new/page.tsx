import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { allowedWarehouses } from "@/lib/warehouse-access";
import { createWriteOffAction } from "@/app/actions/writeoffs";
import { ActionForm } from "@/components/action-form";
import { FormPageShell } from "@/components/page-shell";
import { Card, Field, SelectField } from "@/components/ui";

export default async function NewWriteOffPage() {
  const session = await requireAdminPage();
  const s = scoped(session);
  const [warehouses, users] = await Promise.all([
    allowedWarehouses(session, s.companyId, { activeOnly: true }),
    s.users(),
  ]);
  const employees = users.filter((u) => u.isActive);

  return (
    <FormPageShell title="Новое списание">
      <Card>
        <ActionForm action={createWriteOffAction} submitLabel="Создать списание">
          <SelectField label="Откуда списываем" name="scope" required>
            <optgroup label="Склады">
              {warehouses.map((w) => (
                <option key={w.id} value={`W:${w.id}`}>
                  {w.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="С сотрудника">
              {employees.map((u) => (
                <option key={u.id} value={`E:${u.id}`}>
                  {u.name}
                </option>
              ))}
            </optgroup>
          </SelectField>
          <Field label="Причина списания" name="reason" required placeholder="Бой при разгрузке" />
        </ActionForm>
      </Card>
    </FormPageShell>
  );
}
