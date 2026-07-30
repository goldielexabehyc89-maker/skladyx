"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { hashPassword, loadUserRoles } from "@/lib/auth";
import { setSession, type Role } from "@/lib/session";
import { validateToken } from "@/lib/password-reset";

export interface SetPasswordState {
  error?: string;
}

// Установка пароля по одноразовой ссылке (выдаёт администратор) + автовход.
export async function setPasswordAction(
  _prev: SetPasswordState,
  formData: FormData,
): Promise<SetPasswordState> {
  const token = String(formData.get("token") ?? "");
  const pass1 = String(formData.get("password") ?? "");
  const pass2 = String(formData.get("password2") ?? "");

  if (pass1.length < 8) return { error: "Пароль должен быть не короче 8 символов" };
  if (pass1 !== pass2) return { error: "Пароли не совпадают" };

  const t = await validateToken(token);
  if (!t) return { error: "Ссылка недействительна или устарела — запросите новую у администратора" };

  const user = await prisma.user.findUnique({ where: { id: t.userId } });
  if (!user) return { error: "Пользователь не найден" };

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(pass1) },
    }),
    prisma.authToken.update({ where: { id: t.id }, data: { usedAt: new Date() } }),
  ]);

  await setSession({
    userId: user.id,
    login: user.phone ?? user.email ?? "",
    name: user.name,
    role: user.role as Role,
    roles: await loadUserRoles(user.id, user.role as Role),
    companyId: user.companyId,
  });
  redirect("/warehouse");
}
