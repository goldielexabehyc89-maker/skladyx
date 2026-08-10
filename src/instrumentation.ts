// Next.js instrumentation: запускается один раз при старте серверного процесса (в т.ч. `next start`).
// TASK-007: поднимаем серверный планировщик активации отложенных задач в nodejs-рантайме app-процесса.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startCoolingScheduler } = await import("@/lib/scheduler");
  startCoolingScheduler();
}
