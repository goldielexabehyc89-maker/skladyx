import type { BarcodeSymbology } from "@prisma/client";

// Этап 5/Пакет 9A: заводские штрихкоды EAN-8/EAN-13. Client-safe (без prisma/server-only) — чистые
// функции валидации и классификации скана. Пока НЕ подключено к операциям Пакетов 4–8 (это Пакет 9B):
// здесь только разбор внутреннего кода, проверка EAN и классификация, чтобы EAN не был ошибочно
// принят за внутренний QR или код заказа поставщику.

// Внутренний код (QR/Code128 ячеек и пр.) — ровно 10 символов алфавита Крокфорда (см. qr.ts).
// EAN (8 или 13 цифр) сюда не попадает: разная длина и алфавит.
const INTERNAL_RE = /^[2-9A-HJKMNP-TV-Z]{10}$/;

// Разбор ВНУТРЕННЕГО кода: поддерживает URL /q/<code> и «голый» код; иначе null. Не принимает EAN и
// не принимает supplier-order-line label (это ответственность старого parseScannedCode в qr.ts).
export function parseInternalCode(raw: string): string | null {
  const s = raw.trim().toUpperCase();
  const m = s.match(/\/Q\/([2-9A-HJKMNP-TV-Z]{10})\b/);
  const cand = m ? m[1] : s;
  return INTERNAL_RE.test(cand) ? cand : null;
}

// Контрольная цифра EAN (mod-10, веса 3/1 справа налево). Годится для EAN-8 и EAN-13.
export function eanChecksumValid(code: string): boolean {
  if (!/^\d+$/.test(code)) return false;
  if (code.length !== 8 && code.length !== 13) return false;
  const digits = code.split("").map((d) => Number(d));
  const check = digits.pop() as number;
  let sum = 0;
  for (let i = digits.length - 1, k = 0; i >= 0; i--, k++) sum += digits[i] * (k % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === check;
}

export function eanSymbology(code: string): BarcodeSymbology | null {
  if (code.length === 8) return "EAN8";
  if (code.length === 13) return "EAN13";
  return null;
}

// Валидный EAN: 8 или 13 цифр с верной контрольной цифрой. Иначе null.
export function parseEan(raw: string): { code: string; symbology: BarcodeSymbology } | null {
  const code = raw.trim();
  if (!/^\d+$/.test(code)) return null;
  const sym = eanSymbology(code);
  if (!sym) return null;
  if (!eanChecksumValid(code)) return null;
  return { code, symbology: sym };
}

export type ScanClass =
  | { kind: "internal"; code: string }
  | { kind: "ean"; code: string; symbology: BarcodeSymbology }
  | { kind: "unknown"; raw: string };

// Классификация скана БЕЗ обращения к БД: сначала внутренний 10-символьный код, затем валидный EAN.
// Разные длины (10 vs 8/13) и алфавит гарантируют, что EAN не спутается с внутренним кодом.
export function classifyScan(raw: string): ScanClass {
  const internal = parseInternalCode(raw);
  if (internal) return { kind: "internal", code: internal };
  const ean = parseEan(raw);
  if (ean) return { kind: "ean", code: ean.code, symbology: ean.symbology };
  return { kind: "unknown", raw: raw.trim() };
}
