import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { allowedWarehouses } from "@/lib/warehouse-access";
import { FormPageShell } from "@/components/page-shell";
import { Card } from "@/components/ui";
import { NewUserForm } from "../user-forms";

export default async function NewEmployeePage() {
  const session = await requireAdminPage();
  const s = scoped(session);
  const warehouses = await allowedWarehouses(session, s.companyId);

  return (
    <FormPageShell title="Новый сотрудник">
      <Card>
        <NewUserForm warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))} />
      </Card>
    </FormPageShell>
  );
}
