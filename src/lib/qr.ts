import "server-only";
import { customAlphabet } from "nanoid";
import { prisma } from "@/lib/db";
import { requestBaseUrl } from "@/lib/request-url";
import type { Prisma, QrType } from "@prisma/client";

// QR-коды: в этикетку кодируется URL <домен организации>/q/<code>. Код — 10 символов
// алфавита Крокфорда (без 0/O, 1/I/L и т.п. неоднозначностей при ручном вводе).

const generateCode = customAlphabet("23456789ABCDEFGHJKMNPQRSTVWXYZ", 10);

// R1/TENANT-001: URL строится от домена ТЕКУЩЕЙ организации (request-host), не от глобального APP_URL —
// чтобы QR второй организации не вёл на РостАгро. Для РостАгро host совпадает с APP_URL → URL не меняется.
export async function qrUrl(code: string): Promise<string> {
  const base = await requestBaseUrl();
  return `${base}/q/${code}`;
}

// Создание QR внутри транзакции документа (например, проведения приемки).
// Коллизия кода при 30^10 вариантов практически исключена, но на всякий случай — ретраи.
export async function createQrIn(
  tx: Prisma.TransactionClient,
  args: { companyId: string; type: QrType; refId: string },
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateCode();
    const exists = await tx.qrCode.findUnique({ where: { code } });
    if (exists) continue;
    await tx.qrCode.create({ data: { ...args, code } });
    return code;
  }
  throw new Error("Не удалось сгенерировать уникальный QR-код");
}

// Резолвер кода. Проверку companyId делает вызывающий код (коды глобально уникальны).
export async function resolveQr(code: string) {
  return prisma.qrCode.findUnique({ where: { code: code.trim().toUpperCase() } });
}

// Достаёт код из отсканированной строки: полный URL или голый код.
// Форматы: 10 символов Крокфорда (обычные QR) и id позиций заказа поставщику
// «дата-№заказа-№строки» (6072026-12-1, единицы — с суффиксом 6072026-12-1-2;
// legacy-формат «дата+номер дня» 6072026001 тоже принимается).
const CODE_RE = /^([2-9A-HJKMNP-TV-Z]{10}|\d{7,14}(?:-\d{1,6}){0,3})$/i;

export function parseScannedCode(raw: string): string | null {
  const s = raw.trim();
  const m = s.match(/\/q\/([0-9A-Za-z-]{6,24})\b/);
  const candidate = m ? m[1] : s;
  if (CODE_RE.test(candidate)) return candidate.toUpperCase();
  return null;
}
