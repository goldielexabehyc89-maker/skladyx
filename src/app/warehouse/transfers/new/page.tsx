import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { allowedWarehouses } from "@/lib/warehouse-access";
import { Card, EmptyState } from "@/components/ui";
import { FormPageShell } from "@/components/page-shell";
import { TransferCreateForm } from "../create-form";

export default async function NewTransferPage() {
  const session = await requireAdminPage();
  const s = scoped(session);
  const warehouses = await allowedWarehouses(session, s.companyId, { activeOnly: true });

  return (
    <FormPageShell title="Новое перемещение">
      {warehouses.length < 2 ? (
        <EmptyState>
          Для перемещений нужно минимум два склада —{" "}
          <Link href="/warehouse/warehouses" className="text-brand underline">
            склады и ячейки
          </Link>
          .
        </EmptyState>
      ) : (
        <Card>
          <TransferCreateForm warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))} />
        </Card>
      )}
    </FormPageShell>
  );
}
