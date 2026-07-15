import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { allowedWarehouses } from "@/lib/warehouse-access";
import { prisma } from "@/lib/db";
import { Card, EmptyState } from "@/components/ui";
import { FormPageShell } from "@/components/page-shell";
import { PickListCreateForm } from "../create-form";

export default async function NewPickListPage() {
  const session = await requireAdminPage();
  const s = scoped(session);
  const warehouses = await allowedWarehouses(session, s.companyId, { activeOnly: true });
  const employeesRaw = await prisma.user.findMany({
    where: { companyId: s.companyId, isActive: true },
    include: { warehouseLinks: { select: { warehouseId: true } } },
    orderBy: { name: "asc" },
  });
  const employees = employeesRaw.map((u) => ({
    id: u.id,
    name: u.name,
    allWarehouses: u.allWarehouses,
    warehouseIds: u.warehouseLinks.map((l) => l.warehouseId),
  }));

  return (
    <FormPageShell title="Новая заявка на сбор">
      {warehouses.length === 0 ? (
        <EmptyState>
          Сначала <Link href="/warehouse/warehouses" className="text-brand underline">создайте склад</Link>.
        </EmptyState>
      ) : (
        <Card>
          <PickListCreateForm
            warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
            employees={employees}
          />
        </Card>
      )}
    </FormPageShell>
  );
}
