"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import {
  startTaskAction,
  requestHandoffAction,
  acceptHandoffAction,
  rejectHandoffAction,
  type TaskActionState,
} from "@/app/actions/tasks";
import { completeGroupPlacementAction, type PlacementState } from "@/app/actions/group-receiving";
import { Button, Card, CardTitle, Badge, EmptyState } from "@/components/ui";
import { TASK_STATUS_TONE, taskStatusLabel, taskTypeLabel } from "@/lib/task-labels";

export interface TaskDTO {
  id: string;
  type: string;
  title: string;
  description: string | null;
  priority: "NORMAL" | "URGENT";
  status: string;
  createdAt: string;
  actionUrl: string | null;
}
export interface Mate {
  userId: string;
  name: string;
}
export interface IncomingHandoff {
  handoffId: string;
  taskTitle: string;
  taskType: string;
}
export interface PlacementCell {
  id: string;
  code: string;
  level: number | null;
  recommended: boolean;
}
export interface Placement {
  taskId: string;
  routeLabel: string;
  cells: PlacementCell[];
}

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function TaskMeta({ task }: { task: TaskDTO }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-neutral-500">
      <Badge tone={TASK_STATUS_TONE[task.status] ?? "neutral"}>{taskStatusLabel(task.status)}</Badge>
      {task.priority === "URGENT" && <Badge tone="red">срочно</Badge>}
      <span>{taskTypeLabel(task.type)}</span>
      <span>· создано {fmtTime(task.createdAt)}</span>
    </div>
  );
}

function StartTaskForm({ task }: { task: TaskDTO }) {
  const [state, action, pending] = useActionState<TaskActionState, FormData>(startTaskAction, {});
  return (
    <form action={action} className="mt-2 flex flex-col gap-2">
      <input type="hidden" name="taskId" value={task.id} />
      {state.error && (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-red-600">{state.error}</p>
          <input
            name="skipReason"
            placeholder="Причина пропуска (если начинаете не срочную)"
            className="rounded-lg border border-[#e4e4f0] px-3 py-1.5 text-sm"
          />
        </div>
      )}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "…" : "Начать"}
      </Button>
    </form>
  );
}

function HandoffForm({ taskId, mates }: { taskId: string; mates: Mate[] }) {
  const [state, action, pending] = useActionState<TaskActionState, FormData>(requestHandoffAction, {});
  if (mates.length === 0)
    return <p className="mt-2 text-xs text-neutral-400">Нет коллег той же роли на смене для передачи.</p>;
  return (
    <form action={action} className="mt-2 flex flex-col gap-2">
      <input type="hidden" name="taskId" value={taskId} />
      <div className="flex gap-2">
        <select name="toUserId" required className="min-w-0 flex-1 rounded-lg border border-[#e4e4f0] px-3 py-1.5 text-sm">
          <option value="">Кому передать…</option>
          {mates.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name}
            </option>
          ))}
        </select>
        <Button type="submit" variant="ghost" disabled={pending}>
          {pending ? "…" : "Передать"}
        </Button>
      </div>
      {state.error && <p className="text-xs text-red-600">{state.error}</p>}
    </form>
  );
}

function HandoffResponse({ handoffId }: { handoffId: string }) {
  const [aState, aAction, aPending] = useActionState<TaskActionState, FormData>(acceptHandoffAction, {});
  const [rState, rAction, rPending] = useActionState<TaskActionState, FormData>(rejectHandoffAction, {});
  return (
    <div className="mt-2 flex flex-col gap-1">
      <div className="flex gap-2">
        <form action={aAction} className="flex-1">
          <input type="hidden" name="handoffId" value={handoffId} />
          <Button type="submit" disabled={aPending} className="w-full">
            {aPending ? "…" : "Принять"}
          </Button>
        </form>
        <form action={rAction} className="flex-1">
          <input type="hidden" name="handoffId" value={handoffId} />
          <Button type="submit" variant="ghost" disabled={rPending} className="w-full">
            {rPending ? "…" : "Отклонить"}
          </Button>
        </form>
      </div>
      {(aState.error || rState.error) && <p className="text-xs text-red-600">{aState.error || rState.error}</p>}
    </div>
  );
}

// Пакет 4: завершение размещения группы (PLACE_GROUP) — выбор пустой целевой ячейки.
function PlacementForm({ placement }: { placement: Placement }) {
  const [state, action, pending] = useActionState<PlacementState, FormData>(completeGroupPlacementAction, {});
  const [cellId, setCellId] = useState(placement.cells[0]?.id ?? "");
  if (placement.cells.length === 0)
    return (
      <p className="text-xs text-orange-600">
        Нет пустой активной ячейки зоны «{placement.routeLabel}». Освободите ячейку и обновите.
      </p>
    );
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="taskId" value={placement.taskId} />
      <label className="text-xs font-medium text-neutral-500">Целевая ячейка ({placement.routeLabel})</label>
      <select
        name="cellId"
        value={cellId}
        onChange={(e) => setCellId(e.target.value)}
        className="rounded-lg border border-[#e4e4f0] px-3 py-2 text-sm"
      >
        {placement.cells.map((c) => (
          <option key={c.id} value={c.id}>
            {c.code}
            {c.level != null ? ` · ур.${c.level}` : ""}
            {c.recommended ? " · рекомендуется" : ""}
          </option>
        ))}
      </select>
      {state.error && <p className="text-xs text-red-600">{state.error}</p>}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "…" : "Разместить группу"}
      </Button>
    </form>
  );
}

export function WorkerTasks({
  current,
  urgent,
  normal,
  incoming,
  mates,
  placement,
}: {
  current: TaskDTO | null;
  urgent: TaskDTO[];
  normal: TaskDTO[];
  incoming: IncomingHandoff[];
  mates: Mate[];
  placement?: Placement | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      {incoming.length > 0 && (
        <Card>
          <CardTitle>Входящие передачи</CardTitle>
          <div className="flex flex-col gap-3">
            {incoming.map((h) => (
              <div key={h.handoffId} className="rounded-xl border border-[#eee] p-3">
                <div className="text-sm font-semibold">{h.taskTitle}</div>
                <div className="text-xs text-neutral-500">{taskTypeLabel(h.taskType)}</div>
                <HandoffResponse handoffId={h.handoffId} />
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <CardTitle>Текущая задача</CardTitle>
        {current ? (
          <div className="rounded-xl border border-[#eee] p-3">
            <div className="text-sm font-semibold">{current.title}</div>
            {current.description && <div className="mt-0.5 text-sm text-neutral-600">{current.description}</div>}
            <div className="mt-1">
              <TaskMeta task={current} />
            </div>
            <div className="mt-2 flex flex-col gap-2">
              {current.actionUrl && (
                <Link href={current.actionUrl}>
                  <Button className="w-full">Открыть</Button>
                </Link>
              )}
              {placement && current.status === "IN_PROGRESS" && <PlacementForm placement={placement} />}
              {current.status === "IN_PROGRESS" && <HandoffForm taskId={current.id} mates={mates} />}
              {current.status === "HANDOFF_PENDING" && (
                <p className="text-xs text-orange-600">Ожидает принятия передачи получателем.</p>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-neutral-500">Нет задачи в работе. Возьмите задачу из очереди ниже.</p>
        )}
      </Card>

      <Card>
        <CardTitle>Срочные</CardTitle>
        {urgent.length === 0 ? (
          <p className="text-sm text-neutral-500">Нет срочных задач.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {urgent.map((t) => (
              <div key={t.id} className="rounded-xl border border-red-100 bg-red-50/40 p-3">
                <div className="text-sm font-semibold">{t.title}</div>
                <div className="mt-1">
                  <TaskMeta task={t} />
                </div>
                {!current && <StartTaskForm task={t} />}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardTitle>Обычные задачи</CardTitle>
        {normal.length === 0 ? (
          <p className="text-sm text-neutral-500">Очередь пуста.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {normal.map((t) => (
              <div key={t.id} className="rounded-xl border border-[#eee] p-3">
                <div className="text-sm font-semibold">{t.title}</div>
                <div className="mt-1">
                  <TaskMeta task={t} />
                </div>
                {!current && <StartTaskForm task={t} />}
              </div>
            ))}
          </div>
        )}
      </Card>

      {urgent.length + normal.length + (current ? 1 : 0) === 0 && (
        <EmptyState>Задач пока нет. Список обновится автоматически.</EmptyState>
      )}
    </div>
  );
}
