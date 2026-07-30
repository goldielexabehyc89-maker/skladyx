"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { warehouseAccess, isWhAllowed } from "@/lib/warehouse-access";
import { isWorkRole, workflowTasksEnabled } from "@/lib/roles";
import { rebalanceQueuedTasks } from "@/lib/workflow-tasks";
import type { Role } from "@/lib/jwt";

export interface ShiftState {
  error?: string;
}

class ShiftConflict extends Error {}
class ShiftBlockedByTask extends Error {}

// Начать смену: выбрать ОДНУ рабочую роль + доступный склад. Условия:
// пользователь активен; роль назначена в UserRole; роль ∈ {RECEIVER,LOADER,PICKER,CONTROLLER};
// склад доступен; нет другой активной смены. Транзакция + advisory-lock по пользователю;
// partial unique index (endedAt IS NULL) — финальная гарантия «одна открытая смена».
export async function startWorkShiftAction(_prev: ShiftState, formData: FormData): Promise<ShiftState> {
  const session = await requireUser();
  const s = scoped(session);
  const role = String(formData.get("role") ?? "") as Role;
  const warehouseId = String(formData.get("warehouseId") ?? "");

  if (!isWorkRole(role)) return { error: "Смену можно начать только в рабочей роли (приёмка/погрузка/сборка/контроль)" };

  // пользователь активен (свежая проверка из БД, независимо от флага)
  const u = await prisma.user.findFirst({
    where: { id: session.userId, companyId: s.companyId },
    select: { isActive: true },
  });
  if (!u || !u.isActive) return { error: "Учётная запись неактивна" };

  // роль назначена пользователю (из UserRole)
  const assigned = await prisma.userRole.findFirst({ where: { userId: session.userId, role } });
  if (!assigned) return { error: "Эта роль вам не назначена" };

  // склад существует, активен и доступен пользователю
  const wh = await prisma.warehouse.findFirst({
    where: { id: warehouseId, companyId: s.companyId, isActive: true },
  });
  if (!wh) return { error: "Склад не найден" };
  const access = await warehouseAccess(session);
  if (!isWhAllowed(access, warehouseId)) return { error: "Этот склад вам недоступен" };

  try {
    await prisma.$transaction(async (tx) => {
      // $executeRaw (не $queryRaw): pg_advisory_xact_lock возвращает void — $queryRaw падает на его десериализации.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('skladyx:workshift'), hashtext(${session.userId}))`;
      const open = await tx.workShift.findFirst({ where: { userId: session.userId, endedAt: null } });
      if (open) throw new ShiftConflict();
      await tx.workShift.create({
        data: { companyId: s.companyId, userId: session.userId, warehouseId, role },
      });
    });
  } catch (e) {
    if (e instanceof ShiftConflict) return { error: "У вас уже есть активная смена" };
    // гонка двойного старта — сработал partial unique index
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
      return { error: "У вас уже есть активная смена" };
    throw e;
  }
  // Пакет 2: раздать подходящие QUEUED-задачи новой смене.
  if (workflowTasksEnabled()) await rebalanceQueuedTasks(s.companyId, { warehouseId, role });
  revalidatePath("/warehouse/shift");
  revalidatePath("/warehouse/tasks");
  revalidatePath("/warehouse/employees");
  return {};
}

// Завершить текущую смену. Пакет 2: назначенные, но не начатые задачи (ASSIGNED) вернуть
// в очередь и перераспределить; IN_PROGRESS/HANDOFF_PENDING блокируют завершение — сначала
// завершите задачу или передайте её.
export async function endWorkShiftAction(_prev: ShiftState, _formData: FormData): Promise<ShiftState> {
  const session = await requireUser();
  const s = scoped(session);
  const shift = await prisma.workShift.findFirst({
    where: { userId: session.userId, companyId: s.companyId, endedAt: null },
  });
  if (!shift) return { error: "Активной смены нет" };

  if (!workflowTasksEnabled()) {
    await prisma.workShift.update({ where: { id: shift.id }, data: { endedAt: new Date() } });
    revalidatePath("/warehouse/shift");
    revalidatePath("/warehouse/employees");
    return {};
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('skladyx:tasks'), hashtext(${s.companyId}))`;
      const blocking = await tx.workflowTask.count({
        where: { assignedShiftId: shift.id, status: { in: ["IN_PROGRESS", "HANDOFF_PENDING"] } },
      });
      if (blocking > 0) throw new ShiftBlockedByTask();
      await tx.workflowTask.updateMany({
        where: { assignedShiftId: shift.id, status: "ASSIGNED" },
        data: { status: "QUEUED", assignedUserId: null, assignedShiftId: null, assignedAt: null },
      });
      await tx.workShift.update({ where: { id: shift.id }, data: { endedAt: new Date() } });
    });
  } catch (e) {
    if (e instanceof ShiftBlockedByTask)
      return { error: "Есть задача в работе или ожидающая передачи. Завершите задачу или передайте её, затем закройте смену." };
    throw e;
  }
  // перераспределить возвращённые задачи между оставшимися сменами
  await rebalanceQueuedTasks(s.companyId, { warehouseId: shift.warehouseId, role: shift.role });
  revalidatePath("/warehouse/shift");
  revalidatePath("/warehouse/tasks");
  revalidatePath("/warehouse/employees");
  return {};
}
