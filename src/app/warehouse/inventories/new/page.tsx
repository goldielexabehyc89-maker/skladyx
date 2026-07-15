import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { allowedWarehouses } from "@/lib/warehouse-access";
import { startInventoryAction } from "@/app/actions/inventory";
import { ActionForm } from "@/components/action-form";
import { FormPageShell } from "@/components/page-shell";
import { Card, ChipSelect, EmptyState } from "@/components/ui";

export default async function NewInventoryPage() {
  const session = await requireAdminPage();
  const s = scoped(session);
  const warehouses = await allowedWarehouses(session, s.companyId, { activeOnly: true });

  return (
    <FormPageShell title="Новая инвентаризация">
      {warehouses.length === 0 ? (
        <EmptyState>
          Сначала{" "}
          <Link href="/warehouse/warehouses" className="text-brand underline">
            создайте склад
          </Link>
          .
        </EmptyState>
      ) : (
        <Card>
          <ActionForm action={startInventoryAction} submitLabel="Начать инвентаризацию">
            <fieldset className="flex flex-col gap-2">
              <span className="text-sm font-medium text-[#555]">Склад</span>
              <ChipSelect
                name="warehouseId"
                required
                options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
              />
            </fieldset>
            <p className="text-xs text-neutral-400">
              Остатки склада будут зафиксированы, дальше — подсчёт сканами по ячейкам.
            </p>
          </ActionForm>
        </Card>
      )}
    </FormPageShell>
  );
}
