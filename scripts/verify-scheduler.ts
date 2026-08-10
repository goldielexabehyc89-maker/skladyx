// TASK-007: детерминированная проверка серверной активации отложенных задач через runSchedulerOnce()
// (без таймера и без браузера). Изолированные организации sched-a/sched-b (tenant-изоляция).
// Запуск: WORKFLOW_TASKS_ENABLED=true npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-scheduler.ts
/* eslint-disable no-console */
process.env.WORKFLOW_TASKS_ENABLED = "true";

import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { createWorkflowTask } from "@/lib/workflow-tasks";
import { runSchedulerOnce, schedulerIntervalMs } from "@/lib/scheduler";

const prisma = new PrismaClient();
let failures = 0;
const ok = (n: string, c: boolean, e = "") => (c ? console.log(`  ✓ ${n}`) : (failures++, console.error(`  ✗ ${n} ${e}`)));

async function mkCompany(slug: string, name: string) {
  return prisma.company.upsert({ where: { slug }, update: {}, create: { name, slug, settings: {} } });
}
async function mkLoader(companyId: string, phone: string, warehouseId: string): Promise<string> {
  await prisma.user.deleteMany({ where: { companyId, phone } });
  const u = await prisma.user.create({
    data: { companyId, phone, name: "SCHED loader", role: "LOADER" as Role, isActive: true, allWarehouses: false, passwordHash: await bcrypt.hash("x", 10), userRoles: { create: { role: "LOADER" as Role } }, warehouseLinks: { create: { warehouseId } } },
  });
  return u.id;
}
const assignedEvents = (companyId: string, body: string) =>
  prisma.event.count({ where: { companyId, type: "task_assigned", body } });
const mkTask = (companyId: string, warehouseId: string, title: string, dedupeKey: string, availableAt: Date) =>
  createWorkflowTask({ companyId, warehouseId, type: "RETRIEVE_COOLING", requiredRole: "LOADER" as Role, priority: "URGENT", title, dedupeKey, subjectId: `subj-${dedupeKey}`, availableAt });

async function main() {
  console.log("Планировщик активации (TASK-007)");
  const A = await mkCompany("sched-a", "SCHED A");
  const B = await mkCompany("sched-b", "SCHED B");
  // чистим прошлые прогоны
  for (const c of [A.id, B.id]) {
    await prisma.workflowTask.deleteMany({ where: { companyId: c } });
    await prisma.event.deleteMany({ where: { companyId: c, type: "task_assigned" } });
  }
  const wA = await prisma.warehouse.create({ data: { companyId: A.id, name: `SCHED-A-${Date.now()}`, isActive: true } });
  const wB = await prisma.warehouse.create({ data: { companyId: B.id, name: `SCHED-B-${Date.now()}`, isActive: true } });
  const lA = await mkLoader(A.id, "+79995551001", wA.id);
  const lB = await mkLoader(B.id, "+79995551002", wB.id);
  await prisma.workShift.deleteMany({ where: { userId: { in: [lA, lB] } } });
  await prisma.workShift.create({ data: { companyId: A.id, userId: lA, warehouseId: wA.id, role: "LOADER" as Role } });
  await prisma.workShift.create({ data: { companyId: B.id, userId: lB, warehouseId: wB.id, role: "LOADER" as Role } });

  const soon = () => new Date(Date.now() + 3_600_000);
  const past = () => new Date(Date.now() - 1_000);

  console.log("1) до availableAt задача не назначается планировщиком");
  const t1 = (await mkTask(A.id, wA.id, "SCHED defer 1", "sched-1", soon())).task;
  await runSchedulerOnce();
  let r1 = await prisma.workflowTask.findUniqueOrThrow({ where: { id: t1.id } });
  ok("до срока: QUEUED, исполнитель отсутствует", r1.status === "QUEUED" && r1.assignedUserId === null, `${r1.status}/${r1.assignedUserId}`);

  console.log("2) после срока сервер назначает активному LOADER (ASSIGNED, не IN_PROGRESS)");
  await prisma.workflowTask.update({ where: { id: t1.id }, data: { availableAt: past() } });
  await runSchedulerOnce();
  r1 = await prisma.workflowTask.findUniqueOrThrow({ where: { id: t1.id } });
  ok("назначена активному LOADER компании A", r1.assignedUserId === lA && !!r1.assignedShiftId, `${r1.assignedUserId}`);
  ok("статус ASSIGNED, не IN_PROGRESS", r1.status === "ASSIGNED", r1.status);
  ok("assignedAt проставлен сервером", !!r1.assignedAt);
  ok("tenant: не назначена погрузчику другой организации", r1.assignedUserId !== lB);

  console.log("3) параллельные тики → одно назначение и одно событие task_assigned");
  const t2 = (await mkTask(A.id, wA.id, "SCHED parallel 2", "sched-2", soon())).task;
  await prisma.workflowTask.update({ where: { id: t2.id }, data: { availableAt: past() } });
  await Promise.all([runSchedulerOnce(), runSchedulerOnce(), runSchedulerOnce()]);
  const r2 = await prisma.workflowTask.findUniqueOrThrow({ where: { id: t2.id } });
  ok("параллельно: ровно одно назначение (ASSIGNED)", r2.status === "ASSIGNED" && r2.assignedUserId === lA, `${r2.status}/${r2.assignedUserId}`);
  ok("параллельно: ровно одно событие task_assigned", (await assignedEvents(A.id, "SCHED parallel 2")) === 1);

  console.log("4) без активного погрузчика задача остаётся в очереди; после смены — назначается");
  await prisma.workShift.updateMany({ where: { userId: lA, endedAt: null }, data: { endedAt: new Date() } });
  const t3 = (await mkTask(A.id, wA.id, "SCHED no-picker 3", "sched-3", soon())).task;
  await prisma.workflowTask.update({ where: { id: t3.id }, data: { availableAt: past() } });
  await runSchedulerOnce();
  let r3 = await prisma.workflowTask.findUniqueOrThrow({ where: { id: t3.id } });
  ok("без смены: остаётся QUEUED", r3.status === "QUEUED" && r3.assignedUserId === null, r3.status);
  await prisma.workShift.create({ data: { companyId: A.id, userId: lA, warehouseId: wA.id, role: "LOADER" as Role } });
  await runSchedulerOnce();
  r3 = await prisma.workflowTask.findUniqueOrThrow({ where: { id: t3.id } });
  ok("после появления смены: назначена", r3.status === "ASSIGNED" && r3.assignedUserId === lA, r3.status);

  console.log("5) tenant-изоляция: задача организации B назначается только её погрузчику");
  const tB = (await mkTask(B.id, wB.id, "SCHED tenant B", "sched-b1", soon())).task;
  await prisma.workflowTask.update({ where: { id: tB.id }, data: { availableAt: past() } });
  await runSchedulerOnce();
  const rB = await prisma.workflowTask.findUniqueOrThrow({ where: { id: tB.id } });
  ok("организация B: назначена своему LOADER", rB.assignedUserId === lB, `${rB.assignedUserId}`);

  console.log("6) диапазон SCHEDULER_INTERVAL_MS (1000–30000, иначе default 15000)");
  const withEnv = (v: string | undefined) => { if (v === undefined) delete process.env.SCHEDULER_INTERVAL_MS; else process.env.SCHEDULER_INTERVAL_MS = v; return schedulerIntervalMs(); };
  ok("валидное 3000 → 3000", withEnv("3000") === 3000);
  ok("нижняя граница 1000 → 1000", withEnv("1000") === 1000);
  ok("верхняя граница 30000 → 30000", withEnv("30000") === 30000);
  ok("слишком большое 60000 → default 15000", withEnv("60000") === 15000);
  ok("слишком малое 500 → default 15000", withEnv("500") === 15000);
  ok("нечисловое → default 15000", withEnv("abc") === 15000);
  ok("не задано → default 15000", withEnv(undefined) === 15000);
  process.env.WORKFLOW_TASKS_ENABLED = "true";

  // cleanup
  for (const c of [A.id, B.id]) {
    await prisma.workflowTask.deleteMany({ where: { companyId: c } });
    await prisma.event.deleteMany({ where: { companyId: c, type: "task_assigned" } });
  }
  await prisma.workShift.deleteMany({ where: { userId: { in: [lA, lB] } } });
  await prisma.user.deleteMany({ where: { id: { in: [lA, lB] } } });
  await prisma.warehouse.deleteMany({ where: { id: { in: [wA.id, wB.id] } } });

  console.log(failures === 0 ? "\nSCHEDULER OK ✓" : `\nПРОВАЛЕНО: ${failures}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error("ERR", e); await prisma.$disconnect(); process.exit(1); });
