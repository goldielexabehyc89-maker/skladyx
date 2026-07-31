import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { groupReceivingEnabled, hasRole } from "@/lib/roles";
import { getActiveShift } from "@/lib/work-shift";
import { getSettings } from "@/lib/settings";
import { PageTitle, Card, Badge, EmptyState, LinkButton } from "@/components/ui";
import { ReceivingForm } from "./receiving-form";

// Экран групповой приёмки: только RECEIVER с активной сменой (ADMIN — при активной смене RECEIVER).
export default async function ReceivingPage() {
  if (!groupReceivingEnabled()) redirect("/warehouse");
  const session = await requireUser();
  const s = scoped(session);

  const shift = await getActiveShift(session.userId, s.companyId);
  const receiverShift = shift && shift.role === "RECEIVER" ? shift : null;

  if (!receiverShift) {
    return (
      <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
        <PageTitle>Приёмка группами</PageTitle>
        <Card>
          <p className="text-sm text-neutral-600">
            Групповую приёмку проводит приёмщик с активной сменой (роль RECEIVER). Начните смену
            приёмщика на нужном складе.
          </p>
          <div className="mt-3">
            <LinkButton href="/warehouse/shift" variant="primary">Начать смену</LinkButton>
          </div>
        </Card>
      </div>
    );
  }

  const settings = await getSettings(s.companyId);
  if (settings.tempThresholdX === null) {
    const isAdmin = hasRole(session, "ADMIN");
    return (
      <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
        <PageTitle action={<Badge tone="green">Приёмщик · {receiverShift.warehouseName}</Badge>}>
          Приёмка группами
        </PageTitle>
        <Card>
          <p className="text-sm text-neutral-600">
            Не задан порог температуры X. Групповая приёмка заблокирована.
          </p>
          {isAdmin ? (
            <div className="mt-3">
              <LinkButton href="/warehouse/settings" variant="primary">Задать порог X</LinkButton>
            </div>
          ) : (
            <p className="mt-2 text-sm text-neutral-500">Попросите администратора задать порог X в настройках.</p>
          )}
        </Card>
      </div>
    );
  }

  const items = await prisma.item.findMany({
    where: { companyId: s.companyId, isActive: true, tracking: "LOT" },
    select: { id: true, name: true, sku: true, uom: { select: { name: true } } },
    orderBy: { name: "asc" },
  });

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
      <PageTitle action={<Badge tone="green">Приёмщик · {receiverShift.warehouseName}</Badge>}>
        Приёмка группами
      </PageTitle>
      {items.length === 0 ? (
        <EmptyState>Нет активной партионной номенклатуры для приёмки.</EmptyState>
      ) : (
        <ReceivingForm
          thresholdX={settings.tempThresholdX}
          items={items.map((i) => ({ id: i.id, name: i.name, sku: i.sku, uom: i.uom.name }))}
        />
      )}
    </div>
  );
}
