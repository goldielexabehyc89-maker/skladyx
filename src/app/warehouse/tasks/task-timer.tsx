"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

// TASK-008: живой таймер срочной/отложенной задачи. Режим зависит от жизненного цикла:
//   QUEUED + availableAt в будущем → «До активации» (обратный отсчёт);
//   QUEUED + срок наступил         → «Ожидает назначения» (прямой отсчёт от availableAt);
//   ASSIGNED                       → «Ожидает начала» (прямой отсчёт от assignedAt);
//   IN_PROGRESS                    → «В работе» (прямой отсчёт от startedAt).
// Время считается от переданного сервером serverNow + монотонного времени клиента (performance.now),
// а не от часов устройства. Никаких записей в БД; активацию выполняет серверный планировщик (TASK-007).
// При переходе обратного отсчёта к нулю — однократный router.refresh() (подтянуть серверное назначение).

function fmt(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const days = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const hms = `${pad(h)}:${pad(m)}:${pad(sec)}`;
  return days > 0 ? `${days} д ${hms}` : hms;
}

export function TaskTimer({
  serverNowIso,
  status,
  availableAtIso = null,
  assignedAtIso = null,
  startedAtIso = null,
  createdAtIso = null,
}: {
  serverNowIso: string;
  status: string;
  availableAtIso?: string | null;
  assignedAtIso?: string | null;
  startedAtIso?: string | null;
  createdAtIso?: string | null;
}) {
  const router = useRouter();
  const mountPerf = useRef<number>(typeof performance !== "undefined" ? performance.now() : 0);
  const serverNowMs = useRef<number>(new Date(serverNowIso).getTime());
  const refreshed = useRef(false);
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((v) => v + 1), 1000);
    return () => clearInterval(t); // освобождаем интервал при размонтировании
  }, []);

  if (status === "COMPLETED" || status === "CANCELLED") return null; // терминальные — без таймера

  const nowMs = serverNowMs.current + ((typeof performance !== "undefined" ? performance.now() : 0) - mountPerf.current);
  const avail = availableAtIso ? new Date(availableAtIso).getTime() : null;
  const asg = assignedAtIso ? new Date(assignedAtIso).getTime() : null;
  const st = startedAtIso ? new Date(startedAtIso).getTime() : null;
  const created = createdAtIso ? new Date(createdAtIso).getTime() : null;

  let label: string;
  let secs: number;
  if (status === "IN_PROGRESS" && st != null) {
    label = "В работе"; secs = (nowMs - st) / 1000;
  } else if (status === "ASSIGNED" && asg != null) {
    label = "Ожидает начала"; secs = (nowMs - asg) / 1000;
  } else if (status === "QUEUED" && avail != null && avail > nowMs) {
    label = "До активации"; secs = (avail - nowMs) / 1000;
  } else if (status === "QUEUED") {
    // срок наступил (или задача без availableAt) — ждёт назначения; однократный refresh при переходе
    if (avail != null && !refreshed.current) { refreshed.current = true; router.refresh(); }
    const base = avail ?? created ?? nowMs;
    label = "Ожидает назначения"; secs = (nowMs - base) / 1000;
  } else {
    return null; // прочие статусы без релевантного timestamp
  }

  return (
    <span role="timer" aria-live="off" className="inline-flex items-baseline gap-1 whitespace-nowrap tabular-nums font-mono text-xs text-neutral-600">
      <span>{label}</span>
      <b className="font-semibold text-[#1a1a1a]">{fmt(secs)}</b>
    </span>
  );
}
