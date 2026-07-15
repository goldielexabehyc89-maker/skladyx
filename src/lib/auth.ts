import "server-only";
import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { getSession, setSession, clearSession, type SessionData, type Role } from "@/lib/session";

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

// Проверяет логин/пароль и создаёт сессию. Логин — телефон (+7…/8…/9…);
// email оставлен как legacy-вход для учёток без телефона.
export async function login(identifier: string, password: string): Promise<SessionData | null> {
  const phone = normalizePhone(identifier);
  const user = phone
    ? await prisma.user.findUnique({ where: { phone } })
    : identifier.includes("@")
      ? await prisma.user.findUnique({ where: { email: identifier.toLowerCase().trim() } })
      : null;
  if (!user || !user.isActive) return null;
  if (!user.passwordHash) return null; // пароль ещё не задан — вход только по ссылке
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return null;

  const data: SessionData = {
    userId: user.id,
    login: user.phone ?? user.email ?? "",
    name: user.name,
    role: user.role as Role,
    companyId: user.companyId,
  };
  await setSession(data);
  return data;
}

export async function logout(): Promise<void> {
  await clearSession();
}

// Требует авторизованного пользователя; иначе — исключение (использовать после middleware).
export async function requireUser(): Promise<SessionData> {
  const session = await getSession();
  if (!session) throw new Error("UNAUTHORIZED");
  return session;
}

export async function requireAdmin(): Promise<SessionData> {
  const session = await requireUser();
  if (session.role !== "ADMIN") throw new Error("FORBIDDEN");
  return session;
}

// Складской персонал: админ или кладовщик.
export async function requireStaff(): Promise<SessionData> {
  const session = await requireUser();
  if (session.role !== "ADMIN" && session.role !== "STOREKEEPER") throw new Error("FORBIDDEN");
  return session;
}

// Для страниц (RSC): вместо исключения — редирект.
export async function requireAdminPage(): Promise<SessionData> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "ADMIN") redirect("/warehouse");
  return session;
}

export async function requireStaffPage(): Promise<SessionData> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "ADMIN" && session.role !== "STOREKEEPER") redirect("/warehouse");
  return session;
}

