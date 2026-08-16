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
  | { kind: "zone"; warehouseId: string; zoneId: string } // Пакет 4: виртуальная зона (RECEIVING и др.)
  | { kind: "warehouse"; warehouseId: string }
  | { kind: "employee"; employeeId: string }
  | { kind: "employeePending"; employeeId: string }
  | null;

export class StockError extends Error {}

export function locKey(loc: Exclude<Loc, null>): string {
  switch (loc.kind) {
    case "cell":
      return `C:${loc.cellId}`;
    case "zone":
      return `Z:${loc.zoneId}`;
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
    [`${p}ZoneId`]: loc?.kind === "zone" ? loc.zoneId : null,
    [`${p}EmployeeId`]:
      loc?.kind === "employee" || loc?.kind === "employeePending" ? loc.employeeId : null,
    [`${p}Pending`]: loc?.kind === "employeePending",
  };
}

function balanceFields(loc: Exclude<Loc, null>) {
  return {
    warehouseId: "warehouseId" in loc ? loc.warehouseId : null,
    cellId: loc.kind === "cell" ? loc.cellId : null,
    zoneId: loc.kind === "zone" ? loc.zoneId : null,
    employeeId: loc.kind === "employee" || loc.kind === "employeePending" ? loc.employeeId : null,
  };
}

// R1/TENANT-001: жёсткая проверка принадлежности всех ссылок организации ДО любых записей. Отклоняет
// cross-tenant lotId/itemId/unitId/userId и локации (ячейка/склад/зона/сотрудник) без движений и без
// изменения остатков. Корректные операции (companyId совпадает) не затрагиваются.
async function assertOwned(
  tx: Prisma.TransactionClient,
  companyId: string,
  refs: { lotId?: string; itemId?: string; unitId?: string; userId?: string; locs?: Loc[] },
): Promise<void> {
  const need = async (n: number, what: string) => {
    if (n !== 1) throw new StockError(`Ссылка другой организации: ${what}`);
  };
  if (refs.lotId) await need(await tx.lot.count({ where: { id: refs.lotId, companyId } }), "партия");
  if (refs.itemId) await need(await tx.item.count({ where: { id: refs.itemId, companyId } }), "товар");
  if (refs.unitId) await need(await tx.itemUnit.count({ where: { id: refs.unitId, companyId } }), "единица");
  if (refs.userId) await need(await tx.user.count({ where: { id: refs.userId, companyId } }), "пользователь");
  for (const loc of refs.locs ?? []) {
    if (!loc) continue;
    if (loc.kind === "cell") {
      await need(await tx.cell.count({ where: { id: loc.cellId, companyId } }), "ячейка");
      await need(await tx.warehouse.count({ where: { id: loc.warehouseId, companyId } }), "склад");
    } else if (loc.kind === "zone") {
      await need(await tx.warehouseZone.count({ where: { id: loc.zoneId, companyId } }), "зона");
      await need(await tx.warehouse.count({ where: { id: loc.warehouseId, companyId } }), "склад");
    } else if (loc.kind === "warehouse") {
      await need(await tx.warehouse.count({ where: { id: loc.warehouseId, companyId } }), "склад");
    } else if (loc.kind === "employee" || loc.kind === "employeePending") {
      await need(await tx.user.count({ where: { id: loc.employeeId, companyId } }), "сотрудник");
    }
  }
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
  await assertOwned(tx, args.companyId, { lotId: args.lotId, itemId: args.itemId, userId: args.createdById, locs: [args.from, args.to] });

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
  await assertOwned(tx, args.companyId, { unitId: unit.id, itemId: unit.itemId, userId: args.createdById, locs: [args.to] });
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
