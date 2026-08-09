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

// Пакет 11 (коррекция): выбор ОДНОЙ конкретной целевой ячейки для размещения (в транзакции).
// STORAGE — активная пустая ячейка минимального доступного уровня, затем code ASC; COOLING — активная
// пустая COOLING-ячейка, code ASC. Исключаются: остаток qty>0, поштучные единицы, любые активные брони.
async function pickPlacementCellInTx(
  tx: Tx,
  companyId: string,
  warehouseId: string,
  kind: "STORAGE" | "COOLING",
): Promise<{ id: string; code: string } | null> {
  const cells = await tx.cell.findMany({
    where: { companyId, warehouseId, isActive: true, zone: { kind }, ...(kind === "STORAGE" ? { level: { not: null } } : {}) },
    select: { id: true, code: true, level: true },
  });
  if (cells.length === 0) return null;
  const ids = cells.map((c) => c.id);
  const [bal, unit, reserved] = await Promise.all([
    tx.stockBalance.findMany({ where: { cellId: { in: ids }, qty: { gt: 0 } }, select: { cellId: true } }),
    tx.itemUnit.findMany({ where: { cellId: { in: ids } }, select: { cellId: true } }),
    tx.cellReservation.findMany({ where: { cellId: { in: ids }, status: "ACTIVE" }, select: { cellId: true } }),
  ]);
  const busy = new Set<string>([...bal.map((b) => b.cellId!), ...unit.map((u) => u.cellId!), ...reserved.map((r) => r.cellId)]);
  const free = cells.filter((c) => !busy.has(c.id));
  if (free.length === 0) return null;
  free.sort((a, b) => {
    if (kind === "STORAGE") {
      const dl = (a.level ?? 0) - (b.level ?? 0);
      if (dl !== 0) return dl;
    }
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });
  return { id: free[0].id, code: free[0].code };
}

// Пакет 11 (коррекция): назначение целевой ячейки при ОТКРЫТИИ размещения (а не при приёмке — так
// ячейка не занята бронью, пока задача в очереди). Идемпотентно: повторный вызов возвращает ту же
// назначенную ячейку без второй брони (по taskId). Выбор и бронь — атомарно под lockCompany + lockCell.
export async function prepareGroupPlacement(input: {
  companyId: string;
  userId: string;
  taskId: string;
}): Promise<{ cellId: string; cellCode: string }> {
  return prisma.$transaction(async (tx) => {
    await lockCompany(tx, input.companyId);
    const task = await tx.workflowTask.findFirst({ where: { id: input.taskId, companyId: input.companyId } });
    if (!task) throw new GroupError("Задача не найдена");
    if (task.type !== "PLACE_GROUP") throw new GroupError("Это не задача размещения группы");
    if (task.assignedUserId !== input.userId || task.status !== "IN_PROGRESS")
      throw new GroupError("Назначить ячейку может только назначенный исполнитель с задачей «в работе»");
    const group = await tx.handlingGroup.findFirst({ where: { id: task.subjectId ?? "", companyId: input.companyId } });
    if (!group) throw new GroupError("Группа не найдена");
    if (group.status !== "AWAITING_STORAGE" && group.status !== "AWAITING_COOLING")
      throw new GroupError("Группа уже размещена");
    const kind = group.status === "AWAITING_STORAGE" ? "STORAGE" : "COOLING";

    // идемпотентность: активная бронь по этой задаче уже есть → возвращаем ту же ячейку
    const existing = await tx.cellReservation.findFirst({ where: { taskId: task.id, status: "ACTIVE" } });
    if (existing) {
      const c = await tx.cell.findFirst({ where: { id: existing.cellId, companyId: input.companyId }, select: { code: true } });
      return { cellId: existing.cellId, cellCode: c?.code ?? "" };
    }

    const picked = await pickPlacementCellInTx(tx, input.companyId, group.warehouseId, kind);
    if (!picked)
      throw new GroupError(kind === "STORAGE" ? "Нет свободной ячейки хранения для размещения" : "Нет свободной ячейки охлаждения для размещения");
    await lockCell(tx, input.companyId, picked.id);
    // повторная проверка под локом: ячейка свободна и не забронирована
    if (await cellIsBusy(tx, picked.id)) throw new GroupError("Выбранная ячейка только что занята — повторите");
    const taken = await tx.cellReservation.findFirst({ where: { cellId: picked.id, status: "ACTIVE" }, select: { id: true } });
    if (taken) throw new GroupError("Выбранная ячейка только что забронирована — повторите");
    await tx.cellReservation.create({
      data: { companyId: input.companyId, warehouseId: group.warehouseId, cellId: picked.id, handlingGroupId: group.id, taskId: task.id, status: "ACTIVE" },
    });
    return { cellId: picked.id, cellCode: picked.code };
  });
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

    // Пакет 11 (коррекция): целевую ячейку НЕ выбирает погрузчик — она назначена заранее
    // (prepareGroupPlacement) и держится активной бронью по ЭТОЙ задаче. Отсканированный код обязан
    // совпасть с назначенной ячейкой; любая другая (даже свободная и подходящая) — отклоняется.
    const reservation = await tx.cellReservation.findFirst({ where: { taskId: task.id, status: "ACTIVE" } });
    if (!reservation) throw new GroupError("Ячейка не назначена — откройте размещение заново");
    const scannedCode = parseScannedCode(input.cellCode);
    if (!scannedCode) throw new GroupError("Неверный код ячейки");
    const cellQr = await tx.qrCode.findUnique({ where: { code: scannedCode } });
    if (!cellQr || cellQr.companyId !== input.companyId || cellQr.type !== "CELL")
      throw new GroupError("Это не код ячейки этой организации");
    if (cellQr.refId !== reservation.cellId) throw new GroupError("Отсканирована не назначенная ячейка");

    const cell = await tx.cell.findFirst({
      where: { id: reservation.cellId, companyId: input.companyId, warehouseId: group.warehouseId },
      include: { zone: true },
    });
    if (!cell) throw new GroupError("Назначенная ячейка не найдена");
    if (!cell.isActive) throw new GroupError("Назначенная ячейка отключена");
    if (!cell.zone || cell.zone.kind !== targetKind)
      throw new GroupError(targetKind === "STORAGE" ? "Назначенная ячейка не в зоне хранения" : "Назначенная ячейка не в зоне охлаждения");

    // повторная проверка занятости под локом (бронь держит ячейку, но подстрахуемся от гонок)
    await lockCell(tx, input.companyId, cell.id);
    if (await cellIsBusy(tx, cell.id)) throw new GroupError("Назначенная ячейка занята — размещение отменено");

    // Пакет 5: группа > X при включённом флаге охлаждения — стартуем сессию охлаждения
    // (перенос RECEIVING→COOLING, верхний резерв ур.3+, срочная задача забора).
    if (targetKind === "COOLING" && coolingWorkflowEnabled()) {
      const { taskRes } = await startCoolingInTx(tx, { companyId: input.companyId, group, coolingCellId: cell.id, userId: input.userId });
      // освобождаем бронь ПЕРВИЧНОГО размещения (по задаче); верхний резерв CoolingSession — отдельная
      // бронь (sessionId, без handlingGroupId), её не трогаем.
      await tx.cellReservation.update({ where: { id: reservation.id }, data: { status: "RELEASED", releasedAt: new Date() } });
      const unblocked = await completeWorkflowTaskInTransaction(tx, task.id);
      return { companyId: input.companyId, warehouseId: group.warehouseId, title: task.title, taskId: task.id, unblocked, coolingTaskRes: taskRes as TaskCreateResult | null, groupId: group.id, cellCode: cell.code, targetKind };
    }

    // Прямое размещение (STORAGE, либо COOLING при выключенном флаге охлаждения — простой IN_COOLING
    // без сессии): полный перенос остатка группы RECEIVING → назначенную ячейку (через ядро).
    const receiving = await tx.warehouseZone.findFirst({ where: { companyId: input.companyId, warehouseId: group.warehouseId, kind: "RECEIVING" } });
    if (!receiving) throw new GroupError("На складе нет системной зоны приёмки");
    const recvBal = await tx.stockBalance.findFirst({ where: { lotId: group.lotId, locKey: `Z:${receiving.id}`, qty: { gt: 0 } } });
    if (!recvBal) throw new GroupError("Остаток группы в зоне приёмки не найден");
    // Группа неделима: остаток в RECEIVING должен ТОЧНО равняться количеству группы.
    if (!recvBal.qty.equals(group.qty))
      throw new GroupError("Остаток группы в зоне приёмки не совпадает с её количеством — размещение отменено");

    await applyLotMovement(tx, {
      companyId: input.companyId, docType: "TRANSFER", docId: group.id, itemId: group.itemId, lotId: group.lotId, qty: group.qty,
      from: { kind: "zone", warehouseId: group.warehouseId, zoneId: receiving.id },
      to: { kind: "cell", warehouseId: group.warehouseId, cellId: cell.id },
      createdById: input.userId,
    });
    await tx.handlingGroup.update({ where: { id: group.id }, data: { status: targetKind === "STORAGE" ? "IN_STORAGE" : "IN_COOLING" } });
    await tx.cellReservation.update({ where: { id: reservation.id }, data: { status: "RELEASED", releasedAt: new Date() } });
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

