"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { logEvent } from "@/lib/events";
import { createQrIn } from "@/lib/qr";
import { normalizePhone } from "@/lib/phone";
import { createPasswordToken, passwordLink } from "@/lib/password-reset";

export interface UserFormState {
  error?: string;
  link?: string; // одноразовая ссылка установки пароля — показать и скопировать
}

const userSchema = z.object({
  name: z.string().trim().min(1, "Укажите имя"),
  role: z.enum(["ADMIN", "STOREKEEPER", "EMPLOYEE"]),
});

// Разбор привязки к складам из формы: чекбокс «Все склады» + список складов.
async function parseWarehouses(
  companyId: string,
  formData: FormData,
): Promise<{ error?: string; allWarehouses?: boolean; ids?: string[] }> {
  const all = formData.get("allWarehouses") === "on";
  if (all) return { allWarehouses: true, ids: [] };
  const ids = formData.getAll("wh").map((v) => String(v)).filter(Boolean);
  if (ids.length === 0)
    return { error: "Выберите склад(ы) или отметьте «Все склады»" };
  const found = await prisma.warehouse.findMany({
    where: { companyId, id: { in: ids } },
    select: { id: true },
  });
  const validIds = found.map((w) => w.id);
  if (validIds.length === 0) return { error: "Склады не найдены" };
  return { allWarehouses: false, ids: validIds };
}

const ROLE_RU: Record<string, string> = {
  ADMIN: "админ",
  STOREKEEPER: "кладовщик",
  EMPLOYEE: "сотрудник",
};

// Создание сотрудника: логин — телефон, без пароля (вход по одноразовой ссылке) + QR-бейдж.
export async function createUserAction(
  _prev: UserFormState,
  formData: FormData,
): Promise<UserFormState> {
  const session = await requireAdmin();
  const s = scoped(session);

  const parsed = userSchema.safeParse({
    name: formData.get("name"),
    role: formData.get("role"),
  });
  if (!parsed.success) return { error: parsed.error.errors[0].message };

  const phone = normalizePhone(String(formData.get("phone") ?? ""));
  if (!phone) return { error: "Некорректный телефон — введите с +7, с 8 или сразу с 9" };

  const wh = await parseWarehouses(s.companyId, formData);
  if (wh.error) return { error: wh.error };

  const exists = await prisma.user.findUnique({ where: { phone } });
  if (exists) return { error: "Пользователь с таким телефоном уже есть" };

  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        companyId: s.companyId,
        phone,
        name: parsed.data.name,
        role: parsed.data.role,
        passwordHash: null,
        allWarehouses: wh.allWarehouses!,
        warehouseLinks: wh.allWarehouses
          ? undefined
          : { create: wh.ids!.map((warehouseId) => ({ warehouseId })) },
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
    body: `${user.name} (${ROLE_RU[user.role] ?? user.role})`,
    url: `/warehouse/employees/${user.id}`,
    actorId: session.userId,
  });
  revalidatePath("/warehouse/employees");
  return { link: passwordLink(token) };
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
  const role = String(formData.get("role") ?? "");
  if (!name) return { error: "Укажите имя" };
  if (role !== "ADMIN" && role !== "STOREKEEPER" && role !== "EMPLOYEE")
    return { error: "Некорректная роль" };
  const isActive = formData.get("isActive") === "on";
  if (user.id === session.userId && (!isActive || role !== "ADMIN"))
    return { error: "Нельзя отключить или понизить самого себя" };

  // телефон: пустое поле — оставить как есть (для старых учёток с email-входом)
  const phoneRaw = String(formData.get("phone") ?? "").trim();
  let phone = user.phone;
  if (phoneRaw) {
    phone = normalizePhone(phoneRaw);
    if (!phone) return { error: "Некорректный телефон — введите с +7, с 8 или сразу с 9" };
    const dup = await prisma.user.findFirst({ where: { phone, id: { not: id } } });
    if (dup) return { error: "Этот телефон занят другим пользователем" };
  }

  const wh = await parseWarehouses(s.companyId, formData);
  if (wh.error) return { error: wh.error };

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id },
      data: { name, role, isActive, phone, allWarehouses: wh.allWarehouses! },
    });
    await tx.userWarehouse.deleteMany({ where: { userId: id } });
    if (!wh.allWarehouses && wh.ids!.length) {
      await tx.userWarehouse.createMany({
        data: wh.ids!.map((warehouseId) => ({ userId: id, warehouseId })),
      });
    }
  });
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
  return { link: passwordLink(token) };
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
