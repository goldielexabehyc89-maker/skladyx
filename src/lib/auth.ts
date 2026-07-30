import "server-only";
import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { setSession, clearSession, type SessionData, type Role } from "@/lib/session";
import { sanitizeRoles } from "@/lib/jwt";
import { hasRole, hasAnyRole, tenantAuthEnabled, isWarehouseViewer } from "@/lib/roles";
import { currentSession, resolveHostCompany } from "@/lib/tenant-auth";

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

// S2/S3: набор ролей пользователя из UserRole (fallback [legacyRole]) для сессии.
// Заполняется всегда при создании сессии; как эти роли используются, решает @/lib/roles.
export async function loadUserRoles(userId: string, legacyRole: Role): Promise<Role[]> {
  const rows = await prisma.userRole.findMany({ where: { userId }, select: { role: true } });
  return sanitizeRoles(rows.map((r) => r.role), legacyRole);
}

export type LoginResult =
  | { ok: true; session: SessionData }
  | { ok: false; error: "no-org" | "bad-credentials" };

// Проверяет логин/пароль и создаёт сессию. Логин — телефон (+7…/8…/9…); email — legacy-вход.
// TENANT_AUTH=true: организация берётся из host, пользователь ищется строго внутри неё
//   (одинаковый телефон в разных организациях → разные User). Неизвестный host → no-org.
// TENANT_AUTH=false: прежний поиск без организации (findFirst — совместим и после смены
//   уникальности; однозначен, пока организация одна).
export async function login(identifier: string, password: string): Promise<LoginResult> {
  const tenant = tenantAuthEnabled();

  let companyId: string | null = null;
  if (tenant) {
    const { company } = await resolveHostCompany();
    if (!company) return { ok: false, error: "no-org" };
    companyId = company.id;
  }

  const phone = normalizePhone(identifier);
  const emailNorm = !phone && identifier.includes("@") ? identifier.toLowerCase().trim() : null;
  const ident = phone ? { phone } : emailNorm ? { email: emailNorm } : null;
  if (!ident) return { ok: false, error: "bad-credentials" };

  const user = await prisma.user.findFirst({
    where: tenant ? { ...ident, companyId: companyId! } : ident,
  });
  // единый ответ: не раскрываем, есть ли пользователь в другой организации
  if (!user || !user.isActive || !user.passwordHash) return { ok: false, error: "bad-credentials" };
  if (!(await bcrypt.compare(password, user.passwordHash))) return { ok: false, error: "bad-credentials" };

  const session: SessionData = {
    userId: user.id,
    login: user.phone ?? user.email ?? "",
    name: user.name,
    role: user.role as Role,
    roles: await loadUserRoles(user.id, user.role as Role),
    companyId: user.companyId,
  };
  await setSession(session);
  return { ok: true, session };
}

export async function logout(): Promise<void> {
  await clearSession();
}

// Требует авторизованного пользователя. TENANT_AUTH=true → свежая проверка из БД
// (host==companyId, isActive, роли); иначе — как раньше (JWT). null → отказ.
export async function requireUser(): Promise<SessionData> {
  const session = await currentSession();
  if (!session) throw new Error("UNAUTHORIZED");
  return session;
}

// Решения о правах — через @/lib/roles (учитывает флаги и набор ролей из свежей проверки).
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
  const session = await currentSession();
  if (!session) redirect("/login");
  if (!hasRole(session, "ADMIN")) redirect("/warehouse");
  return session;
}

export async function requireStaffPage(): Promise<SessionData> {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (!hasAnyRole(session, ["ADMIN", "STOREKEEPER"])) redirect("/warehouse");
  return session;
}

// Read-only просмотр (остатки/история): ADMIN/STOREKEEPER + новые роли + OBSERVER.
// НЕ давать операционных прав — использовать только на read-only страницах.
export async function requireWarehouseViewerPage(): Promise<SessionData> {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (!isWarehouseViewer(session)) redirect("/warehouse");
  return session;
}
