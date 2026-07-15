import "server-only";
import { prisma } from "@/lib/db";
import type { SessionData } from "@/lib/session";
import { CompanyForbiddenError } from "@/lib/tenant";

// Доступ пользователя к складам. all=true — все склады; иначе только ids.
// Применяется во всех складских вкладках: пользователь видит и действует
// только в своих складах.

export interface WhAccess {
  all: boolean;
  ids: string[];
}

export async function warehouseAccess(session: SessionData): Promise<WhAccess> {
  const u = await prisma.user.findFirst({
    where: { id: session.userId, companyId: session.companyId },
    select: { allWarehouses: true, warehouseLinks: { select: { warehouseId: true } } },
  });
  if (!u || u.allWarehouses) return { all: true, ids: [] };
  return { all: false, ids: u.warehouseLinks.map((l) => l.warehouseId) };
}

// where-фрагмент по полю склада (пустой при доступе ко всем).
export function whereWh(a: WhAccess, field = "warehouseId"): Record<string, unknown> {
  return a.all ? {} : { [field]: { in: a.ids } };
}

export function isWhAllowed(a: WhAccess, id: string | null | undefined): boolean {
  return a.all || (!!id && a.ids.includes(id));
}

// Разрешённые пользователю склады (записи).
export async function allowedWarehouses(
  session: SessionData,
  companyId: string,
  opts?: { activeOnly?: boolean },
) {
  const a = await warehouseAccess(session);
  return prisma.warehouse.findMany({
    where: {
      companyId,
      ...(a.all ? {} : { id: { in: a.ids } }),
      ...(opts?.activeOnly ? { isActive: true } : {}),
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
}

// Склад по id с проверкой доступа (иначе — FORBIDDEN).
export async function getAllowedWarehouse(session: SessionData, companyId: string, id: string) {
  const a = await warehouseAccess(session);
  const w = await prisma.warehouse.findFirst({ where: { id, companyId } });
  if (!w || !isWhAllowed(a, w.id)) throw new CompanyForbiddenError();
  return w;
}
