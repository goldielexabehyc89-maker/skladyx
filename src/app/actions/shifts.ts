"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { warehouseAccess, isWhAllowed } from "@/lib/warehouse-access";
import { isWorkRole } from "@/lib/roles";
import type { Role } from "@/lib/jwt";

export interface ShiftState {
  error?: string;
}

class ShiftConflict extends Error {}

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
  revalidatePath("/warehouse/shift");
  revalidatePath("/warehouse/employees");
  return {};
}

// Завершить текущую смену. Пакет 1: без проверки взятого товара и возврата задач
// (модели задач ещё нет — это следующий пакет).
export async function endWorkShiftAction(_prev: ShiftState, _formData: FormData): Promise<ShiftState> {
  const session = await requireUser();
  const res = await prisma.workShift.updateMany({
    where: { userId: session.userId, companyId: session.companyId, endedAt: null },
    data: { endedAt: new Date() },
  });
  if (res.count === 0) return { error: "Активной смены нет" };
  revalidatePath("/warehouse/shift");
  revalidatePath("/warehouse/employees");
  return {};
}
