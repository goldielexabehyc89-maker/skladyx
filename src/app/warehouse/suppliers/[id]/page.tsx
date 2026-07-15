import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { updateSupplierAction } from "@/app/actions/suppliers";
import { ActionForm } from "@/components/action-form";
import { PageShell } from "@/components/page-shell";
import { Card, CardTitle, Field, Badge, EmptyState } from "@/components/ui";

export default async function SupplierPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminPage();
  const s = scoped(session);
  const { id } = await params;
  const supplier = await prisma.supplier.findFirst({
    where: { id, companyId: s.companyId },
    include: { _count: { select: { orders: true } } },
  });
  if (!supplier) return <EmptyState>Поставщик не найден.</EmptyState>;

  return (
    <div className="mx-auto w-full max-w-2xl">
      <PageShell
        title={
          <span className="flex items-center gap-2.5">
            {supplier.name}
            {!supplier.isActive && <Badge tone="red">архив</Badge>}
          </span>
        }
      >
        <p className="-mt-2 text-sm text-neutral-500">Заказов: {supplier._count.orders}</p>
        <Card>
          <CardTitle>Карточка поставщика</CardTitle>
          <ActionForm action={updateSupplierAction} submitLabel="Сохранить" variant="ghost">
            <input type="hidden" name="id" value={supplier.id} />
            <Field label="Название" name="name" required defaultValue={supplier.name} />
            <Field label="Телефон" name="phone" defaultValue={supplier.phone ?? ""} />
            <Field label="Заметка" name="note" defaultValue={supplier.note ?? ""} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="isActive" defaultChecked={supplier.isActive} className="h-5 w-5" />
              Активен (виден в списке при создании заказа)
            </label>
          </ActionForm>
        </Card>
      </PageShell>
    </div>
  );
}
