// Этап 5/Пакет 3: правила размещения по уровням ячеек. ЧИСТЫЙ policy-хелпер —
// без движения остатков, без prisma, без побочных эффектов (легко тестируется).
// Движение товара и создание задач — следующие пакеты.

export const MIN_LEVEL = 1;
export const PICK_MAX_LEVEL = 2; // сборщик берёт только с уровней 1–2
export const COOLING_FALLBACK_MIN_LEVEL = 3; // fallback после охлаждения — только 3+
export const MOVE_DOWN_MIN_SOURCE_LEVEL = 3; // задача «переместить вниз» — только для источника 3+

// Порядок обычного размещения: сначала нижние уровни (1 → 2 → 3 → …).
// Возвращает уникальные валидные уровни по возрастанию.
export function storageOrder(levels: readonly number[]): number[] {
  return [...new Set(levels.filter((l) => Number.isInteger(l) && l >= MIN_LEVEL))].sort((a, b) => a - b);
}

// Сборщик берёт товар только с уровней 1–2.
export function isPickableLevel(level: number | null | undefined): boolean {
  return level != null && level >= MIN_LEVEL && level <= PICK_MAX_LEVEL;
}

// Fallback-ячейка после охлаждения допускается только на уровне 3 и выше.
export function isCoolingFallbackLevel(level: number | null | undefined): boolean {
  return level != null && level >= COOLING_FALLBACK_MIN_LEVEL;
}

// Задача перемещения вниз создаётся только если товар лежит на уровне 3+.
export function needsMoveDown(sourceLevel: number | null | undefined): boolean {
  return sourceLevel != null && sourceLevel >= MOVE_DOWN_MIN_SOURCE_LEVEL;
}

// Выбрать ячейку для обычного размещения: наименьший уровень, затем стабильно по code.
export function pickStorageCell<T extends { level: number | null; code: string }>(
  cells: readonly T[],
): T | null {
  const eligible = cells.filter((c) => c.level != null && c.level >= MIN_LEVEL);
  if (eligible.length === 0) return null;
  return [...eligible].sort(
    (a, b) => a.level! - b.level! || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  )[0];
}
