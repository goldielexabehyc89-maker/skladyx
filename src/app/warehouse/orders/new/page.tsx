import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { allowedWarehouses } from "@/lib/warehouse-access";
import { prisma } from "@/lib/db";
import { createSupplierOrderAction } from "@/app/actions/supplier-orders";
import { createSupplierInlineAction } from "@/app/actions/suppliers";
import { ActionForm } from "@/components/action-form";
import { AutocompleteField } from "@/components/autocomplete-field";
import { Card, Field, EmptyState } from "@/components/ui";
import { FormPageShell } from "@/components/page-shell";

export default async function NewSupplierOrderPage() {
  const session = await requireAdminPage();
  const s = scoped(session);
  const [suppliers, warehouses] = await Promise.all([
    prisma.supplier.findMany({
      where: { companyId: s.companyId, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    await allowedWarehouses(session, s.companyId).then((ws) => ws.filter((w) => w.isActive)),
  ]);

  return (
    <FormPageShell title="Новый заказ поставщику">
      {warehouses.length === 0 ? (
        <EmptyState>
          Сначала <Link href="/warehouse/warehouses" className="text-brand underline">создайте склад</Link>.
        </EmptyState>
      ) : (
        <Card>
          <ActionForm action={createSupplierOrderAction} submitLabel="Создать заказ">
            <AutocompleteField
              label="Поставщик"
              name="supplierId"
              options={suppliers}
              placeholder="Начните вводить название…"
              createAction={createSupplierInlineAction}
              createLabel="Создать поставщика"
            />
            <AutocompleteField
              label="Склад"
              name="warehouseId"
              options={warehouses.map((w) => ({ id: w.id, name: w.name }))}
              placeholder="Начните вводить название склада…"
            />
            <Field label="Комментарий (необязательно)" name="note" />
          </ActionForm>
        </Card>
      )}
    </FormPageShell>
  );
}
