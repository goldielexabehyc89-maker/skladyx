import { requireUser } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { allowedWarehouses } from "@/lib/warehouse-access";
import { getActiveShift } from "@/lib/work-shift";
import { WORK_ROLES } from "@/lib/roles";
import { PageTitle } from "@/components/ui";
import { ShiftStart, ShiftActive } from "./shift-screen";
import type { Role } from "@/lib/jwt";

export default async function ShiftPage() {
  const session = await requireUser();
  const s = scoped(session);
  const shift = await getActiveShift(session.userId, s.companyId);

  let workRoles: Role[] = [];
  let warehouses: { id: string; name: string }[] = [];
  if (!shift) {
    const userRoles = await prisma.userRole.findMany({
      where: { userId: session.userId },
      select: { role: true },
    });
    workRoles = WORK_ROLES.filter((r) => userRoles.some((ur) => ur.role === r));
    const whs = await allowedWarehouses(session, s.companyId, { activeOnly: true });
    warehouses = whs.map((w) => ({ id: w.id, name: w.name }));
  }

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
      <PageTitle>Смена</PageTitle>
      {shift ? (
        <ShiftActive
          name={session.name}
          role={shift.role}
          warehouseName={shift.warehouseName}
          startedAtIso={shift.startedAt.toISOString()}
        />
      ) : (
        <ShiftStart workRoles={workRoles} warehouses={warehouses} />
      )}
    </div>
  );
}
