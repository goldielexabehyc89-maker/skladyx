"use client";

import { useEffect } from "react";
import { activateDueTasksAction } from "@/app/actions/tasks";

// Пакет 5: лёгкий периодический триггер активации наступивших отложенных задач (срочный забор
// из охлаждения к estimatedReadyAt). Источник истины — БД (rebalanceQueuedTasks под lockCompany,
// идемпотентно, безопасно для нескольких экземпляров); это только «будильник». Назначение эмитит
// task_assigned → realtime сам обновит экран. Ошибки глушим (следующий тик повторит).
export function DueActivator() {
  useEffect(() => {
    let stopped = false;
    const tick = () => {
      if (!stopped) void activateDueTasksAction().catch(() => {});
    };
    tick(); // сразу при открытии экрана, затем каждые 30 секунд
    const t = setInterval(tick, 30_000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, []);
  return null;
}
