"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import {
  startTaskAction,
  requestHandoffAction,
  acceptHandoffAction,
  rejectHandoffAction,
  prepareCoolingRetrievalAction,
  placeCoolingRetrievalAction,
  type TaskActionState,
} from "@/app/actions/tasks";
import { completeGroupPlacementAction, prepareGroupPlacementAction, type PlacementState, type PreparePlacementState } from "@/app/actions/group-receiving";
import { reportShortageAction, pickScanAction, completeMoveGroupAction, type OrderActionState } from "@/app/actions/external-orders";
import { PickOrderScanner, MoveGroupScanner, PlaceGroupScanner, CoolingRetrievalScanner } from "./order-scanners";
import { ControlOrderPanel, CorrectOrderPanel, type ControlOrderCtx, type CorrectOrderCtx } from "./control-panels";
import { IssueOrderPanel, DeliverOrderPanel, type IssueOrderCtx, type DeliverOrderCtx } from "./issue-panels";
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
  dueAt: string | null; // Пакет 6: срок (arrivalAt заказа) — показываем для сборки
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
export interface Placement {
  taskId: string;
  routeLabel: string;
  // Пакет 11 (коррекция P1): ячейку назначает система, но ТОЛЬКО по явному «Начать размещение»
  // (клиентский вызов prepareGroupPlacementAction). Рендер страницы бронь не создаёт.
}
export interface Cooling {
  taskId: string;
  label: string;
  thresholdX: number;
}
export interface PickOrderCtx {
  orderId: string;
  externalId: string;
  lines: { id: string; item: string; itemId: string; required: string; picked: string }[];
  picks: { itemId: string; item: string; cellId: string; cell: string; level: number | null; qty: string }[];
}
export interface MoveGroupCtx {
  taskId: string;
  item: string;
  qty: string;
  fromCell: string;
  fromLevel: number | null;
  toCell: string;
  toLevel: number | null;
}

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const fmtDue = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")} ${fmtTime(iso)}`;
};

function TaskMeta({ task }: { task: TaskDTO }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-neutral-500">
      <Badge tone={TASK_STATUS_TONE[task.status] ?? "neutral"}>{taskStatusLabel(task.status)}</Badge>
      {task.priority === "URGENT" && <Badge tone="red">срочно</Badge>}
      <span>{taskTypeLabel(task.type)}</span>
      {task.type === "PICK_ORDER" && task.dueAt && <span className="text-[#4c5fd7]">· к {fmtDue(task.dueAt)}</span>}
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

// Пакет 9B: первичное размещение группы (PLACE_GROUP) — основной путь скан (EAN товара → QR/Code128
// целевой ячейки, сервер сам проверяет код ячейки), ручной ввод кодов — fallback.
// Пакет 11 (коррекция P1): бронь создаётся ТОЛЬКО по явному «Начать размещение» (клиентский вызов
// prepareGroupPlacementAction). До успешной подготовки скан и ручное завершение недоступны. Повторное
// «Начать размещение» идемпотентно возвращает ту же бронь. Ручной fallback использует ту же бронь.
function PlacementBlock({ placement }: { placement: Placement }) {
  const [prep, prepareAct, preparing] = useActionState<PreparePlacementState, FormData>(prepareGroupPlacementAction, {});
  if (!prep.cellCode) {
    return (
      <form action={prepareAct} className="flex flex-col gap-2">
        <input type="hidden" name="taskId" value={placement.taskId} />
        <p className="text-sm text-neutral-600">Зона «{placement.routeLabel}». Нажмите «Начать размещение» — система назначит конкретную ячейку.</p>
        {prep.error && <p className="text-sm text-red-600">{prep.error}</p>}
        <Button type="submit" variant="primary" disabled={preparing} className="w-full">
          {preparing ? "Назначаем ячейку…" : prep.error ? "Повторить" : "Начать размещение"}
        </Button>
      </form>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-xl bg-[#eef7ee] px-3 py-2 text-sm text-green-800">
        Назначенная ячейка: <b>{prep.cellCode}</b> · зона «{placement.routeLabel}»
      </div>
      <PlaceGroupScanner placement={placement} assignedCellCode={prep.cellCode} />
      <ManualPlaceForm placement={placement} assignedCellCode={prep.cellCode} />
    </div>
  );
}

function ManualPlaceForm({ placement, assignedCellCode }: { placement: Placement; assignedCellCode: string }) {
  const [state, action, pending] = useActionState<PlacementState, FormData>(completeGroupPlacementAction, {});
  return (
    <details className="text-xs text-neutral-500">
      <summary className="cursor-pointer">Ввести коды вручную (без камеры)</summary>
      <form action={action} className="mt-2 flex flex-col gap-2">
        <input type="hidden" name="taskId" value={placement.taskId} />
        <p className="text-sm text-neutral-700">Назначенная ячейка: <b>{assignedCellCode}</b></p>
        <input name="ean" required inputMode="numeric" placeholder="EAN товара (8/13 цифр)" className="rounded-lg border border-[#e4e4f0] px-3 py-1.5 text-sm" />
        <input name="cellCode" required placeholder={`Код назначенной ячейки (${assignedCellCode})`} className="rounded-lg border border-[#e4e4f0] px-3 py-1.5 text-sm" />
        {state.error && <p className="text-red-600">{state.error}</p>}
        <Button type="submit" variant="ghost" disabled={pending}>{pending ? "…" : "Разместить в назначенную ячейку"}</Button>
      </form>
      <div className="mt-1 text-[11px] text-neutral-400">Разместить можно только в назначенную ячейку {assignedCellCode}.</div>
    </details>
  );
}

// Пакет 9B: двухфазный забор из охлаждения — основной путь скан (CoolingRetrievalScanner),
// ручной ввод кодов — fallback. Фаза 1 — ячейка охлаждения + EAN + температура; если готово (≤ X) —
// Фаза 2: показать назначенную ячейку и подтвердить её сканом (движение через ядро).
const coolInput = "rounded-lg border border-[#e4e4f0] px-3 py-1.5 text-sm";
function CoolingBlock({ cooling }: { cooling: Cooling }) {
  return (
    <div className="flex flex-col gap-2">
      <CoolingRetrievalScanner cooling={cooling} />
      <ManualCoolingForm cooling={cooling} />
    </div>
  );
}

function ManualCoolingForm({ cooling }: { cooling: Cooling }) {
  const [prep, prepAction, prepPending] = useActionState<TaskActionState, FormData>(prepareCoolingRetrievalAction, {});
  const [plc, plcAction, plcPending] = useActionState<TaskActionState, FormData>(placeCoolingRetrievalAction, {});
  return (
    <details className="text-xs text-neutral-500">
      <summary className="cursor-pointer">Ввести коды вручную (без камеры)</summary>
      <div className="mt-2 flex flex-col gap-3">
        <form action={prepAction} className="flex flex-col gap-2">
          <input type="hidden" name="taskId" value={cooling.taskId} />
          <label className="text-xs font-medium text-neutral-500">Фаза 1 · замер (порог X = {cooling.thresholdX})</label>
          <input name="fromCellCode" required placeholder="Ячейка охлаждения (QR/Code 128)" className={coolInput} />
          <input name="ean" required inputMode="numeric" placeholder="EAN товара (8/13 цифр)" className={coolInput} />
          <input name="temperature" type="number" inputMode="decimal" step="0.1" required placeholder="Температура, °C" className={coolInput} />
          {prep.error && <p className="text-xs text-red-600">{prep.error}</p>}
          {prep.ready === false && <p className="text-xs text-neutral-500">Выше X — записан новый цикл охлаждения.</p>}
          <Button type="submit" variant="ghost" disabled={prepPending} className="w-full">{prepPending ? "…" : "Записать замер"}</Button>
        </form>
        {prep.ready && prep.targetCellCode && (
          <form action={plcAction} className="flex flex-col gap-2 border-t border-[#eee] pt-2">
            <input type="hidden" name="taskId" value={cooling.taskId} />
            <p className="text-xs font-medium text-green-700">Готово к вывозу → ячейка <b>{prep.targetCellCode}</b>. Введите коды ячейки охлаждения, EAN и целевой ячейки.</p>
            <input name="fromCellCode" required placeholder="Ячейка охлаждения (QR/Code 128)" className={coolInput} />
            <input name="ean" required inputMode="numeric" placeholder="EAN товара (8/13 цифр)" className={coolInput} />
            <input name="targetCellCode" required placeholder="Целевая ячейка (QR/Code 128)" className={coolInput} />
            {plc.error && <p className="text-xs text-red-600">{plc.error}</p>}
            <Button type="submit" variant="ghost" disabled={plcPending} className="w-full">{plcPending ? "…" : "Разместить в назначенную ячейку"}</Button>
          </form>
        )}
      </div>
    </details>
  );
}

// Пакет 6: ручной ввод ОТСКАНИРОВАННЫХ кодов (fallback к камере + путь без камеры). Отправляет
// коды QR (не скрытые id) — серверная сверка ячейка/группа/резерв ↔ заказ в actions/external-orders.
function ManualPickForm({ taskId }: { taskId: string }) {
  const [state, action, pending] = useActionState<OrderActionState, FormData>(pickScanAction, {});
  return (
    <details className="text-xs text-neutral-500">
      <summary className="cursor-pointer">Ввести коды вручную (без камеры)</summary>
      <form action={action} className="mt-2 flex flex-col gap-2">
        <input type="hidden" name="taskId" value={taskId} />
        <input name="cellCode" required placeholder="Код QR ячейки (1-2)" className="rounded-lg border border-[#e4e4f0] px-3 py-1.5 text-sm" />
        <input name="ean" required inputMode="numeric" placeholder="EAN товара (8/13 цифр)" className="rounded-lg border border-[#e4e4f0] px-3 py-1.5 text-sm" />
        <input name="qty" required type="number" inputMode="decimal" step="1" placeholder="Количество" className="rounded-lg border border-[#e4e4f0] px-3 py-1.5 text-sm" />
        {state.error && <p className="text-red-600">{state.error}</p>}
        <Button type="submit" variant="ghost" disabled={pending}>{pending ? "…" : "Собрать по кодам"}</Button>
      </form>
    </details>
  );
}
function ManualMoveForm({ taskId }: { taskId: string }) {
  const [state, action, pending] = useActionState<OrderActionState, FormData>(completeMoveGroupAction, {});
  return (
    <details className="text-xs text-neutral-500">
      <summary className="cursor-pointer">Ввести коды вручную (без камеры)</summary>
      <form action={action} className="mt-2 flex flex-col gap-2">
        <input type="hidden" name="taskId" value={taskId} />
        <input name="fromCellCode" required placeholder="Код исходной ячейки (QR/Code 128)" className="rounded-lg border border-[#e4e4f0] px-3 py-1.5 text-sm" />
        <input name="ean" required inputMode="numeric" placeholder="EAN товара (8/13 цифр)" className="rounded-lg border border-[#e4e4f0] px-3 py-1.5 text-sm" />
        <input name="cellCode" required placeholder="Код целевой ячейки (QR/Code 128)" className="rounded-lg border border-[#e4e4f0] px-3 py-1.5 text-sm" />
        {state.error && <p className="text-red-600">{state.error}</p>}
        <Button type="submit" variant="ghost" disabled={pending}>{pending ? "…" : "Переставить по кодам"}</Button>
      </form>
    </details>
  );
}

// Пакет 6: фиксация недостачи по своей задаче сборки (данные не подменяются, причина в аудит).
function ShortageForm({ taskId }: { taskId: string }) {
  const [state, action, pending] = useActionState<OrderActionState, FormData>(reportShortageAction, {});
  return (
    <details className="text-xs text-neutral-500">
      <summary className="cursor-pointer">Сообщить о недостаче</summary>
      <form action={action} className="mt-2 flex flex-col gap-2">
        <input type="hidden" name="taskId" value={taskId} />
        <input name="reason" required placeholder="Причина недостачи" className="rounded-lg border border-[#e4e4f0] px-3 py-1.5 text-sm" />
        {state.error && <p className="text-red-600">{state.error}</p>}
        <Button type="submit" variant="ghost" disabled={pending}>{pending ? "…" : "Зафиксировать недостачу"}</Button>
      </form>
    </details>
  );
}

export function WorkerTasks({
  current,
  urgent,
  normal,
  incoming,
  mates,
  placement,
  cooling,
  pickOrder,
  moveGroup,
  controlOrder,
  correctOrder,
  issueOrder,
  deliverOrder,
}: {
  current: TaskDTO | null;
  urgent: TaskDTO[];
  normal: TaskDTO[];
  incoming: IncomingHandoff[];
  mates: Mate[];
  placement?: Placement | null;
  cooling?: Cooling | null;
  pickOrder?: PickOrderCtx | null;
  moveGroup?: MoveGroupCtx | null;
  controlOrder?: ControlOrderCtx | null;
  correctOrder?: CorrectOrderCtx | null;
  issueOrder?: IssueOrderCtx | null;
  deliverOrder?: DeliverOrderCtx | null;
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
              {placement && current.status === "IN_PROGRESS" && <PlacementBlock placement={placement} />}
              {cooling && current.status === "IN_PROGRESS" && <CoolingBlock cooling={cooling} />}
              {moveGroup && current.status === "IN_PROGRESS" && (
                <>
                  <MoveGroupScanner ctx={moveGroup} />
                  <ManualMoveForm taskId={current.id} />
                </>
              )}
              {pickOrder && current.status === "IN_PROGRESS" && (
                <>
                  <PickOrderScanner ctx={pickOrder} taskId={current.id} />
                  <ManualPickForm taskId={current.id} />
                  <ShortageForm taskId={current.id} />
                </>
              )}
              {controlOrder && current.status === "IN_PROGRESS" && <ControlOrderPanel ctx={controlOrder} />}
              {correctOrder && current.status === "IN_PROGRESS" && <CorrectOrderPanel ctx={correctOrder} />}
              {issueOrder && current.status === "IN_PROGRESS" && <IssueOrderPanel ctx={issueOrder} />}
              {deliverOrder && current.status === "IN_PROGRESS" && <DeliverOrderPanel ctx={deliverOrder} />}
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
