import "server-only";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";
import { sanitizeRoles, type Role, type SessionData } from "@/lib/jwt";
import { tenantAuthEnabled } from "@/lib/roles";
import { orgSlugFromHost } from "@/lib/tenant-host";

// Этап 4B/S3 — строгая tenant-авторизация. Единый server-only путь:
//   host (доверенный, nginx передаёт Host $host) → Company → сверка с session.companyId →
//   свежие User.isActive и UserRole из БД. JWT — только доказательство личности (userId+companyId),
//   НЕ источник прав. Немедленный отзыв: блокировка/смена ролей действуют со следующего запроса.
// Полная проверка — здесь (server, есть БД); middleware остаётся edge-проверкой подписи cookie.

export interface HostCompany {
  id: string;
  slug: string;
  name: string;
}

// Доверенный host текущего запроса. nginx на prod и staging проксирует Host $host (проверено),
// поэтому источник один — заголовок Host; произвольным proxy-заголовкам не доверяем.
export async function requestHost(): Promise<string | null> {
  const h = await headers();
  return h.get("host");
}

// Организация из host текущего запроса. company=null (+error) — host не резолвится или нет такой Company.
export async function resolveHostCompany(): Promise<{ company: HostCompany | null; error?: string }> {
  const res = orgSlugFromHost(await requestHost());
  if (res.slug === null) return { company: null, error: res.error };
  const company = await prisma.company.findUnique({
    where: { slug: res.slug },
    select: { id: true, slug: true, name: true },
  });
  if (!company) return { company: null, error: "Организация не найдена" };
  return { company };
}

// Свежая server-side сессия: сверяет host==companyId и читает актуальные isActive + UserRole.
// null при любом отказе: host не резолвится, host≠companyId (mismatch), пользователь отсутствует
// или заблокирован. Роли — всегда из свежего UserRole (fallback [User.role], если строк нет).
export async function freshSession(base: SessionData): Promise<SessionData | null> {
  const { company } = await resolveHostCompany();
  if (!company) return null; // неизвестный/некорректный host
  if (company.id !== base.companyId) return null; // host принадлежит другой организации
  const user = await prisma.user.findFirst({
    where: { id: base.userId, companyId: company.id },
    select: { isActive: true, role: true, name: true, userRoles: { select: { role: true } } },
  });
  if (!user || !user.isActive) return null; // отсутствует или заблокирован
  const roles = sanitizeRoles(user.userRoles.map((r) => r.role), user.role as Role);
  return { ...base, role: user.role as Role, roles, name: user.name };
}

// Единая точка получения сессии для всех защищённых мест.
//   TENANT_AUTH=false → прежнее поведение (личность и права из JWT).
//   TENANT_AUTH=true  → свежая проверка из БД; null при отказе (deny).
export async function currentSession(): Promise<SessionData | null> {
  const base = await getSession();
  if (!base) return null;
  if (!tenantAuthEnabled()) return base;
  return freshSession(base);
}
