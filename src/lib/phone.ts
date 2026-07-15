// Нормализация российского номера телефона к виду +7XXXXXXXXXX.
// Принимает: +79851801650, 89851801650, 9851801650 (а также со скобками/дефисами/пробелами).
export function normalizePhone(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  let d = raw.replace(/[^\d]/g, "");
  if (d.length === 11 && (d.startsWith("7") || d.startsWith("8"))) d = d.slice(1);
  if (d.length === 10 && d.startsWith("9")) return `+7${d}`;
  return null;
}

// Похоже ли на телефон (для выбора способа входа: телефон или email).
export function looksLikePhone(input: string): boolean {
  return /^[\d+()\-\s]+$/.test(input.trim());
}
