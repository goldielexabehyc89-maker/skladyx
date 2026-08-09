"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftRight,
  Bell,
  Briefcase,
  ClipboardList,
  Clock,
  Factory,
  Handshake,
  History,
  Inbox,
  ListChecks,
  ListTodo,
  Menu,
  Package,
  PackagePlus,
  ScanLine,
  Settings,
  ShoppingCart,
  Tags,
  Trash2,
  Truck,
  Users,
  Warehouse,
  Zap,
} from "lucide-react";
import type { Role } from "@/lib/jwt";
import { logoutAction } from "@/app/actions/auth";

// Навигация: на десктопе постоянный сайдбар (сворачиваемый ←) с меню, сгруппированным
// по смыслу (Работа / Документы / Справочники / Контроль / Моё); на мобильном —
// верхняя панель с бургером + нижний таб-бар с главными разделами и кнопкой «Ещё».

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}
interface NavGroup {
  title: string;
  items: NavItem[];
}

const ACTIVE: NavItem = { href: "/warehouse/active", label: "Активные", icon: Zap };
const SCAN: NavItem = { href: "/warehouse/scan", label: "Сканировать", icon: ScanLine };
const RECEIPTS: NavItem = { href: "/warehouse/receipts", label: "Приемка", icon: Inbox };
const STAGING: NavItem = { href: "/warehouse/staging", label: "Зона выдачи", icon: Truck };
const ORDERS: NavItem = { href: "/warehouse/orders", label: "Заказы поставщикам", icon: ShoppingCart };
const PICKLISTS: NavItem = { href: "/warehouse/picklists", label: "Заявки на сбор", icon: ClipboardList };
const TRANSFERS: NavItem = { href: "/warehouse/transfers", label: "Перемещения", icon: ArrowLeftRight };
const ISSUES: NavItem = { href: "/warehouse/issues", label: "Выдачи", icon: Handshake };
const WRITEOFFS: NavItem = { href: "/warehouse/writeoffs", label: "Списания", icon: Trash2 };
const INVENTORIES: NavItem = { href: "/warehouse/inventories", label: "Инвентаризации", icon: ListChecks };
const STOCK: NavItem = { href: "/warehouse/stock", label: "Остатки", icon: Package };
const ITEMS: NavItem = { href: "/warehouse/items", label: "Номенклатура", icon: Tags };
const WAREHOUSES: NavItem = { href: "/warehouse/warehouses", label: "Склады и ячейки", icon: Warehouse };
const SUPPLIERS: NavItem = { href: "/warehouse/suppliers", label: "Поставщики", icon: Factory };
const EMPLOYEES: NavItem = { href: "/warehouse/employees", label: "Сотрудники", icon: Users };
const HISTORY: NavItem = { href: "/warehouse/history", label: "История", icon: History };
const FEED: NavItem = { href: "/warehouse/feed", label: "Лента событий", icon: Bell };
const SETTINGS: NavItem = { href: "/warehouse/settings", label: "Настройки", icon: Settings };
const MY: NavItem = { href: "/warehouse/my", label: "Мои ТМЦ", icon: Briefcase };
const SHIFT: NavItem = { href: "/warehouse/shift", label: "Смена", icon: Clock };
const TASKS: NavItem = { href: "/warehouse/tasks", label: "Задачи", icon: ListTodo };
// ADMIN: рабочая очередь активной смены (?view=mine) отделена от административного монитора всех
// задач (?view=monitor). Монитор — постоянное полномочие ADMIN; «Мои задачи» — только при активной
// рабочей смене LOADER/PICKER/CONTROLLER (ROLE-003).
const TASKS_MINE: NavItem = { href: "/warehouse/tasks?view=mine", label: "Мои задачи", icon: ListTodo };
const TASKS_MONITOR: NavItem = { href: "/warehouse/tasks?view=monitor", label: "Монитор задач", icon: ListTodo };
const RECEIVING_GROUP: NavItem = { href: "/warehouse/receiving", label: "Приёмка группами", icon: PackagePlus };

const WORK_ROLES = ["RECEIVER", "LOADER", "PICKER", "CONTROLLER"] as const;

// Пакет 9B: пункты СТАРОГО интерфейса склада — скрываются при legacyUi=false (код страниц не удалён).
const LEGACY_HREFS = new Set<string>([
  ACTIVE.href, SCAN.href, RECEIPTS.href, STAGING.href, ORDERS.href, PICKLISTS.href,
  TRANSFERS.href, ISSUES.href, WRITEOFFS.href, INVENTORIES.href, SUPPLIERS.href, MY.href,
]);

// role — переходная навигационная роль (профиль меню); canStartShift — есть ли у пользователя
// рабочая роль (тогда даже у ADMIN показываем «Смену»); tasksEnabled — флаг очереди задач;
// canReceive — есть роль RECEIVER; groupReceiving — флаг групповой приёмки (Пакет 4);
// legacyUi — виден ли старый интерфейс (false → legacy-пункты убираются, пустые группы отбрасываются).
function groupsFor(
  role: Role,
  activeShiftRole: Role | null,
  canStartShift: boolean,
  tasksEnabled: boolean,
  canReceive: boolean,
  groupReceiving: boolean,
  legacyUi: boolean,
): NavGroup[] {
  // ROLE-003: операционный рабочий пункт определяется АКТИВНОЙ сменой, а не назначенными ролями.
  // RECEIVER-смена → «Приёмка»; LOADER/PICKER/CONTROLLER-смена → задачи (для ADMIN — «Мои задачи»
  // ?view=mine); без активной рабочей смены операционного пункта нет. canReceive оставлен как
  // дополнительный guard, но сам по себе (без активной смены) «Приёмку» не показывает.
  const opItems = (tasksItem: NavItem): NavItem[] => {
    if (activeShiftRole === "RECEIVER") return groupReceiving && canReceive ? [{ ...RECEIVING_GROUP, label: "Приёмка" }] : [];
    if (activeShiftRole && (["LOADER", "PICKER", "CONTROLLER"] as string[]).includes(activeShiftRole)) return tasksEnabled ? [tasksItem] : [];
    return [];
  };
  let raw: NavGroup[];
  if (role === "ADMIN")
    raw = [
      { title: "Работа", items: [ACTIVE, SCAN, RECEIPTS, STAGING, ...opItems(TASKS_MINE), ...(canStartShift ? [SHIFT] : [])] },
      { title: "Документы", items: [ORDERS, PICKLISTS, TRANSFERS, ISSUES, WRITEOFFS, INVENTORIES] },
      { title: "Справочники", items: [STOCK, ITEMS, WAREHOUSES, SUPPLIERS, EMPLOYEES] },
      { title: "Контроль", items: [...(tasksEnabled ? [TASKS_MONITOR] : []), HISTORY, FEED, SETTINGS] },
      { title: "Моё", items: [MY] },
    ];
  else if (role === "STOREKEEPER")
    raw = [
      { title: "Работа", items: [ACTIVE, SCAN, RECEIPTS, STAGING] },
      { title: "Документы", items: [TRANSFERS, ISSUES] },
      { title: "Справочники", items: [STOCK] },
      { title: "Контроль", items: [HISTORY, FEED] },
      { title: "Моё", items: [MY] },
    ];
  // Новые рабочие роли (Этап 5): ROLE-003 — операционный пункт определяется АКТИВНОЙ сменой, а не
  // всеми назначенными ролями. RECEIVER → «Приёмка» (без «Задач»); LOADER/PICKER/CONTROLLER → «Задачи»
  // (без «Приёмки»); без смены — только «Смена». Просмотр остаётся всегда.
  else if ((WORK_ROLES as readonly string[]).includes(role)) {
    raw = [
      { title: "Работа", items: [...opItems(TASKS), SHIFT] },
      { title: "Просмотр", items: [STOCK, HISTORY] },
      { title: "Моё", items: [MY, FEED] },
    ];
  }
  // Наблюдатель — только просмотр: остатки, история, лента.
  else if (role === "OBSERVER") raw = [{ title: "Просмотр", items: [STOCK, HISTORY, FEED] }];
  else raw = [{ title: "Моё", items: [MY, FEED] }];

  if (legacyUi) return raw;
  return raw
    .map((g) => ({ ...g, items: g.items.filter((it) => !LEGACY_HREFS.has(it.href)) }))
    .filter((g) => g.items.length > 0);
}

function NavContent({
  role,
  activeShiftRole,
  canStartShift,
  tasksEnabled,
  canReceive,
  groupReceiving,
  legacyUi,
  homeHref,
  name,
  collapsed,
  onNavigate,
  onToggleCollapse,
}: {
  role: Role;
  activeShiftRole: Role | null;
  canStartShift: boolean;
  tasksEnabled: boolean;
  canReceive: boolean;
  groupReceiving: boolean;
  legacyUi: boolean;
  homeHref: string;
  name: string;
  collapsed: boolean;
  onNavigate?: () => void;
  onToggleCollapse?: () => void;
}) {
  const pathname = usePathname();
  const groups = groupsFor(role, activeShiftRole, canStartShift, tasksEnabled, canReceive, groupReceiving, legacyUi);
  const [loggingOut, setLoggingOut] = useState(false);
  // Пакет 10 (fix): server-logout очищает cookie, затем ПОЛНАЯ навигация на /login (window.location) —
  // свежий серверный рендер по актуальному Host, без встроенного/закэшированного RSC другого host.
  async function handleLogout() {
    setLoggingOut(true);
    try { await logoutAction(); } catch { /* всё равно уходим на /login */ }
    window.location.assign("/login");
  }

  const itemClass = (active: boolean) =>
    clsx(
      "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition",
      active
        ? "bg-[#1a1a1a] text-white shadow-[0_2px_8px_rgba(0,0,0,0.25)]"
        : "text-[#555] hover:bg-[#f0f1f9]",
      collapsed && "justify-center px-2",
    );

  return (
    <div className="flex h-full flex-col">
      <div
        className={clsx(
          "flex items-center px-4 pb-2 pt-4",
          collapsed ? "justify-center" : "justify-between",
        )}
      >
        {!collapsed && (
          <Link href={homeHref} className="text-[15px] font-bold tracking-wide text-[#3d3460]">
            SkladyX
          </Link>
        )}
        {onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label={collapsed ? "Развернуть меню" : "Свернуть меню"}
            className="rounded-lg border border-[#e4e4f0] bg-white px-2.5 py-1.5 text-sm text-[#9e97c0] transition hover:bg-neutral-50"
          >
            {collapsed ? "→" : "←"}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {groups.map((g) => (
          <div key={g.title} className={clsx(collapsed && "mt-2 border-t border-[#ecebf5] pt-2")}>
            {!collapsed && (
              <div className="px-3 pb-1 pt-3 text-[11px] font-bold uppercase tracking-wider text-[#9e97c0]">
                {g.title}
              </div>
            )}
            <div className="flex flex-col gap-0.5">
              {g.items.map((item) => {
                const active = pathname.startsWith(item.href);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onNavigate}
                    title={item.label}
                    className={itemClass(active)}
                  >
                    <Icon size={17} className="shrink-0" />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div
        className={clsx(
          "flex items-center gap-2 border-t border-[#f0edf8] px-4 py-3",
          collapsed ? "justify-center" : "justify-between",
        )}
      >
        {!collapsed && <span className="truncate text-sm font-medium text-[#555]">{name}</span>}
        <button
          type="button"
          onClick={handleLogout}
          disabled={loggingOut}
          title="Выйти"
          className="rounded-lg border border-[#e4e4f0] bg-white px-3 py-1.5 text-xs font-medium text-[#666] transition hover:bg-neutral-50 disabled:opacity-60"
        >
          {collapsed ? "⎋" : loggingOut ? "…" : "Выйти"}
        </button>
      </div>
    </div>
  );
}

// Нижний таб-бар (только мобильный): главные разделы + «Ещё» с полным меню.
function MobileTabBar({ role, activeShiftRole, tasksEnabled, groupReceiving, legacyUi, onMore }: { role: Role; activeShiftRole: Role | null; tasksEnabled: boolean; groupReceiving: boolean; legacyUi: boolean; onMore: () => void }) {
  const pathname = usePathname();
  // ROLE-003: у рабочей роли главная вкладка — по активной смене (RECEIVER→Приёмка, иначе Задачи);
  // без смены — «Смена».
  const isLpc = !!activeShiftRole && (["LOADER", "PICKER", "CONTROLLER"] as string[]).includes(activeShiftRole);
  const workTabs: NavItem[] =
    activeShiftRole === "RECEIVER"
      ? [...(groupReceiving ? [{ ...RECEIVING_GROUP, label: "Приёмка" }] : []), SHIFT, STOCK]
      : isLpc
        ? [...(tasksEnabled ? [TASKS] : []), SHIFT, STOCK]
        : [SHIFT, STOCK, { ...HISTORY, label: "История" }];
  // ROLE-003: у ADMIN мобильный операционный таб — тоже по активной смене; без смены — «Монитор».
  const adminTabs: NavItem[] =
    activeShiftRole === "RECEIVER"
      ? [...(groupReceiving ? [{ ...RECEIVING_GROUP, label: "Приёмка" }] : []), STOCK, { ...HISTORY, label: "История" }]
      : isLpc
        ? [...(tasksEnabled ? [{ ...TASKS_MINE, label: "Мои задачи" }] : []), STOCK, { ...HISTORY, label: "История" }]
        : [...(tasksEnabled ? [{ ...TASKS_MONITOR, label: "Монитор" }] : []), STOCK, { ...HISTORY, label: "История" }];
  let tabs: NavItem[] =
    role === "EMPLOYEE"
      ? [MY, { ...SCAN, label: "Сканер" }, { ...FEED, label: "Лента" }]
      : role === "OBSERVER"
        ? [STOCK, { ...HISTORY, label: "История" }, { ...FEED, label: "Лента" }]
        : (WORK_ROLES as readonly string[]).includes(role)
          ? workTabs
          : role === "ADMIN"
            ? adminTabs
            : [ACTIVE, { ...SCAN, label: "Сканер" }, STOCK];

  // Пакет 9B: старый интерфейс выключен → убираем legacy-вкладки и добираем безопасными разделами
  // (для ADMIN — монитор задач/справочники/контроль), сохраняя 3 слота + «Ещё».
  if (!legacyUi) {
    const pool: NavItem[] = [...(tasksEnabled ? [TASKS] : []), STOCK, { ...HISTORY, label: "История" }, { ...FEED, label: "Лента" }];
    tabs = tabs.filter((t) => !LEGACY_HREFS.has(t.href));
    for (const p of pool) {
      if (tabs.length >= 3) break;
      if (!tabs.some((t) => t.href === p.href)) tabs.push(p);
    }
    tabs = tabs.slice(0, 3);
  }

  return (
    <nav
      className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-[#e0e2ef] bg-white shadow-[0_-2px_12px_rgba(20,20,60,0.08)] lg:hidden"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 4px)" }}
    >
      <div className="grid grid-cols-4">
        {tabs.map((t) => {
          const active = pathname.startsWith(t.href);
          const Icon = t.icon;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={clsx(
                "flex min-h-14 flex-col items-center justify-center gap-1 whitespace-nowrap text-[11px] font-semibold",
                active ? "text-[#4c5fd7]" : "text-neutral-500",
              )}
            >
              <Icon size={22} strokeWidth={active ? 2.4 : 2} />
              {t.label}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={onMore}
          className="flex min-h-14 flex-col items-center justify-center gap-1 whitespace-nowrap text-[11px] font-semibold text-neutral-500"
        >
          <Menu size={22} />
          Ещё
        </button>
      </div>
    </nav>
  );
}

export function AppNav({
  role,
  roles,
  activeShiftRole,
  name,
  tasksEnabled,
  groupReceivingEnabled = false,
  legacyUi = true,
  homeHref = "/warehouse",
}: {
  role: Role;
  roles: Role[];
  activeShiftRole: Role | null;
  name: string;
  tasksEnabled: boolean;
  groupReceivingEnabled?: boolean;
  legacyUi?: boolean;
  homeHref?: string;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  // «Смена» показываем всем с рабочей ролью — включая ADMIN с дополнительной рабочей ролью.
  const canStartShift = roles.some((r) => (WORK_ROLES as readonly string[]).includes(r));
  // «Приёмка группами» — только для роли RECEIVER (страница дополнительно требует активную смену).
  const canReceive = roles.includes("RECEIVER");

  return (
    <>
      {/* Десктоп: постоянный сайдбар */}
      <aside
        className={clsx(
          "no-print my-2 ml-2 hidden shrink-0 flex-col overflow-hidden rounded-xl border border-[#e7e8f2] bg-[#f7f8fc] shadow-[0_2px_12px_rgba(20,20,60,0.06)] transition-all lg:flex",
          collapsed ? "w-14" : "w-56",
        )}
      >
        <NavContent
          role={role}
          activeShiftRole={activeShiftRole}
          canStartShift={canStartShift}
          tasksEnabled={tasksEnabled}
          canReceive={canReceive}
          groupReceiving={groupReceivingEnabled}
          legacyUi={legacyUi}
          homeHref={homeHref}
          name={name}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
        />
      </aside>

      {/* Мобильный: верхняя панель с бургером */}
      <header className="no-print sticky top-0 z-20 flex h-12 items-center justify-between border-b border-[#e7e8f2] bg-white px-3 lg:hidden">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Открыть меню"
            className="rounded-lg p-2 active:bg-neutral-100"
          >
            <Menu size={20} />
          </button>
          <span className="text-sm font-bold text-[#3d3460]">SkladyX · Склад</span>
        </div>
        <span className="max-w-32 truncate text-sm text-neutral-500">{name}</span>
      </header>

      {/* Мобильный: нижний таб-бар */}
      <MobileTabBar role={role} activeShiftRole={activeShiftRole} tasksEnabled={tasksEnabled} groupReceiving={groupReceivingEnabled} legacyUi={legacyUi} onMore={() => setMobileOpen(true)} />

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <nav className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col overflow-y-auto bg-white shadow-[4px_0_24px_rgba(0,0,0,0.12)]">
            <div className="flex justify-end px-3 pt-3">
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="Закрыть меню"
                className="rounded-lg px-2.5 py-1 text-lg text-[#9e97c0] active:bg-neutral-100"
              >
                ✕
              </button>
            </div>
            <NavContent
              role={role}
              activeShiftRole={activeShiftRole}
              canStartShift={canStartShift}
              tasksEnabled={tasksEnabled}
              canReceive={canReceive}
              groupReceiving={groupReceivingEnabled}
              legacyUi={legacyUi}
              homeHref={homeHref}
              name={name}
              collapsed={false}
              onNavigate={() => setMobileOpen(false)}
            />
          </nav>
        </div>
      )}
    </>
  );
}
