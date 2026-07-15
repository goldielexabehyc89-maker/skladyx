import { Prisma } from "@prisma/client";

// Форматирование для UI (русская локаль).

export function fmtQty(qty: Prisma.Decimal | number | string): string {
  const n = typeof qty === "object" ? qty.toNumber() : Number(qty);
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 3 });
}

export function fmtRub(value: Prisma.Decimal | number | string): string {
  const n = typeof value === "object" ? value.toNumber() : Number(value);
  return `${n.toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ₽`;
}

export function fmtDate(d: Date): string {
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function fmtDateTime(d: Date): string {
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
