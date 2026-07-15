import type {
  PickListStatus,
  SupplierOrderStatus,
  IssueStatus,
  InventoryStatus,
  WriteOffStatus,
} from "@prisma/client";

// Единая карта статусов всех документов: подпись и тон бейджа в одном месте,
// чтобы «новая / в сборке / проведено / отменена» выглядели одинаково везде.
// Используется через <StatusBadge status={...} /> из ui.tsx.

export type StatusTone = "neutral" | "green" | "orange" | "red" | "blue";
export interface StatusInfo {
  label: string;
  tone: StatusTone;
}

export const PICKLIST_STATUS: Record<PickListStatus, StatusInfo> = {
  NEW: { label: "новая", tone: "orange" },
  PICKING: { label: "в сборке", tone: "blue" },
  PICKED: { label: "собрана", tone: "blue" },
  STAGED: { label: "в зоне выдачи", tone: "blue" },
  ISSUED: { label: "выдана", tone: "green" },
  CANCELLED: { label: "отменена", tone: "red" },
};

// Перемещение — та же модель PickList, но формулировки среднего рода.
export const TRANSFER_STATUS: Record<PickListStatus, StatusInfo> = {
  NEW: { label: "новое", tone: "orange" },
  PICKING: { label: "в сборке", tone: "blue" },
  PICKED: { label: "собрано", tone: "blue" },
  STAGED: { label: "в зоне выдачи", tone: "blue" },
  ISSUED: { label: "перемещено", tone: "green" },
  CANCELLED: { label: "отменено", tone: "red" },
};

export const ORDER_STATUS: Record<SupplierOrderStatus, StatusInfo> = {
  DRAFT: { label: "черновик", tone: "orange" },
  ORDERED: { label: "заказан", tone: "blue" },
  RECEIVED: { label: "принят", tone: "green" },
  CANCELLED: { label: "отменён", tone: "red" },
};
export const ORDER_PARTIAL: StatusInfo = { label: "частично принят", tone: "orange" };

export const ISSUE_STATUS: Record<IssueStatus, StatusInfo> = {
  PENDING: { label: "ждёт подтверждения", tone: "orange" },
  CONFIRMED: { label: "подтверждена", tone: "green" },
  CANCELLED: { label: "отменена", tone: "red" },
};

export const INVENTORY_STATUS: Record<InventoryStatus, StatusInfo> = {
  IN_PROGRESS: { label: "подсчёт", tone: "blue" },
  REVIEW: { label: "сверка", tone: "orange" },
  POSTED: { label: "проведена", tone: "green" },
  CANCELLED: { label: "отменена", tone: "red" },
};

export const WRITEOFF_STATUS: Record<WriteOffStatus, StatusInfo> = {
  DRAFT: { label: "черновик", tone: "orange" },
  POSTED: { label: "проведено", tone: "green" },
};
