// Этап 5/Пакет 2: централизованные коды типов задач очереди (без доменной логики — она в след. пакетах).
// Тип — строковый код; requiredRole хранится отдельным полем WorkflowTask.requiredRole.

export const TASK_TYPES = {
  RECEIVE_GROUP: "RECEIVE_GROUP", // приёмка группы (RECEIVER)
  PLACE_GROUP: "PLACE_GROUP", // размещение/перемещение группы (LOADER)
  MOVE_GROUP: "MOVE_GROUP", // перестановка группы ур.3+ → ур.1-2 под сборку (LOADER, Пакет 6)
  PICK_ORDER: "PICK_ORDER", // сборка заказа (PICKER)
  CONTROL_ORDER: "CONTROL_ORDER", // контроль заказа (CONTROLLER)
  ISSUE_ORDER: "ISSUE_ORDER", // размещение в зоне выдачи/выдача (LOADER)
  RETRIEVE_COOLING: "RETRIEVE_COOLING", // забрать группу из охлаждения (LOADER, срочная, Пакет 5)
} as const;

export type TaskType = (typeof TASK_TYPES)[keyof typeof TASK_TYPES];
export const TASK_TYPE_CODES: readonly TaskType[] = Object.values(TASK_TYPES);
export function isTaskType(x: string): x is TaskType {
  return (TASK_TYPE_CODES as readonly string[]).includes(x);
}
