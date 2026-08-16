import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { requireWarehouseViewerPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { externalOrderPickingEnabled, hasRole } from "@/lib/roles";
import { qrUrl } from "@/lib/qr";
import { warehouseAccess, isWhAllowed } from "@/lib/warehouse-access";
import { PageShell } from "@/components/page-shell";
import { Card, CardTitle, Badge, EmptyState } from "@/components/ui";
import type { ExternalOrderStatus } from "@prisma/client";
import { OrderQr } from "./order-qr";

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

  // ORDER-QR (ADMIN): существующий QrCode заказа. GET его НЕ создаёт; отсутствие — контролируемая ошибка.
  const isAdmin = hasRole(session, "ADMIN");
  let orderQrView: { svg: string; png: string; code: string; url: string } | null = null;
  let orderQrMissing = false;
  if (isAdmin) {
    const qr = await prisma.qrCode.findFirst({ where: { companyId: s.companyId, type: "ORDER", refId: order.id }, select: { code: true } });
    if (qr) {
      const url = await qrUrl(qr.code);
      const [svg, png] = await Promise.all([
        QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" }),
        QRCode.toDataURL(url, { margin: 1, scale: 8, errorCorrectionLevel: "M" }),
      ]);
      orderQrView = { svg, png, code: qr.code, url };
    } else {
      orderQrMissing = true;
    }
  }

  return (
    <PageShell title={`Заказ ${order.externalId}`} action={<Badge tone={st.tone}>{st.label}</Badge>}>
      {isAdmin && (
        <Card>
          <CardTitle>QR заказа</CardTitle>
          {orderQrView ? (
            <OrderQr svg={orderQrView.svg} png={orderQrView.png} code={orderQrView.code} url={orderQrView.url} />
          ) : orderQrMissing ? (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">QR заказа не найден. Обратитесь к администратору — потребуется ручное восстановление QR (повторный импорт того же заказа его не создаёт).</div>
          ) : null}
        </Card>
      )}
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
