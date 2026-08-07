import "server-only";
import { Prisma, type HandlingGroup } from "@prisma/client";
import { prisma } from "@/lib/db";
import { applyLotMovement } from "@/lib/stock";
import { lockCell } from "@/lib/cells";
import { parseScannedCode } from "@/lib/qr";
import { eanItemIdInTx } from "@/lib/barcodes";
import { isCoolingFallbackLevel } from "@/lib/placement";
import { fmtDateTime } from "@/lib/format";
import { TASK_TYPES } from "@/lib/workflow-task-types";
import {
  lockCompany,
  createWorkflowTaskInTx,
  emitTaskCreated,
  emitTaskCompleted,
  completeWorkflowTaskInTransaction,
  rebalanceQueuedTasks,
  type TaskCreateResult,
} from "@/lib/workflow-tasks";
import { logEvent } from "@/lib/events";

// Этап 5/Пакет 5: охлаждение и срочный забор. Все движения остатка — через src/lib/stock.ts.
// Резерв ячейки (CellReservation) остаток НЕ двигает. Снимки X/R хранятся в CoolingSession.
// Формула срока: estimatedReadyAt = startedAt + (temp - X)/R часов (R>0 гарантирован).

export class CoolingError extends Error {}
type Tx = Prisma.TransactionClient;

export function estimateReadyAt(from: Date, temp: number, X: number, R: number): Date {
  const hours = Math.max(0, (temp - X) / R);
  return new Date(from.getTime() + hours * 3_600_000);
}

// Два advisory-лока по ячейкам — в детерминированном порядке (по возрастанию id) против дедлоков.
async function lockTwoCells(tx: Tx, companyId: string, a: string, b: string): Promise<void> {
  const [x, y] = a <= b ? [a, b] : [b, a];
  await lockCell(tx, companyId, x);
  if (y !== x) await lockCell(tx, companyId, y);
}

// Свободная активная STORAGE-ячейка уровня 3+, не занятая и не зарезервированная; min level → code.
async function pickReservableStorageCell(
  tx: Tx,
  companyId: string,
  warehouseId: string,
): Promise<{ id: string; level: number } | null> {
  const cells = await tx.cell.findMany({
    where: { companyId, warehouseId, isActive: true, level: { gte: 3 }, zone: { kind: "STORAGE" } },
    select: { id: true, level: true, code: true },
    orderBy: [{ level: "asc" }, { code: "asc" }],
  });
  for (const c of cells) {
    if (c.level == null || !isCoolingFallbackLevel(c.level)) continue;
    const [bal, unit, res] = await Promise.all([
      tx.stockBalance.findFirst({ where: { cellId: c.id, qty: { gt: 0 } }, select: { id: true } }),
      tx.itemUnit.findFirst({ where: { cellId: c.id }, select: { id: true } }),
      tx.cellReservation.findFirst({ where: { cellId: c.id, status: "ACTIVE" }, select: { id: true } }),
    ]);
    if (!bal && !unit && !res) return { id: c.id, level: c.level };
  }
  return null;
}

// Вывоз после охлаждения: приоритет нижних уровней (1 → 2), затем верхний резерв (ур. 3+).
// Внутри уровня — code ASC. Каждую кандидат-ячейку блокируем и перепроверяем (пусто + не
// зарезервирована); занятую конкурентно пропускаем. Верхний резерв — гарантированный fallback
// (он держится за эту сессию, старые операции/размещения в него не кладут).
async function pickRetrievalCell(tx: Tx, companyId: string, warehouseId: string, reservedCellId: string): Promise<string> {
  for (const lvl of [1, 2]) {
    const cands = await tx.cell.findMany({
      where: { companyId, warehouseId, isActive: true, level: lvl, zone: { kind: "STORAGE" } },
      select: { id: true },
      orderBy: { code: "asc" },
    });
    for (const c of cands) {
      await lockCell(tx, companyId, c.id);
      const [bal, unit, res] = await Promise.all([
        tx.stockBalance.findFirst({ where: { cellId: c.id, qty: { gt: 0 } }, select: { id: true } }),
        tx.itemUnit.findFirst({ where: { cellId: c.id }, select: { id: true } }),
        tx.cellReservation.findFirst({ where: { cellId: c.id, status: "ACTIVE" }, select: { id: true } }),
      ]);
      if (!bal && !unit && !res) return c.id;
    }
  }
  await lockCell(tx, companyId, reservedCellId); // верхний резерв — гарантированный fallback
  return reservedCellId;
}

// Старт охлаждения ВНУТРИ транзакции размещения группы в COOLING-ячейку. Требует R>0 и свободный
// резерв уровня 3+, иначе бросает CoolingError (без частичных изменений — вся tx откатится).
// Делает: перенос группы RECEIVING→COOLING (ядро), IN_COOLING, CoolingSession(снимки X/R),
// CellReservation(ACTIVE) на резерв, отложенную срочную задачу RETRIEVE_COOLING (availableAt=срок).
export async function startCoolingInTx(
  tx: Tx,
  input: { companyId: string; group: HandlingGroup; coolingCellId: string; userId: string },
): Promise<{ taskRes: TaskCreateResult; sessionId: string }> {
  const { companyId, group, coolingCellId, userId } = input;
  const warehouseId = group.warehouseId;

  const wh = await tx.warehouse.findFirst({ where: { id: warehouseId, companyId }, select: { coolingRate: true } });
  const R = wh?.coolingRate ? wh.coolingRate.toNumber() : 0;
  if (!(R > 0))
    throw new CoolingError("Для склада не задана скорость охлаждения R (°C/час). Обратитесь к администратору.");

  const receiving = await tx.warehouseZone.findFirst({ where: { companyId, warehouseId, kind: "RECEIVING" } });
  if (!receiving) throw new CoolingError("На складе нет системной зоны приёмки");

  // резерв: свободная STORAGE-ячейка уровня 3+
  const reserved = await pickReservableStorageCell(tx, companyId, warehouseId);
  if (!reserved)
    throw new CoolingError("Нет свободной ячейки хранения уровня 3+ для резерва — охлаждение невозможно");

  // локи: COOLING-ячейка + резерв (детерминированный порядок), затем повторная проверка резерва
  await lockTwoCells(tx, companyId, coolingCellId, reserved.id);
  const resTaken = await tx.cellReservation.findFirst({ where: { cellId: reserved.id, status: "ACTIVE" }, select: { id: true } });
  const resStock = await tx.stockBalance.findFirst({ where: { cellId: reserved.id, qty: { gt: 0 } }, select: { id: true } });
  if (resTaken || resStock) throw new CoolingError("Резервная ячейка только что занята — повторите операцию");

  // перенос всей неделимой группы RECEIVING → COOLING-ячейку (через ядро)
  const recvBal = await tx.stockBalance.findFirst({ where: { lotId: group.lotId, locKey: `Z:${receiving.id}`, qty: { gt: 0 } } });
  if (!recvBal) throw new CoolingError("Остаток группы в зоне приёмки не найден");
  if (!recvBal.qty.equals(group.qty))
    throw new CoolingError("Остаток группы в зоне приёмки не совпадает с её количеством — охлаждение отменено");
  await applyLotMovement(tx, {
    companyId, docType: "TRANSFER", docId: group.id, itemId: group.itemId, lotId: group.lotId, qty: group.qty,
    from: { kind: "zone", warehouseId, zoneId: receiving.id },
    to: { kind: "cell", warehouseId, cellId: coolingCellId },
    createdById: userId,
  });
  await tx.handlingGroup.update({ where: { id: group.id }, data: { status: "IN_COOLING" } });

  // сессия (снимки X из группы, R из склада)
  const X = group.thresholdX.toNumber();
  const startTemp = group.temperature.toNumber();
  const startedAt = new Date();
  const estimatedReadyAt = estimateReadyAt(startedAt, startTemp, X, R);
  const session = await tx.coolingSession.create({
    data: { companyId, warehouseId, handlingGroupId: group.id, coolingCellId, startTemp, thresholdX: X, coolingRate: R, startedAt, estimatedReadyAt, status: "ACTIVE" },
  });
  await tx.cellReservation.create({ data: { companyId, warehouseId, cellId: reserved.id, sessionId: session.id, status: "ACTIVE" } });

  const item = await tx.item.findFirst({ where: { id: group.itemId, companyId }, select: { name: true } });
  const name = item?.name ?? "группа";
  const taskRes = await createWorkflowTaskInTx(tx, {
    companyId, warehouseId, type: TASK_TYPES.RETRIEVE_COOLING, requiredRole: "LOADER", priority: "URGENT",
    title: `Забрать из охлаждения: ${name}`,
    description: `${name} · старт ${startTemp}°C → X=${X}°C · готово ~${fmtDateTime(estimatedReadyAt)}`,
    subjectType: "CoolingSession", subjectId: session.id,
    dedupeKey: `cooling:${session.id}:retrieve:1`,
    availableAt: estimatedReadyAt,
  });
  return { taskRes, sessionId: session.id };
}

// Пакет 9B: резолвинг QR/Code128 ячейки → cellId (по внутреннему коду), scoped компанией+складом.
async function resolveCoolingCell(tx: Tx, companyId: string, warehouseId: string, raw: string): Promise<string> {
  const code = parseScannedCode(raw);
  if (!code) throw new CoolingError("Неверный код ячейки");
  const qr = await tx.qrCode.findUnique({ where: { code } });
  if (!qr || qr.companyId !== companyId || qr.type !== "CELL") throw new CoolingError("Это не код ячейки этой организации");
  const cell = await tx.cell.findFirst({ where: { id: qr.refId, companyId, warehouseId }, select: { id: true } });
  if (!cell) throw new CoolingError("Ячейка не найдена на этом складе");
  return cell.id;
}

// последнее измерение сессии
async function lastMeasurement(tx: Tx, sessionId: string) {
  return tx.temperatureMeasurement.findFirst({ where: { sessionId }, orderBy: { measuredAt: "desc" } });
}

// ── Пакет 9B, Фаза 1 — замер и подготовка. Погрузчик сканирует исходную COOLING-ячейку, EAN и вводит
// температуру. temp > X: замер + следующая отложенная задача, группа не двигается, резерв сохранён.
// temp <= X: выбор цели (ур.1→2→резерв 3+), перевод активной CellReservation на выбранную ячейку и
// возврат её кода (движения/завершения нет). Повтор при уже подготовленном вывозе возвращает ту же
// цель без второго замера и новой брони. ──
export async function prepareCoolingRetrieval(input: {
  companyId: string; userId: string; taskId: string; fromCellCode: string; ean: string; temperature: number;
}): Promise<{ warehouseId: string; ready: boolean; targetCellCode: string | null }> {
  const out = await prisma.$transaction(async (tx) => {
    await lockCompany(tx, input.companyId);
    const task = await tx.workflowTask.findFirst({ where: { id: input.taskId, companyId: input.companyId } });
    if (!task) throw new CoolingError("Задача не найдена");
    if (task.type !== TASK_TYPES.RETRIEVE_COOLING) throw new CoolingError("Это не задача забора из охлаждения");
    if (task.assignedUserId !== input.userId || task.status !== "IN_PROGRESS")
      throw new CoolingError("Только назначенный исполнитель с задачей «в работе»");
    const session = await tx.coolingSession.findFirst({ where: { id: task.subjectId ?? "", companyId: input.companyId } });
    if (!session || session.status !== "ACTIVE") throw new CoolingError("Сессия охлаждения не найдена или уже завершена");
    const group = await tx.handlingGroup.findFirst({ where: { id: session.handlingGroupId, companyId: input.companyId } });
    if (!group) throw new CoolingError("Группа не найдена");
    const X = session.thresholdX.toNumber();
    const reservation = await tx.cellReservation.findFirst({ where: { sessionId: session.id, status: "ACTIVE" } });

    // Пакет 9B-fix: исходную COOLING-ячейку и EAN подтверждаем ВСЕГДА — до любого (в т.ч. идемпотентного) возврата,
    // иначе посторонним кодом можно получить успешный ответ после подготовки.
    const fromCellId = await resolveCoolingCell(tx, input.companyId, group.warehouseId, input.fromCellCode);
    if (fromCellId !== session.coolingCellId) throw new CoolingError("Отсканирована не та ячейка охлаждения");
    const scannedItemId = await eanItemIdInTx(tx, input.companyId, input.ean);
    if (!scannedItemId) throw new CoolingError("Неизвестный, неактивный или чужой EAN — операция отклонена");
    if (scannedItemId !== group.itemId) throw new CoolingError("Отсканирован не тот товар (EAN не совпадает с группой)");

    // идемпотентность: уже подготовлено к вывозу (последнее измерение <= X) — вернуть ту же цель без нового замера
    const last = await lastMeasurement(tx, session.id);
    if (last && last.temperature.toNumber() <= X) {
      if (!reservation) throw new CoolingError("Резерв целевой ячейки не найден");
      const cell = await tx.cell.findFirst({ where: { id: reservation.cellId }, select: { code: true } });
      return { warehouseId: group.warehouseId, ready: true, targetCellCode: cell?.code ?? null, nextTaskRes: null as TaskCreateResult | null };
    }

    // новый замер
    if (!Number.isFinite(input.temperature) || input.temperature < -100 || input.temperature > 100)
      throw new CoolingError("Некорректная температура");
    if (!reservation) throw new CoolingError("Активный резерв ячейки не найден");

    await tx.temperatureMeasurement.create({ data: { companyId: input.companyId, sessionId: session.id, temperature: input.temperature, byUserId: input.userId } });
    const R = session.coolingRate.toNumber();
    const now = new Date();

    if (input.temperature > X) {
      const nextReady = estimateReadyAt(now, input.temperature, X, R);
      await tx.coolingSession.update({ where: { id: session.id }, data: { estimatedReadyAt: nextReady } });
      await completeWorkflowTaskInTransaction(tx, task.id);
      const cycle = await tx.temperatureMeasurement.count({ where: { sessionId: session.id } });
      const next = await createWorkflowTaskInTx(tx, {
        companyId: input.companyId, warehouseId: group.warehouseId, type: TASK_TYPES.RETRIEVE_COOLING,
        requiredRole: "LOADER", priority: "URGENT", title: task.title,
        description: `Повторный замер ${input.temperature}°C → X=${X}°C · готово ~${fmtDateTime(nextReady)}`,
        subjectType: "CoolingSession", subjectId: session.id,
        dedupeKey: `cooling:${session.id}:retrieve:${cycle + 1}`, availableAt: nextReady,
      });
      return { warehouseId: group.warehouseId, ready: false, targetCellCode: null, nextTaskRes: next };
    }

    // temp <= X — выбрать цель (ур.1→2→резерв 3+), перевести активную бронь на выбранную ячейку
    await lockCell(tx, input.companyId, session.coolingCellId);
    const destCellId = await pickRetrievalCell(tx, input.companyId, group.warehouseId, reservation.cellId);
    if (destCellId !== reservation.cellId) {
      // перепроверка свободности новой цели под локом (pickRetrievalCell уже взял lockCell на кандидатов)
      const [dbal, dunit] = await Promise.all([
        tx.stockBalance.findFirst({ where: { cellId: destCellId, qty: { gt: 0 } }, select: { id: true } }),
        tx.itemUnit.findFirst({ where: { cellId: destCellId }, select: { id: true } }),
      ]);
      if (dbal || dunit) throw new CoolingError("Выбранная ячейка занята — повторите");
      await tx.cellReservation.update({ where: { id: reservation.id }, data: { cellId: destCellId } });
    }
    const cell = await tx.cell.findFirst({ where: { id: destCellId }, select: { code: true } });
    return { warehouseId: group.warehouseId, ready: true, targetCellCode: cell?.code ?? null, nextTaskRes: null as TaskCreateResult | null };
  });
  if (out.nextTaskRes) {
    await emitTaskCompleted({ companyId: input.companyId, warehouseId: out.warehouseId, title: "Замер охлаждения", taskId: input.taskId, unblocked: [] });
    await emitTaskCreated(out.nextTaskRes);
    await rebalanceQueuedTasks(input.companyId, { warehouseId: out.warehouseId });
  }
  return { warehouseId: out.warehouseId, ready: out.ready, targetCellCode: out.targetCellCode };
}

// ── Пакет 9B, Фаза 2 — физическое размещение. UI показывает назначенную целевую ячейку; погрузчик
// сканирует её QR/Code128. Сервер сверяет задачу, готовность (последнее измерение <= X), исходную
// ячейку+EAN, совпадение цели с активной бронью сессии, свободность цели и точный неделимый остаток;
// затем движение через ядро, IN_STORAGE, COMPLETED, бронь RELEASED. Повтор — без второго движения. ──
export async function placeCoolingRetrieval(input: {
  companyId: string; userId: string; taskId: string; fromCellCode: string; ean: string; targetCellCode: string;
}): Promise<{ warehouseId: string; placed: boolean; alreadyPlaced: boolean }> {
  const res = await prisma.$transaction(async (tx) => {
    await lockCompany(tx, input.companyId);
    const task = await tx.workflowTask.findFirst({ where: { id: input.taskId, companyId: input.companyId } });
    if (!task) throw new CoolingError("Задача не найдена");
    if (task.type !== TASK_TYPES.RETRIEVE_COOLING) throw new CoolingError("Это не задача забора из охлаждения");
    if (task.assignedUserId !== input.userId) throw new CoolingError("Это не ваша задача");
    const session = await tx.coolingSession.findFirst({ where: { id: task.subjectId ?? "", companyId: input.companyId } });
    if (!session) throw new CoolingError("Сессия охлаждения не найдена");
    const group = await tx.handlingGroup.findFirst({ where: { id: session.handlingGroupId, companyId: input.companyId } });
    if (!group) throw new CoolingError("Группа не найдена");

    // Пакет 9B-fix: исходную ячейку, EAN и назначенную целевую ячейку сверяем ВСЕГДА — включая повтор после
    // COMPLETED (тогда бронь уже RELEASED, но cellId цели сохранён), иначе посторонним кодом можно получить успех.
    const fromCellId = await resolveCoolingCell(tx, input.companyId, group.warehouseId, input.fromCellCode);
    if (fromCellId !== session.coolingCellId) throw new CoolingError("Отсканирована не та ячейка охлаждения");
    const scannedItemId = await eanItemIdInTx(tx, input.companyId, input.ean);
    if (!scannedItemId || scannedItemId !== group.itemId) throw new CoolingError("Отсканирован не тот товар (EAN не совпадает с группой)");
    const reservation = await tx.cellReservation.findFirst({ where: { sessionId: session.id } });
    if (!reservation) throw new CoolingError("Резерв целевой ячейки не найден");
    const destCellId = await resolveCoolingCell(tx, input.companyId, group.warehouseId, input.targetCellCode);
    if (destCellId !== reservation.cellId) throw new CoolingError("Отсканирована не та целевая ячейка (не совпадает с назначенной)");

    // идемпотентность: уже размещено (после полной сверки кодов) — точный повтор успешен без нового движения
    if (session.status === "COMPLETED" || group.status === "IN_STORAGE")
      return { companyId: input.companyId, warehouseId: group.warehouseId, title: task.title, taskId: task.id, unblocked: [] as { id: string; title: string; warehouseId: string }[], alreadyPlaced: true, groupId: group.id, cellCode: "" };
    if (task.status !== "IN_PROGRESS") throw new CoolingError("Задача не в работе");
    if (reservation.status !== "ACTIVE") throw new CoolingError("Активный резерв целевой ячейки не найден");
    const last = await lastMeasurement(tx, session.id);
    if (!last || last.temperature.toNumber() > session.thresholdX.toNumber())
      throw new CoolingError("Сначала выполните замер (Фаза 1): группа ещё не готова к вывозу");

    await lockCell(tx, input.companyId, session.coolingCellId);
    await lockCell(tx, input.companyId, destCellId);
    const [dbal, dunit] = await Promise.all([
      tx.stockBalance.findFirst({ where: { cellId: destCellId, qty: { gt: 0 } }, select: { id: true } }),
      tx.itemUnit.findFirst({ where: { cellId: destCellId }, select: { id: true } }),
    ]);
    if (dbal || dunit) throw new CoolingError("Целевая ячейка занята — размещение отменено");
    const coolBal = await tx.stockBalance.findFirst({ where: { lotId: group.lotId, locKey: `C:${session.coolingCellId}`, qty: { gt: 0 } } });
    if (!coolBal || !coolBal.qty.equals(group.qty))
      throw new CoolingError("Остаток группы в ячейке охлаждения не совпадает — размещение отменено");
    await applyLotMovement(tx, {
      companyId: input.companyId, docType: "TRANSFER", docId: group.id, itemId: group.itemId, lotId: group.lotId, qty: group.qty,
      from: { kind: "cell", warehouseId: group.warehouseId, cellId: session.coolingCellId },
      to: { kind: "cell", warehouseId: group.warehouseId, cellId: destCellId },
      createdById: input.userId,
    });
    await tx.handlingGroup.update({ where: { id: group.id }, data: { status: "IN_STORAGE" } });
    await tx.coolingSession.update({ where: { id: session.id }, data: { status: "COMPLETED" } });
    await tx.cellReservation.update({ where: { id: reservation.id }, data: { status: "RELEASED", releasedAt: new Date() } });
    const destCell = await tx.cell.findFirst({ where: { id: destCellId }, select: { code: true } });
    const unblocked = await completeWorkflowTaskInTransaction(tx, task.id);
    return { companyId: input.companyId, warehouseId: group.warehouseId, title: task.title, taskId: task.id, unblocked, alreadyPlaced: false, groupId: group.id, cellCode: destCell?.code ?? "" };
  });
  // Идемпотентно: точный повтор (alreadyPlaced=true) не пишет второй Event; стабильный ключ
  // group_cooling:<groupId> гарантирует единственность записи в Ленте.
  if (!res.alreadyPlaced) {
    await emitTaskCompleted({ companyId: res.companyId, warehouseId: res.warehouseId, title: res.title, taskId: res.taskId, unblocked: res.unblocked });
    await logEvent({
      companyId: res.companyId,
      type: "group_cooling",
      key: `group_cooling:${res.groupId}`,
      title: "Охлаждение завершено",
      body: `Группа снята с охлаждения и размещена в ячейку ${res.cellCode}`,
      url: "/warehouse/tasks",
      warehouseIds: [res.warehouseId],
      actorId: input.userId,
    });
    await rebalanceQueuedTasks(res.companyId, { warehouseId: res.warehouseId });
  }
  return { warehouseId: res.warehouseId, placed: true, alreadyPlaced: res.alreadyPlaced };
}
