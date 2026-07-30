"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { logEvent } from "@/lib/events";
import { createQrIn } from "@/lib/qr";
import { normalizePhone } from "@/lib/phone";
import { createPasswordToken, passwordLink } from "@/lib/password-reset";
import { highestRole } from "@/lib/roles";
import { ROLE_ORDER, ROLE_LABEL } from "@/lib/role-labels";
import type { Role } from "@/lib/jwt";

export interface UserFormState {
  error?: string;
  link?: string; // одноразовая ссылка установки пароля — показать и скопировать
}

// Организацию нельзя оставить без активного администратора (см. updateUserAction).
class LastAdminError extends Error {}
// Нельзя менять роль/склад/активность пользователя, пока у него открыта смена.
class ShiftOpenError extends Error {}

// Этап 5: у пользователя набор ролей (UserRole). Из формы приходит несколько значений `roles`.
function parseRoles(formData: FormData): { error?: string; roles?: Role[] } {
  const raw = formData.getAll("roles").map(String).filter(Boolean);
  const valid = raw.filter((r): r is Role => (ROLE_ORDER as string[]).includes(r));
  const roles = Array.from(new Set(valid));
  if (roles.length === 0) return { error: "Выберите хотя бы одну роль" };
  return { roles };
}

// Разбор привязки к складам из формы: чекбокс «Все склады» + список складов.
async function parseWarehouses(
  companyId: string,
  formData: FormData,
): Promise<{ error?: string; allWarehouses?: boolean; ids?: string[] }> {
  const all = formData.get("allWarehouses") === "on";
  if (all) return { allWarehouses: true, ids: [] };
  const ids = formData.getAll("wh").map((v) => String(v)).filter(Boolean);
  if (ids.length === 0) return { error: "Выберите склад(ы) или отметьте «Все склады»" };
  const found = await prisma.warehouse.findMany({
    where: { companyId, id: { in: ids } },
    select: { id: true },
  });
  const validIds = found.map((w) => w.id);
  if (validIds.length === 0) return { error: "Склады не найдены" };
  return { allWarehouses: false, ids: validIds };
}

// Создание сотрудника: логин — телефон, без пароля (вход по одноразовой ссылке) + QR-бейдж.
export async function createUserAction(
  _prev: UserFormState,
  formData: FormData,
): Promise<UserFormState> {
  const session = await requireAdmin();
  const s = scoped(session);

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Укажите имя" };
  const parsedRoles = parseRoles(formData);
  if (parsedRoles.error) return { error: parsedRoles.error };
  const roles = parsedRoles.roles!;
  const compat = highestRole(roles)!; // compatibility-поле User.role (детерминированно по приоритету)

  const phone = normalizePhone(String(formData.get("phone") ?? ""));
  if (!phone) return { error: "Некорректный телефон — введите с +7, с 8 или сразу с 9" };

  const wh = await parseWarehouses(s.companyId, formData);
  if (wh.error) return { error: wh.error };

  // S3: телефон уникален в пределах организации
  const exists = await prisma.user.findFirst({ where: { companyId: s.companyId, phone } });
  if (exists) return { error: "Пользователь с таким телефоном уже есть" };

  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        companyId: s.companyId,
        phone,
        name,
        role: compat,
        passwordHash: null,
        allWarehouses: wh.allWarehouses!,
        warehouseLinks: wh.allWarehouses
          ? undefined
          : { create: wh.ids!.map((warehouseId) => ({ warehouseId })) },
        // набор ролей одной транзакцией
        userRoles: { create: roles.map((role) => ({ role })) },
      },
    });
    await createQrIn(tx, { companyId: s.companyId, type: "EMPLOYEE", refId: u.id });
    return u;
  });

  const token = await createPasswordToken(user.id);
  await logEvent({
    companyId: s.companyId,
    type: "user_created",
    title: "Добавлен сотрудник",
    body: `${user.name} (${roles.map((r) => ROLE_LABEL[r]).join(", ")})`,
    url: `/warehouse/employees/${user.id}`,
    actorId: session.userId,
  });
  revalidatePath("/warehouse/employees");
  return { link: await passwordLink(token) };
}

export async function updateUserAction(
  _prev: UserFormState,
  formData: FormData,
): Promise<UserFormState> {
  const session = await requireAdmin();
  const s = scoped(session);
  const id = String(formData.get("id") ?? "");
  const user = await s.user(id);

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Укажите имя" };
  const parsedRoles = parseRoles(formData);
  if (parsedRoles.error) return { error: parsedRoles.error };
  const roles = parsedRoles.roles!;
  const compat = highestRole(roles)!;
  const isActive = formData.get("isActive") === "on";

  if (user.id === session.userId && (!isActive || !roles.includes("ADMIN")))
    return { error: "Нельзя отключить себя или снять с себя роль администратора" };

  // телефон: пустое поле — оставить как есть (для старых учёток с email-входом)
  const phoneRaw = String(formData.get("phone") ?? "").trim();
  let phone = user.phone;
  if (phoneRaw) {
    phone = normalizePhone(phoneRaw);
    if (!phone) return { error: "Некорректный телефон — введите с +7, с 8 или сразу с 9" };
    const dup = await prisma.user.findFirst({ where: { companyId: s.companyId, phone, id: { not: id } } });
    if (dup) return { error: "Этот телефон занят другим пользователем" };
  }

  const wh = await parseWarehouses(s.companyId, formData);
  if (wh.error) return { error: wh.error };

  try {
    await prisma.$transaction(async (tx) => {
      // Защита последнего активного ADMIN, конкурентно-безопасно (advisory-lock по организации).
      // $executeRaw (не $queryRaw): pg_advisory_xact_lock возвращает void — $queryRaw падает на его десериализации.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('skladyx:lastadmin'), hashtext(${s.companyId}))`;

      // Пока у пользователя открыта смена — нельзя деактивировать, снять активную роль
      // смены или доступ к складу смены.
      const openShift = await tx.workShift.findFirst({
        where: { userId: id, companyId: s.companyId, endedAt: null },
        select: { role: true, warehouseId: true },
      });
      if (openShift) {
        if (!isActive) throw new ShiftOpenError("Нельзя отключить сотрудника, пока у него открыта смена");
        if (!roles.includes(openShift.role))
          throw new ShiftOpenError("Нельзя снять роль активной смены — сначала завершите смену");
        const keepsWarehouse = wh.allWarehouses || wh.ids!.includes(openShift.warehouseId);
        if (!keepsWarehouse)
          throw new ShiftOpenError("Нельзя убрать доступ к складу активной смены — сначала завершите смену");
      }

      const willBeActiveAdmin = isActive && roles.includes("ADMIN");
      if (!willBeActiveAdmin) {
        const otherActiveAdmins = await tx.user.count({
          where: {
            companyId: s.companyId,
            isActive: true,
            id: { not: id },
            userRoles: { some: { role: "ADMIN" } },
          },
        });
        if (otherActiveAdmins === 0) throw new LastAdminError();
      }

      await tx.user.update({
        where: { id },
        data: { name, role: compat, isActive, phone, allWarehouses: wh.allWarehouses! },
      });
      await tx.userWarehouse.deleteMany({ where: { userId: id } });
      if (!wh.allWarehouses && wh.ids!.length) {
        await tx.userWarehouse.createMany({
          data: wh.ids!.map((warehouseId) => ({ userId: id, warehouseId })),
        });
      }
      // синхронизировать UserRole с выбранным набором ролей
      await tx.userRole.deleteMany({ where: { userId: id, role: { notIn: roles } } });
      for (const role of roles) {
        await tx.userRole.upsert({
          where: { userId_role: { userId: id, role } },
          create: { userId: id, role },
          update: {},
        });
      }
    });
  } catch (e) {
    if (e instanceof LastAdminError)
      return { error: "Нельзя оставить организацию без активного администратора" };
    if (e instanceof ShiftOpenError) return { error: e.message };
    throw e;
  }
  revalidatePath("/warehouse/employees");
  revalidatePath(`/warehouse/employees/${id}`);
  return {};
}

// Перевыпуск одноразовой ссылки установки пароля.
export async function issuePasswordLinkAction(userId: string): Promise<UserFormState> {
  const session = await requireAdmin();
  const s = scoped(session);
  const user = await s.user(userId);
  const token = await createPasswordToken(user.id);
  return { link: await passwordLink(token) };
}

// Перевыпуск QR-бейджа (старый код перестаёт действовать).
export async function regenerateBadgeAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const s = scoped(session);
  const userId = String(formData.get("userId") ?? "");
  const user = await s.user(userId);

  await prisma.$transaction(async (tx) => {
    await tx.qrCode.deleteMany({ where: { type: "EMPLOYEE", refId: user.id } });
    await createQrIn(tx, { companyId: s.companyId, type: "EMPLOYEE", refId: user.id });
  });
  revalidatePath(`/warehouse/employees/${userId}`);
}
