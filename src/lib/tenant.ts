import "server-only";
import { prisma } from "@/lib/db";
import type { SessionData } from "@/lib/session";

// Сердце изоляции компаний (мультитенантность с первого дня, в UI пока не видна).
// Любой доступ к доменным данным идёт через этот слой, который ОБЯЗАТЕЛЬНО
// подмешивает companyId из сессии.

export class CompanyForbiddenError extends Error {
  constructor() {
    super("FORBIDDEN");
    this.name = "CompanyForbiddenError";
  }
}

export function resolveCompanyId(session: SessionData): string {
  if (!session.companyId) throw new CompanyForbiddenError();
  return session.companyId;
}

// Company-scoped доступ: безопасные чтения, всегда фильтрующие по companyId.
// Для записей companyId брать из scoped(session).companyId.
export function scoped(session: SessionData) {
  const companyId = resolveCompanyId(session);

  return {
    companyId,

    async company() {
      const c = await prisma.company.findUnique({ where: { id: companyId } });
      if (!c) throw new CompanyForbiddenError();
      return c;
    },

    users() {
      return prisma.user.findMany({
        where: { companyId },
        orderBy: [{ role: "asc" }, { name: "asc" }],
      });
    },

    async user(userId: string) {
      const u = await prisma.user.findFirst({ where: { id: userId, companyId } });
      if (!u) throw new CompanyForbiddenError();
      return u;
    },

    warehouses() {
      return prisma.warehouse.findMany({
        where: { companyId },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      });
    },

    async warehouse(warehouseId: string) {
      const w = await prisma.warehouse.findFirst({ where: { id: warehouseId, companyId } });
      if (!w) throw new CompanyForbiddenError();
      return w;
    },

    cells(warehouseId: string) {
      return prisma.cell.findMany({
        where: { companyId, warehouseId },
        orderBy: { code: "asc" },
      });
    },

    // Этап 5/Пакет 3: зоны склада (в порядке отображения).
    zones(warehouseId: string) {
      return prisma.warehouseZone.findMany({
        where: { companyId, warehouseId },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      });
    },

    async cell(cellId: string) {
      const c = await prisma.cell.findFirst({ where: { id: cellId, companyId } });
      if (!c) throw new CompanyForbiddenError();
      return c;
    },

    uoms() {
      return prisma.uom.findMany({ where: { companyId }, orderBy: { name: "asc" } });
    },

    items(search?: string) {
      const q = search?.trim();
      return prisma.item.findMany({
        where: {
          companyId,
          // Пакет 9B: поиск по названию, EAN (штрихкод), SKU и внешнему идентификатору.
          ...(q
            ? {
                OR: [
                  { name: { contains: q, mode: "insensitive" as const } },
                  { sku: { contains: q, mode: "insensitive" as const } },
                  { externalId: { contains: q, mode: "insensitive" as const } },
                  { barcodes: { some: { code: { contains: q } } } },
                ],
              }
            : {}),
        },
        include: { uom: true, barcodes: { orderBy: { createdAt: "asc" } } },
        orderBy: { name: "asc" },
      });
    },

    async item(itemId: string) {
      const i = await prisma.item.findFirst({
        where: { id: itemId, companyId },
        include: { uom: true },
      });
      if (!i) throw new CompanyForbiddenError();
      return i;
    },

    async receipt(receiptId: string) {
      const r = await prisma.receipt.findFirst({
        where: { id: receiptId, companyId },
        include: { lines: true },
      });
      if (!r) throw new CompanyForbiddenError();
      return r;
    },

    async transfer(transferId: string) {
      const t = await prisma.transfer.findFirst({
        where: { id: transferId, companyId },
        include: { lines: true },
      });
      if (!t) throw new CompanyForbiddenError();
      return t;
    },

    async writeOff(writeOffId: string) {
      const w = await prisma.writeOff.findFirst({
        where: { id: writeOffId, companyId },
        include: { lines: true },
      });
      if (!w) throw new CompanyForbiddenError();
      return w;
    },

    async pickList(pickListId: string) {
      const p = await prisma.pickList.findFirst({
        where: { id: pickListId, companyId },
        include: {
          lines: { include: { fulfillments: true } },
          cells: { orderBy: { createdAt: "asc" } },
        },
      });
      if (!p) throw new CompanyForbiddenError();
      return p;
    },

    async issue(issueId: string) {
      const i = await prisma.issue.findFirst({
        where: { id: issueId, companyId },
        include: { lines: true },
      });
      if (!i) throw new CompanyForbiddenError();
      return i;
    },

    async inventory(inventoryId: string) {
      const inv = await prisma.inventory.findFirst({
        where: { id: inventoryId, companyId },
        include: { lines: true },
      });
      if (!inv) throw new CompanyForbiddenError();
      return inv;
    },
  };
}
