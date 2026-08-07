"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAdmin , assertLegacyUiEnabled } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { warehouseAccess, isWhAllowed } from "@/lib/warehouse-access";
import { logEvent } from "@/lib/events";
import { resolveQr, parseScannedCode } from "@/lib/qr";
import { nextNumber } from "@/lib/counters";
import { applyLotMovement, moveUnit, StockError, type Loc } from "@/lib/stock";
import { fmtQty } from "@/lib/format";
import type { FormState } from "@/app/actions/warehouses";
import type { ScanResult } from "@/components/scan-collect";

// Инвентаризация склада: скан ячейки создаёт строки с ожидаемым количеством,
// скан единицы отмечает её найденной, для партий количество вводится вручную.
// REVIEW = акт расхождений; POSTED = корректирующие движения (docType INVENTORY).

export async function startInventoryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdmin();
  assertLegacyUiEnabled();
  const s = scoped(session);
  const warehouseId = String(formData.get("warehouseId") ?? "");
  const warehouse = await s.warehouse(warehouseId);

  const existing = await prisma.inventory.findFirst({
    where: { companyId: s.companyId, warehouseId, status: { in: ["IN_PROGRESS", "REVIEW"] } },
  });
  if (existing) return { error: `По складу уже идёт инвентаризация №${existing.number}` };

  const inventory = await prisma.$transaction(async (tx) => {
    const number = await nextNumber(tx, s.companyId, "inventory");
    return tx.inventory.create({
      data: { companyId: s.companyId, number, warehouseId, createdById: session.userId },
    });
  });
  await logEvent({
    companyId: s.companyId,
    type: "inventory_started",
    warehouseIds: [warehouseId],
    title: `Инвентаризация №${inventory.number} начата`,
    body: warehouse.name,
    url: `/warehouse/inventories/${inventory.id}`,
    actorId: session.userId,
  });
  revalidatePath("/warehouse/inventories");
  redirect(`/warehouse/inventories/${inventory.id}`);
}

// Снимок ожидаемого содержимого места (ячейка или склад-без-ячейки) в строки инвентаризации.
async function snapshotLocation(
  tx: Prisma.TransactionClient,
  inv: { id: string; companyId: string; warehouseId: string },
  cellId: string | null,
): Promise<number> {
  const [balances, units] = await Promise.all([
    tx.stockBalance.findMany({
      where: {
        companyId: inv.companyId,
        warehouseId: inv.warehouseId,
        cellId,
        employeeId: null,
        qty: { gt: 0 },
      },
    }),
    tx.itemUnit.findMany({
      where: {
        companyId: inv.companyId,
        warehouseId: inv.warehouseId,
        cellId,
        status: "IN_STOCK",
      },
    }),
  ]);
  const existing = await tx.inventoryLine.findMany({ where: { inventoryId: inv.id } });
  const hasLot = new Set(existing.filter((l) => l.lotId).map((l) => l.lotId));
  const hasUnit = new Set(existing.filter((l) => l.unitId).map((l) => l.unitId));

  let created = 0;
  for (const b of balances) {
    if (hasLot.has(b.lotId)) continue;
    await tx.inventoryLine.create({
      data: {
        companyId: inv.companyId,
        inventoryId: inv.id,
        cellId,
        itemId: b.itemId,
        lotId: b.lotId,
        expectedQty: b.qty,
      },
    });
    created++;
  }
  for (const u of units) {
    if (hasUnit.has(u.id)) continue;
    await tx.inventoryLine.create({
      data: {
        companyId: inv.companyId,
        inventoryId: inv.id,
        cellId,
        itemId: u.itemId,
        unitId: u.id,
        expectedQty: new Prisma.Decimal(1),
      },
    });
    created++;
  }
  return created;
}

// Скан в инвентаризации: ячейка → снимок ожидаемого; единица → отмечена найденной.
export async function scanInventoryAction(inventoryId: string, raw: string): Promise<ScanResult> {
  const session = await requireAdmin();
  assertLegacyUiEnabled();
  const s = scoped(session);
  const inv = await s.inventory(inventoryId);
  if (inv.status !== "IN_PROGRESS") return { error: "Подсчёт уже завершён" };

  const code = parseScannedCode(raw);
  if (!code) return { error: "Код не распознан" };
  const qr = await resolveQr(code);
  if (!qr || qr.companyId !== s.companyId) return { error: "Код не найден" };

  if (qr.type === "CELL") {
    const cell = await prisma.cell.findFirst({
      where: { id: qr.refId, companyId: s.companyId },
    });
    if (!cell || cell.warehouseId !== inv.warehouseId)
      return { error: "Ячейка не с этого склада" };
    const created = await prisma.$transaction((tx) => snapshotLocation(tx, inv, cell.id));
    revalidatePath(`/warehouse/inventories/${inv.id}`);
    return { ok: `Ячейка ${cell.code}: строк добавлено ${created}` };
  }

  if (qr.type === "UNIT") {
    const unit = await prisma.itemUnit.findFirst({
      where: { id: qr.refId, companyId: s.companyId },
    });
    if (!unit) return { error: "Единица не найдена" };
    const item = await s.item(unit.itemId);
    const line = inv.lines.find((l) => l.unitId === unit.id);
    if (line) {
      await prisma.inventoryLine.update({
        where: { id: line.id },
        data: { countedQty: new Prisma.Decimal(1) },
      });
      revalidatePath(`/warehouse/inventories/${inv.id}`);
      return { ok: `${item.name} №${unit.serial} — найдена ✓` };
    }
    // излишек: единица числится в другом месте, а физически здесь
    await prisma.inventoryLine.create({
      data: {
        companyId: s.companyId,
        inventoryId: inv.id,
        cellId: unit.warehouseId === inv.warehouseId ? unit.cellId : null,
        itemId: unit.itemId,
        unitId: unit.id,
        expectedQty: new Prisma.Decimal(0),
        countedQty: new Prisma.Decimal(1),
      },
    });
    revalidatePath(`/warehouse/inventories/${inv.id}`);
    return { ok: `${item.name} №${unit.serial} — излишек (числится в другом месте)` };
  }

  if (qr.type === "LOT") {
    const lot = await prisma.lot.findFirst({ where: { id: qr.refId, companyId: s.companyId } });
    if (!lot) return { error: "Партия не найдена" };
    const item = await s.item(lot.itemId);
    const line = inv.lines.find((l) => l.lotId === lot.id);
    if (line) {
      return { ok: `${item.name}: введите насчитанное количество в строке акта` };
    }
    // партия не ожидалась на складе — строка-излишек, количество введут вручную
    await prisma.inventoryLine.create({
      data: {
        companyId: s.companyId,
        inventoryId: inv.id,
        cellId: null,
        itemId: lot.itemId,
        lotId: lot.id,
        expectedQty: new Prisma.Decimal(0),
      },
    });
    revalidatePath(`/warehouse/inventories/${inv.id}`);
    return { ok: `${item.name}: партия-излишек добавлена — введите количество` };
  }

  return { error: "Сканируйте ячейку, партию или единицу" };
}

export async function setCountedQtyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdmin();
  assertLegacyUiEnabled();
  const s = scoped(session);
  const lineId = String(formData.get("lineId") ?? "");
  const counted = Number(formData.get("counted"));
  const line = await prisma.inventoryLine.findFirst({
    where: { id: lineId, companyId: s.companyId },
    include: { inventory: true },
  });
  if (!line || line.inventory.status !== "IN_PROGRESS") return { error: "Строка недоступна" };
  if (!Number.isFinite(counted) || counted < 0) return { error: "Некорректное количество" };
  if (line.unitId && counted !== 0 && counted !== 1)
    return { error: "Для единицы — 0 или 1" };

  await prisma.inventoryLine.update({
    where: { id: lineId },
    data: { countedQty: new Prisma.Decimal(counted) },
  });
  revalidatePath(`/warehouse/inventories/${line.inventoryId}`);
  return {};
}

// Завершение подсчёта: достраиваем строки по НЕотсканированным местам склада и
// формируем акт (непосчитанное = 0).
export async function submitReviewAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdmin();
  assertLegacyUiEnabled();
  const s = scoped(session);
  const inventoryId = String(formData.get("inventoryId") ?? "");
  const inv = await s.inventory(inventoryId);
  if (inv.status !== "IN_PROGRESS") return { error: "Подсчёт уже завершён" };

  await prisma.$transaction(async (tx) => {
    const cells = await tx.cell.findMany({
      where: { companyId: s.companyId, warehouseId: inv.warehouseId },
    });
    for (const cell of cells) await snapshotLocation(tx, inv, cell.id);
    await snapshotLocation(tx, inv, null); // склад без ячейки
    await tx.inventory.update({ where: { id: inv.id }, data: { status: "REVIEW" } });
  });
  revalidatePath(`/warehouse/inventories/${inv.id}`);
  return {};
}

export async function backToCountingAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  assertLegacyUiEnabled();
  const s = scoped(session);
  const inv = await s.inventory(String(formData.get("inventoryId") ?? ""));
  if (inv.status !== "REVIEW") return;
  await prisma.inventory.update({ where: { id: inv.id }, data: { status: "IN_PROGRESS" } });
  revalidatePath(`/warehouse/inventories/${inv.id}`);
}

export async function cancelInventoryAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  assertLegacyUiEnabled();
  const s = scoped(session);
  const inv = await s.inventory(String(formData.get("inventoryId") ?? ""));
  if (inv.status !== "IN_PROGRESS" && inv.status !== "REVIEW") return;
  await prisma.inventory.update({ where: { id: inv.id }, data: { status: "CANCELLED" } });
  revalidatePath("/warehouse/inventories");
  redirect("/warehouse/inventories");
}

// Проведение корректировок: излишек — приход извне, недостача — расход вовне.
export async function postInventoryAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdmin();
  assertLegacyUiEnabled();
  const s = scoped(session);
  const inventoryId = String(formData.get("inventoryId") ?? "");
  const inv = await s.inventory(inventoryId);
  if (inv.status !== "REVIEW") return { error: "Сначала завершите подсчёт" };

  try {
    await prisma.$transaction(async (tx) => {
      for (const line of inv.lines) {
        const counted = line.countedQty ?? new Prisma.Decimal(0);
        const diff = counted.sub(line.expectedQty);
        if (diff.isZero()) continue;

        const loc: Loc = line.cellId
          ? { kind: "cell", warehouseId: inv.warehouseId, cellId: line.cellId }
          : { kind: "warehouse", warehouseId: inv.warehouseId };

        if (line.lotId) {
          if (diff.gt(0)) {
            await applyLotMovement(tx, {
              companyId: s.companyId,
              docType: "INVENTORY",
              docId: inv.id,
              itemId: line.itemId,
              lotId: line.lotId,
              qty: diff,
              from: null,
              to: loc,
              createdById: session.userId,
            });
          } else {
            await applyLotMovement(tx, {
              companyId: s.companyId,
              docType: "INVENTORY",
              docId: inv.id,
              itemId: line.itemId,
              lotId: line.lotId,
              qty: diff.neg(),
              from: loc,
              to: null,
              createdById: session.userId,
            });
          }
        } else if (line.unitId) {
          const unit = await tx.itemUnit.findFirst({
            where: { id: line.unitId, companyId: s.companyId },
          });
          if (!unit) continue;
          if (counted.gte(1)) {
            // найдена здесь — перемещаем на место инвентаризации
            await moveUnit(tx, {
              companyId: s.companyId,
              docType: "INVENTORY",
              docId: inv.id,
              unit,
              to: loc,
              status: "IN_STOCK",
              createdById: session.userId,
              pickListId: null,
              issueId: null,
            });
          } else if (unit.status === "IN_STOCK" && unit.warehouseId === inv.warehouseId) {
            // не найдена — недостача, списываем
            await moveUnit(tx, {
              companyId: s.companyId,
              docType: "INVENTORY",
              docId: inv.id,
              unit,
              to: null,
              status: "WRITTEN_OFF",
              createdById: session.userId,
            });
          }
        }
      }
      await tx.inventory.update({
        where: { id: inv.id },
        data: { status: "POSTED", postedAt: new Date() },
      });
    });
  } catch (e) {
    if (e instanceof StockError) return { error: e.message };
    throw e;
  }

  const diffCount = inv.lines.filter(
    (l) => !(l.countedQty ?? new Prisma.Decimal(0)).eq(l.expectedQty),
  ).length;
  await logEvent({
    companyId: s.companyId,
    type: "inventory_posted",
    warehouseIds: [inv.warehouseId],
    title: `Инвентаризация №${inv.number} проведена`,
    body: `Расхождений скорректировано: ${diffCount}`,
    url: `/warehouse/inventories/${inv.id}`,
    actorId: session.userId,
  });
  revalidatePath("/warehouse/inventories");
  revalidatePath(`/warehouse/inventories/${inv.id}`);
  revalidatePath("/warehouse/stock");
  return {};
}

// Удаление инвентаризации (админ): любая непроведённая — проведённая двигала остатки.
export async function deleteInventoryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdmin();
  assertLegacyUiEnabled();
  const s = scoped(session);
  const inv = await prisma.inventory.findFirst({
    where: { id: String(formData.get("inventoryId") ?? ""), companyId: s.companyId },
  });
  if (!inv) return { error: "Инвентаризация не найдена" };
  if (inv.status === "POSTED") return { error: "Проведённую инвентаризацию удалить нельзя" };

  await prisma.inventory.delete({ where: { id: inv.id } }); // строки — каскадом
  await logEvent({
    companyId: s.companyId,
    type: "inventory_deleted",
    warehouseIds: [inv.warehouseId],
    title: `Инвентаризация №${inv.number} удалена`,
    body: "",
    actorId: session.userId,
  });
  revalidatePath("/warehouse/inventories");
  redirect("/warehouse/inventories");
}
