import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { updateUserAction } from "@/app/actions/users";
import { Card, CardTitle, PageTitle, Badge } from "@/components/ui";
import { PasswordLinkButton } from "../user-forms";
import { UserEditForm } from "./user-edit-form";
import { fmtDateTime } from "@/lib/format";
import { allowedWarehouses } from "@/lib/warehouse-access";
import { getActiveShift } from "@/lib/work-shift";
import { ROLE_LABEL, ROLE_TONE, ROLE_ORDER } from "@/lib/role-labels";
import type { Role } from "@/lib/jwt";

// Карточка сотрудника: роли, текущая смена, доступ (ссылка входа) и редактирование.
// Старые разделы (числится за сотрудником, стоимость, печать QR-бейджа) убраны — новая модель.
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
        <CardTitle>Доступ</CardTitle>
        <div className="flex flex-col gap-2">
          <PasswordLinkButton userId={user.id} />
          <p className="text-xs text-neutral-400">
            Ссылка для входа одноразовая: сотрудник задаёт по ней пароль и входит по телефону.
          </p>
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
