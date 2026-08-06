import "server-only";
import { Prisma, type ZoneKind } from "@prisma/client";
import { prisma } from "@/lib/db";
import { StockError } from "@/lib/stock";
import { createQrIn } from "@/lib/qr";
import {
  STANDARD_ZONES,
  isPhysicalZoneKind,
  zoneKindIsStaging,
  zoneKindRequiresLevel,
} from "@/lib/zones";

// Этап 5/Пакет 3: серверная логика зон/ячеек. Остатков НЕ трогает (ядро stock.ts не меняется):
// зона и уровень — метаданные Cell, locKey по-прежнему C:<cellId>.

export class CellError extends Error {}

// Транзакционный advisory-lock по (companyId, cellId). Общий ключ сериализует размещение
// группы и старые операции размещения на ОДНОЙ ячейке: оба пути берут этот лок, поэтому
// «увидели пустую ячейку → оба положили» невозможно. $executeRaw (lock возвращает void).
export async function lockCell(tx: Prisma.TransactionClient, companyId: string, cellId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('skladyx:cell'), hashtext(${`${companyId}:${cellId}`}))`;
}

// Этап 5/Пакет 4–5: инварианты «одна ячейка = одна группа» и «резерв под охлаждение неприкосновенен».
// Старые операции размещения (скан «товар→ячейка», приёмка по заказу) НЕ должны докладывать товар
// в ячейку, где уже лежит размещённая группа (HandlingGroup IN_STORAGE/IN_COOLING) ИЛИ которая
// активно зарезервирована под охлаждение (CellReservation ACTIVE — ячейка при этом пуста).
// Вызывать ВНУТРИ транзакции. Бросает StockError (перехватывается вызывающими → {error}).
export async function assertCellNotHeldByGroup(
  tx: Prisma.TransactionClient,
  companyId: string,
  cellId: string,
): Promise<void> {
  await lockCell(tx, companyId, cellId); // защита от гонки: держим ячейку до конца транзакции
  // Пакет 5: активная бронь под охлаждение (проверяем ДО early-return — резерв-ячейка пуста).
  const reserved = await tx.cellReservation.findFirst({ where: { cellId, status: "ACTIVE" }, select: { id: true } });
  if (reserved) throw new StockError("Ячейка зарезервирована под охлаждение — размещение запрещено");
  // Пакет 8: ячейка занята/зарезервирована под выдачу заказа — чужой товар класть нельзя (симметрично
  // авто-резерву выдачи; проверяем ДО early-return, т.к. зарезервированная ячейка ещё пуста по остатку).
  const issueHold = await tx.orderIssueCell.findFirst({ where: { cellId, status: { not: "RELEASED" } }, select: { id: true } });
  if (issueHold) throw new StockError("Ячейка зарезервирована под выдачу заказа — размещение запрещено");
  const bals = await tx.stockBalance.findMany({
    where: { companyId, cellId, qty: { gt: 0 } },
    select: { lotId: true },
  });
  if (bals.length === 0) return;
  const grp = await tx.handlingGroup.findFirst({
    where: { companyId, status: { in: ["IN_STORAGE", "IN_COOLING"] }, lotId: { in: bals.map((b) => b.lotId) } },
    select: { id: true },
  });
  if (grp) throw new StockError("Ячейка занята группой (паллетой) — размещение другого товара запрещено");
}

// Создать стандартные зоны склада в ПЕРЕДАННОЙ транзакции (идемпотентно).
// Используется при атомарном создании склада (склад + 7 зон в одной транзакции).
export async function createStandardZonesInTx(
  tx: Prisma.TransactionClient,
  companyId: string,
  warehouseId: string,
): Promise<void> {
  for (const z of STANDARD_ZONES) {
    const exists = await tx.warehouseZone.findUnique({
      where: { warehouseId_code: { warehouseId, code: z.code } },
    });
    if (!exists)
      await tx.warehouseZone.create({
        data: { companyId, warehouseId, code: z.code, name: z.name, kind: z.kind, sortOrder: z.sortOrder },
      });
  }
}

// Создать стандартные зоны склада (идемпотентно, собственная транзакция).
export async function ensureStandardZones(companyId: string, warehouseId: string): Promise<void> {
  await prisma.$transaction((tx) => createStandardZonesInTx(tx, companyId, warehouseId));
}

// Обратная совместимость: массив кодов + один уровень → число созданных (используется старыми
// верификаторами и changeCellZone). Новый путь (ручное/массовое с уровнями) — createCellsBatch.
export async function createCellsInZone(input: {
  companyId: string;
  warehouseId: string;
  zoneId: string;
  codes: string[];
  level: number | null;
}): Promise<number> {
  const res = await createCellsBatch({
    companyId: input.companyId,
    warehouseId: input.warehouseId,
    zoneId: input.zoneId,
    items: input.codes.map((code) => ({ code, level: input.level })),
  });
  return res.created;
}

// Создание ячеек в физической зоне (ручное = один элемент, массовое = много), одной транзакцией:
// при любой ошибке набор не создаётся частично. Виртуальная зона запрещена; для STORAGE уровень >= 1,
// для остальных физических — уровень должен быть null. isStaging синхронизируется с зоной ISSUE.
// Существующие коды пропускаются и возвращаются в skipped (отчёт created/skipped).
export async function createCellsBatch(input: {
  companyId: string;
  warehouseId: string;
  zoneId: string;
  items: { code: string; level: number | null }[];
}): Promise<{ created: number; skipped: string[] }> {
  if (input.items.length === 0) throw new CellError("Нет ячеек для создания");
  if (input.items.length > 500) throw new CellError("Не больше 500 ячеек за раз");
  return prisma.$transaction(async (tx) => {
    const zone = await tx.warehouseZone.findFirst({
      where: { id: input.zoneId, companyId: input.companyId, warehouseId: input.warehouseId },
    });
    if (!zone) throw new CellError("Зона не найдена");
    if (!isPhysicalZoneKind(zone.kind))
      throw new CellError("Нельзя создавать ячейки в виртуальной зоне");
    const isStaging = zoneKindIsStaging(zone.kind);

    let created = 0;
    const skipped: string[] = [];
    const seen = new Set<string>();
    for (const it of input.items) {
      const code = it.code.trim();
      if (!code) throw new CellError("Пустой код ячейки");
      if (seen.has(code)) continue; // дубли в самом наборе
      seen.add(code);
      const level = normalizeLevel(zone.kind, it.level);
      const exists = await tx.cell.findUnique({ where: { warehouseId_code: { warehouseId: input.warehouseId, code } } });
      if (exists) { skipped.push(code); continue; }
      const cell = await tx.cell.create({
        data: { companyId: input.companyId, warehouseId: input.warehouseId, code, zoneId: zone.id, level, isStaging },
      });
      await createQrIn(tx, { companyId: input.companyId, type: "CELL", refId: cell.id });
      created++;
    }
    return { created, skipped };
  });
}

// Ячейка «использована» — по ней когда-либо было движение/остаток/резерв/единица. Код такой ячейки
// менять и физически удалять нельзя (только деактивировать). Максимально широкий набор ссылок на cellId.
export async function cellUsed(tx: Prisma.TransactionClient, cellId: string): Promise<boolean> {
  const [bal, mv, sr, cr, oic, unit] = await Promise.all([
    tx.stockBalance.findFirst({ where: { cellId }, select: { id: true } }),
    tx.stockMovement.findFirst({ where: { OR: [{ fromCellId: cellId }, { toCellId: cellId }] }, select: { id: true } }),
    tx.stockReservation.findFirst({ where: { cellId }, select: { id: true } }),
    tx.cellReservation.findFirst({ where: { cellId }, select: { id: true } }),
    tx.orderIssueCell.findFirst({ where: { cellId }, select: { id: true } }),
    tx.itemUnit.findFirst({ where: { cellId }, select: { id: true } }),
  ]);
  return !!(bal || mv || sr || cr || oic || unit);
}

// Ячейка «занята сейчас» — есть текущий остаток/единица/активный резерв (деактивировать нельзя).
export async function cellOccupied(tx: Prisma.TransactionClient, cellId: string): Promise<boolean> {
  const [bal, unit, cr, oic, sr] = await Promise.all([
    tx.stockBalance.findFirst({ where: { cellId, qty: { gt: 0 } }, select: { id: true } }),
    tx.itemUnit.findFirst({ where: { cellId }, select: { id: true } }),
    tx.cellReservation.findFirst({ where: { cellId, status: "ACTIVE" }, select: { id: true } }),
    tx.orderIssueCell.findFirst({ where: { cellId, status: { not: "RELEASED" } }, select: { id: true } }),
    tx.stockReservation.findFirst({ where: { cellId, status: "ACTIVE" }, select: { id: true } }),
  ]);
  return !!(bal || unit || cr || oic || sr);
}

// Переименовать неиспользованную ячейку (после первого движения/резерва/задачи код менять нельзя).
// QR не трогаем — он указывает на cellId, а не на код.
export async function renameCell(companyId: string, cellId: string, newCode: string): Promise<{ warehouseId: string }> {
  const code = newCode.trim();
  if (!code) throw new CellError("Укажите код ячейки");
  return prisma.$transaction(async (tx) => {
    const cell = await tx.cell.findFirst({ where: { id: cellId, companyId } });
    if (!cell) throw new CellError("Ячейка не найдена");
    await lockCell(tx, companyId, cellId);
    if (await cellUsed(tx, cellId)) throw new CellError("Ячейка уже использовалась — код менять нельзя, только деактивировать");
    if (code !== cell.code) {
      const dup = await tx.cell.findUnique({ where: { warehouseId_code: { warehouseId: cell.warehouseId, code } } });
      if (dup) throw new CellError("Ячейка с таким кодом уже существует");
      await tx.cell.update({ where: { id: cellId }, data: { code } });
    }
    return { warehouseId: cell.warehouseId };
  });
}

// Удалить неиспользованную ячейку — атомарно с её внутренним кодом/QR.
export async function deleteCell(companyId: string, cellId: string): Promise<{ warehouseId: string }> {
  return prisma.$transaction(async (tx) => {
    const cell = await tx.cell.findFirst({ where: { id: cellId, companyId } });
    if (!cell) throw new CellError("Ячейка не найдена");
    await lockCell(tx, companyId, cellId);
    if (await cellUsed(tx, cellId)) throw new CellError("Ячейка уже использовалась — удалять нельзя, только деактивировать");
    await tx.qrCode.deleteMany({ where: { type: "CELL", refId: cellId } });
    await tx.cell.delete({ where: { id: cellId } });
    return { warehouseId: cell.warehouseId };
  });
}

// Деактивировать/активировать ячейку. Деактивация запрещена при остатке/единице/активном резерве.
export async function setCellActive(companyId: string, cellId: string, active: boolean): Promise<{ warehouseId: string }> {
  return prisma.$transaction(async (tx) => {
    const cell = await tx.cell.findFirst({ where: { id: cellId, companyId } });
    if (!cell) throw new CellError("Ячейка не найдена");
    await lockCell(tx, companyId, cellId);
    if (!active && (await cellOccupied(tx, cellId)))
      throw new CellError("Нельзя деактивировать ячейку с остатком, единицей или активным резервом");
    await tx.cell.update({ where: { id: cellId }, data: { isActive: active } });
    return { warehouseId: cell.warehouseId };
  });
}

// Перенести ячейку в другую физическую зону (замена старому переключателю «зона выдачи»).
export async function changeCellZone(input: {
  companyId: string;
  cellId: string;
  zoneId: string;
  level: number | null;
}): Promise<{ warehouseId: string }> {
  return prisma.$transaction(async (tx) => {
    const cell = await tx.cell.findFirst({ where: { id: input.cellId, companyId: input.companyId } });
    if (!cell) throw new CellError("Ячейка не найдена");
    // Занятую ячейку переносить нельзя: сначала переместить товар через ядро остатков.
    // Занята, если есть партионный остаток (StockBalance qty>0) ИЛИ поштучная единица (ItemUnit)
    // с этим cellId (moveUnit обнуляет cellId при выходе — остаются только физически лежащие).
    const [lotHere, unitHere] = await Promise.all([
      tx.stockBalance.findFirst({ where: { cellId: cell.id, qty: { gt: 0 } }, select: { id: true } }),
      tx.itemUnit.findFirst({ where: { cellId: cell.id }, select: { id: true } }),
    ]);
    if (lotHere || unitHere)
      throw new CellError("Нельзя изменить зону занятой ячейки. Сначала переместите товар");
    const zone = await tx.warehouseZone.findFirst({
      where: { id: input.zoneId, companyId: input.companyId, warehouseId: cell.warehouseId },
    });
    if (!zone) throw new CellError("Зона не найдена");
    if (!isPhysicalZoneKind(zone.kind))
      throw new CellError("Нельзя перенести ячейку в виртуальную зону");
    const level = normalizeLevel(zone.kind, input.level);
    await tx.cell.update({
      where: { id: cell.id },
      data: { zoneId: zone.id, level, isStaging: zoneKindIsStaging(zone.kind) },
    });
    return { warehouseId: cell.warehouseId };
  });
}

// Пакет 9A: системные зоны фиксированы (ровно 7 на склад, один kind каждого вида). Переименование и
// добавление зон закрыто — функции renameZone/addPhysicalZone удалены. Зоны создаёт только
// createStandardZonesInTx при создании склада; изменить/добавить/удалить/деактивировать нельзя.

// Уровень: для STORAGE обязателен и >= 1; для остальных физических зон — всегда null (задавать запрещено).
function normalizeLevel(kind: ZoneKind, level: number | null): number | null {
  if (zoneKindRequiresLevel(kind)) {
    if (level == null || !Number.isInteger(level) || level < 1)
      throw new CellError("Для зоны хранения укажите уровень (целое ≥ 1)");
    return level;
  }
  if (level != null) throw new CellError("Уровень задаётся только для зоны хранения");
  return null;
}

// Тип ошибки для actions: польз. сообщение из CellError, иначе — общий текст.
export function cellErrorMessage(e: unknown): string {
  if (e instanceof CellError) return e.message;
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
    return "Такая ячейка уже существует";
  return "Не удалось выполнить действие";
}
