// TASK-007: интеграционная проверка независимости от браузера. Приложение запущено (next start с
// активным планировщиком), НИ ОДНА страница задач не открывается. Скрипт создаёт задачу с ближайшим
// availableAt и ждёт, пока её назначит СЕРВЕРНЫЙ планировщик (никаких браузерных действий).
// Запуск (после старта сервера): npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-scheduler-live.ts
/* eslint-disable no-console */
process.env.WORKFLOW_TASKS_ENABLED = "true";

import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { createWorkflowTask } from "@/lib/workflow-tasks";

const prisma = new PrismaClient();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const slug = process.env.SEED_COMPANY_SLUG || "rostagro";
  const company = await prisma.company.findFirstOrThrow({ where: { slug } });
  const companyId = company.id;

  // Изолированный склад + погрузчик на активной смене (не трогаем фикстуры).
  const wh = await prisma.warehouse.create({ data: { companyId, name: `SCHED-LIVE-${Date.now()}`, isActive: true } });
  const phone = `+7999556${String(Date.now()).slice(-4)}`;
  const loader = await prisma.user.create({
    data: { companyId, phone, name: "SCHED live loader", role: "LOADER" as Role, isActive: true, allWarehouses: false, passwordHash: await bcrypt.hash("x", 10), userRoles: { create: { role: "LOADER" as Role } }, warehouseLinks: { create: { warehouseId: wh.id } } },
  });
  await prisma.workShift.create({ data: { companyId, userId: loader.id, warehouseId: wh.id, role: "LOADER" as Role } });

  // Задача с ближайшим сроком (через 2с) — остаётся QUEUED до наступления срока.
  const availableAt = new Date(Date.now() + 2_000);
  const { task } = await createWorkflowTask({
    companyId, warehouseId: wh.id, type: "RETRIEVE_COOLING", requiredRole: "LOADER" as Role, priority: "URGENT",
    title: `SCHED live ${Date.now()}`, dedupeKey: `sched-live-${Date.now()}`, subjectId: `sched-live-subj-${Date.now()}`, availableAt,
  });
  const t0 = await prisma.workflowTask.findUniqueOrThrow({ where: { id: task.id } });
  if (t0.status !== "QUEUED" || t0.assignedUserId) { console.error(`✗ задача создана не QUEUED: ${t0.status}/${t0.assignedUserId}`); process.exit(1); }
  console.log("задача создана QUEUED, страницу задач НИКТО не открывает; ждём серверный планировщик…");

  // Ждём до 45с: сервер должен сам назначить (без браузера).
  let assigned = null as null | { status: string; assignedUserId: string | null };
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    const r = await prisma.workflowTask.findUniqueOrThrow({ where: { id: task.id } });
    if (r.status !== "QUEUED") { assigned = { status: r.status, assignedUserId: r.assignedUserId }; break; }
  }

  let failures = 0;
  const ok = (n: string, c: boolean, e = "") => (c ? console.log(`  ✓ ${n}`) : (failures++, console.error(`  ✗ ${n} ${e}`)));
  ok("сервер назначил задачу без открытого браузера", !!assigned, "таймаут ожидания назначения");
  ok("статус ASSIGNED, не IN_PROGRESS", assigned?.status === "ASSIGNED", assigned?.status ?? "-");
  ok("назначена созданному активному LOADER", assigned?.assignedUserId === loader.id, assigned?.assignedUserId ?? "-");

  // cleanup
  await prisma.workflowTask.deleteMany({ where: { id: task.id } });
  await prisma.event.deleteMany({ where: { companyId, type: "task_assigned", body: task.title } });
  await prisma.workShift.deleteMany({ where: { userId: loader.id } });
  await prisma.user.deleteMany({ where: { id: loader.id } });
  await prisma.warehouse.deleteMany({ where: { id: wh.id } });

  console.log(failures === 0 ? "\nSCHEDULER-LIVE OK ✓" : `\nПРОВАЛЕНО: ${failures}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error("ERR", e); await prisma.$disconnect(); process.exit(1); });
