import { Printer } from "lucide-react";
import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { regenerateBadgeAction } from "@/app/actions/users";
import { updateUserAction } from "@/app/actions/users";
import { Card, CardTitle, Field, PageTitle, Badge, LinkButton, Button, DownloadButton } from "@/components/ui";
import { PasswordLinkButton } from "../user-forms";
import { UserEditForm } from "./user-edit-form";
import { fmtQty, fmtRub, fmtDateTime } from "@/lib/format";
import { allowedWarehouses } from "@/lib/warehouse-access";
import { getActiveShift } from "@/lib/work-shift";
import { ROLE_LABEL, ROLE_TONE, ROLE_ORDER } from "@/lib/role-labels";
import type { Role } from "@/lib/jwt";

export default async function EmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminPage();
  const s = scoped(session);
  const { id } = await params;
  const user = await prisma.user.findFirst({
    where: { id, companyId: s.companyId },
    include: {
      warehouseLinks: { select: { warehouseId: true } },
      userRoles: { select: { role: true } },
    },
  });
  if (!user) return null;
  const roles = ROLE_ORDER.filter((r) => user.userRoles.some((ur) => ur.role === r));
  const shift = await getActiveShift(user.id, s.companyId);
  const warehouses = await allowedWarehouses(session, s.companyId);
  const badge = await prisma.qrCode.findUnique({
    where: { type_refId: { type: "EMPLOYEE", refId: user.id } },
  });

  // Что числится за сотрудником
  const [balances, units] = await Promise.all([
    prisma.stockBalance.findMany({
      where: { companyId: s.companyId, employeeId: user.id, qty: { gt: 0 } },
    }),
    prisma.itemUnit.findMany({
      where: {
        companyId: s.companyId,
        employeeId: user.id,
        status: { in: ["ISSUED", "ISSUE_PENDING"] },
      },
    }),
  ]);
  const itemIds = [...new Set([...balances.map((b) => b.itemId), ...units.map((u) => u.itemId)])];
  const lots = await prisma.lot.findMany({
    where: { id: { in: balances.map((b) => b.lotId) } },
  });
  const items = await prisma.item.findMany({
    where: { id: { in: itemIds } },
    include: { uom: true },
  });
  const itemById = new Map(items.map((i) => [i.id, i]));
  const lotById = new Map(lots.map((l) => [l.id, l]));

  const totalValue =
    balances.reduce((sum, b) => {
      const price = lotById.get(b.lotId)?.price;
      return sum + (price ? price.toNumber() * b.qty.toNumber() : 0);
    }, 0) + units.reduce((sum, u) => sum + (u.price ? u.price.toNumber() : 0), 0);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <PageTitle
        action={
          <span className="flex flex-wrap justify-end gap-1">
            {roles.map((r) => (
              <Badge key={r} tone={ROLE_TONE[r]}>
                {ROLE_LABEL[r]}
              </Badge>
            ))}
          </span>
        }
      >
        {user.name}
      </PageTitle>
      <p className="-mt-3 text-sm text-neutral-500">{user.phone ?? user.email}</p>

      {shift && (
        <Card>
          <CardTitle>
            <span className="flex items-center gap-2">
              <Badge tone="green">На смене</Badge>
              {ROLE_LABEL[shift.role]}
            </span>
          </CardTitle>
          <div className="text-sm text-neutral-600">
            Склад: {shift.warehouseName} · начало: {fmtDateTime(shift.startedAt)}
          </div>
        </Card>
      )}

      <Card>
        <CardTitle>Числится за сотрудником</CardTitle>
        {balances.length === 0 && units.length === 0 ? (
          <p className="text-sm text-neutral-500">Ничего не числится.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {balances.map((b) => {
              const item = itemById.get(b.itemId);
              return (
                <div key={b.id} className="flex justify-between text-sm">
                  <span>
                    {item?.name ?? "—"}
                    {b.locKey.startsWith("EP:") && <Badge tone="orange">ждёт подтверждения</Badge>}
                  </span>
                  <span>
                    {fmtQty(b.qty)} {item?.uom.name ?? ""}
                  </span>
                </div>
              );
            })}
            {units.map((u) => {
              const item = itemById.get(u.itemId);
              return (
                <div key={u.id} className="flex justify-between text-sm">
                  <span>
                    {item?.name ?? "—"} · ед. №{u.serial}{" "}
                    {u.status === "ISSUE_PENDING" && <Badge tone="orange">ждёт подтверждения</Badge>}
                  </span>
                  <span>1 {item?.uom.name ?? ""}</span>
                </div>
              );
            })}
            {totalValue > 0 && (
              <p className="mt-2 text-right text-sm font-semibold">На сумму: {fmtRub(totalValue)}</p>
            )}
          </div>
        )}
      </Card>

      <Card>
        <CardTitle>Доступ и бейдж</CardTitle>
        <div className="flex flex-col gap-2">
          <PasswordLinkButton userId={user.id} />
          {badge && (
            <LinkButton href={`/warehouse/print/labels?employee=${user.id}`}>
              <Printer size={18} /> Печать бейджа
            </LinkButton>
          )}
          <form action={regenerateBadgeAction}>
            <input type="hidden" name="userId" value={user.id} />
            <Button type="submit" variant="ghost" className="w-full">
              ♻️ Перевыпустить QR-бейдж
            </Button>
          </form>
        </div>
      </Card>

      <Card>
        <CardTitle>Карточка</CardTitle>
        <UserEditForm
          action={updateUserAction}
          warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
          user={{
            id: user.id,
            name: user.name,
            roles: user.userRoles.map((ur) => ur.role as Role),
            isActive: user.isActive,
            phone: user.phone,
            allWarehouses: user.allWarehouses,
            warehouseIds: user.warehouseLinks.map((l) => l.warehouseId),
          }}
        />
      </Card>
    </div>
  );
}
