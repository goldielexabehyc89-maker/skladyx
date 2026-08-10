import "server-only";
import { prisma } from "@/lib/db";
import { rebalanceQueuedTasks } from "@/lib/workflow-tasks";
import { workflowTasksEnabled } from "@/lib/roles";

// TASK-007: серверная активация отложенных задач. Долгоживущий фоновый цикл app-процесса находит все
// организации с QUEUED-задачами, чей срок наступил (availableAt <= now или availableAt = null), и
// вызывает rebalanceQueuedTasks(companyId) под lockCompany — идемпотентно и безопасно при нескольких
// экземплярах и параллельных тиках (одно назначение, одно событие task_assigned). От открытых страниц
// не зависит. Ошибка одной организации/тика не останавливает последующие.

const DEFAULT_INTERVAL_MS = 15_000; // не реже раза в 30 секунд — берём 15с
function intervalMs(): number {
  const raw = Number(process.env.SCHEDULER_INTERVAL_MS ?? "");
  return Number.isFinite(raw) && raw >= 1000 ? raw : DEFAULT_INTERVAL_MS;
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

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;

export function startCoolingScheduler(): void {
  if (started) return; // один цикл на процесс
  started = true;
  const period = intervalMs();
  const tick = () => {
    void runSchedulerOnce().catch((e) => console.error("[scheduler] tick error:", e instanceof Error ? e.message : "unknown"));
  };
  tick(); // сразу после старта
  timer = setInterval(tick, period);
  if (typeof timer.unref === "function") timer.unref(); // не держим процесс при завершении
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  process.once("SIGTERM", stop); // корректная остановка
  process.once("SIGINT", stop);
  console.log(`[scheduler] запущен, период ${period}мс`);
}
