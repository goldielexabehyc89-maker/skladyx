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
// Этап 5/Пакет 4: групповая приёмка + температурный контроль. false — экран приёмки группами
// скрыт, action запрещён; старые процессы работают как раньше.
export function groupReceivingEnabled(): boolean {
  return process.env.GROUP_RECEIVING_ENABLED === "true";
}
// Этап 5/Пакет 5: охлаждение и срочный забор. false — группа > X размещается в COOLING как
// прежде (IN_COOLING без сессии); true — сессия охлаждения, резерв ячейки ур. 3+, срочная
// отложенная задача забора и повторный замер температуры.
export function coolingWorkflowEnabled(): boolean {
  return process.env.COOLING_WORKFLOW_ENABLED === "true";
}
// Этап 5/Пакет 6: внешние заказы, FIFO-резерв и сборка. false — импорт/резерв/сборка недоступны,
// экран задач сборки скрыт, action запрещён; остальные процессы работают как раньше.
export function externalOrderPickingEnabled(): boolean {
  return process.env.EXTERNAL_ORDER_PICKING_ENABLED === "true";
}
// Этап 5/Пакет 7: контроль заказа, исправление и полный повторный контроль. false — при переходе
// заказа в IN_CONTROL задача контроля НЕ создаётся (поведение Пакета 6 без изменений); действия
// контроля/исправления запрещены. true — авто-создание CONTROL_ORDER и цикл контроль→исправление.
export function orderControlEnabled(): boolean {
  return process.env.ORDER_CONTROL_ENABLED === "true";
}
// Этап 5/Пакет 8: размещение проверенного заказа в ячейки выдачи (ISSUE) и выдача водителю. false —
// после CONTROL_PASSED заказ остаётся в этом статусе (Пакет 7 заканчивается на контроле); действия
// размещения/выдачи запрещены. true — авто-резерв ячейки выдачи, задачи размещения и выдачи.
export function orderIssueEnabled(): boolean {
  return process.env.ORDER_ISSUE_ENABLED === "true";
}

// Этап 5/Пакет 9B: видимость СТАРОГО (legacy) интерфейса склада. В отличие от бизнес-флагов,
// по умолчанию ВКЛЮЧЁН — скрываем только при явном `false` (prod-совместимость: отсутствие
// переменной = старый UI пока доступен). false — legacy-пункты навигации скрыты, прямые
// legacy-маршруты редиректятся в новый интерфейс. Код и данные старых страниц не трогаются.
export function legacyWarehouseUiEnabled(): boolean {
  return process.env.LEGACY_WAREHOUSE_UI_ENABLED !== "false";
}

// Этап 5/Пакет 10: нейтральный REST-API интеграции (POST /api/integration/v1/{items,orders}).
// По умолчанию ВЫКЛЮЧЕН. Токен читается напрямую в роуте и сравнивается безопасно (timingSafeEqual);
// сюда НЕ выносим — чтобы не светить секрет в общих геттерах и логах.
export function integrationApiEnabled(): boolean {
  return process.env.INTEGRATION_API_ENABLED === "true";
}

// Сегменты СТАРОГО интерфейса склада — единый список для скрытия в навигации и редиректа прямых
// маршрутов при LEGACY_WAREHOUSE_UI_ENABLED=false (включая вложенные). Код страниц не удаляется.
export const LEGACY_WAREHOUSE_PATHS = [
  "/warehouse/active",
  "/warehouse/scan",
  "/warehouse/receipts",
  "/warehouse/staging",
  "/warehouse/orders",
  "/warehouse/picklists",
  "/warehouse/transfers",
  "/warehouse/issues",
  "/warehouse/writeoffs",
  "/warehouse/inventories",
  "/warehouse/suppliers",
  "/warehouse/my",
  "/warehouse/docs",
] as const;

// true — путь принадлежит СТАРОМУ интерфейсу (точное совпадение сегмента или вложенный маршрут).
// Аккуратная проверка границы сегмента, чтобы /warehouse/issues не задевал /warehouse/items и т.п.
export function isLegacyWarehousePath(pathname: string): boolean {
  return LEGACY_WAREHOUSE_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
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

// Пакет 10 (коррекция навигации): единый резолвер домашнего экрана роли. Используется и лендингом
// `/warehouse` (redirect), и логотипом навигации — чтобы nav ссылался ПРЯМО на реальную страницу, а не
// на редирект-маршрут `/warehouse` (иначе его prefetch кэширует редирект и перехватывает навигацию по
// `/warehouse/*`). Логика зеркалит src/app/warehouse/page.tsx.
// ROLE-003: основной рабочий экран определяется АКТИВНОЙ сменой, а не старшей назначенной ролью.
// activeShiftRole — роль текущей WorkShift (или null, если смены нет).
export function warehouseHomePath(session: SessionData, activeShiftRole?: Role | null): string {
  // Активная смена задаёт home рабочего сотрудника (приоритетнее административного профиля):
  // RECEIVER работает напрямую в «Приёмке», остальные рабочие роли — в «Задачах».
  if (activeShiftRole === "RECEIVER") return "/warehouse/receiving";
  if (activeShiftRole && isWorkRole(activeShiftRole)) return "/warehouse/tasks"; // LOADER/PICKER/CONTROLLER
  const role = navRole(session);
  const legacyUi = legacyWarehouseUiEnabled();
  const newHome = workflowTasksEnabled() ? "/warehouse/tasks" : "/warehouse/stock";
  if (role === "ADMIN" || role === "STOREKEEPER") return legacyUi ? "/warehouse/active" : newHome;
  if (role === "OBSERVER") return "/warehouse/stock";
  if (role === "EMPLOYEE") return legacyUi ? "/warehouse/my" : newHome;
  return "/warehouse/shift"; // рабочая роль без активной смены → начать смену
}
