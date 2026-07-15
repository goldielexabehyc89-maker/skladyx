"use client";

import { Bell } from "lucide-react";
import { useEffect, useState } from "react";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

type State = "loading" | "unsupported" | "idle" | "on" | "working" | "denied";

export function PushSubscribeButton() {
  const [state, setState] = useState<State>("loading");

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setState("unsupported");
      return;
    }
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then(async (sub) => {
        if (!sub) {
          setState("idle");
          return;
        }
        // пересинхронизация на сервер — лечит потерю серверной записи
        try {
          const j = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
          await fetch("/api/push/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }),
          });
        } catch {
          /* не критично */
        }
        setState("on");
      })
      .catch(() => setState("idle"));
  }, []);

  async function enable() {
    setState("working");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setState("denied");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const vapid = (await fetch("/api/push/vapid").then((r) => r.json())) as { key?: string };
      if (!vapid.key) {
        setState("idle");
        return;
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid.key) as BufferSource,
      });
      const j = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }),
      });
      setState("on");
    } catch {
      setState("idle");
    }
  }

  if (state === "unsupported" || state === "loading") return null;
  if (state === "on")
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
        <Bell size={12} /> уведомления включены
      </span>
    );

  return (
    <button
      onClick={enable}
      disabled={state === "working"}
      className="rounded-xl border border-[#e4e4f0] bg-white px-3 py-2 text-sm font-medium active:bg-neutral-100 disabled:opacity-60"
    >
      {state === "working" ? (
        "…"
      ) : (
        <>
          <Bell size={16} /> Включить уведомления
        </>
      )}
      {state === "denied" && " (запрещено в браузере)"}
    </button>
  );
}
