import "server-only";
import { Prisma, type ItemUnit, type MovementDocType, type UnitStatus } from "@prisma/client";

// ЯДРО остатков. Единственная точка изменения остатков во всём коде:
// - партионные товары: applyLotMovement (ledger + материализованный StockBalance
//   в одной транзакции; отрицательные остатки исключены атомарным decrement);
// - поштучные: moveUnit (местоположение/статус на самой единице + запись в ledger).
//
// Место хранения (Loc): ячейка / склад без ячейки / за сотрудником /
// выдано-ждёт-подтверждения / null = внешний мир (приемка, списание).

export type Loc =
  | { kind: "cell"; warehouseId: string; cellId: string }
  | { kind: "warehouse"; warehouseId: string }
  | { kind: "employee"; employeeId: string }
  | { kind: "employeePending"; employeeId: string }
  | null;

export class StockError extends Error {}

export function locKey(loc: Exclude<Loc, null>): string {
  switch (loc.kind) {
    case "cell":
      return `C:${loc.cellId}`;
    case "warehouse":
      return `W:${loc.warehouseId}`;
    case "employee":
      return `E:${loc.employeeId}`;
    case "employeePending":
      return `EP:${loc.employeeId}`;
  }
}

function locFields(loc: Loc, side: "from" | "to") {
  const p = side === "from" ? "from" : "to";
  return {
    [`${p}WarehouseId`]: loc && "warehouseId" in loc ? loc.warehouseId : null,
    [`${p}CellId`]: loc?.kind === "cell" ? loc.cellId : null,
    [`${p}EmployeeId`]:
      loc?.kind === "employee" || loc?.kind === "employeePending" ? loc.employeeId : null,
    [`${p}Pending`]: loc?.kind === "employeePending",
  };
}

function balanceFields(loc: Exclude<Loc, null>) {
  return {
    warehouseId: "warehouseId" in loc ? loc.warehouseId : null,
    cellId: loc.kind === "cell" ? loc.cellId : null,
    employeeId: loc.kind === "employee" || loc.kind === "employeePending" ? loc.employeeId : null,
  };
}

// Движение партионного товара. from=null — приход извне, to=null — расход вовне.
export async function applyLotMovement(
  tx: Prisma.TransactionClient,
  args: {
    companyId: string;
    docType: MovementDocType;
    docId: string;
    itemId: string;
    lotId: string;
    qty: Prisma.Decimal | number | string;
    from: Loc;
    to: Loc;
    createdById: string;
  },
): Promise<void> {
  const qty = new Prisma.Decimal(args.qty);
  if (qty.lte(0)) throw new StockError("Количество должно быть больше нуля");

  await tx.stockMovement.create({
    data: {
      companyId: args.companyId,
      docType: args.docType,
      docId: args.docId,
      itemId: args.itemId,
      lotId: args.lotId,
      qty,
      createdById: args.createdById,
      ...locFields(args.from, "from"),
      ...locFields(args.to, "to"),
    },
  });

  if (args.from) {
    const key = locKey(args.from);
    // Атомарно: уменьшаем только если остатка хватает — защита от гонок и минуса.
    const res = await tx.stockBalance.updateMany({
      where: { lotId: args.lotId, locKey: key, qty: { gte: qty } },
      data: { qty: { decrement: qty } },
    });
    if (res.count !== 1) throw new StockError("Недостаточно остатка в этом месте хранения");
    await tx.stockBalance.deleteMany({ where: { lotId: args.lotId, locKey: key, qty: 0 } });
  }

  if (args.to) {
    const key = locKey(args.to);
    await tx.stockBalance.upsert({
      where: { lotId_locKey: { lotId: args.lotId, locKey: key } },
      update: { qty: { increment: qty } },
      create: {
        companyId: args.companyId,
        itemId: args.itemId,
        lotId: args.lotId,
        locKey: key,
        qty,
        ...balanceFields(args.to),
      },
    });
  }
}

// Движение единицы поштучного товара: обновляет её место/статус и пишет в ledger.
export async function moveUnit(
  tx: Prisma.TransactionClient,
  args: {
    companyId: string;
    docType: MovementDocType;
    docId: string;
    unit: Pick<ItemUnit, "id" | "itemId" | "warehouseId" | "cellId" | "employeeId" | "status">;
    to: Loc;
    status: UnitStatus;
    createdById: string;
    pickListId?: string | null;
    issueId?: string | null;
  },
): Promise<void> {
  const { unit } = args;
  const from: Loc = unit.employeeId
    ? unit.status === "ISSUE_PENDING"
      ? { kind: "employeePending", employeeId: unit.employeeId }
      : { kind: "employee", employeeId: unit.employeeId }
    : unit.cellId && unit.warehouseId
      ? { kind: "cell", warehouseId: unit.warehouseId, cellId: unit.cellId }
      : unit.warehouseId
        ? { kind: "warehouse", warehouseId: unit.warehouseId }
        : null;

  await tx.stockMovement.create({
    data: {
      companyId: args.companyId,
      docType: args.docType,
      docId: args.docId,
      itemId: unit.itemId,
      unitId: unit.id,
      qty: new Prisma.Decimal(1),
      createdById: args.createdById,
      ...locFields(from, "from"),
      ...locFields(args.to, "to"),
    },
  });

  await tx.itemUnit.update({
    where: { id: unit.id },
    data: {
      status: args.status,
      warehouseId: args.to && "warehouseId" in args.to ? args.to.warehouseId : null,
      cellId: args.to?.kind === "cell" ? args.to.cellId : null,
      employeeId:
        args.to?.kind === "employee" || args.to?.kind === "employeePending"
          ? args.to.employeeId
          : null,
      ...(args.pickListId !== undefined ? { pickListId: args.pickListId } : {}),
      ...(args.issueId !== undefined ? { issueId: args.issueId } : {}),
    },
  });
}
