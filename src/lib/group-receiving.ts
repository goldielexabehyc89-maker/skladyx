import "server-only";
import { Prisma, type HandlingGroupStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { applyLotMovement } from "@/lib/stock";
import { lockCell } from "@/lib/cells";
import { nextNumber } from "@/lib/counters";
import { getSettings } from "@/lib/settings";
import { fmtDateTime } from "@/lib/format";
import { coolingWorkflowEnabled } from "@/lib/roles";
import { logEvent } from "@/lib/events";
import { parseScannedCode } from "@/lib/qr";
import { eanItemIdInTx } from "@/lib/barcodes";
import { startCoolingInTx } from "@/lib/cooling";
import {
  lockCompany,
  createWorkflowTaskInTx,
  emitTaskCreated,
  emitTaskCompleted,
  completeWorkflowTaskInTransaction,
  rebalanceQueuedTasks,
  type TaskCreateResult,
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

// минимальный уровень среди СВОБОДНЫХ активных STORAGE-ячеек склада (пустых и не зарезервированных
// под охлаждение), или null. Пакет 5: активная бронь исключает ячейку из «есть свободная ниже».
async function lowestEmptyStorageLevel(tx: Tx, companyId: string, warehouseId: string): Promise<number | null> {
  const cells = await tx.cell.findMany({
    where: { companyId, warehouseId, isActive: true, level: { not: null }, zone: { kind: "STORAGE" } },
    select: { id: true, level: true },
  });
  if (cells.length === 0) return null;
  const ids = cells.map((c) => c.id);
  const [busyBal, busyUnit, reserved] = await Promise.all([
    tx.stockBalance.findMany({ where: { cellId: { in: ids }, qty: { gt: 0 } }, select: { cellId: true } }),
    tx.itemUnit.findMany({ where: { cellId: { in: ids } }, select: { cellId: true } }),
    tx.cellReservation.findMany({ where: { cellId: { in: ids }, status: "ACTIVE" }, select: { cellId: true } }),
  ]);
  const busy = new Set<string>([...busyBal.map((b) => b.cellId!), ...busyUnit.map((u) => u.cellId!), ...reserved.map((r) => r.cellId)]);
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
      return { groupId: existing.id, created: false, status: existing.status, qrCode: null, taskId: null, taskRes: null, itemName: null as string | null };

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
    // Пакет 9B: новые группы БЕЗ собственного GROUP QR и этикетки паллеты. Товар определяется EAN,
    // конкретная группа — задачей/резервом. Старые GROUP QR не удаляем, но новые не создаём.
    const qrCode: string | null = null;

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

    return { groupId: group.id, created: true, status, qrCode, taskId: taskRes.task.id, taskRes, itemName: item.name as string | null };
  });

  // события — после коммита (без push, только Event + realtime). Идемпотентно:
  // при повторной приёмке с тем же dedupeKey created=false → второй Event не пишем,
  // время первого не меняется. Стабильный ключ гарантирует единственность записи.
  if (out.created) {
    if (out.taskRes) await emitTaskCreated(out.taskRes);
    const route = out.status === "AWAITING_COOLING" ? "охлаждение" : "хранение";
    await logEvent({
      companyId: input.companyId,
      type: "group_received",
      key: `group_received:${out.groupId}`,
      title: "Приёмка группы",
      body: `${out.itemName ?? "товар"} · ${input.qty} шт · ${input.temperature}°C · маршрут: ${route}`,
      url: "/warehouse/tasks",
      warehouseIds: [input.warehouseId],
      actorId: input.acceptedById,
    });
  }
  return { groupId: out.groupId, created: out.created, status: out.status, qrCode: out.qrCode, taskId: out.taskId };
}

// ── Завершение размещения погрузчиком (атомарно) ──
export async function completeGroupPlacement(input: {
  companyId: string;
  userId: string;
  taskId: string;
  cellCode: string; // Пакет 9B: отсканированный QR/Code128 целевой ячейки — сервер сам резолвит и проверяет
  ean: string;
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
    // Пакет 9B: подтверждение EAN — задача однозначно определяет группу, отсканированный товар обязан
    // совпасть с товаром группы. Неизвестный/неактивный/чужой EAN или не тот товар — отказ.
    const scannedItemId = await eanItemIdInTx(tx, input.companyId, input.ean);
    if (!scannedItemId) throw new GroupError("Неизвестный, неактивный или чужой EAN — размещение отклонено");
    if (scannedItemId !== group.itemId) throw new GroupError("Отсканирован не тот товар (EAN не совпадает с группой)");
    if (group.status !== "AWAITING_STORAGE" && group.status !== "AWAITING_COOLING")
      throw new GroupError("Группа уже размещена");
    const targetKind = group.status === "AWAITING_STORAGE" ? "STORAGE" : "COOLING";

    // Пакет 9B: целевую ячейку определяем ТОЛЬКО по отсканированному коду (QR/Code128), а не по
    // присланному id — сервер резолвит код в ячейку и проверяет её принадлежность складу/зоне.
    const scannedCellCode = parseScannedCode(input.cellCode);
    if (!scannedCellCode) throw new GroupError("Неверный код ячейки");
    const cellQr = await tx.qrCode.findUnique({ where: { code: scannedCellCode } });
    if (!cellQr || cellQr.companyId !== input.companyId || cellQr.type !== "CELL")
      throw new GroupError("Это не код ячейки этой организации");
    // целевая ячейка: та же компания+склад, активная, физическая нужного kind
    const cell = await tx.cell.findFirst({
      where: { id: cellQr.refId, companyId: input.companyId, warehouseId: group.warehouseId },
      include: { zone: true },
    });
    if (!cell) throw new GroupError("Ячейка не найдена на этом складе");
    if (!cell.isActive) throw new GroupError("Ячейка отключена");
    if (!cell.zone || cell.zone.kind !== targetKind)
      throw new GroupError(targetKind === "STORAGE" ? "Нужна ячейка зоны хранения" : "Нужна ячейка зоны охлаждения");

    // пустая (одна ячейка — одна группа). Берём per-cell advisory-lock ДО проверки занятости —
    // тем же ключом, что и старые операции (assertCellNotHeldByGroup), — чтобы исключить гонку.
    await lockCell(tx, input.companyId, cell.id);
    if (await cellIsBusy(tx, cell.id)) throw new GroupError("Ячейка занята — выберите пустую");

    // Пакет 5: группа > X при включённом флаге охлаждения — стартуем сессию охлаждения
    // (перенос RECEIVING→COOLING, резерв ур.3+, срочная отложенная задача забора), а не просто IN_COOLING.
    if (targetKind === "COOLING" && coolingWorkflowEnabled()) {
      const { taskRes } = await startCoolingInTx(tx, {
        companyId: input.companyId,
        group,
        coolingCellId: cell.id,
        userId: input.userId,
      });
      const unblocked = await completeWorkflowTaskInTransaction(tx, task.id);
      return { companyId: input.companyId, warehouseId: group.warehouseId, title: task.title, taskId: task.id, unblocked, coolingTaskRes: taskRes as TaskCreateResult | null, groupId: group.id, cellCode: cell.code, targetKind };
    }

    // STORAGE: нижний доступный уровень + ячейка не должна быть зарезервирована под охлаждение.
    if (targetKind === "STORAGE") {
      if (cell.level == null) throw new GroupError("У ячейки хранения не настроен уровень");
      const reserved = await tx.cellReservation.findFirst({ where: { cellId: cell.id, status: "ACTIVE" }, select: { id: true } });
      if (reserved) throw new GroupError("Ячейка зарезервирована под охлаждение — выберите другую");
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
    return { companyId: input.companyId, warehouseId: group.warehouseId, title: task.title, taskId: task.id, unblocked, coolingTaskRes: null as TaskCreateResult | null, groupId: group.id, cellCode: cell.code, targetKind };
  });

  // события после коммита + перераспределение очереди (без push). Размещение единично:
  // повторный вызов на завершённой задаче/размещённой группе бросает исключение выше, сюда не
  // доходит; стабильный ключ group_placed:<groupId> гарантирует единственность записи в Ленте.
  await emitTaskCompleted(res);
  if (res.coolingTaskRes) await emitTaskCreated(res.coolingTaskRes);
  await logEvent({
    companyId: res.companyId,
    type: "group_placed",
    key: `group_placed:${res.groupId}`,
    title: "Размещение",
    body: `Группа размещена в ячейку ${res.cellCode}${res.targetKind === "COOLING" ? " (охлаждение)" : ""}`,
    url: "/warehouse/tasks",
    warehouseIds: [res.warehouseId],
    actorId: input.userId,
  });
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
  const [busyBal, busyUnit, reserved] = await Promise.all([
    prisma.stockBalance.findMany({ where: { cellId: { in: ids }, qty: { gt: 0 } }, select: { cellId: true } }),
    prisma.itemUnit.findMany({ where: { cellId: { in: ids } }, select: { cellId: true } }),
    prisma.cellReservation.findMany({ where: { cellId: { in: ids }, status: "ACTIVE" }, select: { cellId: true } }),
  ]);
  // Пакет 5: зарезервированные под охлаждение ячейки не предлагаем для прямого размещения.
  const busy = new Set<string>([...busyBal.map((b) => b.cellId!), ...busyUnit.map((u) => u.cellId!), ...reserved.map((r) => r.cellId)]);
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
