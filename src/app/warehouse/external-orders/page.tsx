import { notFound } from "next/navigation";
import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { externalOrderPickingEnabled } from "@/lib/roles";
import { PageShell } from "@/components/page-shell";
import { Card, CardTitle, Badge, EmptyState } from "@/components/ui";
import { ImportOrderForm } from "./import-form";
import type { ExternalOrderStatus } from "@prisma/client";

const STATUS_RU: Record<ExternalOrderStatus, { label: string; tone: "neutral" | "blue" | "green" | "orange" | "red" }> = {
  IMPORTED: { label: "Импортирован", tone: "neutral" },
  PARTIALLY_RESERVED: { label: "Частично зарезервирован", tone: "orange" },
  READY_TO_PICK: { label: "Готов к сборке", tone: "blue" },
  PICKING: { label: "Собирается", tone: "blue" },
  IN_CONTROL: { label: "На контроле", tone: "green" },
  CORRECTION_REQUIRED: { label: "Требует исправления", tone: "red" },
  CONTROL_PASSED: { label: "Контроль пройден", tone: "green" },
  BLOCKED: { label: "Заблокирован", tone: "red" },
};

// Этап 5/Пакет 6: список внешних заказов + ручной импорт (мост до интеграционного адаптера). ADMIN.
export default async function ExternalOrdersPage() {
  if (!externalOrderPickingEnabled()) notFound();
  const session = await requireAdminPage();
  const s = scoped(session);
  const [orders, warehouses] = await Promise.all([
    prisma.externalOrder.findMany({ where: { companyId: s.companyId }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.warehouse.findMany({ where: { companyId: s.companyId, isActive: true }, orderBy: { sortOrder: "asc" }, select: { id: true, name: true } }),
  ]);
  return (
    <PageShell title="Внешние заказы">
      <Card>
        <CardTitle>Импорт заказа</CardTitle>
        {warehouses.length === 0 ? (
          <EmptyState>Нет активных складов.</EmptyState>
        ) : (
          <ImportOrderForm warehouses={warehouses} />
        )}
      </Card>
      <Card>
        <CardTitle>Заказы</CardTitle>
        {orders.length === 0 ? (
          <EmptyState>Заказов пока нет.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {orders.map((o) => {
              const st = STATUS_RU[o.status];
              return (
                <li key={o.id}>
                  <Link href={`/warehouse/external-orders/${o.id}`} className="flex items-center justify-between rounded-xl border border-[#eee] p-3 text-sm">
                    <span className="font-medium">{o.externalId}</span>
                    <Badge tone={st.tone}>{st.label}</Badge>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </PageShell>
  );
}
