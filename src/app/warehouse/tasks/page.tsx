import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { hasRole, isWorkRole, workflowTasksEnabled, groupReceivingEnabled, coolingWorkflowEnabled, externalOrderPickingEnabled, orderControlEnabled, orderIssueEnabled } from "@/lib/roles";
import { getPickOrderContext, getMoveGroupContext } from "@/lib/external-orders";
import { getControlOrderContext, getCorrectOrderContext } from "@/lib/order-control";
import { getIssueOrderContext, getDeliverOrderContext } from "@/lib/order-issue";
import { allowedWarehouses } from "@/lib/warehouse-access";
import { getActiveShift } from "@/lib/work-shift";
import { ROLE_LABEL } from "@/lib/role-labels";
import { TASK_STATUS_LABEL, TASK_STATUS_TONE, taskStatusLabel, taskTypeLabel } from "@/lib/task-labels";
import { PageShell } from "@/components/page-shell";
import { PageTitle, Card, Badge, EmptyState, FilterBar, FilterSubmit, SelectField, LinkButton } from "@/components/ui";
import { WorkerTasks, UrgentChip, type TaskDTO } from "./tasks-screen";
import { TaskTimer } from "./task-timer";
import type { Prisma, Role, TaskStatus } from "@prisma/client";

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
// «Доступна с ДД.ММ в ЧЧ:ММ» по московскому времени (сервер форматирует, часы устройства не участвуют).
function fmtMsk(d: Date): string {
  const parts = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d);
  const g = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${g("day")}.${g("month")} в ${g("hour")}:${g("minute")}`;
}

const WORK_ROLES: Role[] = ["RECEIVER", "LOADER", "PICKER", "CONTROLLER"];
const STATUSES: TaskStatus[] = ["BLOCKED", "QUEUED", "ASSIGNED", "IN_PROGRESS", "HANDOFF_PENDING", "NEEDS_ATTENTION", "COMPLETED", "CANCELLED"];

const toDTO = (t: {
  id: string; type: string; title: string; description: string | null;
  priority: "NORMAL" | "URGENT"; status: string; createdAt: Date; actionUrl: string | null; dueAt: Date | null;
  availableAt?: Date | null; assignedAt?: Date | null; startedAt?: Date | null;
}): TaskDTO => ({
  id: t.id, type: t.type, title: t.title, description: t.description,
  priority: t.priority, status: t.status, createdAt: t.createdAt.toISOString(), actionUrl: t.actionUrl,
  dueAt: t.dueAt ? t.dueAt.toISOString() : null,
  availableAt: t.availableAt ? t.availableAt.toISOString() : null,
  assignedAt: t.assignedAt ? t.assignedAt.toISOString() : null,
  startedAt: t.startedAt ? t.startedAt.toISOString() : null,
});

// Переключатель «Мои задачи / Монитор» — только для ADMIN (монитор доступен лишь ему).
function ViewToggle({ active }: { active: "mine" | "monitor" }) {
  const base = "rounded-md px-3 py-1 text-sm font-medium transition-colors";
  const on = "bg-[#1a1a2e] text-white";
  const off = "text-neutral-600 hover:text-neutral-900";
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-[#e4e4f0] bg-white p-0.5">
      <Link href="/warehouse/tasks?view=mine" className={`${base} ${active === "mine" ? on : off}`}>Мои задачи</Link>
      <Link href="/warehouse/tasks?view=monitor" className={`${base} ${active === "monitor" ? on : off}`}>Монитор</Link>
    </div>
  );
}

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ warehouse?: string; role?: string; status?: string; priority?: string; assignee?: string; view?: string }>;
}) {
  if (!workflowTasksEnabled()) redirect("/warehouse");
  const session = await requireUser();
  const s = scoped(session);
  const sp = await searchParams;

  const isAdmin = hasRole(session, "ADMIN");
  const shift = await getActiveShift(session.userId, s.companyId);
  const hasWorkShift = !!shift && isWorkRole(shift.role);

  // Монитор всех задач видит только ADMIN. По умолчанию ADMIN с активной рабочей сменой
  // попадает на свою рабочую очередь, без смены — на монитор. Явный выбор — ?view=mine|monitor.
  const view: "mine" | "monitor" = isAdmin
    ? sp.view === "monitor"
      ? "monitor"
      : sp.view === "mine"
        ? "mine"
        : hasWorkShift
          ? "mine"
          : "monitor"
    : "mine";

  // ── ADMIN: read-only монитор всех задач организации ──
  if (isAdmin && view === "monitor") {
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
        orderBy: [{ priority: "desc" }, { dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
        take: 200,
      }),
      allowedWarehouses(session, s.companyId),
      prisma.user.findMany({ where: { companyId: s.companyId, assignedTasks: { some: {} } }, select: { id: true, name: true } }),
    ]);

    const serverNowIso = new Date().toISOString();
    const nowMs = Date.now();
    return (
      <PageShell title="Задачи — монитор" action={<ViewToggle active="monitor" />}>
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
            {tasks.map((t) => {
              // TASK-007/008: QUEUED с будущим availableAt — «Запланирована» + МСК-время + таймер.
              const scheduled = t.status === "QUEUED" && !!t.availableAt && t.availableAt.getTime() > nowMs;
              // TASK-009: активная срочная — светло-красная карточка (терминальные не выделяем).
              const urgentActive = t.priority === "URGENT" && t.status !== "COMPLETED" && t.status !== "CANCELLED";
              const showTimer = scheduled || urgentActive;
              return (
                <div key={t.id} className={"flex items-start justify-between gap-3 rounded-xl border p-3 " + (urgentActive ? "border-red-200 bg-red-50" : "border-[#eee] bg-white")}>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-[#1a1a1a]">{t.title}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-neutral-500">
                      <span>{t.warehouse.name}</span>
                      <span>· {ROLE_LABEL[t.requiredRole]}</span>
                      <span>· {taskTypeLabel(t.type)}</span>
                      {t.assignedUser && <span>· {t.assignedUser.name}</span>}
                    </div>
                    {scheduled && t.availableAt && <div className="mt-0.5 text-xs text-neutral-500">Доступна с {fmtMsk(t.availableAt)} (МСК)</div>}
                    {showTimer && (
                      <div className="mt-1">
                        <TaskTimer serverNowIso={serverNowIso} status={t.status} availableAtIso={iso(t.availableAt)} assignedAtIso={iso(t.assignedAt)} startedAtIso={iso(t.startedAt)} createdAtIso={t.createdAt.toISOString()} />
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge tone={scheduled ? "blue" : (TASK_STATUS_TONE[t.status] ?? "neutral")}>{scheduled ? "Запланирована" : taskStatusLabel(t.status)}</Badge>
                    {t.priority === "URGENT" && <UrgentChip />}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </PageShell>
    );
  }

  // ── Рабочая доска (сотрудник или ADMIN в режиме «Мои задачи») ──
  if (!shift) {
    return (
      <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
        {isAdmin && <ViewToggle active="mine" />}
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
    orderBy: [{ priority: "desc" }, { dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
  });
  const current = mine.find((t) => t.status === "IN_PROGRESS" || t.status === "HANDOFF_PENDING") ?? null;
  const assigned = mine.filter((t) => t.status === "ASSIGNED");

  // TASK-006 (расширение): компактные карточки всех физических задач погрузчика — структурированные
  // контексты (товар/количество/маршрут) грузим ПАКЕТНО, без отдельного запроса на каждую карточку.
  const loaderCards: Record<string, { taskId: string; command: string; itemName: string; qty: number; from: string; to: string; note?: string }> = {};
  {
    const place = mine.filter((t) => t.type === "PLACE_GROUP" && t.subjectId);
    const cool = mine.filter((t) => t.type === "RETRIEVE_COOLING" && t.subjectId);
    const move = mine.filter((t) => t.type === "MOVE_GROUP" && t.subjectId);
    if (place.length || cool.length || move.length) {
      const directGroupIds = [...place, ...move].map((t) => t.subjectId!);
      const sessions = cool.length
        ? await prisma.coolingSession.findMany({ where: { companyId: s.companyId, id: { in: cool.map((t) => t.subjectId!) } }, select: { id: true, handlingGroupId: true, coolingCellId: true } })
        : [];
      const groupIds = [...new Set([...directGroupIds, ...sessions.map((x) => x.handlingGroupId)])];
      const groups = groupIds.length ? await prisma.handlingGroup.findMany({ where: { companyId: s.companyId, id: { in: groupIds } }, select: { id: true, itemId: true, lotId: true, qty: true, status: true } }) : [];
      const gById = new Map(groups.map((g) => [g.id, g]));
      const items = groups.length ? await prisma.item.findMany({ where: { companyId: s.companyId, id: { in: [...new Set(groups.map((g) => g.itemId))] } }, select: { id: true, name: true } }) : [];
      const itemName = new Map(items.map((i) => [i.id, i.name]));
      // MOVE_GROUP: исходная ячейка — по остатку партии; целевая — по активной броне задачи.
      const moveGroupIds = move.map((t) => t.subjectId!);
      const moveLotIds = moveGroupIds.map((id) => gById.get(id)?.lotId).filter((x): x is string => !!x);
      const [reservations, balances] = await Promise.all([
        moveGroupIds.length ? prisma.cellReservation.findMany({ where: { handlingGroupId: { in: moveGroupIds }, status: "ACTIVE" }, select: { handlingGroupId: true, cellId: true } }) : Promise.resolve([]),
        moveLotIds.length ? prisma.stockBalance.findMany({ where: { companyId: s.companyId, lotId: { in: moveLotIds }, cellId: { not: null }, qty: { gt: 0 } }, select: { lotId: true, cellId: true } }) : Promise.resolve([]),
      ]);
      const toCellByGroup = new Map(reservations.map((r) => [r.handlingGroupId!, r.cellId]));
      const fromCellByLot = new Map<string, string>();
      for (const b of balances) if (b.cellId && !fromCellByLot.has(b.lotId)) fromCellByLot.set(b.lotId, b.cellId);
      const cellIds = [...new Set([...sessions.map((x) => x.coolingCellId), ...toCellByGroup.values(), ...fromCellByLot.values()].filter((x): x is string => !!x))];
      const cells = cellIds.length ? await prisma.cell.findMany({ where: { companyId: s.companyId, id: { in: cellIds } }, select: { id: true, code: true } }) : [];
      const cellCode = new Map(cells.map((c) => [c.id, c.code]));
      for (const t of place) {
        const g = gById.get(t.subjectId!); if (!g) continue;
        loaderCards[t.id] = { taskId: t.id, command: "Разместить", itemName: itemName.get(g.itemId) ?? "Товар", qty: g.qty.toNumber(), from: "Приёмка", to: g.status === "AWAITING_COOLING" ? "Охлаждение" : "Хранение" };
      }
      for (const t of cool) {
        const sess = sessions.find((x) => x.id === t.subjectId); if (!sess) continue;
        const g = gById.get(sess.handlingGroupId); if (!g) continue;
        loaderCards[t.id] = { taskId: t.id, command: "Забрать из охлаждения", itemName: itemName.get(g.itemId) ?? "Товар", qty: g.qty.toNumber(), from: cellCode.get(sess.coolingCellId) ?? "охлаждение", to: "Хранение", note: "Ячейка будет назначена после замера" };
      }
      for (const t of move) {
        const g = gById.get(t.subjectId!); if (!g) continue;
        const toId = toCellByGroup.get(g.id); const fromId = fromCellByLot.get(g.lotId);
        loaderCards[t.id] = { taskId: t.id, command: "Переместить", itemName: itemName.get(g.itemId) ?? "Товар", qty: g.qty.toNumber(), from: (fromId && cellCode.get(fromId)) || "—", to: (toId && cellCode.get(toId)) || "—" };
      }
    }
  }
  const incoming = await prisma.taskHandoff.findMany({
    where: { status: "PENDING", toShift: { userId: session.userId, companyId: s.companyId, endedAt: null } },
    include: { task: { select: { title: true, type: true } } },
  });
  const mateShifts = await prisma.workShift.findMany({
    where: { companyId: s.companyId, warehouseId: shift.warehouseId, role: shift.role, endedAt: null, userId: { not: session.userId } },
    include: { user: { select: { id: true, name: true } } },
  });

  // Пакет 11 (коррекция P1): рендер /warehouse/tasks — ЧИСТО READ-ONLY. Назначение ячейки
  // (prepareGroupPlacement) НЕ вызывается на сервер-рендере/GET/prefetch/refresh — иначе обычное
  // открытие страницы создавало бы бронь. Бронь создаёт клиент только по явному «Начать размещение»
  // (PLACE-001). Здесь лишь передаём контекст задачи; назначенный код появляется после действия.
  // TASK-006: операционные поля из СТРУКТУРИРОВАННЫХ данных (HandlingGroup + Item), без парсинга
  // title/description. source — фактическая зона ожидающей группы (приёмка); targetZone — целевая зона.
  let placement: { taskId: string; itemName: string; qty: number; source: string; targetZone: string } | null = null;
  if (current && current.type === "PLACE_GROUP" && current.status === "IN_PROGRESS" && groupReceivingEnabled()) {
    const group = await prisma.handlingGroup.findFirst({ where: { id: current.subjectId ?? "", companyId: s.companyId } });
    if (group && (group.status === "AWAITING_STORAGE" || group.status === "AWAITING_COOLING")) {
      const item = await prisma.item.findFirst({ where: { id: group.itemId, companyId: s.companyId }, select: { name: true } });
      placement = {
        taskId: current.id,
        itemName: item?.name ?? "Товар",
        qty: group.qty.toNumber(),
        source: "Приёмка",
        targetZone: group.status === "AWAITING_COOLING" ? "Охлаждение" : "Хранение",
      };
    }
  }

  // Пакет 5: для текущей RETRIEVE_COOLING-задачи в работе — контекст сессии для ввода температуры.
  let cooling: { taskId: string; thresholdX: number; itemName: string; qty: number; coolingCell: string } | null = null;
  if (current && current.type === "RETRIEVE_COOLING" && current.status === "IN_PROGRESS" && coolingWorkflowEnabled()) {
    const session = await prisma.coolingSession.findFirst({ where: { id: current.subjectId ?? "", companyId: s.companyId, status: "ACTIVE" } });
    const card = loaderCards[current.id];
    // Структурированные поля (товар/количество/исходная ячейка) — из батча, без парсинга title.
    if (session && card) cooling = { taskId: current.id, thresholdX: session.thresholdX.toNumber(), itemName: card.itemName, qty: card.qty, coolingCell: card.from };
  }

  // Пакет 6: контекст текущей задачи сборки (PICK_ORDER) и перестановки (MOVE_GROUP).
  let pickOrder = null as Awaited<ReturnType<typeof getPickOrderContext>> | null;
  let moveGroup = null as Awaited<ReturnType<typeof getMoveGroupContext>> | null;
  if (current && current.status === "IN_PROGRESS" && externalOrderPickingEnabled()) {
    if (current.type === "PICK_ORDER") pickOrder = await getPickOrderContext(s.companyId, current.id);
    else if (current.type === "MOVE_GROUP") moveGroup = await getMoveGroupContext(s.companyId, current.id);
  }

  // Пакет 7: контекст текущей задачи контроля (CONTROL_ORDER) и исправления (CORRECT_ORDER).
  let controlOrder = null as Awaited<ReturnType<typeof getControlOrderContext>> | null;
  let correctOrder = null as Awaited<ReturnType<typeof getCorrectOrderContext>> | null;
  if (current && current.status === "IN_PROGRESS" && orderControlEnabled()) {
    if (current.type === "CONTROL_ORDER") controlOrder = await getControlOrderContext(s.companyId, current.id);
    else if (current.type === "CORRECT_ORDER") correctOrder = await getCorrectOrderContext(s.companyId, current.id);
  }

  // Пакет 8: контекст текущей задачи размещения (ISSUE_ORDER) и выдачи (DELIVER_ORDER).
  let issueOrder = null as Awaited<ReturnType<typeof getIssueOrderContext>> | null;
  let deliverOrder = null as Awaited<ReturnType<typeof getDeliverOrderContext>> | null;
  if (current && current.status === "IN_PROGRESS" && orderIssueEnabled()) {
    if (current.type === "ISSUE_ORDER") issueOrder = await getIssueOrderContext(s.companyId, current.id);
    else if (current.type === "DELIVER_ORDER") deliverOrder = await getDeliverOrderContext(s.companyId, current.id);
  }

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
      {isAdmin && <ViewToggle active="mine" />}
      <PageTitle action={<Badge tone="green">{ROLE_LABEL[shift.role]} · {shift.warehouseName}</Badge>}>Задачи</PageTitle>
      <WorkerTasks
        serverNow={new Date().toISOString()}
        loaderCards={loaderCards}
        current={current ? toDTO(current) : null}
        urgent={assigned.filter((t) => t.priority === "URGENT").map(toDTO)}
        normal={assigned.filter((t) => t.priority === "NORMAL").map(toDTO)}
        incoming={incoming.map((h) => ({ handoffId: h.id, taskTitle: h.task.title, taskType: h.task.type }))}
        mates={mateShifts.map((sh) => ({ userId: sh.userId, name: sh.user.name }))}
        placement={placement}
        cooling={cooling}
        pickOrder={pickOrder}
        moveGroup={moveGroup}
        controlOrder={controlOrder}
        correctOrder={correctOrder}
        issueOrder={issueOrder}
        deliverOrder={deliverOrder}
      />
    </div>
  );
}
