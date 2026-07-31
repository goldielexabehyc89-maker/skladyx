"use server";

import { prisma } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";
import { hasRole } from "@/lib/roles";
import { scoped } from "@/lib/tenant";
import { warehouseAccess, isWhAllowed } from "@/lib/warehouse-access";
import { resolveQr, parseScannedCode } from "@/lib/qr";
import { logEvent } from "@/lib/events";
import { applyLotMovement, moveUnit, StockError, type Loc } from "@/lib/stock";
import { assertCellNotHeldByGroup } from "@/lib/cells";
import { fmtQty } from "@/lib/format";
import { revalidatePath } from "next/cache";

export interface ScanInfo {
  error?: string;
  type?: "LOT" | "UNIT" | "CELL" | "EMPLOYEE" | "PICKLIST";
  title?: string;
  lines?: string[];
  url?: string;
  // для сценариев выдачи: свободный остаток (не за сотрудниками) и единица измерения
  available?: number;
  uom?: string;
  refId?: string;
}

const UNIT_STATUS_RU: Record<string, string> = {
  IN_STOCK: "на складе",
  PICKED: "в сборке заявки",
  ISSUE_PENDING: "ждёт подтверждения сотрудником",
  ISSUED: "за сотрудником",
  WRITTEN_OFF: "списана",
};

async function locName(
  companyId: string,
  b: { warehouseId?: string | null; cellId?: string | null; employeeId?: string | null; locKey?: string },
): Promise<string> {
  if (b.employeeId) {
    const u = await prisma.user.findFirst({ where: { id: b.employeeId, companyId } });
    const pending = b.locKey?.startsWith("EP:");
    return `${u?.name ?? "сотрудник"}${pending ? " (ждёт подтверждения)" : ""}`;
  }
  if (b.cellId) {
    const c = await prisma.cell.findFirst({
      where: { id: b.cellId, companyId },
      include: { warehouse: true },
    });
    return c ? `${c.warehouse.name} · ${c.code}` : "ячейка";
  }
  if (b.warehouseId) {
    const w = await prisma.warehouse.findFirst({ where: { id: b.warehouseId, companyId } });
    return `${w?.name ?? "склад"} (без ячейки)`;
  }
  return "—";
}

// Универсальный резолвер скана: краткая сводка по сущности.
export async function resolveScanAction(raw: string): Promise<ScanInfo> {
  const session = await requireUser();
  const s = scoped(session);
  const code = parseScannedCode(raw);
  if (!code) return { error: "Это не QR-код системы" };
  const qr = await resolveQr(code);
  if (!qr || qr.companyId !== s.companyId) {
    // возможно, это этикетка позиции заказа поставщику, ещё не принятой на склад
    const base = code.includes("-") ? code.slice(0, code.lastIndexOf("-")) : null;
    const line = await prisma.supplierOrderLine.findFirst({
      where: {
        companyId: s.companyId,
        lineCode: base ? { in: [code, base] } : code,
      },
    });
    if (line) {
      const [order, item] = await Promise.all([
        prisma.supplierOrder.findUnique({ where: { id: line.orderId } }),
        s.item(line.itemId),
      ]);
      return {
        title: item.name,
        lines: [
          `Позиция заказа поставщику №${order?.number ?? "—"}`,
          "Ещё не принята на склад — примите сканированием на странице заказа",
        ],
        url: `/warehouse/orders/${line.orderId}`,
      };
    }
    return { error: "Код не найден" };
  }

  if (qr.type === "LOT") {
    const lot = await prisma.lot.findFirst({ where: { id: qr.refId, companyId: s.companyId } });
    if (!lot) return { error: "Партия не найдена" };
    const item = await s.item(lot.itemId);
    const line = await prisma.receiptLine.findUnique({ where: { id: lot.receiptLineId } });
    const receipt = line
      ? await prisma.receipt.findUnique({ where: { id: line.receiptId } })
      : null;
    const balances = await prisma.stockBalance.findMany({ where: { lotId: lot.id } });
    const lines: string[] = [];
    if (receipt) lines.push(`Партия из приемки №${receipt.number}`);
    if (balances.length === 0) lines.push("Остатка нет");
    for (const b of balances)
      lines.push(`${fmtQty(b.qty)} ${item.uom.name} — ${await locName(s.companyId, b)}`);
    // свободно = физический остаток − неразмещённый резерв активных заявок
    const reservingLines = await prisma.pickLine.findMany({
      where: {
        companyId: s.companyId,
        lotId: lot.id,
        pickList: { status: { in: ["NEW", "PICKING"] } },
      },
      select: { qtyRequested: true, fulfillments: { select: { qty: true, toCellId: true } } },
    });
    const reserved = reservingLines.reduce((sum, rl) => {
      const placed = rl.fulfillments
        .filter((fu) => fu.toCellId)
        .reduce((s2, fu) => s2 + fu.qty.toNumber(), 0);
      return sum + Math.max(0, rl.qtyRequested.toNumber() - placed);
    }, 0);
    if (reserved > 0) lines.push(`В резерве заявок: ${fmtQty(reserved)} ${item.uom.name}`);
    const available = Math.max(
      0,
      balances.filter((b) => !b.employeeId).reduce((sum, b) => sum + b.qty.toNumber(), 0) -
        reserved,
    );
    return {
      type: "LOT",
      title: item.name,
      lines,
      url: `/warehouse/items/${item.id}`,
      available,
      uom: item.uom.name,
      refId: lot.id,
    };
  }

  if (qr.type === "UNIT") {
    const unit = await prisma.itemUnit.findFirst({
      where: { id: qr.refId, companyId: s.companyId },
    });
    if (!unit) return { error: "Единица не найдена" };
    const item = await s.item(unit.itemId);
    const lines = [
      `Единица №${unit.serial} · ${UNIT_STATUS_RU[unit.status] ?? unit.status}`,
      await locName(s.companyId, unit),
    ];
    // единица в резерве активной заявки недоступна для прямой выдачи
    const unitBusy = await prisma.pickLine.findFirst({
      where: {
        companyId: s.companyId,
        unitId: unit.id,
        pickList: { status: { in: ["NEW", "PICKING"] } },
      },
      include: { pickList: true },
    });
    if (unitBusy) lines.push(`В резерве: №${unitBusy.pickList.number}`);
    return {
      type: "UNIT",
      title: `${item.name} · ед. №${unit.serial}`,
      lines,
      url: `/warehouse/items/${item.id}`,
      available: unit.status === "IN_STOCK" && !unitBusy ? 1 : 0,
      uom: item.uom.name,
      refId: unit.id,
    };
  }

  if (qr.type === "CELL") {
    const cell = await prisma.cell.findFirst({
      where: { id: qr.refId, companyId: s.companyId },
      include: { warehouse: true },
    });
    if (!cell) return { error: "Ячейка не найдена" };
    const [balances, units] = await Promise.all([
      prisma.stockBalance.findMany({ where: { companyId: s.companyId, cellId: cell.id } }),
      prisma.itemUnit.findMany({
        where: { companyId: s.companyId, cellId: cell.id, status: "IN_STOCK" },
      }),
    ]);
    const itemIds = [...new Set([...balances.map((b) => b.itemId), ...units.map((u) => u.itemId)])];
    const items = await prisma.item.findMany({
      where: { id: { in: itemIds } },
      include: { uom: true },
    });
    const itemById = new Map(items.map((i) => [i.id, i]));
    const lines: string[] = [];
    for (const b of balances) {
      const item = itemById.get(b.itemId);
      lines.push(`${item?.name ?? "—"}: ${fmtQty(b.qty)} ${item?.uom.name ?? ""}`);
    }
    const unitCountByItem = new Map<string, number>();
    for (const u of units)
      unitCountByItem.set(u.itemId, (unitCountByItem.get(u.itemId) ?? 0) + 1);
    for (const [itemId, count] of unitCountByItem)
      lines.push(`${itemById.get(itemId)?.name ?? "—"}: ${count} шт (серийные)`);
    if (lines.length === 0) lines.push("Ячейка пуста");
    return {
      type: "CELL",
      title: `${cell.warehouse.name} · ${cell.code}${cell.isStaging ? " (зона выдачи)" : ""}`,
      lines,
      url: `/warehouse/cells/${cell.id}`,
    };
  }

  if (qr.type === "EMPLOYEE") {
    const user = await prisma.user.findFirst({ where: { id: qr.refId, companyId: s.companyId } });
    if (!user) return { error: "Сотрудник не найден" };
    return {
      type: "EMPLOYEE",
      title: user.name,
      lines: ["Бейдж сотрудника"],
      url: hasRole(session, "ADMIN") ? `/warehouse/employees/${user.id}` : undefined,
    };
  }

  // PICKLIST
  const pl = await prisma.pickList.findFirst({ where: { id: qr.refId, companyId: s.companyId } });
  if (!pl) return { error: "Заявка не найдена" };
  const target = pl.targetEmployeeId
    ? await prisma.user.findFirst({
        where: { id: pl.targetEmployeeId, companyId: s.companyId },
      })
    : null;
  const targetWh = pl.targetWarehouseId
    ? await prisma.warehouse.findFirst({
        where: { id: pl.targetWarehouseId, companyId: s.companyId },
      })
    : null;
  return {
    type: "PICKLIST",
    title: pl.targetWarehouseId ? `Перемещение №${pl.number}` : `Заявка №${pl.number}`,
    lines: [pl.targetWarehouseId ? `На склад: ${targetWh?.name ?? "—"}` : `Для: ${target?.name ?? "—"}`],
    url: `/warehouse/picklists/${pl.id}`,
  };
}

// «Скан товара → скан ячейки»: кладёт партию/единицу в ячейку (в рамках склада ячейки).
export async function assignCellAction(
  itemRaw: string,
  cellRaw: string,
): Promise<{ ok?: string; error?: string }> {
  const session = await requireAdmin();
  const s = scoped(session);

  const itemCode = parseScannedCode(itemRaw);
  const cellCode = parseScannedCode(cellRaw);
  if (!itemCode || !cellCode) return { error: "Код не распознан" };

  const [itemQr, cellQr] = await Promise.all([resolveQr(itemCode), resolveQr(cellCode)]);
  if (!itemQr || itemQr.companyId !== s.companyId) return { error: "Код товара не найден" };
  if (!cellQr || cellQr.companyId !== s.companyId || cellQr.type !== "CELL")
    return { error: "Вторым сканируйте QR ячейки" };
  if (itemQr.type !== "LOT" && itemQr.type !== "UNIT")
    return { error: "Первым сканируйте QR партии или единицы" };

  const cell = await prisma.cell.findFirst({
    where: { id: cellQr.refId, companyId: s.companyId, isActive: true },
    include: { warehouse: true },
  });
  if (!cell) return { error: "Ячейка не найдена или отключена" };
  const to: Loc = { kind: "cell", warehouseId: cell.warehouseId, cellId: cell.id };

  try {
    if (itemQr.type === "UNIT") {
      const unit = await prisma.itemUnit.findFirst({
        where: { id: itemQr.refId, companyId: s.companyId },
      });
      if (!unit) return { error: "Единица не найдена" };
      if (unit.status !== "IN_STOCK") return { error: `Единица ${UNIT_STATUS_RU[unit.status]}` };
      if (unit.warehouseId !== cell.warehouseId)
        return { error: "Ячейка на другом складе — оформите перемещение" };
      const item = await s.item(unit.itemId);
      await prisma.$transaction(async (tx) => {
        await assertCellNotHeldByGroup(tx, s.companyId, cell.id); // «одна ячейка = одна группа»
        await moveUnit(tx, {
          companyId: s.companyId,
          docType: "CELL_ASSIGN",
          docId: cell.id,
          unit,
          to,
          status: "IN_STOCK",
          createdById: session.userId,
        });
      });
      await logEvent({
        companyId: s.companyId,
        type: "cell_assigned",
        title: `${item.name} → ${cell.code}`,
        body: `Единица №${unit.serial} помещена в ячейку ${cell.code} (${cell.warehouse.name})`,
        actorId: session.userId,
        warehouseIds: [cell.warehouseId],
      });
      revalidatePath("/warehouse/stock");
      return { ok: `${item.name} №${unit.serial} → ${cell.code}` };
    }

    // LOT: переносим весь остаток партии в пределах склада ячейки
    const lot = await prisma.lot.findFirst({ where: { id: itemQr.refId, companyId: s.companyId } });
    if (!lot) return { error: "Партия не найдена" };
    const item = await s.item(lot.itemId);
    const balances = await prisma.stockBalance.findMany({
      where: { lotId: lot.id, warehouseId: cell.warehouseId, employeeId: null },
    });
    const sources = balances.filter((b) => b.cellId !== cell.id && b.qty.gt(0));
    if (sources.length === 0)
      return { error: `На складе «${cell.warehouse.name}» нет остатка этой партии` };

    let moved = 0;
    await prisma.$transaction(async (tx) => {
      await assertCellNotHeldByGroup(tx, s.companyId, cell.id); // «одна ячейка = одна группа»
      for (const b of sources) {
        const from: Loc = b.cellId
          ? { kind: "cell", warehouseId: cell.warehouseId, cellId: b.cellId }
          : { kind: "warehouse", warehouseId: cell.warehouseId };
        await applyLotMovement(tx, {
          companyId: s.companyId,
          docType: "CELL_ASSIGN",
          docId: cell.id,
          itemId: lot.itemId,
          lotId: lot.id,
          qty: b.qty,
          from,
          to,
          createdById: session.userId,
        });
        moved += b.qty.toNumber();
      }
    });
    await logEvent({
      companyId: s.companyId,
      type: "cell_assigned",
      title: `${item.name} → ${cell.code}`,
      body: `${fmtQty(moved)} ${item.uom.name} помещено в ячейку ${cell.code} (${cell.warehouse.name})`,
      actorId: session.userId,
      warehouseIds: [cell.warehouseId],
    });
    revalidatePath("/warehouse/stock");
    return { ok: `${item.name}: ${fmtQty(moved)} ${item.uom.name} → ${cell.code}` };
  } catch (e) {
    if (e instanceof StockError) return { error: e.message };
    throw e;
  }
}
