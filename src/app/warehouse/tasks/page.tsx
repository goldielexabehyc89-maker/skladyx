import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { hasRole, workflowTasksEnabled } from "@/lib/roles";
import { allowedWarehouses } from "@/lib/warehouse-access";
import { getActiveShift } from "@/lib/work-shift";
import { ROLE_LABEL } from "@/lib/role-labels";
import { TASK_STATUS_LABEL, TASK_STATUS_TONE, taskStatusLabel, taskTypeLabel } from "@/lib/task-labels";
import { PageShell } from "@/components/page-shell";
import { PageTitle, Card, Badge, EmptyState, FilterBar, FilterSubmit, SelectField, LinkButton } from "@/components/ui";
import { WorkerTasks, type TaskDTO } from "./tasks-screen";
import type { Prisma, Role, TaskStatus } from "@prisma/client";

const WORK_ROLES: Role[] = ["RECEIVER", "LOADER", "PICKER", "CONTROLLER"];
const STATUSES: TaskStatus[] = ["BLOCKED", "QUEUED", "ASSIGNED", "IN_PROGRESS", "HANDOFF_PENDING", "NEEDS_ATTENTION", "COMPLETED", "CANCELLED"];

const toDTO = (t: {
  id: string; type: string; title: string; description: string | null;
  priority: "NORMAL" | "URGENT"; status: string; createdAt: Date; actionUrl: string | null;
}): TaskDTO => ({
  id: t.id, type: t.type, title: t.title, description: t.description,
  priority: t.priority, status: t.status, createdAt: t.createdAt.toISOString(), actionUrl: t.actionUrl,
});

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ warehouse?: string; role?: string; status?: string; priority?: string; assignee?: string }>;
}) {
  if (!workflowTasksEnabled()) redirect("/warehouse");
  const session = await requireUser();
  const s = scoped(session);

  // ── ADMIN: read-only монитор всех задач организации ──
  if (hasRole(session, "ADMIN")) {
    const sp = await searchParams;
    const where: Prisma.WorkflowTaskWhereInput = {
      companyId: s.companyId,
      ...(sp.warehouse ? { warehouseId: sp.warehouse } : {}),
      ...(sp.role ? { requiredRole: sp.role as Role } : {}),
      ...(sp.status ? { status: sp.status as TaskStatus } : {}),
      ...(sp.priority ? { priority: sp.priority as "NORMAL" | "URGENT" } : {}),
      ...(sp.assignee ? { assignedUserId: sp.assignee } : {}),
    };
    const [tasks, warehouses, workers] = await Promise.all([
      prisma.workflowTask.findMany({
        where,
        include: { assignedUser: { select: { name: true } }, warehouse: { select: { name: true } } },
        orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
        take: 200,
      }),
      allowedWarehouses(session, s.companyId),
      prisma.user.findMany({ where: { companyId: s.companyId, assignedTasks: { some: {} } }, select: { id: true, name: true } }),
    ]);

    return (
      <PageShell title="Задачи — монитор">
        <FilterBar>
          <SelectField name="warehouse" defaultValue={sp.warehouse ?? ""} className="text-sm">
            <option value="">Все склады</option>
            {warehouses.map((w) => (<option key={w.id} value={w.id}>{w.name}</option>))}
          </SelectField>
          <SelectField name="role" defaultValue={sp.role ?? ""} className="text-sm">
            <option value="">Все роли</option>
            {WORK_ROLES.map((r) => (<option key={r} value={r}>{ROLE_LABEL[r]}</option>))}
          </SelectField>
          <SelectField name="status" defaultValue={sp.status ?? ""} className="text-sm">
            <option value="">Все статусы</option>
            {STATUSES.map((st) => (<option key={st} value={st}>{TASK_STATUS_LABEL[st]}</option>))}
          </SelectField>
          <SelectField name="priority" defaultValue={sp.priority ?? ""} className="text-sm">
            <option value="">Любая срочность</option>
            <option value="URGENT">Срочные</option>
            <option value="NORMAL">Обычные</option>
          </SelectField>
          <SelectField name="assignee" defaultValue={sp.assignee ?? ""} className="text-sm">
            <option value="">Любой исполнитель</option>
            {workers.map((w) => (<option key={w.id} value={w.id}>{w.name}</option>))}
          </SelectField>
          <FilterSubmit label="Фильтр" />
        </FilterBar>

        {tasks.length === 0 ? (
          <EmptyState>Задач нет.</EmptyState>
        ) : (
          <div className="flex flex-col gap-2">
            {tasks.map((t) => (
              <div key={t.id} className="flex items-start justify-between gap-3 rounded-xl border border-[#eee] bg-white p-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{t.title}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-neutral-500">
                    <span>{t.warehouse.name}</span>
                    <span>· {ROLE_LABEL[t.requiredRole]}</span>
                    <span>· {taskTypeLabel(t.type)}</span>
                    {t.assignedUser && <span>· {t.assignedUser.name}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <Badge tone={TASK_STATUS_TONE[t.status] ?? "neutral"}>{taskStatusLabel(t.status)}</Badge>
                  {t.priority === "URGENT" && <Badge tone="red">срочно</Badge>}
                </div>
              </div>
            ))}
          </div>
        )}
      </PageShell>
    );
  }

  // ── Рабочий сотрудник: доска задач текущей смены ──
  const shift = await getActiveShift(session.userId, s.companyId);
  if (!shift) {
    return (
      <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
        <PageTitle>Задачи</PageTitle>
        <Card>
          <p className="text-sm text-neutral-600">Чтобы получать задачи, начните смену.</p>
          <div className="mt-3">
            <LinkButton href="/warehouse/shift" variant="primary">Начать смену</LinkButton>
          </div>
        </Card>
      </div>
    );
  }

  const mine = await prisma.workflowTask.findMany({
    where: { companyId: s.companyId, assignedUserId: session.userId, status: { in: ["ASSIGNED", "IN_PROGRESS", "HANDOFF_PENDING"] } },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  });
  const current = mine.find((t) => t.status === "IN_PROGRESS" || t.status === "HANDOFF_PENDING") ?? null;
  const assigned = mine.filter((t) => t.status === "ASSIGNED");
  const incoming = await prisma.taskHandoff.findMany({
    where: { status: "PENDING", toShift: { userId: session.userId, companyId: s.companyId, endedAt: null } },
    include: { task: { select: { title: true, type: true } } },
  });
  const mateShifts = await prisma.workShift.findMany({
    where: { companyId: s.companyId, warehouseId: shift.warehouseId, role: shift.role, endedAt: null, userId: { not: session.userId } },
    include: { user: { select: { id: true, name: true } } },
  });

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
      <PageTitle action={<Badge tone="green">{ROLE_LABEL[shift.role]} · {shift.warehouseName}</Badge>}>Задачи</PageTitle>
      <WorkerTasks
        current={current ? toDTO(current) : null}
        urgent={assigned.filter((t) => t.priority === "URGENT").map(toDTO)}
        normal={assigned.filter((t) => t.priority === "NORMAL").map(toDTO)}
        incoming={incoming.map((h) => ({ handoffId: h.id, taskTitle: h.task.title, taskType: h.task.type }))}
        mates={mateShifts.map((sh) => ({ userId: sh.userId, name: sh.user.name }))}
      />
    </div>
  );
}
