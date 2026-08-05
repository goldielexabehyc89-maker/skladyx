import type { BadgeTone } from "@/lib/role-labels";

// Русские подписи статусов/приоритетов/типов задач (Этап 5/Пакет 2). Общий модуль для UI.

export const TASK_STATUS_LABEL: Record<string, string> = {
  BLOCKED: "Заблокирована",
  QUEUED: "В очереди",
  ASSIGNED: "Назначена",
  IN_PROGRESS: "В работе",
  HANDOFF_PENDING: "Ожидает передачи",
  NEEDS_ATTENTION: "Требует внимания",
  COMPLETED: "Выполнена",
  CANCELLED: "Отменена",
};

export const TASK_STATUS_TONE: Record<string, BadgeTone> = {
  BLOCKED: "neutral",
  QUEUED: "neutral",
  ASSIGNED: "blue",
  IN_PROGRESS: "green",
  HANDOFF_PENDING: "orange",
  NEEDS_ATTENTION: "red",
  COMPLETED: "green",
  CANCELLED: "red",
};

export const TASK_TYPE_LABEL: Record<string, string> = {
  RECEIVE_GROUP: "Приёмка группы",
  PLACE_GROUP: "Размещение группы",
  MOVE_GROUP: "Перестановка группы вниз",
  PICK_ORDER: "Сборка заказа",
  CONTROL_ORDER: "Контроль заказа",
  CORRECT_ORDER: "Исправление заказа",
  ISSUE_ORDER: "Размещение в выдаче",
  DELIVER_ORDER: "Выдача водителю",
  RETRIEVE_COOLING: "Забрать из охлаждения",
};

export const taskTypeLabel = (t: string) => TASK_TYPE_LABEL[t] ?? t;
export const taskStatusLabel = (s: string) => TASK_STATUS_LABEL[s] ?? s;
