"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { ArrowRight, AlertTriangle } from "lucide-react";
import { TaskTimer } from "./task-timer";
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
  // TASK-008: серверные timestamps жизненного цикла для живого таймера срочной/отложенной задачи.
  availableAt: string | null;
  assignedAt: string | null;
  startedAt: string | null;
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
  // TASK-006: операционные поля из структурированных данных (не парсинг title/description).
  // itemName/qty — напрямую из HandlingGroup и связанного Item; source — фактическая зона группы
  // (приёмка); targetZone — целевая зона маршрута («Хранение»/«Охлаждение»). Конкретная ячейка приходит
  // после «Начать размещение» (prepareGroupPlacementAction); рендер брони не создаёт.
  itemName: string;
  qty: number;
  source: string;
  targetZone: string;
}
export interface Cooling {
  taskId: string;
  thresholdX: number;
  // TASK-006 (расширение): структурированные поля для компактной карточки/шторки (не парсинг title).
  itemName: string;
  qty: number;
  coolingCell: string; // код исходной COOLING-ячейки (ОХ-01)
}
// TASK-006 (расширение): единый компактный контекст физической задачи погрузчика (команда + товар +
// количество + маршрут «откуда → куда»). Строится из структурированных моделей на сервере, пакетно.
export interface LoaderCard {
  taskId: string;
  command: string;   // «Разместить» / «Забрать из охлаждения» / «Переместить» / «Разместить заказ в выдаче» / «Выдать водителю»
  detail: string;    // «<товар> · <кол-во> шт» или «Заказ <externalId> · <N> поз. · <M> шт»
  from: string;
  to: string;
  note?: string;     // напр. «Ячейка будет назначена после замера»
}
// Известные физические типы задач погрузчика — для них компактная карточка обязательна; fallback на
// техническую карточку не допускается (повреждённый контекст → понятная ошибка, старт заблокирован).
export const LOADER_PHYSICAL_TYPES = new Set(["PLACE_GROUP", "RETRIEVE_COOLING", "MOVE_GROUP", "ISSUE_ORDER", "DELIVER_ORDER"]);
export interface PickOrderCtx {
  orderId: string;
  externalId: string;
  positions: number;
  totalRequired: string;
  totalPicked: string;
  linesDone: number;
  linesTotal: number;
  // PICK-001: детерминированный следующий незавершённый резерв (конкретная ячейка/товар/количество).
  next: { cell: string; cellLevel: number | null; item: string; itemId: string; qty: string } | null;
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

// TASK-009: насыщенный бейдж «Срочно» (иконка + текст) — смысл не только цветом.
export function UrgentChip() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-bold text-white">
      <AlertTriangle size={11} aria-hidden /> Срочно
    </span>
  );
}
// TASK-009: активная (не терминальная) срочная задача → очень светлый красный фон + спокойная рамка.
export function isUrgentActive(task: TaskDTO): boolean {
  return task.priority === "URGENT" && task.status !== "COMPLETED" && task.status !== "CANCELLED";
}

// TASK-006 (расширение): компактная карточка физической задачи погрузчика — только команда, товар,
// количество, маршрут; срочная — красное выделение, бейдж «Срочно» и живой таймер; кнопка «Начать»,
// если задача ещё не начата. Без типа/статуса/времени/ID/EAN/description. Код цели — самый заметный.
function LoaderTaskCard({ card, task, serverNow, canStart, children }: { card: LoaderCard; task: TaskDTO; serverNow: string; canStart?: boolean; children?: React.ReactNode }) {
  const urgent = isUrgentActive(task);
  return (
    <div className={"rounded-xl border p-3 " + (urgent ? "border-red-200 bg-red-50" : "border-[#eee]")}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-lg font-bold text-[#1a1a1a]">{card.command}</div>
        {urgent && <UrgentChip />}
      </div>
      <div className="mt-0.5 text-base font-semibold text-[#1a1a1a]">{card.detail}</div>
      <div className="mt-1 flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-base text-neutral-500">{card.from}</span>
        <ArrowRight size={20} className="shrink-0 text-neutral-400" aria-hidden />
        <span className="min-w-0 truncate text-lg font-semibold text-[#1a1a1a]">{card.to}</span>
      </div>
      {card.note && <div className="mt-0.5 text-xs text-neutral-500">{card.note}</div>}
      {urgent && (
        <div className="mt-1">
          <TaskTimer serverNowIso={serverNow} status={task.status} availableAtIso={task.availableAt} assignedAtIso={task.assignedAt} startedAtIso={task.startedAt} createdAtIso={task.createdAt} />
        </div>
      )}
      {canStart && <StartTaskForm task={task} />}
      {children && <div className="mt-2 flex flex-col gap-2">{children}</div>}
    </div>
  );
}

function TaskMeta({ task, serverNow }: { task: TaskDTO; serverNow?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-neutral-500">
      <Badge tone={TASK_STATUS_TONE[task.status] ?? "neutral"}>{taskStatusLabel(task.status)}</Badge>
      {task.priority === "URGENT" && <UrgentChip />}
      <span>{taskTypeLabel(task.type)}</span>
      {task.type === "PICK_ORDER" && task.dueAt && <span className="text-[#4c5fd7]">· к {fmtDue(task.dueAt)}</span>}
      <span>· создано {fmtTime(task.createdAt)}</span>
      {serverNow && isUrgentActive(task) && (
        <TaskTimer serverNowIso={serverNow} status={task.status} availableAtIso={task.availableAt} assignedAtIso={task.assignedAt} startedAtIso={task.startedAt} createdAtIso={task.createdAt} />
      )}
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
// TASK-006: компактная физическая задача — только команда «Разместить» и маршрут «<откуда> → <куда>».
// Ни типа/статуса/времени задачи, ни title/description. Код целевой ячейки — самый заметный элемент.
function PlacementBlock({ placement }: { placement: Placement }) {
  const [prep, prepareAct, preparing] = useActionState<PreparePlacementState, FormData>(prepareGroupPlacementAction, {});
  const assigned = !!prep.cellCode;
  const target = prep.cellCode ?? placement.targetZone;
  return (
    <div className="flex flex-col gap-3">
      {/* Команда + товар·количество + маршрут (компактно). Код целевой ячейки — самый заметный элемент. */}
      <div>
        <div className="text-lg font-bold text-[#1a1a1a]">Разместить</div>
        {/* Товар и количество: название переносится, количество не отрывается от товара. */}
        <div className="mt-0.5 text-base font-semibold text-[#1a1a1a]">
          {placement.itemName} <span className="whitespace-nowrap font-normal text-neutral-500">· {placement.qty} шт</span>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-base text-neutral-500">{placement.source}</span>
          <ArrowRight size={20} className="shrink-0 text-neutral-400" aria-hidden />
          <span className={assigned
            ? "min-w-0 truncate font-mono text-2xl font-extrabold tracking-tight text-[#1a1a1a]"
            : "min-w-0 truncate text-lg font-semibold text-[#1a1a1a]"}>{target}</span>
        </div>
      </div>
      {!assigned ? (
        <form action={prepareAct} className="flex flex-col gap-2">
          <input type="hidden" name="taskId" value={placement.taskId} />
          {prep.error && <p role="alert" className="text-sm font-medium text-red-600">{prep.error}</p>}
          <Button type="submit" variant="primary" disabled={preparing} className="w-full">
            {preparing ? "Назначаем ячейку…" : prep.error ? "Повторить" : "Начать размещение"}
          </Button>
        </form>
      ) : (
        <PlaceGroupScanner placement={placement} assignedCellCode={prep.cellCode!} />
      )}
    </div>
  );
}


// Пакет 9B: двухфазный забор из охлаждения — основной путь скан (CoolingRetrievalScanner),
// ручной ввод кодов — fallback. Фаза 1 — ячейка охлаждения + EAN + температура; если готово (≤ X) —
// Фаза 2: показать назначенную ячейку и подтвердить её сканом (движение через ядро).
function CoolingBlock({ cooling }: { cooling: Cooling }) {
  return (
    <div className="flex flex-col gap-2">
      <CoolingRetrievalScanner cooling={cooling} />
    </div>
  );
}


// Пакет 6: ручной ввод ОТСКАНИРОВАННЫХ кодов (fallback к камере + путь без камеры). Отправляет
// коды QR (не скрытые id) — серверная сверка ячейка/группа/резерв ↔ заказ в actions/external-orders.

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

// TASK-005/009: одна строка очереди. Срочная активная задача — светло-красный фон + спокойная рамка,
// насыщенный бейдж «Срочно» и живой таймер (через TaskMeta). Текст остаётся тёмным.
// Повреждённый контекст известной физической задачи: понятная ошибка, старт заблокирован (без метаданных).
function LoaderErrorCard({ task }: { task: TaskDTO }) {
  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3">
      <div className="text-sm font-semibold text-red-700">Данные задачи недоступны</div>
      <div className="mt-0.5 text-sm text-neutral-600">Не удалось загрузить товар и маршрут. Обновите список или обратитесь к администратору — задачу нельзя начать.</div>
    </div>
  );
}

function QueueItem({ task, canStart, serverNow, card }: { task: TaskDTO; canStart: boolean; serverNow: string; card?: LoaderCard }) {
  // TASK-006 (расширение): физическая задача погрузчика — компактная карточка (команда/деталь/маршрут).
  if (card) return <LoaderTaskCard card={card} task={task} serverNow={serverNow} canStart={canStart} />;
  // Известный физический тип без контекста — не откатываемся на техническую карточку.
  if (LOADER_PHYSICAL_TYPES.has(task.type)) return <LoaderErrorCard task={task} />;
  const urgentCard = isUrgentActive(task);
  return (
    <div className={"rounded-xl border p-3 " + (urgentCard ? "border-red-200 bg-red-50" : "border-[#eee]")}>
      <div className="text-sm font-semibold text-[#1a1a1a]">{task.title}</div>
      <div className="mt-1"><TaskMeta task={task} serverNow={serverNow} /></div>
      {canStart && <StartTaskForm task={task} />}
    </div>
  );
}

// TASK-005: пока идёт текущая задача — ожидающая очередь показывается свёрнутой строкой
// «Срочные: N · Обычные: N», раскрывается по нажатию; новая срочная выделяется, но не прерывает.
function QueueSummary({ urgent, normal, serverNow, loaderCards }: { urgent: TaskDTO[]; normal: TaskDTO[]; serverNow: string; loaderCards: Record<string, LoaderCard> }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between gap-2 text-left">
        <span className="flex items-center gap-2 text-sm font-semibold">
          Очередь
          {urgent.length > 0 && <Badge tone="red">Срочные: {urgent.length}</Badge>}
          <span className="text-neutral-500">Обычные: {normal.length}</span>
        </span>
        <span className="text-xs text-neutral-400">{open ? "Свернуть ▾" : "Показать ▸"}</span>
      </button>
      {open && (
        <div className="mt-3 flex flex-col gap-3">
          {urgent.map((t) => <QueueItem key={t.id} task={t} canStart={false} serverNow={serverNow} card={loaderCards[t.id]} />)}
          {normal.map((t) => <QueueItem key={t.id} task={t} canStart={false} serverNow={serverNow} card={loaderCards[t.id]} />)}
        </div>
      )}
    </Card>
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
  serverNow,
  loaderCards,
}: {
  current: TaskDTO | null;
  urgent: TaskDTO[];
  normal: TaskDTO[];
  incoming: IncomingHandoff[];
  mates: Mate[];
  serverNow: string;
  loaderCards: Record<string, LoaderCard>;
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

      {/* TASK-005: карточку «Текущая задача» рендерим только когда задача есть */}
      {/* TASK-006: PLACE_GROUP «в работе» — компактная карточка (только команда и маршрут), без
          title/description/TaskMeta/типа/статуса/времени. Остальные типы — прежний вид. */}
      {/* TASK-006 (расширение): все физические задачи погрузчика — компактная карточка (команда/деталь/
          маршрут) + действия сканирования, без title/description/TaskMeta. */}
      {current && placement && current.status === "IN_PROGRESS" ? (
        <Card>
          <CardTitle>Текущая задача</CardTitle>
          <div className="rounded-xl border border-[#eee] p-3">
            <PlacementBlock placement={placement} />
          </div>
        </Card>
      ) : current && cooling && loaderCards[current.id] && current.status === "IN_PROGRESS" ? (
        <Card>
          <CardTitle>Текущая задача</CardTitle>
          <LoaderTaskCard card={loaderCards[current.id]} task={current} serverNow={serverNow}>
            <CoolingBlock cooling={cooling} />
          </LoaderTaskCard>
        </Card>
      ) : current && moveGroup && loaderCards[current.id] && current.status === "IN_PROGRESS" ? (
        <Card>
          <CardTitle>Текущая задача</CardTitle>
          <LoaderTaskCard card={loaderCards[current.id]} task={current} serverNow={serverNow}>
            <MoveGroupScanner ctx={moveGroup} />
          </LoaderTaskCard>
        </Card>
      ) : current && issueOrder && loaderCards[current.id] && current.status === "IN_PROGRESS" ? (
        <Card>
          <CardTitle>Текущая задача</CardTitle>
          <LoaderTaskCard card={loaderCards[current.id]} task={current} serverNow={serverNow}>
            <IssueOrderPanel ctx={issueOrder} />
          </LoaderTaskCard>
        </Card>
      ) : current && deliverOrder && loaderCards[current.id] && current.status === "IN_PROGRESS" ? (
        <Card>
          <CardTitle>Текущая задача</CardTitle>
          <LoaderTaskCard card={loaderCards[current.id]} task={current} serverNow={serverNow}>
            <DeliverOrderPanel ctx={deliverOrder} />
          </LoaderTaskCard>
        </Card>
      ) : current && pickOrder && current.status === "IN_PROGRESS" ? (
        // PICK-001: компактная карточка сборщика — команда/номер/позиции·количество/прогресс/текущее
        // действие. Без title/description/типа/статуса/времени и повторяющихся инструкций.
        <Card>
          <CardTitle>Текущая задача</CardTitle>
          <div className="rounded-xl border border-[#eee] p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-[#667eea]">Собрать заказ</div>
            <div className="mt-0.5 text-base font-semibold text-[#1a1a1a]">№ {pickOrder.externalId}</div>
            <div className="mt-0.5 text-sm text-neutral-600">{pickOrder.positions} поз. · {pickOrder.totalRequired} шт</div>
            <div className="mt-1 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#eef0f8]">
                <div className="h-full rounded-full bg-gradient-to-r from-[#667eea] to-[#764ba2]" style={{ width: `${pickOrder.linesTotal ? Math.round((pickOrder.linesDone / pickOrder.linesTotal) * 100) : 0}%` }} />
              </div>
              <span className="text-xs text-neutral-500">{pickOrder.linesDone}/{pickOrder.linesTotal}</span>
            </div>
            <div className="mt-2 flex flex-col gap-2">
              <PickOrderScanner ctx={pickOrder} taskId={current.id} />
              <ShortageForm taskId={current.id} />
            </div>
          </div>
        </Card>
      ) : current && LOADER_PHYSICAL_TYPES.has(current.type) && current.status === "IN_PROGRESS" ? (
        // Известная физическая задача погрузчика с повреждённым контекстом — ошибка, без метаданных.
        <Card>
          <CardTitle>Текущая задача</CardTitle>
          <LoaderErrorCard task={current} />
        </Card>
      ) : current && (
        <Card>
          <CardTitle>Текущая задача</CardTitle>
          <div className={"rounded-xl border p-3 " + (isUrgentActive(current) ? "border-red-200 bg-red-50" : "border-[#eee]")}>
            <div className="text-sm font-semibold text-[#1a1a1a]">{current.title}</div>
            {current.description && <div className="mt-0.5 text-sm text-neutral-600">{current.description}</div>}
            <div className="mt-1">
              <TaskMeta task={current} serverNow={serverNow} />
            </div>
            <div className="mt-2 flex flex-col gap-2">
              {current.actionUrl && (
                <Link href={current.actionUrl}>
                  <Button className="w-full">Открыть</Button>
                </Link>
              )}
              {controlOrder && current.status === "IN_PROGRESS" && <ControlOrderPanel ctx={controlOrder} />}
              {correctOrder && current.status === "IN_PROGRESS" && <CorrectOrderPanel ctx={correctOrder} />}
              {current.status === "IN_PROGRESS" && <HandoffForm taskId={current.id} mates={mates} />}
              {current.status === "HANDOFF_PENDING" && (
                <p className="text-xs text-orange-600">Ожидает принятия передачи получателем.</p>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* TASK-005: очередь. При текущей задаче — свёрнутая сводка; без текущей — только непустые списки
          (срочные выше обычных); если всё пусто — одно компактное пустое состояние. */}
      {current ? (
        (urgent.length + normal.length > 0) && <QueueSummary urgent={urgent} normal={normal} serverNow={serverNow} loaderCards={loaderCards} />
      ) : urgent.length + normal.length > 0 ? (
        <>
          {urgent.length > 0 && (
            <Card>
              <CardTitle>Срочные</CardTitle>
              <div className="flex flex-col gap-3">{urgent.map((t) => <QueueItem key={t.id} task={t} canStart serverNow={serverNow} card={loaderCards[t.id]} />)}</div>
            </Card>
          )}
          {normal.length > 0 && (
            <Card>
              <CardTitle>Обычные задачи</CardTitle>
              <div className="flex flex-col gap-3">{normal.map((t) => <QueueItem key={t.id} task={t} canStart serverNow={serverNow} card={loaderCards[t.id]} />)}</div>
            </Card>
          )}
        </>
      ) : (
        <EmptyState>Задач пока нет. Список обновится автоматически.</EmptyState>
      )}
    </div>
  );
}
