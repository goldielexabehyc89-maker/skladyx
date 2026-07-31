import "server-only";
import { Prisma, type TaskStatus, type WorkflowTask } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logEvent, type EventType } from "@/lib/events";
import { isTaskType } from "@/lib/workflow-task-types";
import type { Role } from "@/lib/jwt";

// Этап 5/Пакет 2: транзакционный движок очереди задач. Остатки НЕ трогает (это будущие
// доменные обработчики через completeWorkflowTaskInTransaction). Конкурентная безопасность —
// advisory-lock по организации + partial unique (одна IN_PROGRESS/пользователь, одна PENDING-передача/задача).

type Tx = Prisma.TransactionClient;
export interface TaskResult {
  error?: string;
}
// Ошибка бизнес-правила движка (превращается в user-facing message в actions/verify).
class EngineError extends Error {}
const ACTIVE: { in: TaskStatus[] } = { in: ["ASSIGNED", "IN_PROGRESS", "HANDOFF_PENDING"] };

// Экспортируется: групповая приёмка (Пакет 4) создаёт задачу в СВОЕЙ транзакции под этим же
// локом (createWorkflowTaskInTx), чтобы приход + группа + задача были атомарны.
export async function lockCompany(tx: Tx, companyId: string): Promise<void> {
  // $executeRaw: pg_advisory_xact_lock возвращает void — $queryRaw падает на десериализации.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('skladyx:tasks'), hashtext(${companyId}))`;
}

// Нагрузка пользователя по формуле роли: LOADER — число активных задач; остальные — сумма loadUnits.
async function userLoad(tx: Tx, userId: string, role: Role): Promise<number> {
  if (role === "LOADER") {
    return tx.workflowTask.count({ where: { assignedUserId: userId, status: ACTIVE } });
  }
  const agg = await tx.workflowTask.aggregate({
    where: { assignedUserId: userId, status: ACTIVE },
    _sum: { loadUnits: true },
  });
  return agg._sum.loadUnits ?? 0;
}

// Назначить QUEUED-задачу наименее загруженной активной смене нужной роли/склада (внутри tx под lock).
// true — назначена; false — подходящей смены нет (остаётся QUEUED). Событие вернём вызывающему.
async function assignInTx(tx: Tx, task: WorkflowTask): Promise<string | null> {
  if (task.status !== "QUEUED") return null;
  const shifts = await tx.workShift.findMany({
    where: {
      companyId: task.companyId,
      warehouseId: task.warehouseId,
      role: task.requiredRole,
      endedAt: null,
    },
    select: { id: true, userId: true, startedAt: true },
  });
  if (shifts.length === 0) return null;
  const scored: { id: string; userId: string; startedAt: Date; load: number }[] = [];
  for (const sh of shifts) scored.push({ ...sh, load: await userLoad(tx, sh.userId, task.requiredRole) });
  scored.sort(
    (a, b) =>
      a.load - b.load ||
      a.startedAt.getTime() - b.startedAt.getTime() ||
      (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
  );
  const chosen = scored[0];
  await tx.workflowTask.update({
    where: { id: task.id },
    data: {
      status: "ASSIGNED",
      assignedUserId: chosen.userId,
      assignedShiftId: chosen.id,
      assignedAt: new Date(),
    },
  });
  return chosen.userId; // кому назначено (для аудита/realtime)
}

async function emit(
  type: EventType,
  companyId: string,
  title: string,
  body: string,
  warehouseIds?: string[],
  userIds?: string[],
  key?: string,
  actorId?: string,
): Promise<void> {
  await logEvent({ companyId, type, title, body, url: "/warehouse/tasks", warehouseIds, userIds, key, actorId });
}

export interface TaskCreateInput {
  companyId: string;
  warehouseId: string;
  type: string;
  requiredRole: Role;
  priority?: "NORMAL" | "URGENT";
  title: string;
  description?: string;
  actionUrl?: string;
  subjectType?: string;
  subjectId?: string;
  dedupeKey: string;
  loadUnits?: number;
  dependsOn?: string[];
}
export interface TaskCreateResult {
  task: WorkflowTask;
  created: boolean;
  assignedTo: string | null;
}

// ── Создание в ПЕРЕДАННОЙ транзакции (идемпотентно по dedupeKey, авто-назначение) ──
// Вызывающий ДОЛЖЕН держать lockCompany(tx). События эмитятся после коммита через emitTaskCreated.
// Позволяет групповой приёмке (Пакет 4) сделать приход + группу + задачу одной транзакцией.
export async function createWorkflowTaskInTx(tx: Tx, input: TaskCreateInput): Promise<TaskCreateResult> {
  if (!isTaskType(input.type)) throw new Error(`Неизвестный тип задачи: ${input.type}`);
  const loadUnits = Math.max(1, Math.floor(input.loadUnits ?? 1));
  const deps = Array.from(new Set(input.dependsOn ?? [])).filter((d) => d && d !== "");

  const existing = await tx.workflowTask.findUnique({
    where: { companyId_dedupeKey: { companyId: input.companyId, dedupeKey: input.dedupeKey } },
  });
  if (existing) return { task: existing, created: false, assignedTo: null };

  // Tenant-изоляция зависимостей: каждый dependsOn существует И принадлежит этой организации.
  if (deps.length) {
    const validDeps = await tx.workflowTask.count({
      where: { id: { in: deps }, companyId: input.companyId },
    });
    if (validDeps !== deps.length) throw new EngineError("Зависимость не найдена в этой организации");
  }

  // BLOCKED, если есть незавершённые зависимости
  let status: TaskStatus = "QUEUED";
  if (deps.length) {
    const done = await tx.workflowTask.count({ where: { id: { in: deps }, status: "COMPLETED" } });
    if (done < deps.length) status = "BLOCKED";
  }
  const task = await tx.workflowTask.create({
    data: {
      companyId: input.companyId,
      warehouseId: input.warehouseId,
      type: input.type,
      requiredRole: input.requiredRole,
      priority: input.priority ?? "NORMAL",
      status,
      title: input.title,
      description: input.description,
      actionUrl: input.actionUrl,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      dedupeKey: input.dedupeKey,
      loadUnits,
      dependencies: deps.length ? { create: deps.map((dependsOnTaskId) => ({ dependsOnTaskId })) } : undefined,
    },
  });
  let assignedTo: string | null = null;
  if (status === "QUEUED") assignedTo = await assignInTx(tx, task);
  const fresh = await tx.workflowTask.findUniqueOrThrow({ where: { id: task.id } });
  return { task: fresh, created: true, assignedTo };
}

// События создания/назначения задачи — вызывать ПОСЛЕ коммита транзакции.
export async function emitTaskCreated(res: TaskCreateResult): Promise<void> {
  if (!res.created) return;
  const t = res.task;
  await emit("task_created", t.companyId, "Задача создана", t.title, [t.warehouseId], undefined, `task:${t.id}:created`);
  if (res.assignedTo)
    await emit("task_assigned", t.companyId, "Задача назначена", t.title, [t.warehouseId], [res.assignedTo]);
}

// События завершения задачи — вызывать ПОСЛЕ коммита (для доменных обработчиков вроде размещения группы).
export async function emitTaskCompleted(info: {
  companyId: string;
  warehouseId: string;
  title: string;
  taskId: string;
  unblocked: TaskBrief[];
}): Promise<void> {
  await emit("task_completed", info.companyId, "Задача выполнена", info.title, [info.warehouseId], undefined, `task:${info.taskId}:completed`);
  for (const u of info.unblocked)
    await emit("task_unblocked", info.companyId, "Задача разблокирована", u.title, [u.warehouseId], undefined, `task:${u.id}:unblocked`);
}

// ── Создание (идемпотентно по dedupeKey, собственная транзакция + lock) ──
export async function createWorkflowTask(input: TaskCreateInput): Promise<{ task: WorkflowTask; created: boolean }> {
  const res = await prisma.$transaction(async (tx) => {
    await lockCompany(tx, input.companyId);
    return createWorkflowTaskInTx(tx, input);
  });
  await emitTaskCreated(res);
  return { task: res.task, created: res.created };
}

// ── Назначить конкретную QUEUED-задачу (own tx) ──
export async function assignWorkflowTask(taskId: string): Promise<boolean> {
  const out = await prisma.$transaction(async (tx) => {
    const t = await tx.workflowTask.findUnique({ where: { id: taskId } });
    if (!t) return null;
    await lockCompany(tx, t.companyId);
    const fresh = await tx.workflowTask.findUniqueOrThrow({ where: { id: taskId } });
    const to = await assignInTx(tx, fresh);
    return to ? { companyId: t.companyId, warehouseId: t.warehouseId, title: t.title, to } : null;
  });
  if (out) await emit("task_assigned", out.companyId, "Задача назначена", out.title, [out.warehouseId], [out.to]);
  return !!out;
}

// ── Перераспределить QUEUED-задачи (URGENT раньше, затем по createdAt) ──
export async function rebalanceQueuedTasks(
  companyId: string,
  filter?: { warehouseId?: string; role?: Role },
): Promise<number> {
  const assigned = await prisma.$transaction(async (tx) => {
    await lockCompany(tx, companyId);
    const queued = await tx.workflowTask.findMany({
      where: {
        companyId,
        status: "QUEUED",
        ...(filter?.warehouseId ? { warehouseId: filter.warehouseId } : {}),
        ...(filter?.role ? { requiredRole: filter.role } : {}),
      },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    });
    const events: { companyId: string; warehouseId: string; title: string; to: string }[] = [];
    for (const t of queued) {
      const to = await assignInTx(tx, t);
      if (to) events.push({ companyId, warehouseId: t.warehouseId, title: t.title, to });
    }
    return events;
  });
  for (const e of assigned) await emit("task_assigned", e.companyId, "Задача назначена", e.title, [e.warehouseId], [e.to]);
  return assigned.length;
}

// ── Взять задачу в работу ──
export async function startWorkflowTask(
  userId: string,
  companyId: string,
  taskId: string,
  skipReason?: string,
): Promise<TaskResult> {
  let skipped: { title: string; warehouseId: string } | null = null;
  try {
    skipped = await prisma.$transaction(async (tx) => {
      await lockCompany(tx, companyId);
      const task = await tx.workflowTask.findFirst({ where: { id: taskId, companyId } });
      if (!task) throw new EngineError("Задача не найдена");
      if (task.assignedUserId !== userId || task.status !== "ASSIGNED")
        throw new EngineError("Эту задачу нельзя начать");
      // нельзя иметь вторую активную (IN_PROGRESS или ожидающую передачу) задачу
      const busy = await tx.workflowTask.findFirst({
        where: { assignedUserId: userId, status: { in: ["IN_PROGRESS", "HANDOFF_PENDING"] } },
      });
      if (busy) throw new EngineError("У вас уже есть задача в работе — завершите или передайте её");
      // пропуск доступной срочной — только с причиной
      const recommended = await tx.workflowTask.findFirst({
        where: { assignedUserId: userId, status: "ASSIGNED" },
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      });
      const skipsUrgent = !!recommended && recommended.id !== task.id && recommended.priority === "URGENT";
      if (skipsUrgent && !skipReason?.trim())
        throw new EngineError("Впереди есть срочная задача. Укажите причину пропуска или начните срочную.");
      await tx.workflowTask.update({
        where: { id: task.id },
        data: { status: "IN_PROGRESS", startedAt: new Date() },
      });
      return skipsUrgent ? { title: recommended!.title, warehouseId: task.warehouseId } : null;
    });
  } catch (e) {
    if (e instanceof EngineError) return { error: e.message };
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
      return { error: "У вас уже есть задача в работе" };
    throw e;
  }
  await emit("task_started", companyId, "Задача взята в работу", taskId, undefined, [userId], `task:${taskId}:started`);
  if (skipped)
    await emit("task_skipped", companyId, "Пропущена срочная задача", `Причина: ${skipReason}`, [skipped.warehouseId], [userId], undefined, userId);
  return {};
}

// Инфо о задаче для аудита/realtime после коммита.
type TaskBrief = { id: string; title: string; warehouseId: string };

// ── Завершение (для будущих доменных обработчиков; в tx вместе с движением остатка) ──
// Возвращает список разблокированных зависящих задач (для события task_unblocked после коммита).
export async function completeWorkflowTaskInTransaction(tx: Tx, taskId: string): Promise<TaskBrief[]> {
  await tx.workflowTask.update({
    where: { id: taskId },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  return unlockDependentTasks(tx, taskId);
}

export async function completeWorkflowTask(taskId: string): Promise<void> {
  const info = await prisma.$transaction(async (tx) => {
    const t = await tx.workflowTask.findUnique({ where: { id: taskId } });
    if (!t) return null;
    await lockCompany(tx, t.companyId);
    const unblocked = await completeWorkflowTaskInTransaction(tx, taskId);
    return { companyId: t.companyId, warehouseId: t.warehouseId, title: t.title, unblocked };
  });
  if (info) {
    await emit("task_completed", info.companyId, "Задача выполнена", info.title, [info.warehouseId], undefined, `task:${taskId}:completed`);
    for (const u of info.unblocked)
      await emit("task_unblocked", info.companyId, "Задача разблокирована", u.title, [u.warehouseId], undefined, `task:${u.id}:unblocked`);
    await rebalanceQueuedTasks(info.companyId, { warehouseId: info.warehouseId });
  }
}

// Разблокировать зависящие задачи, у которых ВСЕ зависимости COMPLETED: BLOCKED → QUEUED.
// Возвращает разблокированные задачи (событие task_unblocked эмитим после коммита tx).
export async function unlockDependentTasks(tx: Tx, completedTaskId: string): Promise<TaskBrief[]> {
  const unblocked: TaskBrief[] = [];
  const dependents = await tx.taskDependency.findMany({
    where: { dependsOnTaskId: completedTaskId },
    select: { taskId: true },
  });
  for (const { taskId } of dependents) {
    const t = await tx.workflowTask.findUnique({ where: { id: taskId } });
    if (!t || t.status !== "BLOCKED") continue;
    const deps = await tx.taskDependency.findMany({ where: { taskId }, select: { dependsOnTaskId: true } });
    const done = await tx.workflowTask.count({
      where: { id: { in: deps.map((d) => d.dependsOnTaskId) }, status: "COMPLETED" },
    });
    if (done >= deps.length) {
      const upd = await tx.workflowTask.update({ where: { id: taskId }, data: { status: "QUEUED" } });
      unblocked.push({ id: upd.id, title: upd.title, warehouseId: upd.warehouseId });
    }
  }
  return unblocked;
}

export async function cancelWorkflowTask(taskId: string): Promise<void> {
  const info = await prisma.$transaction(async (tx) => {
    const t = await tx.workflowTask.findUnique({ where: { id: taskId } });
    if (!t || t.status === "COMPLETED" || t.status === "CANCELLED") return null;
    await lockCompany(tx, t.companyId);
    // Незавершённую (PENDING) передачу закрываем в ЭТОЙ ЖЕ транзакции — иначе устаревшая
    // передача могла бы «воскресить» отменённую задачу при accept/reject.
    await tx.taskHandoff.updateMany({
      where: { taskId, status: "PENDING" },
      data: { status: "CANCELLED", respondedAt: new Date() },
    });
    await tx.workflowTask.update({
      where: { id: taskId },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
    return { companyId: t.companyId, warehouseId: t.warehouseId, title: t.title };
  });
  if (info) await emit("task_cancelled", info.companyId, "Задача отменена", info.title, [info.warehouseId], undefined, `task:${taskId}:cancelled`);
}

// ── Передача задачи (двойное подтверждение) ──
export async function requestTaskHandoff(
  companyId: string,
  taskId: string,
  fromUserId: string,
  toUserId: string,
): Promise<TaskResult> {
  let notify: { warehouseId: string; title: string } | null = null;
  try {
    notify = await prisma.$transaction(async (tx) => {
      await lockCompany(tx, companyId);
      const task = await tx.workflowTask.findFirst({ where: { id: taskId, companyId } });
      if (!task || task.status !== "IN_PROGRESS" || task.assignedUserId !== fromUserId)
        throw new EngineError("Передать можно только свою задачу в работе");
      const fromShift = await tx.workShift.findFirst({ where: { userId: fromUserId, companyId, endedAt: null } });
      const toShift = await tx.workShift.findFirst({
        where: { userId: toUserId, companyId, endedAt: null, role: task.requiredRole, warehouseId: task.warehouseId },
      });
      if (!fromShift) throw new EngineError("У вас нет активной смены");
      if (!toShift) throw new EngineError("У получателя нет активной смены той же роли и склада");
      const toBusy = await tx.workflowTask.findFirst({
        where: { assignedUserId: toUserId, status: { in: ["IN_PROGRESS", "HANDOFF_PENDING"] } },
      });
      if (toBusy) throw new EngineError("У получателя уже есть задача в работе");
      await tx.taskHandoff.create({
        data: { taskId, fromShiftId: fromShift.id, toShiftId: toShift.id, status: "PENDING" },
      });
      await tx.workflowTask.update({ where: { id: taskId }, data: { status: "HANDOFF_PENDING" } });
      return { warehouseId: task.warehouseId, title: task.title };
    });
  } catch (e) {
    if (e instanceof EngineError) return { error: e.message };
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
      return { error: "По задаче уже есть активная передача" };
    throw e;
  }
  if (notify) await emit("task_handoff_requested", companyId, "Запрос передачи задачи", notify.title, [notify.warehouseId], [toUserId]);
  return {};
}

export async function acceptTaskHandoff(companyId: string, handoffId: string, toUserId: string): Promise<TaskResult> {
  let notify: { warehouseId: string; title: string } | null = null;
  try {
    notify = await prisma.$transaction(async (tx) => {
      await lockCompany(tx, companyId);
      const h = await tx.taskHandoff.findFirst({ where: { id: handoffId, status: "PENDING" }, include: { toShift: true, task: true, fromShift: true } });
      if (!h || h.task.companyId !== companyId) throw new EngineError("Передача не найдена");
      if (h.toShift.userId !== toUserId || h.toShift.endedAt !== null) throw new EngineError("Это не ваша активная передача");
      // защита от устаревшей передачи: задача всё ещё ждёт передачи и принадлежит исходной смене/пользователю
      if (h.task.status !== "HANDOFF_PENDING" || h.task.assignedShiftId !== h.fromShiftId || h.task.assignedUserId !== h.fromShift.userId)
        throw new EngineError("Передача устарела — задача изменилась");
      const busy = await tx.workflowTask.findFirst({
        where: { assignedUserId: toUserId, status: { in: ["IN_PROGRESS", "HANDOFF_PENDING"] }, id: { not: h.taskId } },
      });
      if (busy) throw new EngineError("У вас уже есть задача в работе");
      await tx.taskHandoff.update({ where: { id: handoffId }, data: { status: "ACCEPTED", respondedAt: new Date() } });
      await tx.workflowTask.update({
        where: { id: h.taskId },
        data: { status: "IN_PROGRESS", assignedUserId: toUserId, assignedShiftId: h.toShiftId },
      });
      return { warehouseId: h.task.warehouseId, title: h.task.title };
    });
  } catch (e) {
    if (e instanceof EngineError) return { error: e.message };
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
      return { error: "У вас уже есть задача в работе" };
    throw e;
  }
  if (notify) await emit("task_handoff_accepted", companyId, "Передача принята", notify.title, [notify.warehouseId], [toUserId]);
  return {};
}

export async function rejectTaskHandoff(companyId: string, handoffId: string, toUserId: string): Promise<TaskResult> {
  let notify: { warehouseId: string; title: string; from: string } | null = null;
  try {
    notify = await prisma.$transaction(async (tx) => {
      await lockCompany(tx, companyId);
      const h = await tx.taskHandoff.findFirst({ where: { id: handoffId, status: "PENDING" }, include: { toShift: true, task: true, fromShift: true } });
      if (!h || h.task.companyId !== companyId) throw new EngineError("Передача не найдена");
      if (h.toShift.userId !== toUserId) throw new EngineError("Это не ваша передача");
      // защита от устаревшей передачи: задача всё ещё ждёт передачи и принадлежит исходной смене/пользователю
      if (h.task.status !== "HANDOFF_PENDING" || h.task.assignedShiftId !== h.fromShiftId || h.task.assignedUserId !== h.fromShift.userId)
        throw new EngineError("Передача устарела — задача изменилась");
      await tx.taskHandoff.update({ where: { id: handoffId }, data: { status: "REJECTED", respondedAt: new Date() } });
      // задача возвращается исходному исполнителю в IN_PROGRESS
      await tx.workflowTask.update({ where: { id: h.taskId }, data: { status: "IN_PROGRESS" } });
      return { warehouseId: h.task.warehouseId, title: h.task.title, from: h.fromShift.userId };
    });
  } catch (e) {
    if (e instanceof EngineError) return { error: e.message };
    throw e;
  }
  if (notify) await emit("task_handoff_rejected", companyId, "Передача отклонена", notify.title, [notify.warehouseId], [notify.from]);
  return {};
}
