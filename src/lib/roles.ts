import type { Role, SessionData } from "@/lib/jwt";

// Единая политика ролей для серверных решений о доступе/видимости (Этап 4B/S2 — dual-read).
//
// Все решения о правах должны идти ЧЕРЕЗ этот helper, а не читать session.role напрямую.
// Флаг ROLES_DUAL_READ переключает источник ролей без отката БД:
//   false (по умолчанию) → права только по legacy session.role (поведение до S2);
//   true               → права по набору session.roles (из UserRole), fallback [session.role].
//
// Здесь НЕТ запросов к БД: работаем только с уже готовой сессией (JWT). Проверка свежих
// ролей/isActive на каждом запросе и немедленный отзыв — это S3, не S2.

// Приоритет ролей для переходной навигации и одиночных решений: ADMIN > STOREKEEPER > EMPLOYEE.
const ROLE_PRIORITY: readonly Role[] = ["ADMIN", "STOREKEEPER", "EMPLOYEE"];

// Серверные runtime-флаги (НЕ NEXT_PUBLIC): читаются на каждом решении, чтобы выключение
// флага сразу возвращало прежнее поведение без пересборки.
export function rolesDualReadEnabled(): boolean {
  return process.env.ROLES_DUAL_READ === "true";
}
export function tenantAuthEnabled(): boolean {
  return process.env.TENANT_AUTH === "true";
}

// Эффективный набор ролей.
// При TENANT_AUTH=true роли всегда берутся из session.roles (их наполняет свежая
// проверка из БД в @/lib/tenant-auth) — независимо от ROLES_DUAL_READ.
// При TENANT_AUTH=false: ROLES_DUAL_READ=true → session.roles; иначе legacy [session.role].
export function effectiveRoles(session: SessionData): Role[] {
  const useRoleSet = tenantAuthEnabled() || rolesDualReadEnabled();
  if (!useRoleSet) return [session.role];
  return session.roles && session.roles.length > 0 ? session.roles : [session.role];
}

export function hasRole(session: SessionData, role: Role): boolean {
  return effectiveRoles(session).includes(role);
}

export function hasAnyRole(session: SessionData, roles: readonly Role[]): boolean {
  const eff = effectiveRoles(session);
  return roles.some((r) => eff.includes(r));
}

// Складской персонал: админ или кладовщик.
export function isStaff(session: SessionData): boolean {
  return hasAnyRole(session, ["ADMIN", "STOREKEEPER"]);
}

// Переходная навигационная роль: наивысшая по приоритету из эффективного набора.
// Выбор активной роли пользователем — Этап 5; здесь только детерминированная свёртка,
// чтобы, например, ADMIN+STOREKEEPER получил админ-навигацию, а STOREKEEPER+EMPLOYEE —
// навигацию кладовщика (не employee-ветку).
export function navRole(session: SessionData): Role {
  const eff = effectiveRoles(session);
  return ROLE_PRIORITY.find((r) => eff.includes(r)) ?? session.role;
}
