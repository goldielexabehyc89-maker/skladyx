import "server-only";
import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { getSession, setSession, clearSession, type SessionData, type Role } from "@/lib/session";
import { sanitizeRoles } from "@/lib/jwt";
import { hasRole, hasAnyRole } from "@/lib/roles";

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

// S2 dual-read: набор ролей пользователя из UserRole (fallback [legacyRole]) для сессии.
// Заполняется всегда при создании сессии, независимо от флага ROLES_DUAL_READ —
// флаг лишь решает, использовать ли этот набор при проверках прав (см. @/lib/roles).
export async function loadUserRoles(userId: string, legacyRole: Role): Promise<Role[]> {
  const rows = await prisma.userRole.findMany({ where: { userId }, select: { role: true } });
  return sanitizeRoles(rows.map((r) => r.role), legacyRole);
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
    roles: await loadUserRoles(user.id, user.role as Role),
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

// Решения о правах — через @/lib/roles (учитывает флаг ROLES_DUAL_READ и набор ролей).
export async function requireAdmin(): Promise<SessionData> {
  const session = await requireUser();
  if (!hasRole(session, "ADMIN")) throw new Error("FORBIDDEN");
  return session;
}

// Складской персонал: админ или кладовщик.
export async function requireStaff(): Promise<SessionData> {
  const session = await requireUser();
  if (!hasAnyRole(session, ["ADMIN", "STOREKEEPER"])) throw new Error("FORBIDDEN");
  return session;
}

// Для страниц (RSC): вместо исключения — редирект.
export async function requireAdminPage(): Promise<SessionData> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!hasRole(session, "ADMIN")) redirect("/warehouse");
  return session;
}

export async function requireStaffPage(): Promise<SessionData> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!hasAnyRole(session, ["ADMIN", "STOREKEEPER"])) redirect("/warehouse");
  return session;
}

