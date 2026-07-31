import "server-only";
import { Prisma, type HandlingGroupStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { applyLotMovement } from "@/lib/stock";
import { createQrIn } from "@/lib/qr";
import { nextNumber } from "@/lib/counters";
import { getSettings } from "@/lib/settings";
import { fmtDateTime } from "@/lib/format";
import {
  lockCompany,
  createWorkflowTaskInTx,
  emitTaskCreated,
  emitTaskCompleted,
  completeWorkflowTaskInTransaction,
  rebalanceQueuedTasks,
} from "@/lib/workflow-tasks";

// Этап 5/Пакет 4: групповая приёмка + температурный контроль. Все движения остатка — только
// через src/lib/stock.ts. Приход: null → зона RECEIVING (Z:<zoneId>); размещение: RECEIVING → Cell.
// Локация группы — из ledger (своего cellId у HandlingGroup нет). Только TrackingType=LOT.

export class GroupError extends Error {}

type Tx = Prisma.TransactionClient;

// пустая ли ячейка: нет партионного остатка qty>0 и нет поштучных единиц
async function cellIsBusy(tx: Tx, cellId: string): Promise<boolean> {
  const [bal, unit] = await Promise.all([
    tx.stockBalance.findFirst({ where: { cellId, qty: { gt: 0 } }, select: { id: true } }),
    tx.itemUnit.findFirst({ where: { cellId }, select: { id: true } }),
  ]);
  return !!bal || !!unit;
}

// минимальный уровень среди ПУСТЫХ активных STORAGE-ячеек склада (или null, если таких нет)
async function lowestEmptyStorageLevel(tx: Tx, companyId: string, warehouseId: string): Promise<number | null> {
  const cells = await tx.cell.findMany({
    where: { companyId, warehouseId, isActive: true, level: { not: null }, zone: { kind: "STORAGE" } },
    select: { id: true, level: true },
  });
  if (cells.length === 0) return null;
  const ids = cells.map((c) => c.id);
  const [busyBal, busyUnit] = await Promise.all([
    tx.stockBalance.findMany({ where: { cellId: { in: ids }, qty: { gt: 0 } }, select: { cellId: true } }),
    tx.itemUnit.findMany({ where: { cellId: { in: ids } }, select: { cellId: true } }),
  ]);
  const busy = new Set<string>([...busyBal.map((b) => b.cellId!), ...busyUnit.map((u) => u.cellId!)]);
  const levels = cells.filter((c) => !busy.has(c.id)).map((c) => c.level!);
  return levels.length ? Math.min(...levels) : null;
}

// ── Создание группы (идемпотентно по dedupeKey, атомарно) ──
export async function createHandlingGroup(input: {
  companyId: string;
  warehouseId: string;
  itemId: string;
  qty: number;
  temperature: number;
  acceptedById: string;
  dedupeKey: string;
}): Promise<{ groupId: string; created: boolean; status: HandlingGroupStatus; qrCode: string | null; taskId: string | null }> {
  // --- серверная валидация до транзакции ---
  if (!Number.isInteger(input.qty) || input.qty <= 0)
    throw new GroupError("Количество должно быть целым числом больше нуля");
  if (!Number.isFinite(input.temperature) || input.temperature < -100 || input.temperature > 100)
    throw new GroupError("Некорректная температура");
  const settings = await getSettings(input.companyId);
  if (settings.tempThresholdX === null)
    throw new GroupError("Порог температуры X не настроен. Задайте его в настройках, затем повторите приёмку.");
  const X = settings.tempThresholdX;
  const now = new Date();

  const out = await prisma.$transaction(async (tx) => {
    await lockCompany(tx, input.companyId);

    // идемпотентность
    const existing = await tx.handlingGroup.findUnique({
      where: { companyId_dedupeKey: { companyId: input.companyId, dedupeKey: input.dedupeKey } },
    });
    if (existing)
      return { groupId: existing.id, created: false, status: existing.status, qrCode: null, taskId: null, taskRes: null };

    // товар: свой, активный, партионный
    const item = await tx.item.findFirst({ where: { id: input.itemId, companyId: input.companyId } });
    if (!item || !item.isActive) throw new GroupError("Товар не найден или неактивен");
    if (item.tracking === "UNIT")
      throw new GroupError("Групповая приёмка для поштучного учёта пока недоступна");

    // склад: свой, активный
    const wh = await tx.warehouse.findFirst({ where: { id: input.warehouseId, companyId: input.companyId, isActive: true } });
    if (!wh) throw new GroupError("Склад не найден или неактивен");

    // системная зона приёмки
    const receiving = await tx.warehouseZone.findFirst({
      where: { companyId: input.companyId, warehouseId: input.warehouseId, kind: "RECEIVING" },
    });
    if (!receiving) throw new GroupError("На складе нет системной зоны приёмки");

    // внутренние Receipt/ReceiptLine/Lot (Lot требует receiptLineId; в UI это не документ приёмки)
    const number = await nextNumber(tx, input.companyId, "group_receipt");
    const receipt = await tx.receipt.create({
      data: {
        companyId: input.companyId,
        number,
        warehouseId: input.warehouseId,
        status: "POSTED",
        postedAt: now,
        note: "Групповая приёмка",
        createdById: input.acceptedById,
      },
    });
    const line = await tx.receiptLine.create({
      data: { companyId: input.companyId, receiptId: receipt.id, itemId: input.itemId, qty: input.qty },
    });
    const lot = await tx.lot.create({
      data: { companyId: input.companyId, itemId: input.itemId, receiptLineId: line.id, qtyReceived: input.qty },
    });

    // приход: null → зона RECEIVING (через ядро остатков)
    await applyLotMovement(tx, {
      companyId: input.companyId,
      docType: "RECEIPT",
      docId: receipt.id,
      itemId: input.itemId,
      lotId: lot.id,
      qty: input.qty,
      from: null,
      to: { kind: "zone", warehouseId: input.warehouseId, zoneId: receiving.id },
      createdById: input.acceptedById,
    });

    // маршрут по температуре (равенство → STORAGE)
    const status: HandlingGroupStatus = input.temperature <= X ? "AWAITING_STORAGE" : "AWAITING_COOLING";

    const group = await tx.handlingGroup.create({
      data: {
        companyId: input.companyId,
        warehouseId: input.warehouseId,
        itemId: input.itemId,
        lotId: lot.id,
        qty: input.qty,
        temperature: input.temperature,
        thresholdX: X,
        status,
        dedupeKey: input.dedupeKey,
        acceptedById: input.acceptedById,
        acceptedAt: now,
      },
    });
    const qrCode = await createQrIn(tx, { companyId: input.companyId, type: "GROUP", refId: group.id });

    // задача погрузчику PLACE_GROUP (авто-назначение по загрузке смен)
    const route = status === "AWAITING_STORAGE" ? "хранение" : "охлаждение";
    const taskRes = await createWorkflowTaskInTx(tx, {
      companyId: input.companyId,
      warehouseId: input.warehouseId,
      type: "PLACE_GROUP",
      requiredRole: "LOADER",
      priority: "NORMAL",
      title: `Разместить: ${item.name} · ${input.qty} шт`,
      description: `Приёмка ${fmtDateTime(now)} · ${item.name} · ${input.qty} шт · ${input.temperature}°C · назначение: ${route}`,
      subjectType: "HandlingGroup",
      subjectId: group.id,
      dedupeKey: `group:${group.id}:place`,
    });

    return { groupId: group.id, created: true, status, qrCode, taskId: taskRes.task.id, taskRes };
  });

  // события задачи — после коммита (без push, только Event + realtime)
  if (out.created && out.taskRes) await emitTaskCreated(out.taskRes);
  return { groupId: out.groupId, created: out.created, status: out.status, qrCode: out.qrCode, taskId: out.taskId };
}

// ── Завершение размещения погрузчиком (атомарно) ──
export async function completeGroupPlacement(input: {
  companyId: string;
  userId: string;
  taskId: string;
  cellId: string;
}): Promise<{ warehouseId: string }> {
  const res = await prisma.$transaction(async (tx) => {
    await lockCompany(tx, input.companyId);

    const task = await tx.workflowTask.findFirst({ where: { id: input.taskId, companyId: input.companyId } });
    if (!task) throw new GroupError("Задача не найдена");
    if (task.type !== "PLACE_GROUP") throw new GroupError("Это не задача размещения группы");
    if (task.assignedUserId !== input.userId || task.status !== "IN_PROGRESS")
      throw new GroupError("Завершить может только назначенный исполнитель с задачей «в работе»");

    const group = await tx.handlingGroup.findFirst({ where: { id: task.subjectId ?? "", companyId: input.companyId } });
    if (!group) throw new GroupError("Группа не найдена");
    if (group.status !== "AWAITING_STORAGE" && group.status !== "AWAITING_COOLING")
      throw new GroupError("Группа уже размещена");
    const targetKind = group.status === "AWAITING_STORAGE" ? "STORAGE" : "COOLING";

    // целевая ячейка: та же компания+склад, активная, физическая нужного kind
    const cell = await tx.cell.findFirst({
      where: { id: input.cellId, companyId: input.companyId, warehouseId: group.warehouseId },
      include: { zone: true },
    });
    if (!cell) throw new GroupError("Ячейка не найдена на этом складе");
    if (!cell.isActive) throw new GroupError("Ячейка отключена");
    if (!cell.zone || cell.zone.kind !== targetKind)
      throw new GroupError(targetKind === "STORAGE" ? "Нужна ячейка зоны хранения" : "Нужна ячейка зоны охлаждения");

    // пустая (одна ячейка — одна группа); повторная проверка под advisory-lock
    if (await cellIsBusy(tx, cell.id)) throw new GroupError("Ячейка занята — выберите пустую");

    // STORAGE: нижний доступный уровень (не класть выше при свободной ниже)
    if (targetKind === "STORAGE") {
      if (cell.level == null) throw new GroupError("У ячейки хранения не настроен уровень");
      const minLevel = await lowestEmptyStorageLevel(tx, input.companyId, group.warehouseId);
      if (minLevel != null && cell.level > minLevel)
        throw new GroupError(`Есть свободная ячейка ниже (уровень ${minLevel}). Разместите там.`);
    }

    // полный перенос остатка группы из зоны RECEIVING → ячейку (через ядро)
    const receiving = await tx.warehouseZone.findFirst({
      where: { companyId: input.companyId, warehouseId: group.warehouseId, kind: "RECEIVING" },
    });
    if (!receiving) throw new GroupError("На складе нет системной зоны приёмки");
    const recvBal = await tx.stockBalance.findFirst({
      where: { lotId: group.lotId, locKey: `Z:${receiving.id}`, qty: { gt: 0 } },
    });
    if (!recvBal) throw new GroupError("Остаток группы в зоне приёмки не найден");
    // Группа неделима: остаток в RECEIVING должен ТОЧНО равняться количеству группы.
    // Иначе (частичный расход/доп. приход в ту же зону) — отменяем, не размещаем «что нашлось».
    if (!recvBal.qty.equals(group.qty))
      throw new GroupError("Остаток группы в зоне приёмки не совпадает с её количеством — размещение отменено");

    await applyLotMovement(tx, {
      companyId: input.companyId,
      docType: "TRANSFER",
      docId: group.id,
      itemId: group.itemId,
      lotId: group.lotId,
      qty: group.qty,
      from: { kind: "zone", warehouseId: group.warehouseId, zoneId: receiving.id },
      to: { kind: "cell", warehouseId: group.warehouseId, cellId: cell.id },
      createdById: input.userId,
    });

    await tx.handlingGroup.update({
      where: { id: group.id },
      data: { status: targetKind === "STORAGE" ? "IN_STORAGE" : "IN_COOLING" },
    });

    // завершить задачу (+ разблокировать зависимости)
    const unblocked = await completeWorkflowTaskInTransaction(tx, task.id);
    return { companyId: input.companyId, warehouseId: group.warehouseId, title: task.title, taskId: task.id, unblocked };
  });

  // события после коммита + перераспределение очереди (без push)
  await emitTaskCompleted(res);
  await rebalanceQueuedTasks(res.companyId, { warehouseId: res.warehouseId });
  return { warehouseId: res.warehouseId };
}

// ── Список подходящих пустых ячеек для размещения (UI) ──
export async function eligibleCellsForGroup(
  companyId: string,
  warehouseId: string,
  status: HandlingGroupStatus,
): Promise<{ id: string; code: string; level: number | null; recommended: boolean }[]> {
  const kind = status === "AWAITING_STORAGE" ? "STORAGE" : status === "AWAITING_COOLING" ? "COOLING" : null;
  if (!kind) return [];
  const cells = await prisma.cell.findMany({
    where: { companyId, warehouseId, isActive: true, zone: { kind } },
    select: { id: true, code: true, level: true },
  });
  if (cells.length === 0) return [];
  const ids = cells.map((c) => c.id);
  const [busyBal, busyUnit] = await Promise.all([
    prisma.stockBalance.findMany({ where: { cellId: { in: ids }, qty: { gt: 0 } }, select: { cellId: true } }),
    prisma.itemUnit.findMany({ where: { cellId: { in: ids } }, select: { cellId: true } }),
  ]);
  const busy = new Set<string>([...busyBal.map((b) => b.cellId!), ...busyUnit.map((u) => u.cellId!)]);
  let empty = cells.filter((c) => !busy.has(c.id));
  if (kind === "STORAGE") empty = empty.filter((c) => c.level != null); // для STORAGE нужен уровень
  empty.sort((a, b) => {
    if (kind === "STORAGE") {
      const dl = (a.level ?? 0) - (b.level ?? 0);
      if (dl !== 0) return dl;
    }
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });
  return empty.map((c, i) => ({ id: c.id, code: c.code, level: c.level, recommended: i === 0 }));
}
