import type { ZoneKind } from "@prisma/client";

// Этап 5/Пакет 3: зоны склада. Client-safe (только данные и предикаты, без prisma/server-only) —
// используется и на сервере (actions/pages), и в клиентских компонентах (плитки/лейблы).
//
// Виртуальные зоны (RECEIVING/CONTROL/DISCREPANCY) — «одна большая ячейка», без физических Cell.
// Физические зоны (STORAGE/COOLING/ISSUE/BUFFER) содержат ячейки. BUFFER — физическая ячейка,
// а не виртуальная зона. isStaging синхронизируется с зоной ISSUE (обратная совместимость).

export const ZONE_KINDS: readonly ZoneKind[] = [
  "RECEIVING",
  "STORAGE",
  "COOLING",
  "CONTROL",
  "ISSUE",
  "DISCREPANCY",
  "BUFFER",
];

export const VIRTUAL_ZONE_KINDS: readonly ZoneKind[] = ["RECEIVING", "CONTROL", "DISCREPANCY"];
export const PHYSICAL_ZONE_KINDS: readonly ZoneKind[] = ["STORAGE", "COOLING", "ISSUE", "BUFFER"];

export function isVirtualZoneKind(kind: ZoneKind): boolean {
  return VIRTUAL_ZONE_KINDS.includes(kind);
}
export function isPhysicalZoneKind(kind: ZoneKind): boolean {
  return PHYSICAL_ZONE_KINDS.includes(kind);
}
// isStaging (старое поле «зона выдачи») = зона ISSUE.
export function zoneKindIsStaging(kind: ZoneKind): boolean {
  return kind === "ISSUE";
}
// Уровень обязателен только у зоны хранения (у остальных физических — необязателен).
export function zoneKindRequiresLevel(kind: ZoneKind): boolean {
  return kind === "STORAGE";
}

// Стандартный набор зон, создаваемый для каждого склада (миграция-backfill и новые склады).
// code == kind у стандартных зон; name настраивается организацией.
export const STANDARD_ZONES: readonly { kind: ZoneKind; code: string; name: string; sortOrder: number }[] = [
  { kind: "RECEIVING", code: "RECEIVING", name: "Зона приёмки", sortOrder: 10 },
  { kind: "STORAGE", code: "STORAGE", name: "Хранение", sortOrder: 20 },
  { kind: "COOLING", code: "COOLING", name: "Охлаждение", sortOrder: 30 },
  { kind: "CONTROL", code: "CONTROL", name: "Зона контроля", sortOrder: 40 },
  { kind: "ISSUE", code: "ISSUE", name: "Зона выдачи", sortOrder: 50 },
  { kind: "DISCREPANCY", code: "DISCREPANCY", name: "Зона расхождений", sortOrder: 60 },
  { kind: "BUFFER", code: "BUFFER", name: "Буфер", sortOrder: 70 },
];

export const ZONE_KIND_LABEL: Record<ZoneKind, string> = {
  RECEIVING: "Приёмка",
  STORAGE: "Хранение",
  COOLING: "Охлаждение",
  CONTROL: "Контроль",
  ISSUE: "Выдача",
  DISCREPANCY: "Расхождения",
  BUFFER: "Буфер",
};

// Тон бейджа зоны (значения совместимы с Badge tone).
export const ZONE_KIND_TONE: Record<ZoneKind, "neutral" | "blue" | "green" | "orange" | "red"> = {
  RECEIVING: "neutral",
  STORAGE: "green",
  COOLING: "blue",
  CONTROL: "orange",
  ISSUE: "blue",
  DISCREPANCY: "red",
  BUFFER: "neutral",
};
