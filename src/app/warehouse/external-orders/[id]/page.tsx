import { notFound } from "next/navigation";
import { requireWarehouseViewerPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { externalOrderPickingEnabled } from "@/lib/roles";
import { warehouseAccess, isWhAllowed } from "@/lib/warehouse-access";
import { PageShell } from "@/components/page-shell";
import { Card, CardTitle, Badge, EmptyState } from "@/components/ui";
import type { ExternalOrderStatus } from "@prisma/client";

const STATUS_RU: Record<ExternalOrderStatus, { label: string; tone: "neutral" | "blue" | "green" | "orange" | "red" }> = {
  IMPORTED: { label: "Импортирован", tone: "neutral" },
  PARTIALLY_RESERVED: { label: "Частично зарезервирован", tone: "orange" },
  READY_TO_PICK: { label: "Готов к сборке", tone: "blue" },
  PICKING: { label: "Собирается", tone: "blue" },
  IN_CONTROL: { label: "На контроле", tone: "green" },
  CORRECTION_REQUIRED: { label: "Требует исправления", tone: "red" },
  CONTROL_PASSED: { label: "Контроль пройден", tone: "green" },
  AWAITING_ISSUE_CELL: { label: "Ожидает ячейку выдачи", tone: "orange" },
  MOVING_TO_ISSUE: { label: "Перемещается в выдачу", tone: "blue" },
  READY_FOR_DRIVER: { label: "Готов к выдаче", tone: "green" },
  ISSUED: { label: "Выдан", tone: "green" },
  BLOCKED: { label: "Заблокирован (нет места)", tone: "red" },
};

// Этап 5/Пакет 6: карточка внешнего заказа (QR заказа ведёт сюда). Read-only.
export default async function ExternalOrderPage({ params }: { params: Promise<{ id: string }> }) {
  if (!externalOrderPickingEnabled()) notFound();
  const { id } = await params;
  const session = await requireWarehouseViewerPage();
  const s = scoped(session);

  const order = await prisma.externalOrder.findFirst({ where: { id, companyId: s.companyId } });
  if (!order) notFound();
  // Доступ к складу заказа обязателен (не только принадлежность тенанту).
  const access = await warehouseAccess(session);
  if (!isWhAllowed(access, order.warehouseId)) notFound();
  const lines = await prisma.externalOrderLine.findMany({ where: { orderId: order.id }, orderBy: { externalLineId: "asc" } });
  const items = await prisma.item.findMany({ where: { id: { in: lines.map((l) => l.itemId) } }, select: { id: true, name: true } });
  const itemName = new Map(items.map((i) => [i.id, i.name]));
  const st = STATUS_RU[order.status];

  return (
    <PageShell title={`Заказ ${order.externalId}`} action={<Badge tone={st.tone}>{st.label}</Badge>}>
      <Card>
        <CardTitle>Строки заказа</CardTitle>
        {lines.length === 0 ? (
          <EmptyState>Нет строк.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {lines.map((l) => (
              <li key={l.id} className="rounded-xl border border-[#eee] p-3 text-sm">
                <div className="font-medium">{itemName.get(l.itemId) ?? l.itemId}</div>
                <div className="text-xs text-neutral-500">
                  Нужно {l.requiredQty.toString()} · зарезервировано {l.reservedQty.toString()} · собрано {l.pickedQty.toString()}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </PageShell>
  );
}
