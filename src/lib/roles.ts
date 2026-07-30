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

// Приоритет ролей (Этап 5): для навигации и для compatibility-поля User.role.
// ADMIN > RECEIVER > LOADER > PICKER > CONTROLLER > OBSERVER > STOREKEEPER > EMPLOYEE.
export const ROLE_PRIORITY: readonly Role[] = [
  "ADMIN",
  "RECEIVER",
  "LOADER",
  "PICKER",
  "CONTROLLER",
  "OBSERVER",
  "STOREKEEPER",
  "EMPLOYEE",
];

// Рабочие роли, для которых начинается смена (выбор ОДНОЙ роли + склад). ADMIN/OBSERVER — нет.
export const WORK_ROLES: readonly Role[] = ["RECEIVER", "LOADER", "PICKER", "CONTROLLER"];
export function isWorkRole(role: Role): boolean {
  return WORK_ROLES.includes(role);
}

// Наивысшая по приоритету роль из набора (для compat User.role и навигации). null — пустой набор.
export function highestRole(roles: readonly Role[]): Role | null {
  return ROLE_PRIORITY.find((r) => roles.includes(r)) ?? null;
}

// Серверные runtime-флаги (НЕ NEXT_PUBLIC): читаются на каждом решении, чтобы выключение
// флага сразу возвращало прежнее поведение без пересборки.
export function rolesDualReadEnabled(): boolean {
  return process.env.ROLES_DUAL_READ === "true";
}
export function tenantAuthEnabled(): boolean {
  return process.env.TENANT_AUTH === "true";
}
// Этап 5/Пакет 2: очередь задач. false — пункт меню скрыт, действия очереди запрещены.
export function workflowTasksEnabled(): boolean {
  return process.env.WORKFLOW_TASKS_ENABLED === "true";
}
// Этап 5/Пакет 3: зоны и уровни ячеек. false — карточка склада работает в прежнем режиме
// (плоский список ячеек + переключатель «зона выдачи»); true — секции зон, уровни, смена зоны.
export function warehouseZonesEnabled(): boolean {
  return process.env.WAREHOUSE_ZONES_ENABLED === "true";
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

// Складской персонал: админ или кладовщик (старые операционные страницы).
export function isStaff(session: SessionData): boolean {
  return hasAnyRole(session, ["ADMIN", "STOREKEEPER"]);
}

// Read-only просмотр склада (остатки/история): все роли, кроме чистого EMPLOYEE.
// НЕ даёт операционных прав — только чтение (см. requireWarehouseViewerPage).
export const VIEWER_ROLES: readonly Role[] = [
  "ADMIN",
  "STOREKEEPER",
  "RECEIVER",
  "LOADER",
  "PICKER",
  "CONTROLLER",
  "OBSERVER",
];
export function isWarehouseViewer(session: SessionData): boolean {
  return hasAnyRole(session, VIEWER_ROLES);
}

// Переходная навигационная роль: наивысшая по приоритету из эффективного набора.
// Выбор активной роли пользователем — Этап 5; здесь только детерминированная свёртка,
// чтобы, например, ADMIN+STOREKEEPER получил админ-навигацию, а STOREKEEPER+EMPLOYEE —
// навигацию кладовщика (не employee-ветку).
export function navRole(session: SessionData): Role {
  const eff = effectiveRoles(session);
  return ROLE_PRIORITY.find((r) => eff.includes(r)) ?? session.role;
}
