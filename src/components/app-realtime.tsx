"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";

// Онлайн-обновления: слушаем SSE /api/realtime и по релевантным событиям делаем
// router.refresh() (серия событий схлопывается в одно обновление). Несохранённый
// ввод не перетираем: если пользователь начал заполнять форму — вместо обновления
// показываем плашку «Документ изменился». Пока открыта скан-шторка (WorkflowSheet),
// автообновление не выполняется, чтобы не сбить шаг сканирования.

interface RtEvent {
  type: string;
  entity?: string;
  entityId?: string;
  warehouseIds?: string[];
  actorUserId?: string;
  createdAt?: string;
}

const REFRESH_DEBOUNCE_MS = 700;
const OFFLINE_AFTER_MS = 15_000;

// какие сущности важны для текущего экрана (уменьшаем лишние refresh)
function isRelevant(path: string, ev: RtEvent): boolean {
  if (ev.type === "hello") return false;
  const e = ev.entity ?? "";
  // рабочие агрегирующие экраны — обновляем почти на всё
  if (
    path === "/warehouse/active" ||
    path === "/warehouse/feed" ||
    path === "/warehouse/history" ||
    path === "/warehouse/my" ||
    path === "/warehouse/staging" ||
    path === "/warehouse/docs"
  )
    return true;
  if (path.startsWith("/warehouse/stock")) return ["stock", "cell", "item"].includes(e);
  if (path.startsWith("/warehouse/cells/")) return ["stock", "cell", "picklist", "issue"].includes(e);
  if (path.startsWith("/warehouse/warehouses")) return ["stock", "cell", "warehouse"].includes(e);
  if (path.startsWith("/warehouse/orders")) return ["order", "receipt"].includes(e);
  if (path.startsWith("/warehouse/receipts")) return ["receipt", "order"].includes(e);
  if (path.startsWith("/warehouse/picklists")) return ["picklist", "transfer", "issue"].includes(e);
  if (path.startsWith("/warehouse/transfers")) return ["transfer", "picklist"].includes(e);
  if (path.startsWith("/warehouse/issues")) return ["issue", "picklist"].includes(e);
  if (path.startsWith("/warehouse/writeoffs")) return e === "writeoff";
  if (path.startsWith("/warehouse/inventories")) return e === "inventory";
  if (path.startsWith("/warehouse/items")) return ["item", "stock"].includes(e);
  if (path.startsWith("/warehouse/employees")) return e === "employee";
  if (path.startsWith("/warehouse/tasks")) return e === "task";
  if (path.startsWith("/warehouse/receiving")) return false; // форма приёмки — без автообновления
  if (path.startsWith("/warehouse/suppliers")) return false;
  if (path.startsWith("/warehouse/settings") || path.startsWith("/warehouse/more")) return false;
  return true;
}

type ConnState = "connecting" | "online" | "reconnecting" | "offline";

export function AppRealtimeProvider() {
  const router = useRouter();
  const pathname = usePathname();
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  const [conn, setConn] = useState<ConnState>("connecting");
  const [banner, setBanner] = useState(false); // «документ изменился», когда есть несохранённый ввод
  const [flash, setFlash] = useState(false); // «обновлено только что»

  const dirtyRef = useRef(false); // пользователь что-то ввёл и не сохранил
  const pendingRef = useRef(false); // событие пришло при открытой скан-шторке — обновим после закрытия
  const sheetWatcher = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const offlineTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doRefresh = useCallback(() => {
    router.refresh();
    setFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(false), 2000);
  }, [router]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return; // уже запланировано — серия схлопнется
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      // скан-шторка открыта — не сбиваем шаг: откладываем и обновим после закрытия
      if (document.querySelector("[data-workflow-sheet]")) {
        pendingRef.current = true;
        if (!sheetWatcher.current) {
          sheetWatcher.current = setInterval(() => {
            if (document.querySelector("[data-workflow-sheet]")) return;
            clearInterval(sheetWatcher.current!);
            sheetWatcher.current = null;
            if (!pendingRef.current) return;
            pendingRef.current = false;
            if (dirtyRef.current) setBanner(true);
            else doRefresh();
          }, 1000);
        }
        return;
      }
      if (dirtyRef.current) {
        setBanner(true); // не перетираем несохранённый ввод
        return;
      }
      doRefresh();
    }, REFRESH_DEBOUNCE_MS);
  }, [doRefresh]);

  // Отслеживание несохранённого ввода: dirty — только ввод внутри форм
  // редактирования (обычный <form> или поле с form=«id»). Поиск и фильтры
  // (формы с data-realtime-ignore-dirty, одиночные поля вне форм) не считаются:
  // по ним автообновление продолжает работать без плашки.
  useEffect(() => {
    const markDirty = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (!t.matches("input, textarea, select") || t.matches('[type="hidden"]')) return;
      const form =
        t.closest("form") ??
        (t.getAttribute("form")
          ? document.getElementById(t.getAttribute("form")!)
          : null);
      if (!form || form.hasAttribute("data-realtime-ignore-dirty")) return;
      dirtyRef.current = true;
    };
    const clearDirty = () => {
      dirtyRef.current = false;
      setBanner(false);
    };
    document.addEventListener("input", markDirty, true);
    document.addEventListener("submit", clearDirty, true);
    return () => {
      document.removeEventListener("input", markDirty, true);
      document.removeEventListener("submit", clearDirty, true);
    };
  }, []);

  useEffect(() => {
    // навигация — прежний ввод неактуален
    dirtyRef.current = false;
    setBanner(false);
  }, [pathname]);

  useEffect(() => {
    let es: EventSource | null = null;
    let stopped = false;

    const markOfflineSoon = () => {
      if (offlineTimer.current) clearTimeout(offlineTimer.current);
      offlineTimer.current = setTimeout(() => setConn("offline"), OFFLINE_AFTER_MS);
    };

    function connect() {
      if (stopped) return;
      es = new EventSource("/api/realtime");
      es.onopen = () => {
        if (offlineTimer.current) clearTimeout(offlineTimer.current);
        setConn("online");
      };
      es.onerror = () => {
        // EventSource переподключается сам (retry с сервера)
        setConn((c) => (c === "offline" ? c : "reconnecting"));
        markOfflineSoon();
      };
      es.onmessage = (msg) => {
        let ev: RtEvent;
        try {
          ev = JSON.parse(msg.data);
        } catch {
          return;
        }
        if (!isRelevant(pathRef.current ?? "", ev)) return;
        scheduleRefresh();
      };
    }

    connect();
    return () => {
      stopped = true;
      if (offlineTimer.current) clearTimeout(offlineTimer.current);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      if (sheetWatcher.current) clearInterval(sheetWatcher.current);
      es?.close();
    };
  }, [scheduleRefresh]);

  return (
    <>
      {/* Плашка: данные на экране изменились, но у пользователя несохранённый ввод */}
      {banner && (
        <div className="fixed inset-x-3 bottom-20 z-[75] mx-auto flex max-w-sm items-center gap-3 rounded-xl bg-[#1a1a2e] px-4 py-3 text-sm text-white shadow-[0_8px_30px_rgba(0,0,0,0.35)] lg:bottom-6">
          <span className="min-w-0 flex-1">Документ изменился в другой вкладке. Обновить данные?</span>
          <button
            type="button"
            className="shrink-0 rounded-lg bg-white/15 px-3 py-1.5 font-semibold active:bg-white/25"
            onClick={() => {
              dirtyRef.current = false;
              setBanner(false);
              doRefresh();
            }}
          >
            Обновить
          </button>
          <button
            type="button"
            className="shrink-0 px-1 py-1.5 text-white/70 active:text-white"
            onClick={() => setBanner(false)}
          >
            Позже
          </button>
        </div>
      )}

      {/* Индикатор состояния синхронизации: показываем только проблемы и краткое «обновлено» */}
      {conn === "reconnecting" && (
        <div className="pointer-events-none fixed bottom-20 right-3 z-[74] rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800 shadow lg:bottom-4">
          Восстанавливаем соединение…
        </div>
      )}
      {conn === "offline" && (
        <div className="pointer-events-none fixed bottom-20 right-3 z-[74] rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700 shadow lg:bottom-4">
          Нет онлайн-обновлений — данные могут быть устаревшими
        </div>
      )}
      {flash && conn === "online" && (
        <div className="pointer-events-none fixed bottom-20 right-3 z-[74] rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-700 shadow lg:bottom-4">
          Обновлено только что
        </div>
      )}
    </>
  );
}
