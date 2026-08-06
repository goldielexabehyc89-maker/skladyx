import "server-only";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { applyLotMovement } from "@/lib/stock";
import { lockCell } from "@/lib/cells";
import { createQrIn, parseScannedCode } from "@/lib/qr";
import { eanItemIdInTx } from "@/lib/barcodes";
import { logEvent } from "@/lib/events";
import { isPickableLevel } from "@/lib/placement";
import { orderControlEnabled } from "@/lib/roles";
import { createControlTaskInTx } from "@/lib/order-control";
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

// Этап 5/Пакет 6: внешние заказы, FIFO-резерв, перестановка под сборку, сборка в зону CONTROL.
// ExternalOrder — канонический владелец жизненного цикла (§1.6/§2.4). Все движения остатка —
// только через src/lib/stock.ts. Резерв (StockReservation) остаток НЕ двигает (это бронь);
// движение — при отборе через ядро. Конкурентность/идемпотентность — lockCompany + Σ active ≤
// balance на точной строке-источнике + dedupeKey (§3). За флагом EXTERNAL_ORDER_PICKING_ENABLED.

export class ExternalOrderError extends Error {}
type Tx = Prisma.TransactionClient;
const D = (x: Prisma.Decimal | number | string) => new Prisma.Decimal(x);

// ── Резолвинг отсканированных QR (настоящее сканирование, не скрытые id) ──
// Ячейка: QR типа CELL, своя организация, этот склад.
async function resolveScannedCell(tx: Tx, companyId: string, warehouseId: string, raw: string): Promise<string> {
  const code = parseScannedCode(raw);
  if (!code) throw new ExternalOrderError("Неверный QR ячейки");
  const qr = await tx.qrCode.findUnique({ where: { code } });
  if (!qr || qr.companyId !== companyId || qr.type !== "CELL") throw new ExternalOrderError("Это не QR ячейки этой организации");
  const cell = await tx.cell.findFirst({ where: { id: qr.refId, companyId, warehouseId }, select: { id: true } });
  if (!cell) throw new ExternalOrderError("Ячейка не найдена на этом складе");
  return cell.id;
}
// Группа/партия: QR типа GROUP (паллета) или LOT (партия) → группа хранения этой организации.
async function resolveScannedGroup(tx: Tx, companyId: string, raw: string): Promise<{ groupId: string; lotId: string; itemId: string }> {
  const code = parseScannedCode(raw);
  if (!code) throw new ExternalOrderError("Неверный QR группы/партии");
  const qr = await tx.qrCode.findUnique({ where: { code } });
  if (!qr || qr.companyId !== companyId) throw new ExternalOrderError("Это не QR этой организации");
  let group;
  if (qr.type === "GROUP") group = await tx.handlingGroup.findFirst({ where: { id: qr.refId, companyId }, select: { id: true, lotId: true, itemId: true } });
  else if (qr.type === "LOT") group = await tx.handlingGroup.findFirst({ where: { lotId: qr.refId, companyId }, select: { id: true, lotId: true, itemId: true } });
  else throw new ExternalOrderError("Отсканируйте QR группы или партии товара");
  if (!group) throw new ExternalOrderError("Группа хранения не найдена");
  return { groupId: group.id, lotId: group.lotId, itemId: group.itemId };
}

// Пакет 9B: однозначная группа заказа в ячейке по товару EAN. Одна физическая ячейка = одна группа,
// поэтому резервы заказа в этой ячейке указывают на одну группу; сверяем её товар с EAN.
// null — если группы этого товара по резервам заказа в ячейке нет или их несколько (fail-closed).
async function pickGroupInCellForOrder(tx: Tx, orderId: string, cellId: string, itemId: string): Promise<string | null> {
  const resvs = await tx.stockReservation.findMany({ where: { orderId, cellId }, select: { handlingGroupId: true }, distinct: ["handlingGroupId"] });
  const groupIds = resvs.map((r) => r.handlingGroupId).filter((g): g is string => !!g);
  if (groupIds.length === 0) return null;
  const groups = await tx.handlingGroup.findMany({ where: { id: { in: groupIds }, itemId }, select: { id: true } });
  return groups.length === 1 ? groups[0].id : null;
}

export interface ImportLine {
  externalLineId: string;
  itemId: string;
  requiredQty: number;
}
export interface ImportPayload {
  companyId: string;
  warehouseId: string;
  externalId: string;
  createdById: string | null; // Пакет 10: интеграционный импорт передаёт null (без сессии)
  arrivalAt?: Date | string | null;
  lines: ImportLine[];
}

// Канонический снимок payload для идемпотентности/детекции изменений (без externalId — это ключ).
function hashPayload(p: ImportPayload): string {
  const norm = {
    warehouseId: p.warehouseId,
    arrivalAt: p.arrivalAt ? new Date(p.arrivalAt).toISOString() : null,
    lines: [...p.lines]
      .map((l) => ({ externalLineId: l.externalLineId, itemId: l.itemId, requiredQty: D(l.requiredQty).toFixed(3) }))
      .sort((a, b) => (a.externalLineId < b.externalLineId ? -1 : a.externalLineId > b.externalLineId ? 1 : 0)),
  };
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex");
}

// ── Импорт заказа (идемпотентно по externalId; изменённый payload → контролируемая ошибка) ──
// server-only; позднее вызывается интеграционным адаптером (webhook — вне этого пакета).
export async function importExternalOrder(
  payload: ImportPayload,
): Promise<{ orderId: string; created: boolean; qrCode: string | null }> {
  if (!payload.lines.length) throw new ExternalOrderError("Заказ без строк");
  for (const l of payload.lines) {
    if (!Number.isInteger(l.requiredQty) || l.requiredQty <= 0)
      throw new ExternalOrderError("Количество строки должно быть целым больше нуля");
  }
  if (new Set(payload.lines.map((l) => l.externalLineId)).size !== payload.lines.length)
    throw new ExternalOrderError("Дублирующиеся строки заказа");
  const payloadHash = hashPayload(payload);
  const arrivalAt = payload.arrivalAt ? new Date(payload.arrivalAt) : null;

  return prisma.$transaction(async (tx) => {
    await lockCompany(tx, payload.companyId);

    const existing = await tx.externalOrder.findUnique({
      where: { companyId_externalId: { companyId: payload.companyId, externalId: payload.externalId } },
    });
    if (existing) {
      // идемпотентность: тот же payload → тот же заказ; изменённый → ошибка без частичных изменений
      if (existing.payloadHash !== payloadHash)
        throw new ExternalOrderError(
          "Заказ с этим externalId уже импортирован с другим содержимым — изменение импортированного заказа не поддерживается",
        );
      return { orderId: existing.id, created: false, qrCode: null };
    }

    const wh = await tx.warehouse.findFirst({
      where: { id: payload.warehouseId, companyId: payload.companyId, isActive: true },
      select: { id: true },
    });
    if (!wh) throw new ExternalOrderError("Склад не найден или неактивен");

    // товары: свои, активные, партионные (RostAgro — LOT; поштучные в сборке групп не участвуют)
    for (const l of payload.lines) {
      const item = await tx.item.findFirst({ where: { id: l.itemId, companyId: payload.companyId }, select: { isActive: true, tracking: true } });
      if (!item || !item.isActive) throw new ExternalOrderError(`Товар строки ${l.externalLineId} не найден или неактивен`);
      if (item.tracking === "UNIT") throw new ExternalOrderError("Поштучный товар в сборке заказов пока не поддерживается");
    }

    const order = await tx.externalOrder.create({
      data: {
        companyId: payload.companyId,
        warehouseId: payload.warehouseId,
        externalId: payload.externalId,
        status: "IMPORTED",
        arrivalAt,
        payloadHash,
        createdById: payload.createdById,
        lines: {
          create: payload.lines.map((l) => ({
            companyId: payload.companyId,
            externalLineId: l.externalLineId,
            itemId: l.itemId,
            requiredQty: D(l.requiredQty),
          })),
        },
      },
    });
    const qrCode = await createQrIn(tx, { companyId: payload.companyId, type: "ORDER", refId: order.id });
    return { orderId: order.id, created: true, qrCode };
  });
}

// Свободные (пустые + не зарезервированные) активные STORAGE-ячейки по фильтру уровня, min level→code.
// Чистая выборка (без побочных эффектов) — для планирования перестановки. Нижние: {in:[1,2]};
// верхняя ячейка — ЛЮБАЯ активная STORAGE с level>=3 ({gte:3}), без жёсткого списка уровней.
async function freeCells(tx: Tx, companyId: string, warehouseId: string, levelWhere: Prisma.IntNullableFilter): Promise<{ id: string; level: number }[]> {
  const cells = await tx.cell.findMany({
    where: { companyId, warehouseId, isActive: true, level: levelWhere, zone: { kind: "STORAGE" } },
    select: { id: true, level: true, code: true },
    orderBy: [{ level: "asc" }, { code: "asc" }],
  });
  const out: { id: string; level: number }[] = [];
  for (const c of cells) {
    const [bal, unit, res] = await Promise.all([
      tx.stockBalance.findFirst({ where: { cellId: c.id, qty: { gt: 0 } }, select: { id: true } }),
      tx.itemUnit.findFirst({ where: { cellId: c.id }, select: { id: true } }),
      tx.cellReservation.findFirst({ where: { cellId: c.id, status: "ACTIVE" }, select: { id: true } }),
    ]);
    if (!bal && !unit && !res) out.push({ id: c.id, level: c.level! });
  }
  return out;
}

// Нижние (ур.1-2) ячейки, занятые невостребованной группой (без активного StockReservation),
// сама ячейка не забронирована. Их можно поднять наверх, освободив место под нужную группу.
async function liftableLowerGroups(tx: Tx, companyId: string, warehouseId: string, exclude: Set<string>): Promise<{ groupId: string; cellId: string }[]> {
  const cells = await tx.cell.findMany({
    where: { companyId, warehouseId, isActive: true, level: { in: [1, 2] }, zone: { kind: "STORAGE" } },
    select: { id: true },
    orderBy: { code: "asc" },
  });
  const out: { groupId: string; cellId: string }[] = [];
  for (const c of cells) {
    const res = await tx.cellReservation.findFirst({ where: { cellId: c.id, status: "ACTIVE" }, select: { id: true } });
    if (res) continue;
    const bal = await tx.stockBalance.findFirst({ where: { cellId: c.id, qty: { gt: 0 } }, select: { lotId: true } });
    if (!bal) continue;
    const group = await tx.handlingGroup.findFirst({ where: { companyId, lotId: bal.lotId, status: "IN_STORAGE" }, select: { id: true } });
    if (!group || exclude.has(group.id)) continue;
    const demand = await tx.stockReservation.findFirst({ where: { handlingGroupId: group.id, status: "ACTIVE" }, select: { id: true } });
    if (demand) continue; // востребованную не двигаем как «лишнюю»
    const moving = await tx.cellReservation.findFirst({ where: { handlingGroupId: group.id, status: "ACTIVE" }, select: { id: true } });
    if (moving) continue; // уже участвует в активной перестановке — не берём как «лишнюю»
    out.push({ groupId: group.id, cellId: c.id });
  }
  return out;
}

type MoveStep =
  | { kind: "down"; groupId: string; targetCellId: string } // нужная группа сразу в свободную нижнюю
  | { kind: "lift"; groupId: string; targetCellId: string } // невостребованную группу наверх
  | { kind: "down-after"; groupId: string; targetCellId: string; afterGroupId: string }; // нужную в освобождённую нижнюю после подъёма

// Спланировать перестановку ВСЕХ нужных групп на ур.1-2 — БЕЗ побочных эффектов (all-or-nothing).
// Целевые ячейки учитываются виртуально (usedLower/usedUpper). null → нет безопасной цепочки (BLOCKED).
async function planMoves(tx: Tx, companyId: string, warehouseId: string, groupIds: string[]): Promise<MoveStep[] | null> {
  const freeLower = (await freeCells(tx, companyId, warehouseId, { in: [1, 2] })).map((c) => c.id);
  const freeUpper = (await freeCells(tx, companyId, warehouseId, { gte: 3 })).map((c) => c.id); // любая STORAGE ур.3+
  const liftable = await liftableLowerGroups(tx, companyId, warehouseId, new Set(groupIds));
  const usedLower = new Set<string>();
  const usedUpper = new Set<string>();
  const usedLift = new Set<string>();
  const steps: MoveStep[] = [];
  for (const g of groupIds) {
    const lower = freeLower.find((id) => !usedLower.has(id));
    if (lower) {
      usedLower.add(lower);
      steps.push({ kind: "down", groupId: g, targetCellId: lower });
      continue;
    }
    const upper = freeUpper.find((id) => !usedUpper.has(id));
    const h = liftable.find((x) => !usedLift.has(x.groupId) && !usedLower.has(x.cellId));
    if (!upper || !h) return null; // нет верхнего места или нечего поднять — безопасной перестановки нет
    usedUpper.add(upper);
    usedLift.add(h.groupId);
    usedLower.add(h.cellId); // освобождаемая нижняя ячейка H — цель для нужной группы
    steps.push({ kind: "lift", groupId: h.groupId, targetCellId: upper });
    steps.push({ kind: "down-after", groupId: g, targetCellId: h.cellId, afterGroupId: h.groupId });
  }
  return steps;
}

// ── FIFO-резерв заказа + планирование сборки/перестановки (идемпотентно, под lockCompany) ──
export async function reserveAndPlanOrder(input: { companyId: string; orderId: string; userId: string }): Promise<{ status: string }> {
  const created: TaskCreateResult[] = [];
  const res = await prisma.$transaction(async (tx) => {
    await lockCompany(tx, input.companyId);
    const order = await tx.externalOrder.findFirst({ where: { id: input.orderId, companyId: input.companyId } });
    if (!order) throw new ExternalOrderError("Заказ не найден");
    if (!["IMPORTED", "PARTIALLY_RESERVED", "BLOCKED"].includes(order.status))
      return { status: order.status, warehouseId: order.warehouseId }; // уже в сборке/контроле — идемпотентно

    const lines = await tx.externalOrderLine.findMany({ where: { orderId: order.id }, orderBy: { externalLineId: "asc" } });
    // задачи перестановки, от которых должна зависеть сборка (группа уже едет ВНИЗ под другой заказ)
    const dependOnMoves = new Set<string>();

    // FIFO-резерв каждой недопокрытой строки на точную строку-источник (Σ active + new ≤ balance)
    for (const line of lines) {
      let need = line.requiredQty.minus(line.reservedQty);
      if (need.lte(0)) continue;
      const lots = await tx.lot.findMany({
        where: { companyId: input.companyId, itemId: line.itemId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }], // FIFO + стабильный tie-break
        select: { id: true },
      });
      let added = D(0);
      for (const lot of lots) {
        if (need.lte(0)) break;
        const bal = await tx.stockBalance.findFirst({
          where: { companyId: input.companyId, lotId: lot.id, cellId: { not: null }, qty: { gt: 0 } },
          select: { cellId: true },
        });
        if (!bal?.cellId) continue;
        const cell = await tx.cell.findFirst({ where: { id: bal.cellId }, include: { zone: true } });
        if (!cell || cell.zone?.kind !== "STORAGE") continue; // резервируем/собираем только из хранения
        const group = await tx.handlingGroup.findFirst({
          where: { companyId: input.companyId, lotId: lot.id, status: "IN_STORAGE" },
          select: { id: true },
        });
        if (!group) continue;
        // группа в активной перестановке: смотрим ЦЕЛЕВУЮ ячейку брони (не текущий уровень группы).
        // Наверх (target ур.3+) — источник недоступен, пропускаем (следующий FIFO-источник).
        // Вниз (target ур.1-2) — резерв разрешён, но сборка обязана зависеть от ЭТОЙ задачи.
        const mv = await tx.cellReservation.findFirst({ where: { handlingGroupId: group.id, status: "ACTIVE" }, select: { cellId: true, taskId: true } });
        if (mv) {
          const mvLevel = (await tx.cell.findFirst({ where: { id: mv.cellId }, select: { level: true } }))?.level ?? null;
          if (!isPickableLevel(mvLevel)) continue; // перестановка НАВЕРХ — из этой группы не резервируем
          if (mv.taskId) dependOnMoves.add(mv.taskId); // перестановка ВНИЗ — сборка зависит от неё
        }
        await lockCell(tx, input.companyId, cell.id);
        const bal2 = await tx.stockBalance.findFirst({ where: { lotId: lot.id, locKey: `C:${cell.id}`, qty: { gt: 0 } }, select: { qty: true } });
        if (!bal2) continue;
        const agg = await tx.stockReservation.aggregate({ where: { lotId: lot.id, sourceLocKey: `C:${cell.id}`, status: "ACTIVE" }, _sum: { qty: true } });
        const available = bal2.qty.minus(agg._sum.qty ?? D(0)); // Σ active(lotId, locKey) + new ≤ balance
        if (available.lte(0)) continue;
        const take = Prisma.Decimal.min(need, available);
        await tx.stockReservation.create({
          data: {
            companyId: input.companyId, orderId: order.id, lineId: line.id, handlingGroupId: group.id,
            lotId: lot.id, sourceLocKey: `C:${cell.id}`, cellId: cell.id, qty: take, status: "ACTIVE",
            dedupeKey: `res:${order.id}:${line.id}:${lot.id}:${cell.id}`,
          },
        });
        need = need.minus(take);
        added = added.plus(take);
      }
      if (added.gt(0)) await tx.externalOrderLine.update({ where: { id: line.id }, data: { reservedQty: { increment: added } } });
    }

    // покрытие
    const fresh = await tx.externalOrderLine.findMany({ where: { orderId: order.id }, select: { requiredQty: true, reservedQty: true } });
    const fullyCovered = fresh.every((l) => l.reservedQty.gte(l.requiredQty));
    const anyReserved = fresh.some((l) => l.reservedQty.gt(0));

    if (!fullyCovered) {
      const status = anyReserved ? "PARTIALLY_RESERVED" : "IMPORTED";
      await tx.externalOrder.update({ where: { id: order.id }, data: { status } });
      return { status, warehouseId: order.warehouseId }; // задача сборщику НЕ создаётся до полного покрытия
    }

    // полное покрытие: группы на ур.3+ нужно спустить (срочная цепочка), иначе PICK_ORDER сразу
    const activeRes = await tx.stockReservation.findMany({
      where: { orderId: order.id, status: "ACTIVE" },
      select: { handlingGroupId: true, cellId: true },
    });
    const need3plus: string[] = [];
    const seen = new Set<string>();
    for (const r of activeRes) {
      if (!r.handlingGroupId || !r.cellId || seen.has(r.handlingGroupId)) continue;
      const cell = await tx.cell.findFirst({ where: { id: r.cellId }, select: { level: true } });
      if (!isPickableLevel(cell?.level ?? null)) {
        need3plus.push(r.handlingGroupId);
        seen.add(r.handlingGroupId);
      }
    }

    // группа уже может переставляться другой активной задачей (другой заказ). Тогда НЕ создаём
    // дубль — зависим от существующей задачи; остальные ур.3+ планируем заново.
    const dependOn: string[] = [];
    const toPlan: string[] = [];
    for (const g of need3plus) {
      const existing = await tx.cellReservation.findFirst({ where: { handlingGroupId: g, status: "ACTIVE" }, select: { taskId: true } });
      if (existing?.taskId) dependOn.push(existing.taskId);
      else toPlan.push(g);
    }

    const plan = await planMoves(tx, input.companyId, order.warehouseId, toPlan);
    if (!plan) {
      // нет безопасной цепочки/места → BLOCKED. Резервы товара сохраняем; невыполнимую задачу не создаём.
      await tx.externalOrder.update({ where: { id: order.id }, data: { status: "BLOCKED" } });
      return { status: "BLOCKED", warehouseId: order.warehouseId };
    }

    // исполнить план: задача MOVE_GROUP (с зависимостями) + бронь целевой ячейки, привязанная к ЗАДАЧЕ
    // (taskId). partial-unique по (handlingGroupId WHERE ACTIVE) не даёт двух перестановок одной группы.
    const liftTaskByGroup = new Map<string, string>();
    for (const step of plan) {
      await lockCell(tx, input.companyId, step.targetCellId);
      const deps = step.kind === "down-after" ? [liftTaskByGroup.get(step.afterGroupId)!] : [];
      const title = step.kind === "lift" ? "Поднять группу наверх (освободить нижний уровень)" : `Переставить вниз: заказ ${order.externalId}`;
      const t = await createWorkflowTaskInTx(tx, {
        companyId: input.companyId, warehouseId: order.warehouseId, type: TASK_TYPES.MOVE_GROUP, requiredRole: "LOADER", priority: "URGENT",
        title, description: "Срочная перестановка группы под сборку заказа (уровни 1-2)",
        subjectType: "HandlingGroup", subjectId: step.groupId,
        dedupeKey: `move:${order.id}:${step.groupId}:${step.kind === "lift" ? "up" : "down"}`,
        dueAt: order.arrivalAt ?? undefined, dependsOn: deps,
      });
      created.push(t);
      await tx.cellReservation.create({ data: { companyId: input.companyId, warehouseId: order.warehouseId, cellId: step.targetCellId, handlingGroupId: step.groupId, taskId: t.task.id, status: "ACTIVE" } });
      if (step.kind === "lift") liftTaskByGroup.set(step.groupId, t.task.id);
      else dependOn.push(t.task.id); // нужную группу опускают 'down' / 'down-after' — их ждёт сборка
    }

    const pick = await createWorkflowTaskInTx(tx, {
      companyId: input.companyId, warehouseId: order.warehouseId, type: TASK_TYPES.PICK_ORDER, requiredRole: "PICKER", priority: "NORMAL",
      title: `Собрать заказ ${order.externalId}`, description: `Строк: ${lines.length}`,
      subjectType: "ExternalOrder", subjectId: order.id,
      dedupeKey: `order:${order.id}:pick`, loadUnits: lines.length,
      // зависимости: наши новые перестановки вниз + существующие (общая группа) + перестановки вниз,
      // замеченные при резервировании (createWorkflowTaskInTx дедуплицирует список).
      dueAt: order.arrivalAt ?? undefined, dependsOn: [...new Set([...dependOn, ...dependOnMoves])],
    });
    created.push(pick);
    await tx.externalOrder.update({ where: { id: order.id }, data: { status: "READY_TO_PICK" } });
    return { status: "READY_TO_PICK", warehouseId: order.warehouseId };
  });

  // события — после коммита (created пуст на путях без создания задач: idempotent/partial/blocked)
  for (const r of created) await emitTaskCreated(r);
  await rebalanceQueuedTasks(input.companyId, { warehouseId: res.warehouseId });
  return { status: res.status };
}

// ── Завершение перестановки погрузчиком: настоящее сканирование группы и целевой ячейки ──
// Последовательность: скан QR группы → скан QR целевой ячейки → серверная сверка с задачей и
// бронью (по taskId) → движение. Физическое подтверждение — не скрытыми id.
export async function completeMoveGroup(input: {
  companyId: string;
  userId: string;
  taskId: string;
  fromCellCode: string;
  ean: string;
  cellCode: string;
}): Promise<{ warehouseId: string }> {
  const res = await prisma.$transaction(async (tx) => {
    await lockCompany(tx, input.companyId);
    const task = await tx.workflowTask.findFirst({ where: { id: input.taskId, companyId: input.companyId } });
    if (!task) throw new ExternalOrderError("Задача не найдена");
    if (task.type !== TASK_TYPES.MOVE_GROUP) throw new ExternalOrderError("Это не задача перестановки");
    if (task.assignedUserId !== input.userId || task.status !== "IN_PROGRESS")
      throw new ExternalOrderError("Завершить может только назначенный исполнитель с задачей «в работе»");
    const group = await tx.handlingGroup.findFirst({ where: { id: task.subjectId ?? "", companyId: input.companyId } });
    if (!group) throw new ExternalOrderError("Группа не найдена");

    // бронь целевой ячейки — по ЗАДАЧЕ (однозначно), а не по группе
    const reservation = await tx.cellReservation.findFirst({ where: { taskId: task.id, status: "ACTIVE" }, select: { id: true, cellId: true } });
    if (!reservation) throw new ExternalOrderError("Целевая ячейка перестановки не найдена (бронь снята)");
    const targetCellId = reservation.cellId;

    // Пакет 9B: группа однозначна из задачи; EAN подтверждает её товар; исходная и целевая ячейки — сканами.
    const scannedItemId = await eanItemIdInTx(tx, input.companyId, input.ean);
    if (!scannedItemId) throw new ExternalOrderError("Неизвестный, неактивный или чужой EAN — перестановка отклонена");
    if (scannedItemId !== group.itemId) throw new ExternalOrderError("Отсканирован не тот товар (EAN не совпадает с группой)");
    const scannedCellId = await resolveScannedCell(tx, input.companyId, group.warehouseId, input.cellCode);
    if (scannedCellId !== targetCellId) throw new ExternalOrderError("Отсканирована не та целевая ячейка");

    const curBal = await tx.stockBalance.findFirst({
      where: { lotId: group.lotId, companyId: input.companyId, cellId: { not: null }, qty: { gt: 0 } },
      select: { cellId: true, qty: true },
    });
    if (!curBal?.cellId) throw new ExternalOrderError("Текущее размещение группы не найдено");
    const fromCellId = curBal.cellId;
    // фактическое нахождение группы в исходной ячейке: скан исходной ячейки обязан совпасть
    const scannedFromCellId = await resolveScannedCell(tx, input.companyId, group.warehouseId, input.fromCellCode);
    if (scannedFromCellId !== fromCellId) throw new ExternalOrderError("Отсканирована не та исходная ячейка (группа находится в другой)");

    if (fromCellId === targetCellId) {
      // уже на месте — снять бронь и завершить (идемпотентно)
      await tx.cellReservation.update({ where: { id: reservation.id }, data: { status: "RELEASED", releasedAt: new Date() } });
      const unblocked = await completeWorkflowTaskInTransaction(tx, task.id);
      return { companyId: input.companyId, warehouseId: group.warehouseId, title: task.title, taskId: task.id, unblocked };
    }

    // локи двух ячеек в детерминированном порядке; целевая должна быть пустой (одна ячейка — одна группа)
    const [a, b] = fromCellId <= targetCellId ? [fromCellId, targetCellId] : [targetCellId, fromCellId];
    await lockCell(tx, input.companyId, a);
    if (b !== a) await lockCell(tx, input.companyId, b);
    const [tBal, tUnit] = await Promise.all([
      tx.stockBalance.findFirst({ where: { cellId: targetCellId, qty: { gt: 0 } }, select: { id: true } }),
      tx.itemUnit.findFirst({ where: { cellId: targetCellId }, select: { id: true } }),
    ]);
    if (tBal || tUnit) throw new ExternalOrderError("Целевая ячейка занята — перестановка отменена");

    await applyLotMovement(tx, {
      companyId: input.companyId, docType: "TRANSFER", docId: group.id, itemId: group.itemId, lotId: group.lotId, qty: curBal.qty,
      from: { kind: "cell", warehouseId: group.warehouseId, cellId: fromCellId },
      to: { kind: "cell", warehouseId: group.warehouseId, cellId: targetCellId },
      createdById: input.userId,
    });
    // резервы товара этой группы переезжают на новую ячейку (источник обновляется вместе с группой)
    await tx.stockReservation.updateMany({
      where: { handlingGroupId: group.id, status: "ACTIVE", sourceLocKey: `C:${fromCellId}` },
      data: { sourceLocKey: `C:${targetCellId}`, cellId: targetCellId },
    });
    await tx.cellReservation.update({ where: { id: reservation.id }, data: { status: "RELEASED", releasedAt: new Date() } });
    const unblocked = await completeWorkflowTaskInTransaction(tx, task.id);
    return { companyId: input.companyId, warehouseId: group.warehouseId, title: task.title, taskId: task.id, unblocked };
  });

  await emitTaskCompleted(res);
  await rebalanceQueuedTasks(res.companyId, { warehouseId: res.warehouseId });
  return { warehouseId: res.warehouseId };
}

// ── Скан сборки: скан QR ячейки(1-2) → скан QR группы/партии → количество. Серверная сверка,
// что группа+товар+ячейка+активный резерв относятся к этому заказу; отбор через ядро → CONTROL. ──
// Идемпотентно: повтор финального скана после IN_CONTROL → alreadyPicked без движения; повтор
// скана уже собранной (заказ, группа, ячейка) → alreadyPicked. Излишек отклоняется; недостача — кнопкой.
export async function pickOrderScan(input: {
  companyId: string;
  userId: string;
  taskId: string;
  cellCode: string;
  ean: string;
  qty: number;
}): Promise<{ done: boolean; alreadyPicked: boolean }> {
  type Brief = { id: string; title: string; warehouseId: string };
  const res = await prisma.$transaction(async (tx) => {
    await lockCompany(tx, input.companyId);
    const task = await tx.workflowTask.findFirst({ where: { id: input.taskId, companyId: input.companyId } });
    if (!task) throw new ExternalOrderError("Задача не найдена");
    if (task.type !== TASK_TYPES.PICK_ORDER) throw new ExternalOrderError("Это не задача сборки");
    const order = await tx.externalOrder.findFirst({ where: { id: task.subjectId ?? "", companyId: input.companyId } });
    if (!order) throw new ExternalOrderError("Заказ не найден");
    const base = { companyId: input.companyId, warehouseId: order.warehouseId, orderId: order.id, taskId: task.id };
    if (task.assignedUserId !== input.userId) throw new ExternalOrderError("Это не ваша задача сборки");

    // Настоящие сканы РЕЗОЛВИМ И СВЕРЯЕМ ВСЕГДА (в т.ч. при IN_CONTROL): чужой tenant / чужая ячейка /
    // неверный QR — отказ (resolve* бросает при несовпадении организации/типа/существования).
    const cellId = await resolveScannedCell(tx, input.companyId, order.warehouseId, input.cellCode);
    const cell = await tx.cell.findFirst({ where: { id: cellId }, select: { level: true } });
    if (!isPickableLevel(cell?.level ?? null)) throw new ExternalOrderError("Сборка только с нижних уровней (1-2)");
    // Пакет 9B: товар — по EAN; группа/партия выводится из ячейки и резервов ЭТОГО заказа (одна
    // физическая ячейка = одна группа, поэтому по (заказ, ячейка, товар) группа однозначна).
    const itemId = await eanItemIdInTx(tx, input.companyId, input.ean);
    if (!itemId) throw new ExternalOrderError("Неизвестный, неактивный или чужой EAN — сборка отклонена");
    const groupId = await pickGroupInCellForOrder(tx, order.id, cellId, itemId);
    if (!groupId) throw new ExternalOrderError("В этой ячейке нет группы этого товара по резервам заказа");

    // Точная идемпотентность повтора финального скана: при IN_CONTROL успех alreadyPicked ТОЛЬКО если
    // есть FULFILLED-резерв этого заказа именно с этой группой и этой (исходной) ячейкой; иначе — отказ.
    if (order.status === "IN_CONTROL") {
      const done = await tx.stockReservation.findFirst({ where: { orderId: order.id, handlingGroupId: groupId, cellId, status: "FULFILLED" }, select: { id: true } });
      if (done) return { ...base, done: true, alreadyPicked: true, justCompleted: false, unblocked: [] as Brief[], controlTask: null as TaskCreateResult | null };
      throw new ExternalOrderError("Скан не соответствует собранному заказу");
    }
    if (task.status !== "IN_PROGRESS") throw new ExternalOrderError("Задача сборки не в работе");

    await lockCell(tx, input.companyId, cellId);
    // резерв ЭТОГО заказа для этой группы в этой ячейке — связывает заказ+группу+товар+ячейку+резерв
    const reservations = await tx.stockReservation.findMany({
      where: { orderId: order.id, cellId, handlingGroupId: groupId, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
    });
    const remaining = reservations.reduce((s, r) => s.plus(r.qty), D(0));
    if (remaining.lte(0)) {
      // нет активного резерва: повтор уже собранного (заказ, группа, ячейка) → alreadyPicked; иначе — чужой скан
      const already = await tx.stockReservation.findFirst({ where: { orderId: order.id, cellId, handlingGroupId: groupId, status: "FULFILLED" }, select: { id: true } });
      if (already) return { ...base, done: await orderFullyPicked(tx, order.id), alreadyPicked: true, justCompleted: false, unblocked: [] as Brief[], controlTask: null as TaskCreateResult | null };
      throw new ExternalOrderError("Нет активного резерва этого заказа для этой группы в этой ячейке");
    }
    const qty = D(input.qty);
    if (qty.lte(0)) throw new ExternalOrderError("Количество должно быть больше нуля");
    if (qty.gt(remaining)) throw new ExternalOrderError("Нельзя собрать больше зарезервированного (излишек не фиксируется)");
    if (qty.lt(remaining)) throw new ExternalOrderError("При сборке отбирается весь резерв ячейки; недостачу фиксируйте кнопкой «Недостача»");

    const control = await tx.warehouseZone.findFirst({ where: { companyId: input.companyId, warehouseId: order.warehouseId, kind: "CONTROL" } });
    if (!control) throw new ExternalOrderError("На складе нет системной зоны контроля (CONTROL)");

    // отбор через ядро: ячейка → зона CONTROL; погашение резерва; инкремент собранного строки
    for (const r of reservations) {
      if (!r.lotId) continue;
      await applyLotMovement(tx, {
        companyId: input.companyId, docType: "PICKLIST", docId: order.id, itemId, lotId: r.lotId, qty: r.qty,
        from: { kind: "cell", warehouseId: order.warehouseId, cellId },
        to: { kind: "zone", warehouseId: order.warehouseId, zoneId: control.id },
        createdById: input.userId,
      });
      await tx.stockReservation.update({ where: { id: r.id }, data: { status: "FULFILLED", fulfilledAt: new Date() } });
      await tx.externalOrderLine.update({ where: { id: r.lineId }, data: { pickedQty: { increment: r.qty } } });
    }
    if (order.status === "READY_TO_PICK") await tx.externalOrder.update({ where: { id: order.id }, data: { status: "PICKING" } });

    // нагрузка = число ещё не собранных строк (не прерывает выполняемую задачу)
    const allLines = await tx.externalOrderLine.findMany({ where: { orderId: order.id }, select: { requiredQty: true, pickedQty: true } });
    const remainLines = allLines.filter((l) => l.pickedQty.lt(l.requiredQty)).length;
    const done = remainLines === 0 && allLines.length > 0;
    let unblocked: Brief[] = [];
    let controlTask: TaskCreateResult | null = null;
    if (done) {
      await tx.externalOrder.update({ where: { id: order.id }, data: { status: "IN_CONTROL" } });
      unblocked = await completeWorkflowTaskInTransaction(tx, task.id);
      // Пакет 7: при включённом флаге атомарно создаём задачу контроля (CONTROL_ORDER) вместе с
      // переходом в IN_CONTROL. Флаг OFF → поведение Пакета 6 без изменений (задача не создаётся).
      if (orderControlEnabled())
        controlTask = await createControlTaskInTx(tx, { companyId: input.companyId, order, dedupeKey: `control:${order.id}:initial` });
    } else {
      await tx.workflowTask.update({ where: { id: task.id }, data: { loadUnits: Math.max(1, remainLines) } });
    }
    return { ...base, done, alreadyPicked: false, justCompleted: done, unblocked, controlTask };
  });

  if (res.justCompleted) {
    await emitTaskCompleted({ companyId: res.companyId, warehouseId: res.warehouseId, title: "Заказ собран", taskId: res.taskId, unblocked: res.unblocked });
    if (res.controlTask) await emitTaskCreated(res.controlTask);
    await rebalanceQueuedTasks(res.companyId, { warehouseId: res.warehouseId });
  }
  return { done: res.done, alreadyPicked: res.alreadyPicked };
}

async function orderFullyPicked(tx: Tx, orderId: string): Promise<boolean> {
  const lines = await tx.externalOrderLine.findMany({ where: { orderId }, select: { requiredQty: true, pickedQty: true } });
  return lines.length > 0 && lines.every((l) => l.pickedQty.gte(l.requiredQty));
}

// ── Недостача: фиксируем причину (task_needs_attention), данные НЕ подменяем ──
export async function reportPickShortage(input: { companyId: string; userId: string; taskId: string; reason: string }): Promise<void> {
  const info = await prisma.$transaction(async (tx) => {
    await lockCompany(tx, input.companyId);
    const task = await tx.workflowTask.findFirst({ where: { id: input.taskId, companyId: input.companyId } });
    if (!task || task.type !== TASK_TYPES.PICK_ORDER) throw new ExternalOrderError("Это не задача сборки");
    if (task.assignedUserId !== input.userId) throw new ExternalOrderError("Это не ваша задача");
    // недостачу можно фиксировать только по своей задаче В РАБОТЕ и заказу, ещё не ушедшему на контроль;
    // завершённую/отменённую задачу воскрешать нельзя.
    if (task.status !== "IN_PROGRESS") throw new ExternalOrderError("Недостача — только для задачи «в работе»");
    const order = await tx.externalOrder.findFirst({ where: { id: task.subjectId ?? "", companyId: input.companyId }, select: { status: true } });
    if (!order || order.status === "IN_CONTROL") throw new ExternalOrderError("Заказ уже собран — недостача недоступна");
    if (!input.reason.trim()) throw new ExternalOrderError("Укажите причину недостачи");
    await tx.workflowTask.update({ where: { id: task.id }, data: { status: "NEEDS_ATTENTION" } });
    return { warehouseId: task.warehouseId, title: task.title };
  });
  await logEvent({
    companyId: input.companyId, type: "task_needs_attention", title: "Недостача при сборке",
    body: `${info.title}: ${input.reason}`, url: "/warehouse/tasks", warehouseIds: [info.warehouseId], actorId: input.userId,
  });
}

// ── Геттеры для UI ──
export async function getPickOrderContext(companyId: string, taskId: string) {
  const task = await prisma.workflowTask.findFirst({ where: { id: taskId, companyId, type: TASK_TYPES.PICK_ORDER } });
  if (!task?.subjectId) return null;
  const order = await prisma.externalOrder.findFirst({ where: { id: task.subjectId, companyId } });
  if (!order) return null;
  const lines = await prisma.externalOrderLine.findMany({ where: { orderId: order.id }, orderBy: { externalLineId: "asc" } });
  const items = await prisma.item.findMany({ where: { id: { in: lines.map((l) => l.itemId) } }, select: { id: true, name: true } });
  const itemName = new Map(items.map((i) => [i.id, i.name]));
  const lineItem = new Map(lines.map((l) => [l.id, l.itemId]));
  const reservations = await prisma.stockReservation.findMany({ where: { orderId: order.id, status: "ACTIVE" } });
  const cellIds = reservations.map((r) => r.cellId).filter((x): x is string => !!x);
  const cells = await prisma.cell.findMany({ where: { id: { in: cellIds } }, select: { id: true, code: true, level: true } });
  const cellById = new Map(cells.map((c) => [c.id, c]));
  return {
    orderId: order.id,
    externalId: order.externalId,
    lines: lines.map((l) => ({ id: l.id, item: itemName.get(l.itemId) ?? l.itemId, itemId: l.itemId, required: l.requiredQty.toString(), picked: l.pickedQty.toString() })),
    picks: reservations.map((r) => {
      const itId = lineItem.get(r.lineId) ?? "";
      return {
        itemId: itId, item: itemName.get(itId) ?? "",
        cellId: r.cellId ?? "", cell: cellById.get(r.cellId ?? "")?.code ?? "", level: cellById.get(r.cellId ?? "")?.level ?? null,
        qty: r.qty.toString(),
      };
    }),
  };
}

export async function getMoveGroupContext(companyId: string, taskId: string) {
  const task = await prisma.workflowTask.findFirst({ where: { id: taskId, companyId, type: TASK_TYPES.MOVE_GROUP } });
  if (!task?.subjectId) return null;
  const group = await prisma.handlingGroup.findFirst({ where: { id: task.subjectId, companyId } });
  if (!group) return null;
  const reservation = await prisma.cellReservation.findFirst({ where: { handlingGroupId: group.id, status: "ACTIVE" } });
  const toCell = reservation ? await prisma.cell.findFirst({ where: { id: reservation.cellId }, select: { code: true, level: true } }) : null;
  const bal = await prisma.stockBalance.findFirst({ where: { lotId: group.lotId, companyId, cellId: { not: null }, qty: { gt: 0 } }, select: { cellId: true } });
  const fromCell = bal?.cellId ? await prisma.cell.findFirst({ where: { id: bal.cellId }, select: { code: true, level: true } }) : null;
  const item = await prisma.item.findFirst({ where: { id: group.itemId, companyId }, select: { name: true } });
  return {
    taskId: task.id, item: item?.name ?? group.itemId, qty: group.qty.toString(),
    fromCell: fromCell?.code ?? "—", fromLevel: fromCell?.level ?? null,
    toCell: toCell?.code ?? "—", toLevel: toCell?.level ?? null,
  };
}
