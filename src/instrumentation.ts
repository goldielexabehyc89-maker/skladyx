// Next.js instrumentation: запускается один раз при старте серверного процесса (в т.ч. `next start`).
// TASK-007: поднимаем серверный планировщик активации отложенных задач в nodejs-рантайме app-процесса.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // R1/TENANT-001: на развёрнутом контуре (APP_URL=https://…) tenant-авторизация обязательна —
  // приложение не должно стартовать с TENANT_AUTH!=true. Маркер https-APP_URL безопасен для CI/локали
  // (там APP_URL=http://localhost). Понятная ошибка запуска (не process.exit) — Next не поднимет сервер.
  const deployedContour = /^https:\/\//i.test(process.env.APP_URL || "");
  if (deployedContour && process.env.TENANT_AUTH !== "true") {
    throw new Error(
      "FATAL: TENANT_AUTH=true обязателен на развёрнутом контуре (APP_URL=https). " +
        "Запуск остановлен во избежание работы без изоляции организаций.",
    );
  }
  const { startCoolingScheduler } = await import("@/lib/scheduler");
  startCoolingScheduler();
}
