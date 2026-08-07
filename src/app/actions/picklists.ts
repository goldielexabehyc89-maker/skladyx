"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAdmin, requireStaff , assertLegacyUiEnabled } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { warehouseAccess, isWhAllowed } from "@/lib/warehouse-access";
import { logEvent } from "@/lib/events";
import { broadcastRealtime } from "@/lib/realtime";
import { resolveQr, parseScannedCode, createQrIn } from "@/lib/qr";
import { nextNumber } from "@/lib/counters";
import { sendPushToWarehouseStorekeepers } from "@/lib/push";
import { applyLotMovement, moveUnit, StockError, type Loc } from "@/lib/stock";
import { fmtQty } from "@/lib/format";
import type { FormState } from "@/app/actions/warehouses";
export interface PickScanResult {
  ok?: string;
  error?: string;
  done?: boolean;
  itemLabel?: string;
  cellCode?: string;
}

// Заявка на сбор: NEW → PICKING → PICKED → (STAGED →) ISSUED. Позиции закрываются
// сканами в любом порядке (PickFulfillment), собранное — сразу сотруднику или в
// ячейку зоны выдачи, где ждёт выдачи.

export async function createPickListAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdmin();
  assertLegacyUiEnabled();
  const s = scoped(session);
  const targetEmployeeId = String(formData.get("targetEmployeeId") ?? "");
  const warehouseId = String(formData.get("warehouseId") ?? "");
  const target = await s.user(targetEmployeeId);
  if (!target.isActive) return { error: "Сотрудник отключён" };
  const warehouse = warehouseId
    ? await prisma.warehouse.findFirst({ where: { id: warehouseId, companyId: s.companyId } })
    : null;
  if (!warehouse) return { error: "Выберите склад" };
  if (!isWhAllowed(await warehouseAccess(session), warehouse.id))
    return { error: "Нет доступа к этому складу" };

  const pickList = await prisma.$transaction(async (tx) => {
    const number = await nextNumber(tx, s.companyId, "picklist");
    const pl = await tx.pickList.create({
      data: {
        companyId: s.companyId,
        number,
        warehouseId,
        targetEmployeeId,
        note: String(formData.get("note") ?? "").trim() || null,
        createdById: session.userId,
      },
    });
    await createQrIn(tx, { companyId: s.companyId, type: "PICKLIST", refId: pl.id });
    return pl;
  });

  await logEvent({
    companyId: s.companyId,
    type: "picklist_created",
    title: `Заявка №${pickList.number} создана`,
    body: `Для: ${target.name}`,
    url: `/warehouse/picklists/${pickList.id}`,
    actorId: session.userId,
    warehouseIds: [warehouseId],
    userIds: [targetEmployeeId],
  });
  // пуш кладовщикам уйдёт при добавлении первой позиции (см. addPickLineAction):
  // пустая заявка в «Активных» не видна — оповещать при создании рано
  revalidatePath("/warehouse/picklists");
  revalidatePath("/warehouse/active");
  redirect(`/warehouse/picklists/${pickList.id}`);
}

// Склады, которых касается заявка/перемещение (для фильтрации realtime-событий).
function plWh(p: { warehouseId: string | null; targetWarehouseId?: string | null }): string[] {
  return [p.warehouseId, p.targetWarehouseId].filter((x): x is string => !!x);
}

// «Заявка №N» или «Перемещение №N» — по типу документа.
function docName(p: { number: number; targetWarehouseId: string | null }): string {
  return p.targetWarehouseId ? `Перемещение №${p.number}` : `Заявка №${p.number}`;
}

// Пуш кладовщикам склада при сохранении заявки/перемещения: именно в этот
// момент документ появляется у них в «Активных».
async function notifyStorekeepersSaved(
  companyId: string,
  pickList: {
    id: string;
    number: number;
    warehouseId: string | null;
    targetWarehouseId: string | null;
    targetEmployeeId: string | null;
  },
): Promise<void> {
  if (!pickList.warehouseId) return;
  let body = "";
  if (pickList.targetWarehouseId) {
    const [fromWh, toWh] = await Promise.all([
      prisma.warehouse.findFirst({ where: { id: pickList.warehouseId, companyId } }),
      prisma.warehouse.findFirst({ where: { id: pickList.targetWarehouseId, companyId } }),
    ]);
    body = `${fromWh?.name ?? "—"} → ${toWh?.name ?? "—"}`;
  } else if (pickList.targetEmployeeId) {
    const target = await prisma.user.findFirst({
      where: { id: pickList.targetEmployeeId, companyId },
    });
    body = `Для: ${target?.name ?? "—"}`;
  }
  await sendPushToWarehouseStorekeepers(companyId, pickList.warehouseId, {
    title: pickList.targetWarehouseId
      ? `Новое перемещение №${pickList.number}`
      : `Новая заявка на сбор №${pickList.number}`,
    body,
    url: "/warehouse/active",
    tag: `picklist-${pickList.id}`,
  });
}

// Создание перемещения: та же заявка на сбор, но цель — склад (targetWarehouseId).
// Свой счётчик номеров ("transfer"). Дальше жизненный цикл общий с заявкой.
export async function createTransferPickAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdmin();
  assertLegacyUiEnabled();
  const s = scoped(session);
  const warehouseId = String(formData.get("warehouseId") ?? "");
  const targetWarehouseId = String(formData.get("targetWarehouseId") ?? "");
  if (!warehouseId) return { error: "Выберите склад-источник" };
  if (!targetWarehouseId) return { error: "Выберите склад-назначение" };
  if (warehouseId === targetWarehouseId)
    return { error: "Склад-источник и склад-назначение совпадают" };
  const [fromWh, toWh] = await Promise.all([
    prisma.warehouse.findFirst({ where: { id: warehouseId, companyId: s.companyId } }),
    prisma.warehouse.findFirst({ where: { id: targetWarehouseId, companyId: s.companyId } }),
  ]);
  if (!fromWh || !toWh) return { error: "Склад не найден" };
  if (!isWhAllowed(await warehouseAccess(session), fromWh.id))
    return { error: "Нет доступа к складу-источнику" };

  const pickList = await prisma.$transaction(async (tx) => {
    const number = await nextNumber(tx, s.companyId, "transfer");
    const pl = await tx.pickList.create({
      data: {
        companyId: s.companyId,
        kind: "TRANSFER",
        number,
        warehouseId,
        targetWarehouseId,
        note: String(formData.get("note") ?? "").trim() || null,
        createdById: session.userId,
      },
    });
    await createQrIn(tx, { companyId: s.companyId, type: "PICKLIST", refId: pl.id });
    return pl;
  });

  await logEvent({
    companyId: s.companyId,
    type: "picklist_created",
    title: `Перемещение №${pickList.number} создано`,
    body: `${fromWh.name} → ${toWh.name}`,
    url: `/warehouse/picklists/${pickList.id}`,
    actorId: session.userId,
    warehouseIds: [warehouseId, targetWarehouseId],
  });
  // пуш кладовщикам уйдёт при добавлении первой позиции (см. addPickLineAction)
  revalidatePath("/warehouse/transfers");
  revalidatePath("/warehouse/active");
  redirect(`/warehouse/picklists/${pickList.id}`);
}

// Позиция заявки = конкретный остаток со склада заявки: партия в ячейке ("L:lotId:cellId")
// или единица ("U:unitId"). Выбирается из положительных остатков этого склада.
export async function addPickLineAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdmin();
  assertLegacyUiEnabled();
  const s = scoped(session);
  const pickListId = String(formData.get("pickListId") ?? "");
  const pickList = await s.pickList(pickListId);
  if (pickList.status !== "NEW") return { error: "Заявка уже в сборке — позиции не изменить" };
  const wh = pickList.warehouseId;
  if (!wh) return { error: "У заявки не указан склад" };

  const ref = String(formData.get("ref") ?? "");
  if (ref.startsWith("U:")) {
    const unitId = ref.slice(2);
    const unit = await prisma.itemUnit.findFirst({
      where: { id: unitId, companyId: s.companyId, status: "IN_STOCK", warehouseId: wh },
    });
    if (!unit) return { error: "Единица недоступна на этом складе" };
    if (pickList.lines.some((l) => l.unitId === unitId))
      return { error: "Эта единица уже в заявке" };
    const unitBusy = await prisma.pickLine.findFirst({
      where: {
        companyId: s.companyId,
        unitId,
        pickListId: { not: pickList.id },
        pickList: { status: { in: ["NEW", "PICKING"] } },
      },
    });
    if (unitBusy) return { error: "Единица в резерве другой заявки" };
    await prisma.pickLine.create({
      data: {
        companyId: s.companyId,
        pickListId: pickList.id,
        itemId: unit.itemId,
        unitId: unit.id,
        cellId: unit.cellId,
        qtyRequested: new Prisma.Decimal(1),
      },
    });
    broadcastRealtime({
      type: "document.updated",
      entity: "picklist",
      entityId: pickList.id,
      companyId: s.companyId,
      warehouseIds: plWh(pickList),
      actorUserId: session.userId,
    });
    revalidatePath(`/warehouse/picklists/${pickList.id}`);
    return {};
  }

  if (ref.startsWith("L:")) {
    const [lotId, cellId] = ref.slice(2).split(":");
    const balance = await prisma.stockBalance.findFirst({
      where: { lotId, cellId, warehouseId: wh, employeeId: null, qty: { gt: 0 } },
    });
    if (!balance) return { error: "Нет остатка этой партии в выбранной ячейке" };
    if (pickList.lines.some((l) => l.lotId === lotId && l.cellId === cellId))
      return { error: "Эта позиция уже в заявке" };
    const item = await s.item(balance.itemId);
    const qty = Number(String(formData.get("qty") ?? "").trim().replace(",", "."));
    if (!Number.isFinite(qty) || qty <= 0) return { error: "Некорректное количество" };
    const reservingLines = await prisma.pickLine.findMany({
      where: {
        companyId: s.companyId,
        lotId,
        cellId,
        pickListId: { not: pickList.id },
        pickList: { status: { in: ["NEW", "PICKING"] } },
      },
      select: { qtyRequested: true, qtyPicked: true },
    });
    const reservedQty = reservingLines.reduce(
      (sum, l) => sum + Math.max(0, l.qtyRequested.sub(l.qtyPicked).toNumber()),
      0,
    );
    const availQty = balance.qty.toNumber() - reservedQty;
    if (qty > availQty)
      return {
        error: `Доступно с учётом резерва: ${fmtQty(Math.max(0, availQty))} ${item.uom.name}`,
      };
    if (!item.uom.allowFraction && !Number.isInteger(qty))
      return { error: `«${item.uom.name}» не допускает дробное количество` };
    await prisma.pickLine.create({
      data: {
        companyId: s.companyId,
        pickListId: pickList.id,
        itemId: item.id,
        lotId,
        cellId,
        qtyRequested: new Prisma.Decimal(qty),
      },
    });
    broadcastRealtime({
      type: "document.updated",
      entity: "picklist",
      entityId: pickList.id,
      companyId: s.companyId,
      warehouseIds: plWh(pickList),
      actorUserId: session.userId,
    });
    revalidatePath(`/warehouse/picklists/${pickList.id}`);
    return {};
  }

  return { error: "Выберите остаток из списка" };
}

export async function removePickLineAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  assertLegacyUiEnabled();
  const s = scoped(session);
  const lineId = String(formData.get("lineId") ?? "");
  const line = await prisma.pickLine.findFirst({
    where: { id: lineId, companyId: s.companyId },
    include: { pickList: true },
  });
  if (!line || line.pickList.status !== "NEW") return;
  await prisma.pickLine.delete({ where: { id: lineId } });
  broadcastRealtime({
    type: "document.updated",
    entity: "picklist",
    entityId: line.pickListId,
    companyId: s.companyId,
    warehouseIds: plWh(line.pickList),
    actorUserId: session.userId,
  });
  revalidatePath(`/warehouse/picklists/${line.pickListId}`);
}

// Сохранение заявки/перемещения: черновик становится видимым кладовщикам
// в «Активных», им уходит пуш. Повторное сохранение — просто выход в журнал.
export async function savePickListAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  assertLegacyUiEnabled();
  const s = scoped(session);
  const pickList = await s.pickList(String(formData.get("pickListId") ?? ""));
  if (pickList.status !== "NEW" || pickList.lines.length === 0)
    redirect(pickList.targetWarehouseId ? "/warehouse/transfers" : "/warehouse/picklists");
  if (!pickList.savedAt) {
    await prisma.pickList.update({
      where: { id: pickList.id },
      data: { savedAt: new Date() },
    });
    await notifyStorekeepersSaved(s.companyId, pickList);
    broadcastRealtime({
      type: "document.updated",
      entity: pickList.targetWarehouseId ? "transfer" : "picklist",
      entityId: pickList.id,
      companyId: s.companyId,
      warehouseIds: plWh(pickList),
      actorUserId: session.userId,
    });
  }
  revalidatePath("/warehouse/picklists");
  revalidatePath("/warehouse/transfers");
  revalidatePath("/warehouse/active");
  redirect(pickList.targetWarehouseId ? "/warehouse/transfers" : "/warehouse/picklists");
}

// Скан товара при сборке: штука помечается «проверено» (PickFulfillment без
// ячейки выдачи) и резервируется за заявкой, но физически остаётся на месте.
// Перемещение произойдёт при скане ячейки выдачи (placePickToCellAction).
export async function checkPickItemAction(
  pickListId: string,
  raw: string,
): Promise<PickScanResult> {
  const session = await requireStaff();
  assertLegacyUiEnabled();
  const s = scoped(session);
  const pickList = await s.pickList(pickListId);
  if (!isWhAllowed(await warehouseAccess(session), pickList.warehouseId))
    return { error: "Нет доступа к складу заявки" };
  if (pickList.status !== "NEW" && pickList.status !== "PICKING")
    return { error: "Заявка уже собрана" };
  if (pickList.status === "NEW" && !pickList.savedAt)
    return { error: "Документ ещё не сохранён — черновик не собирается" };

  const code = parseScannedCode(raw);
  if (!code) return { error: "Код не распознан" };
  const qr = await resolveQr(code);
  if (!qr || qr.companyId !== s.companyId) return { error: "Код не найден" };
  if (qr.type === "CELL")
    return { error: "Это ячейка — сначала сканируйте товары, ячейку в конце" };
  if (qr.type !== "LOT" && qr.type !== "UNIT") return { error: "Сканируйте QR товара" };

  const markPicking = async (tx: Prisma.TransactionClient) => {
    if (pickList.status === "NEW")
      await tx.pickList.update({
        where: { id: pickList.id },
        data: { status: "PICKING", pickedById: session.userId },
      });
  };

  let label: string;
  if (qr.type === "UNIT") {
    const unit = await prisma.itemUnit.findFirst({
      where: { id: qr.refId, companyId: s.companyId },
    });
    if (!unit) return { error: "Единица не найдена" };
    if (unit.status !== "IN_STOCK") return { error: "Единица недоступна (уже занята)" };
    const line = pickList.lines.find(
      (l) => l.unitId === unit.id && l.qtyPicked.lt(l.qtyRequested),
    );
    if (!line) return { error: "Этой единицы нет среди непроверенных позиций заявки" };
    const item = await s.item(unit.itemId);
    await prisma.$transaction(async (tx) => {
      await tx.itemUnit.update({
        where: { id: unit.id },
        data: { status: "PICKED", pickListId: pickList.id },
      });
      await tx.pickFulfillment.create({
        data: {
          companyId: s.companyId,
          pickLineId: line.id,
          unitId: unit.id,
          qty: new Prisma.Decimal(1),
          fromWarehouseId: unit.warehouseId ?? pickList.warehouseId ?? "",
          fromCellId: unit.cellId,
          scannedById: session.userId,
        },
      });
      await tx.pickLine.update({ where: { id: line.id }, data: { qtyPicked: { increment: 1 } } });
      await markPicking(tx);
    });
    label = `${item.name} №${unit.serial}`;
  } else {
    const lot = await prisma.lot.findFirst({ where: { id: qr.refId, companyId: s.companyId } });
    if (!lot) return { error: "Партия не найдена" };
    const line = pickList.lines.find(
      (l) => l.lotId === lot.id && l.qtyPicked.lt(l.qtyRequested),
    );
    if (!line) return { error: "Этой партии нет среди непроверенных позиций заявки" };
    const item = await s.item(lot.itemId);
    const need = line.qtyRequested.sub(line.qtyPicked);
    const source = await prisma.stockBalance.findFirst({
      where: {
        lotId: lot.id,
        ...(line.cellId ? { cellId: line.cellId } : { employeeId: null }),
        qty: { gt: 0 },
      },
    });
    if (!source) return { error: `«${item.name}»: нет остатка партии в ячейке хранения` };
    // 1 скан = 1 штука; последний скан добирает дробный остаток
    const take = Prisma.Decimal.min(need, source.qty, new Prisma.Decimal(1));
    await prisma.$transaction(async (tx) => {
      await tx.pickFulfillment.create({
        data: {
          companyId: s.companyId,
          pickLineId: line.id,
          lotId: lot.id,
          qty: take,
          fromWarehouseId: source.warehouseId ?? pickList.warehouseId ?? "",
          fromCellId: source.cellId,
          scannedById: session.userId,
        },
      });
      await tx.pickLine.update({
        where: { id: line.id },
        data: { qtyPicked: { increment: take } },
      });
      await markPicking(tx);
    });
    label = `${item.name}: ${fmtQty(take)} ${item.uom.name}`;
  }

  broadcastRealtime({
    type: "document.updated",
    entity: "picklist",
    entityId: pickList.id,
    companyId: s.companyId,
    warehouseIds: plWh(pickList),
    actorUserId: session.userId,
  });
  broadcastRealtime({
    type: "stock.updated",
    entity: "stock",
    companyId: s.companyId,
    warehouseIds: plWh(pickList),
    actorUserId: session.userId,
  });
  revalidatePath(`/warehouse/picklists/${pickList.id}`);
  revalidatePath("/warehouse/stock");
  const fresh = await prisma.pickLine.findMany({ where: { pickListId: pickList.id } });
  const allChecked = fresh.every((l) => l.qtyPicked.gte(l.qtyRequested));
  return { ok: `${label} — проверено`, itemLabel: label, done: allChecked };
}

// Скан ячейки выдачи: все проверенные, но ещё не размещённые товары заявки
// перемещаются в эту ячейку. Когда проверено и размещено всё — заявка
// автоматически уходит в зону выдачи (STAGED).
export async function placePickToCellAction(
  pickListId: string,
  raw: string,
): Promise<PickScanResult> {
  const session = await requireStaff();
  assertLegacyUiEnabled();
  const s = scoped(session);
  const pickList = await s.pickList(pickListId);
  if (!isWhAllowed(await warehouseAccess(session), pickList.warehouseId))
    return { error: "Нет доступа к складу заявки" };
  if (pickList.status !== "NEW" && pickList.status !== "PICKING")
    return { error: "Заявка уже собрана" };
  if (pickList.status === "NEW" && !pickList.savedAt)
    return { error: "Документ ещё не сохранён — черновик не собирается" };

  const code = parseScannedCode(raw);
  if (!code) return { error: "Код не распознан" };
  const qr = await resolveQr(code);
  if (!qr || qr.companyId !== s.companyId || qr.type !== "CELL")
    return { error: "Сканируйте QR ячейки зоны выдачи" };
  const cell = await prisma.cell.findFirst({
    where: { id: qr.refId, companyId: s.companyId, isActive: true },
  });
  if (!cell) return { error: "Ячейка не найдена или отключена" };
  if (!cell.isStaging) return { error: "Это не ячейка зоны выдачи" };
  if (cell.warehouseId !== pickList.warehouseId) return { error: "Ячейка на другом складе" };

  const unplaced = pickList.lines.flatMap((l) =>
    l.fulfillments.filter((fu) => !fu.toCellId).map((fu) => ({ line: l, fu })),
  );
  if (unplaced.length === 0) return { error: "Сначала отсканируйте товары" };
  const to: Loc = { kind: "cell", warehouseId: cell.warehouseId, cellId: cell.id };

  try {
    await prisma.$transaction(async (tx) => {
      for (const { line, fu } of unplaced) {
        if (fu.unitId) {
          const unit = await tx.itemUnit.findFirst({
            where: { id: fu.unitId, companyId: s.companyId },
          });
          if (!unit || unit.status !== "PICKED")
            throw new StockError("Проверенная единица недоступна");
          await moveUnit(tx, {
            companyId: s.companyId,
            docType: "PICKLIST",
            docId: pickList.id,
            unit,
            to,
            status: "PICKED",
            createdById: session.userId,
            pickListId: pickList.id,
          });
        } else if (fu.lotId) {
          const from: Loc = fu.fromCellId
            ? { kind: "cell", warehouseId: fu.fromWarehouseId, cellId: fu.fromCellId }
            : { kind: "warehouse", warehouseId: fu.fromWarehouseId };
          await applyLotMovement(tx, {
            companyId: s.companyId,
            docType: "PICKLIST",
            docId: pickList.id,
            itemId: line.itemId,
            lotId: fu.lotId,
            qty: fu.qty,
            from,
            to,
            createdById: session.userId,
          });
        }
        await tx.pickFulfillment.update({ where: { id: fu.id }, data: { toCellId: cell.id } });
      }
      await tx.pickListCell.upsert({
        where: { pickListId_cellId: { pickListId: pickList.id, cellId: cell.id } },
        update: {},
        create: { companyId: s.companyId, pickListId: pickList.id, cellId: cell.id },
      });
      await tx.pickList.update({
        where: { id: pickList.id },
        data: { stagingCellId: cell.id },
      });
    });
  } catch (e) {
    if (e instanceof StockError) return { error: e.message };
    throw e;
  }

  // всё проверено и размещено → заявка собрана
  const freshLines = await prisma.pickLine.findMany({
    where: { pickListId: pickList.id },
    include: { fulfillments: { select: { toCellId: true } } },
  });
  const done =
    freshLines.every((l) => l.qtyPicked.gte(l.qtyRequested)) &&
    freshLines.every((l) => l.fulfillments.every((fu) => !!fu.toCellId));
  if (done) {
    await prisma.pickList.update({
      where: { id: pickList.id },
      data: {
        status: "STAGED",
        pickedAt: new Date(),
        stagedAt: new Date(),
        pickedById: session.userId,
      },
    });
    await logEvent({
      companyId: s.companyId,
      type: "picklist_staged",
      title: `${docName(pickList)} — собрано в зону выдачи`,
      body: `Позиций: ${pickList.lines.length}`,
      url: `/warehouse/picklists/${pickList.id}`,
      actorId: session.userId,
      warehouseIds: plWh(pickList),
      userIds: pickList.targetEmployeeId ? [pickList.targetEmployeeId] : undefined,
    });
  }
  broadcastRealtime({
    type: "document.updated",
    entity: "picklist",
    entityId: pickList.id,
    companyId: s.companyId,
    warehouseIds: plWh(pickList),
    actorUserId: session.userId,
  });
  broadcastRealtime({
    type: "stock.updated",
    entity: "stock",
    companyId: s.companyId,
    warehouseIds: plWh(pickList),
    actorUserId: session.userId,
  });
  revalidatePath(`/warehouse/picklists/${pickList.id}`);
  revalidatePath("/warehouse/picklists");
  revalidatePath("/warehouse/active");
  revalidatePath("/warehouse/staging");
  revalidatePath("/warehouse/stock");
  return { ok: `Товары в ячейке ${cell.code}`, cellCode: cell.code, done };
}

export async function undoPickAction(formData: FormData): Promise<void> {
  const session = await requireStaff();
  assertLegacyUiEnabled();
  const s = scoped(session);
  const fulfillmentId = String(formData.get("fulfillmentId") ?? "");
  const f = await prisma.pickFulfillment.findFirst({
    where: { id: fulfillmentId, companyId: s.companyId },
    include: { pickLine: { include: { pickList: true } } },
  });
  if (!f) return;
  if (!isWhAllowed(await warehouseAccess(session), f.pickLine.pickList.warehouseId)) return;
  const status = f.pickLine.pickList.status;
  if (status !== "NEW" && status !== "PICKING") return;

  const backCell: Loc = f.fromCellId
    ? { kind: "cell", warehouseId: f.fromWarehouseId, cellId: f.fromCellId }
    : { kind: "warehouse", warehouseId: f.fromWarehouseId };
  await prisma.$transaction(async (tx) => {
    if (f.unitId && f.toCellId) {
      // размещено в ячейке выдачи — вернуть физически
      const unit = await tx.itemUnit.findFirst({ where: { id: f.unitId, companyId: s.companyId } });
      if (unit && unit.status === "PICKED")
        await moveUnit(tx, {
          companyId: s.companyId,
          docType: "PICKLIST",
          docId: f.pickLine.pickList.id,
          unit,
          to: backCell,
          status: "IN_STOCK",
          createdById: session.userId,
          pickListId: null,
        });
    } else if (f.unitId) {
      // только проверено (не перемещалось) — снять резерв
      await tx.itemUnit.update({
        where: { id: f.unitId },
        data: { status: "IN_STOCK", pickListId: null },
      });
    } else if (f.lotId && f.toCellId) {
      await applyLotMovement(tx, {
        companyId: s.companyId,
        docType: "PICKLIST",
        docId: f.pickLine.pickList.id,
        itemId: f.pickLine.itemId,
        lotId: f.lotId,
        qty: f.qty,
        from: { kind: "cell", warehouseId: f.fromWarehouseId, cellId: f.toCellId },
        to: backCell,
        createdById: session.userId,
      });
    }
    await tx.pickLine.update({
      where: { id: f.pickLineId },
      data: { qtyPicked: { decrement: f.qty } },
    });
    await tx.pickFulfillment.delete({ where: { id: f.id } });
  });
  broadcastRealtime({
    type: "document.updated",
    entity: "picklist",
    entityId: f.pickLine.pickList.id,
    companyId: s.companyId,
    warehouseIds: plWh(f.pickLine.pickList),
    actorUserId: session.userId,
  });
  broadcastRealtime({
    type: "stock.updated",
    entity: "stock",
    companyId: s.companyId,
    warehouseIds: plWh(f.pickLine.pickList),
    actorUserId: session.userId,
  });
  revalidatePath(`/warehouse/picklists/${f.pickLine.pickList.id}`);
  revalidatePath("/warehouse/stock");
}

export async function cancelPickListAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  assertLegacyUiEnabled();
  const s = scoped(session);
  const pickListId = String(formData.get("pickListId") ?? "");
  const pickList = await s.pickList(pickListId);
  if (pickList.status !== "NEW" && pickList.status !== "PICKING") return;

  try {
    await prisma.$transaction(async (tx) => {
      // вернуть уже перемещённое из ячеек выдачи обратно в ячейки хранения
      for (const line of pickList.lines) {
        for (const f of line.fulfillments) {
          const backCell: Loc = f.fromCellId
            ? { kind: "cell", warehouseId: f.fromWarehouseId, cellId: f.fromCellId }
            : { kind: "warehouse", warehouseId: f.fromWarehouseId };
          if (f.unitId && f.toCellId) {
            const unit = await tx.itemUnit.findFirst({
              where: { id: f.unitId, companyId: s.companyId },
            });
            if (unit && unit.status === "PICKED")
              await moveUnit(tx, {
                companyId: s.companyId,
                docType: "PICKLIST",
                docId: pickList.id,
                unit,
                to: backCell,
                status: "IN_STOCK",
                createdById: session.userId,
                pickListId: null,
              });
          } else if (f.unitId) {
            // только проверено — снять резерв без движения
            await tx.itemUnit.update({
              where: { id: f.unitId },
              data: { status: "IN_STOCK", pickListId: null },
            });
          } else if (f.lotId && f.toCellId) {
            await applyLotMovement(tx, {
              companyId: s.companyId,
              docType: "PICKLIST",
              docId: pickList.id,
              itemId: line.itemId,
              lotId: f.lotId,
              qty: f.qty,
              from: { kind: "cell", warehouseId: f.fromWarehouseId, cellId: f.toCellId },
              to: backCell,
              createdById: session.userId,
            });
          }
        }
      }
      await tx.pickFulfillment.deleteMany({
        where: { pickLineId: { in: pickList.lines.map((l) => l.id) } },
      });
      await tx.pickLine.updateMany({
        where: { pickListId: pickList.id },
        data: { qtyPicked: 0 },
      });
      await tx.pickListCell.deleteMany({ where: { pickListId: pickList.id } });
      await tx.pickList.update({
        where: { id: pickList.id },
        data: { status: "CANCELLED", stagingCellId: null },
      });
    });
  } catch (e) {
    if (e instanceof StockError) return; // остаток уже разошёлся — отмена невозможна
    throw e;
  }
  broadcastRealtime({
    type: "document.updated",
    entity: pickList.targetWarehouseId ? "transfer" : "picklist",
    entityId: pickList.id,
    companyId: s.companyId,
    warehouseIds: plWh(pickList),
    actorUserId: session.userId,
  });
  broadcastRealtime({
    type: "stock.updated",
    entity: "stock",
    companyId: s.companyId,
    warehouseIds: plWh(pickList),
    actorUserId: session.userId,
  });
  revalidatePath("/warehouse/picklists");
  revalidatePath("/warehouse/stock");
  redirect("/warehouse/picklists");
}

// Скан товара при выдаче (документ в зоне выдачи): проверка, что товар из этого
// документа. Прогресс проверки держит клиент — сама выдача происходит после
// скана бейджа сотрудника (заявка) или автоматически после проверки всего
// (перемещение).
export async function resolveIssueScanAction(
  pickListId: string,
  raw: string,
): Promise<{ ok?: string; error?: string; lineId?: string; unitRefId?: string }> {
  const session = await requireStaff();
  assertLegacyUiEnabled();
  const s = scoped(session);
  const pickList = await s.pickList(pickListId);
  if (!isWhAllowed(await warehouseAccess(session), pickList.warehouseId))
    return { error: "Нет доступа к складу" };
  if (pickList.status !== "STAGED") return { error: "Документ не в зоне выдачи" };

  const code = parseScannedCode(raw);
  if (!code) return { error: "Код не распознан" };
  const qr = await resolveQr(code);
  if (!qr || qr.companyId !== s.companyId) return { error: "Код не найден" };
  if (qr.type === "EMPLOYEE")
    return { error: "Сначала проверьте все товары — бейдж сканируется в конце" };
  if (qr.type !== "LOT" && qr.type !== "UNIT") return { error: "Сканируйте QR товара" };

  if (qr.type === "UNIT") {
    const line = pickList.lines.find((l) => l.unitId === qr.refId);
    if (!line) return { error: "Этой единицы нет в документе" };
    const item = await s.item(line.itemId);
    return { ok: item.name, lineId: line.id, unitRefId: qr.refId };
  }
  const line = pickList.lines.find((l) => l.lotId === qr.refId);
  if (!line) return { error: "Этой партии нет в документе" };
  const item = await s.item(line.itemId);
  return { ok: item.name, lineId: line.id };
}

// Выдача заявки по QR-бейджу адресата: скан бейджа = подтверждение получения,
// поэтому выдача сразу CONFIRMED (отдельное подтверждение сотруднику не нужно).
export async function issuePickListByBadgeAction(
  pickListId: string,
  badgeRaw: string,
): Promise<{ ok?: string; error?: string; employeeName?: string }> {
  const session = await requireStaff();
  assertLegacyUiEnabled();
  const s = scoped(session);
  const pickList = await s.pickList(pickListId);
  if (!isWhAllowed(await warehouseAccess(session), pickList.warehouseId))
    return { error: "Нет доступа к складу заявки" };
  if (pickList.status !== "STAGED") return { error: "Заявка не в зоне выдачи" };
  const employeeId = pickList.targetEmployeeId;
  if (!employeeId) return { error: "Это перемещение — сканирование бейджа не нужно" };
  const target = await s.user(employeeId);

  const code = parseScannedCode(badgeRaw);
  const qr = code ? await resolveQr(code) : null;
  if (!qr || qr.companyId !== s.companyId || qr.type !== "EMPLOYEE")
    return { error: "Это не QR-бейдж сотрудника" };
  if (qr.refId !== employeeId)
    return { error: `Бейдж другого сотрудника — выдача для: ${target.name}` };

  const toLoc: Loc = { kind: "employee", employeeId };
  let issueNumber = 0;
  try {
    const issue = await prisma.$transaction(async (tx) => {
      const number = await nextNumber(tx, s.companyId, "issue");
      const issue = await tx.issue.create({
        data: {
          companyId: s.companyId,
          number,
          employeeId,
          source: "PICKLIST",
          pickListId: pickList.id,
          status: "CONFIRMED",
          confirmedAt: new Date(),
          issuedById: session.userId,
        },
      });

      for (const line of pickList.lines) {
        for (const f of line.fulfillments) {
          if (f.unitId) {
            const unit = await tx.itemUnit.findFirst({
              where: { id: f.unitId, companyId: s.companyId },
            });
            if (!unit || unit.status !== "PICKED")
              throw new StockError("Зарезервированная единица недоступна");
            await moveUnit(tx, {
              companyId: s.companyId,
              docType: "ISSUE",
              docId: issue.id,
              unit,
              to: toLoc,
              status: "ISSUED",
              createdById: session.userId,
              pickListId: null,
              issueId: issue.id,
            });
            await tx.issueLine.create({
              data: {
                companyId: s.companyId,
                issueId: issue.id,
                itemId: unit.itemId,
                unitId: unit.id,
                qty: new Prisma.Decimal(1),
                price: unit.price,
              },
            });
          } else if (f.lotId) {
            let remaining = f.qty;
            const balances = await tx.stockBalance.findMany({
              where: f.toCellId
                ? { lotId: f.lotId, cellId: f.toCellId, qty: { gt: 0 } }
                : { lotId: f.lotId, employeeId: null, qty: { gt: 0 } },
              orderBy: { cellId: { sort: "asc", nulls: "first" } },
            });
            for (const b of balances) {
              if (remaining.lte(0)) break;
              const take = Prisma.Decimal.min(remaining, b.qty);
              const from: Loc = b.cellId
                ? { kind: "cell", warehouseId: b.warehouseId!, cellId: b.cellId }
                : { kind: "warehouse", warehouseId: b.warehouseId! };
              await applyLotMovement(tx, {
                companyId: s.companyId,
                docType: "ISSUE",
                docId: issue.id,
                itemId: line.itemId,
                lotId: f.lotId,
                qty: take,
                from,
                to: toLoc,
                createdById: session.userId,
              });
              remaining = remaining.sub(take);
            }
            if (remaining.gt(0))
              throw new StockError("Остатка партии уже не хватает — пересоберите заявку");
            const lot = await tx.lot.findUnique({ where: { id: f.lotId } });
            await tx.issueLine.create({
              data: {
                companyId: s.companyId,
                issueId: issue.id,
                itemId: line.itemId,
                lotId: f.lotId,
                qty: f.qty,
                price: lot?.price ?? null,
              },
            });
          }
        }
      }

      await tx.pickList.update({
        where: { id: pickList.id },
        data: { status: "ISSUED", issuedAt: new Date() },
      });
      return issue;
    });
    issueNumber = issue.number;

    await logEvent({
      companyId: s.companyId,
      type: "issue_created",
      title: `Выдача №${issue.number} по заявке №${pickList.number} — ${target.name}`,
      body: "Выдано и подтверждено сканом QR сотрудника",
      url: `/warehouse/issues/${issue.id}`,
      actorId: session.userId,
      warehouseIds: plWh(pickList),
      userIds: [target.id],
    });
  } catch (e) {
    if (e instanceof StockError) return { error: e.message };
    throw e;
  }

  revalidatePath("/warehouse/picklists");
  revalidatePath("/warehouse/staging");
  revalidatePath("/warehouse/issues");
  revalidatePath("/warehouse/active");
  revalidatePath("/warehouse/stock");
  revalidatePath("/warehouse/my");
  return { ok: `Выдача №${issueNumber}`, employeeName: target.name };
}

// Отправка перемещения на склад-назначение: вызывается автоматически после
// проверки сканами всех товаров (кнопки нет).
export async function dispatchTransferByScanAction(
  pickListId: string,
): Promise<{ ok?: string; error?: string; destName?: string }> {
  const session = await requireStaff();
  assertLegacyUiEnabled();
  const s = scoped(session);
  const pickList = await s.pickList(pickListId);
  if (!isWhAllowed(await warehouseAccess(session), pickList.warehouseId))
    return { error: "Нет доступа к складу" };
  if (pickList.status !== "STAGED") return { error: "Перемещение не в зоне выдачи" };
  if (!pickList.targetWarehouseId) return { error: "Это заявка — выдача по бейджу сотрудника" };
  const dest = await prisma.warehouse.findFirst({
    where: { id: pickList.targetWarehouseId, companyId: s.companyId, isActive: true },
  });
  if (!dest) return { error: "Склад-назначение не найден или отключён" };
  const toLoc: Loc = { kind: "warehouse", warehouseId: dest.id };

  try {
    await prisma.$transaction(async (tx) => {
      for (const line of pickList.lines) {
        for (const fu of line.fulfillments) {
          if (fu.unitId) {
            const unit = await tx.itemUnit.findFirst({
              where: { id: fu.unitId, companyId: s.companyId },
            });
            if (!unit || unit.status !== "PICKED")
              throw new StockError("Собранная единица недоступна");
            await moveUnit(tx, {
              companyId: s.companyId,
              docType: "TRANSFER",
              docId: pickList.id,
              unit,
              to: toLoc,
              status: "IN_STOCK",
              createdById: session.userId,
              pickListId: null,
            });
          } else if (fu.lotId && fu.toCellId) {
            await applyLotMovement(tx, {
              companyId: s.companyId,
              docType: "TRANSFER",
              docId: pickList.id,
              itemId: line.itemId,
              lotId: fu.lotId,
              qty: fu.qty,
              from: { kind: "cell", warehouseId: fu.fromWarehouseId, cellId: fu.toCellId },
              to: toLoc,
              createdById: session.userId,
            });
          }
        }
      }
      await tx.pickList.update({
        where: { id: pickList.id },
        data: { status: "ISSUED", issuedAt: new Date() },
      });
    });
  } catch (e) {
    if (e instanceof StockError) return { error: e.message };
    throw e;
  }
  await logEvent({
    companyId: s.companyId,
    type: "transfer_posted",
    title: `Перемещение №${pickList.number} отправлено на «${dest.name}»`,
    body: "Товар пришёл на склад без ячейки — разложите по ячейкам сканами",
    url: `/warehouse/picklists/${pickList.id}`,
    actorId: session.userId,
    warehouseIds: plWh(pickList),
  });
  revalidatePath("/warehouse/transfers");
  revalidatePath("/warehouse/picklists");
  revalidatePath("/warehouse/staging");
  revalidatePath("/warehouse/active");
  revalidatePath("/warehouse/stock");
  return { ok: `Перемещение №${pickList.number} отправлено`, destName: dest.name };
}

// Удаление заявки (админ): только «новая» или «отменена», без выдачи. По заявке
// в сборке сначала выполняется отмена (товар возвращается в ячейки хранения).
export async function deletePickListAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdmin();
  assertLegacyUiEnabled();
  const s = scoped(session);
  const pickList = await s.pickList(String(formData.get("pickListId") ?? ""));
  const issue = await prisma.issue.findFirst({
    where: { companyId: s.companyId, pickListId: pickList.id },
  });
  if (issue) return { error: `По заявке есть выдача №${issue.number} — удалить нельзя` };
  if (pickList.status !== "NEW" && pickList.status !== "CANCELLED")
    return { error: "Сначала отмените заявку — собранный товар вернётся в ячейки хранения" };
  if (pickList.lines.some((l) => l.fulfillments.length > 0))
    return { error: "По заявке есть сканы — сначала отмените её" };

  await prisma.$transaction(async (tx) => {
    await tx.qrCode.deleteMany({
      where: { companyId: s.companyId, type: "PICKLIST", refId: pickList.id },
    });
    await tx.pickList.delete({ where: { id: pickList.id } }); // строки и ячейки — каскадом
  });
  await logEvent({
    companyId: s.companyId,
    type: "picklist_deleted",
    title: `${docName(pickList)} — удалено`,
    body: "",
    actorId: session.userId,
    warehouseIds: plWh(pickList),
  });
  revalidatePath("/warehouse/picklists");
  revalidatePath("/warehouse/transfers");
  revalidatePath("/warehouse/active");
  revalidatePath("/warehouse/stock");
  redirect(pickList.targetWarehouseId ? "/warehouse/transfers" : "/warehouse/picklists");
}
