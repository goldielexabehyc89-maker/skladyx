import "server-only";
import { prisma } from "@/lib/db";
import { rebalanceQueuedTasks } from "@/lib/workflow-tasks";
import { reserveAndPlanOrder } from "@/lib/external-orders";
import { workflowTasksEnabled, externalOrderPickingEnabled } from "@/lib/roles";

// TASK-007: серверная активация отложенных задач. Долгоживущий фоновый цикл app-процесса находит все
// организации с QUEUED-задачами, чей срок наступил (availableAt <= now или availableAt = null), и
// вызывает rebalanceQueuedTasks(companyId) под lockCompany — идемпотентно и безопасно при нескольких
// экземплярах и параллельных тиках (одно назначение, одно событие task_assigned). От открытых страниц
// не зависит. Ошибка одной организации/тика не останавливает последующие.

const DEFAULT_INTERVAL_MS = 15_000; // безопасный default
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 30_000; // зафиксированная гарантия «не реже раза в 30 секунд»
// Разрешён только диапазон 1000–30000; любое некорректное/выходящее за диапазон значение → 15000.
export function schedulerIntervalMs(): number {
  const raw = Number(process.env.SCHEDULER_INTERVAL_MS ?? "");
  if (!Number.isFinite(raw) || raw < MIN_INTERVAL_MS || raw > MAX_INTERVAL_MS) return DEFAULT_INTERVAL_MS;
  return raw;
}

// Один проход планировщика: назначает наступившие задачи по всем организациям. Возвращает число
// назначенных задач. Используется и циклом, и детерминированными тестами.
export async function runSchedulerOnce(): Promise<number> {
  if (!workflowTasksEnabled()) return 0;
  const now = new Date();
  const companies = await prisma.workflowTask.findMany({
    where: { status: "QUEUED", OR: [{ availableAt: null }, { availableAt: { lte: now } }] },
    select: { companyId: true },
    distinct: ["companyId"],
  });
  let assigned = 0;
  for (const c of companies) {
    try {
      assigned += await rebalanceQueuedTasks(c.companyId);
    } catch (e) {
      // Без секретов и внутренних ID: только текст ошибки.
      console.error("[scheduler] rebalance error:", e instanceof Error ? e.message : "unknown");
    }
  }
  return assigned;
}

// ORDER-003: один проход авто-возобновления BLOCKED-заказов. Находит организации с незавершёнными
// BLOCKED-заказами и повторно вызывает штатное reserveAndPlanOrder (под lockCompany, идемпотентно):
// причина устранена (освободилась нижняя ячейка) → ровно одна MOVE_GROUP + зависимая PICK_ORDER; причина
// не устранена → заказ остаётся BLOCKED без побочных изменений. Порядок детерминирован, пакет ограничен;
// состояние читается из БД (рестарт-безопасно), ошибка одного заказа/организации не рушит остальные.
const BLOCKED_BATCH = 50; // ограниченный пакет BLOCKED-заказов на организацию за тик
export async function replanBlockedOnce(): Promise<number> {
  if (!externalOrderPickingEnabled()) return 0;
  const companies = await prisma.externalOrder.findMany({
    where: { status: "BLOCKED" },
    select: { companyId: true },
    distinct: ["companyId"],
  });
  let replanned = 0;
  for (const c of companies) {
    try {
      // Детерминированный стабильный порядок: arrivalAt ASC (nulls last) → createdAt ASC → id ASC.
      const blocked = await prisma.externalOrder.findMany({
        where: { companyId: c.companyId, status: "BLOCKED" },
        orderBy: [{ arrivalAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }],
        take: BLOCKED_BATCH,
        select: { id: true },
      });
      for (const o of blocked) {
        try {
          const r = await reserveAndPlanOrder({ companyId: c.companyId, orderId: o.id });
          if (r.status !== "BLOCKED") replanned++;
        } catch (e) {
          console.error("[scheduler] replan order error:", e instanceof Error ? e.message : "unknown");
        }
      }
    } catch (e) {
      console.error("[scheduler] replan company error:", e instanceof Error ? e.message : "unknown");
    }
  }
  return replanned;
}

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;

export function startCoolingScheduler(): void {
  if (started) return; // один цикл на процесс
  started = true;
  const period = schedulerIntervalMs();
  const tick = () => {
    void runSchedulerOnce().catch((e) => console.error("[scheduler] tick error:", e instanceof Error ? e.message : "unknown"));
    // ORDER-003: авто-возобновление BLOCKED-заказов — отдельный безопасный проход в том же тике.
    void replanBlockedOnce().catch((e) => console.error("[scheduler] replan tick error:", e instanceof Error ? e.message : "unknown"));
  };
  tick(); // сразу после старта
  timer = setInterval(tick, period);
  if (typeof timer.unref === "function") timer.unref(); // не держим процесс при завершении
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  process.once("SIGTERM", stop); // корректная остановка
  process.once("SIGINT", stop);
  console.log(`[scheduler] запущен, период ${period}мс`);
}
