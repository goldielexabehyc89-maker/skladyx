import "server-only";
import { prisma } from "@/lib/db";
import type { Role } from "@/lib/jwt";

// Этап 5: активная рабочая смена. Helper для экрана смены и для будущих процессов
// (следующий пакет — очередь задач по активной роли/складу смены).

export interface ActiveShift {
  id: string;
  role: Role;
  warehouseId: string;
  warehouseName: string;
  startedAt: Date;
}

// Текущая незавершённая смена пользователя (в его организации) или null.
export async function getActiveShift(userId: string, companyId: string): Promise<ActiveShift | null> {
  const shift = await prisma.workShift.findFirst({
    where: { userId, companyId, endedAt: null },
    include: { warehouse: { select: { name: true } } },
    orderBy: { startedAt: "desc" },
  });
  if (!shift) return null;
  return {
    id: shift.id,
    role: shift.role as Role,
    warehouseId: shift.warehouseId,
    warehouseName: shift.warehouse.name,
    startedAt: shift.startedAt,
  };
}

// Для будущих процессов: активная смена нужной рабочей роли (иначе null).
export async function activeShiftForRole(
  userId: string,
  companyId: string,
  role: Role,
): Promise<ActiveShift | null> {
  const shift = await getActiveShift(userId, companyId);
  return shift && shift.role === role ? shift : null;
}
