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

// Массовое создание ячеек в физической зоне. Виртуальная зона запрещена; для STORAGE уровень >= 1.
// isStaging синхронизируется с зоной ISSUE. Возвращает число созданных ячеек.
export async function createCellsInZone(input: {
  companyId: string;
  warehouseId: string;
  zoneId: string;
  codes: string[];
  level: number | null;
}): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const zone = await tx.warehouseZone.findFirst({
      where: { id: input.zoneId, companyId: input.companyId, warehouseId: input.warehouseId },
    });
    if (!zone) throw new CellError("Зона не найдена");
    if (!isPhysicalZoneKind(zone.kind))
      throw new CellError("Нельзя создавать ячейки в виртуальной зоне");
    const level = normalizeLevel(zone.kind, input.level);
    const isStaging = zoneKindIsStaging(zone.kind);

    let count = 0;
    for (const code of input.codes) {
      const exists = await tx.cell.findUnique({ where: { warehouseId_code: { warehouseId: input.warehouseId, code } } });
      if (exists) continue;
      const cell = await tx.cell.create({
        data: { companyId: input.companyId, warehouseId: input.warehouseId, code, zoneId: zone.id, level, isStaging },
      });
      await createQrIn(tx, { companyId: input.companyId, type: "CELL", refId: cell.id });
      count++;
    }
    return count;
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

// Переименовать зону (названия зон настраиваются организацией; kind неизменен).
export async function renameZone(companyId: string, zoneId: string, name: string): Promise<{ warehouseId: string }> {
  const zone = await prisma.warehouseZone.findFirst({ where: { id: zoneId, companyId } });
  if (!zone) throw new CellError("Зона не найдена");
  const trimmed = name.trim();
  if (!trimmed) throw new CellError("Укажите название зоны");
  await prisma.warehouseZone.update({ where: { id: zone.id }, data: { name: trimmed } });
  return { warehouseId: zone.warehouseId };
}

// Добавить дополнительную ФИЗИЧЕСКУЮ зону нужного kind (допускается несколько зон одного kind).
// Код генерируется уникальным в пределах склада: KIND-2, KIND-3, …
export async function addPhysicalZone(input: {
  companyId: string;
  warehouseId: string;
  kind: ZoneKind;
  name: string;
}): Promise<void> {
  if (!isPhysicalZoneKind(input.kind)) throw new CellError("Добавлять можно только физические зоны");
  const name = input.name.trim();
  if (!name) throw new CellError("Укажите название зоны");
  await prisma.$transaction(async (tx) => {
    const existing = await tx.warehouseZone.findMany({
      where: { warehouseId: input.warehouseId, code: { startsWith: input.kind } },
      select: { code: true },
    });
    const taken = new Set(existing.map((z) => z.code));
    let n = 2;
    let code = `${input.kind}-${n}`;
    while (taken.has(code)) code = `${input.kind}-${++n}`;
    const base = STANDARD_ZONES.find((z) => z.kind === input.kind);
    await tx.warehouseZone.create({
      data: {
        companyId: input.companyId,
        warehouseId: input.warehouseId,
        code,
        name,
        kind: input.kind,
        sortOrder: (base?.sortOrder ?? 20) + n,
      },
    });
  });
}

// Уровень: для STORAGE обязателен и >= 1; для прочих физических зон — необязателен (если задан, >= 1).
function normalizeLevel(kind: ZoneKind, level: number | null): number | null {
  if (zoneKindRequiresLevel(kind)) {
    if (level == null || !Number.isInteger(level) || level < 1)
      throw new CellError("Для зоны хранения укажите уровень (целое ≥ 1)");
    return level;
  }
  if (level == null) return null;
  if (!Number.isInteger(level) || level < 1) throw new CellError("Уровень должен быть целым ≥ 1");
  return level;
}

// Тип ошибки для actions: польз. сообщение из CellError, иначе — общий текст.
export function cellErrorMessage(e: unknown): string {
  if (e instanceof CellError) return e.message;
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
    return "Такая ячейка уже существует";
  return "Не удалось выполнить действие";
}
