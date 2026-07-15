"use client";

import { useEffect } from "react";

// Регистрирует service worker (нужно для установки PWA и push-уведомлений).
export function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* тихо игнорируем — не критично для работы сайта */
    });
  }, []);
  return null;
}
