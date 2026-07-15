"use client";

import { useEffect } from "react";

// Тихое авто-обновление: замечает новую версию на сервере и перезагружает
// приложение при возврате в него (или когда вкладка скрыта). Защита от циклов.
export function VersionWatcher() {
  useEffect(() => {
    let baseline: string | null = null;
    let stopped = false;

    async function fetchVersion(): Promise<string | null> {
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return null;
        const data = (await res.json()) as { v?: string };
        return data.v ?? null;
      } catch {
        return null;
      }
    }

    function guardedReload() {
      try {
        const KEY = "bld_ver_reload";
        const last = Number(sessionStorage.getItem(KEY) || 0);
        if (Date.now() - last < 20000) return;
        sessionStorage.setItem(KEY, String(Date.now()));
      } catch {
        /* sessionStorage недоступен */
      }
      location.reload();
    }

    async function check(fromReturn: boolean) {
      if (stopped) return;
      const v = await fetchVersion();
      if (!v) return;
      if (baseline === null) {
        baseline = v;
        return;
      }
      if (v !== baseline) {
        if (fromReturn || document.hidden) guardedReload();
      }
    }

    check(false);

    const onReturn = () => {
      if (document.visibilityState === "visible") check(true);
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    const timer = setInterval(() => check(false), 5 * 60 * 1000);

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
      clearInterval(timer);
    };
  }, []);

  return null;
}
