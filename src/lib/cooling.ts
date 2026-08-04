import "server-only";
import { Prisma, type HandlingGroup } from "@prisma/client";
import { prisma } from "@/lib/db";
import { applyLotMovement } from "@/lib/stock";
import { lockCell } from "@/lib/cells";
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

// Завершение срочной задачи забора: погрузчик вводит фактическую температуру.
// temp > X: группа остаётся, пересчёт срока, следующая отложенная задача, резерв сохранён.
// temp <= X: атомарный вывоз всей группы COOLING→резерв, IN_STORAGE, сессия COMPLETED, бронь RELEASED.
export async function completeCoolingRetrieval(input: {
  companyId: string;
  userId: string;
  taskId: string;
  temperature: number;
}): Promise<{ warehouseId: string; placed: boolean }> {
  if (!Number.isFinite(input.temperature) || input.temperature < -100 || input.temperature > 100)
    throw new CoolingError("Некорректная температура");

  const res = await prisma.$transaction(async (tx) => {
    await lockCompany(tx, input.companyId);
    const task = await tx.workflowTask.findFirst({ where: { id: input.taskId, companyId: input.companyId } });
    if (!task) throw new CoolingError("Задача не найдена");
    if (task.type !== TASK_TYPES.RETRIEVE_COOLING) throw new CoolingError("Это не задача забора из охлаждения");
    if (task.assignedUserId !== input.userId || task.status !== "IN_PROGRESS")
      throw new CoolingError("Завершить может только назначенный исполнитель с задачей «в работе»");
    const session = await tx.coolingSession.findFirst({ where: { id: task.subjectId ?? "", companyId: input.companyId } });
    if (!session || session.status !== "ACTIVE") throw new CoolingError("Сессия охлаждения не найдена или уже завершена");
    const group = await tx.handlingGroup.findFirst({ where: { id: session.handlingGroupId, companyId: input.companyId } });
    if (!group) throw new CoolingError("Группа не найдена");

    await tx.temperatureMeasurement.create({
      data: { companyId: input.companyId, sessionId: session.id, temperature: input.temperature, byUserId: input.userId },
    });

    const X = session.thresholdX.toNumber();
    const R = session.coolingRate.toNumber();
    const now = new Date();

    if (input.temperature > X) {
      // ещё тёплая — новый цикл, резерв сохраняется
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
      return { companyId: input.companyId, warehouseId: group.warehouseId, title: task.title, taskId: task.id, unblocked: [] as { id: string; title: string; warehouseId: string }[], nextTaskRes: next, placed: false };
    }

    // temp <= X — вывоз всей группы. Приоритет: свободная ячейка ур.1 → ур.2 → верхний резерв (ур.3+).
    const reservation = await tx.cellReservation.findFirst({ where: { sessionId: session.id, status: "ACTIVE" } });
    if (!reservation) throw new CoolingError("Активный резерв ячейки не найден");
    await lockCell(tx, input.companyId, session.coolingCellId);
    const destCellId = await pickRetrievalCell(tx, input.companyId, group.warehouseId, reservation.cellId);
    // финальная перепроверка целевой ячейки под локом (гарантия «одна ячейка = одна группа»)
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
    // верхний резерв освобождаем НЕЗАВИСИМО от того, положили в нижнюю ячейку или в него.
    await tx.cellReservation.update({ where: { id: reservation.id }, data: { status: "RELEASED", releasedAt: now } });
    const unblocked = await completeWorkflowTaskInTransaction(tx, task.id);
    return { companyId: input.companyId, warehouseId: group.warehouseId, title: task.title, taskId: task.id, unblocked, nextTaskRes: null as TaskCreateResult | null, placed: true };
  });

  await emitTaskCompleted({ companyId: res.companyId, warehouseId: res.warehouseId, title: res.title, taskId: res.taskId, unblocked: res.unblocked });
  if (res.nextTaskRes) await emitTaskCreated(res.nextTaskRes);
  await rebalanceQueuedTasks(res.companyId, { warehouseId: res.warehouseId });
  return { warehouseId: res.warehouseId, placed: res.placed };
}
