import type { Role } from "@/lib/jwt";

// Русские подписи и тон бейджей для всех ролей (Этап 5). Общий модуль для форм/списков/карточек.

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Администратор",
  RECEIVER: "Приёмка",
  LOADER: "Погрузчик",
  PICKER: "Сборка",
  CONTROLLER: "Контролёр",
  OBSERVER: "Наблюдатель",
  STOREKEEPER: "Кладовщик",
  EMPLOYEE: "Сотрудник",
};

export type BadgeTone = "blue" | "green" | "orange" | "neutral" | "red";
export const ROLE_TONE: Record<Role, BadgeTone> = {
  ADMIN: "blue",
  RECEIVER: "green",
  LOADER: "green",
  PICKER: "green",
  CONTROLLER: "orange",
  OBSERVER: "neutral",
  STOREKEEPER: "orange",
  EMPLOYEE: "neutral",
};

// Порядок показа бейджей/плиток (совпадает с приоритетом ролей).
export const ROLE_ORDER: Role[] = [
  "ADMIN",
  "RECEIVER",
  "LOADER",
  "PICKER",
  "CONTROLLER",
  "OBSERVER",
  "STOREKEEPER",
  "EMPLOYEE",
];

// Роли, предлагаемые к назначению в формах (go-forward). Legacy-роли показываем дополнительно,
// только если они уже есть у пользователя (чтобы не терять их молча — см. user-edit-form).
export const ASSIGNABLE_ROLES: Role[] = ["ADMIN", "RECEIVER", "LOADER", "PICKER", "CONTROLLER", "OBSERVER"];
export const LEGACY_ROLES: Role[] = ["STOREKEEPER", "EMPLOYEE"];

export function roleOptions(roles: Role[]): { value: Role; label: string }[] {
  return [...roles].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b)).map((r) => ({
    value: r,
    label: ROLE_LABEL[r],
  }));
}
