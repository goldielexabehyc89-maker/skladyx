import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { parseEan } from "@/lib/ean";

// Этап 5/Пакет 9A: серверная логика EAN номенклатуры (tenant-scoped). Пока не подключено к операциям
// Пакетов 4–8 (Пакет 9B). Один EAN в пределах компании относится только к одному Item; один скан = штука.

export class BarcodeError extends Error {}

// Поиск товара по EAN в пределах компании: только АКТИВНЫЙ штрихкод активного товара (для новых
// операций). Возвращает null, если EAN невалиден/не найден/деактивирован. Не перепривязывает.
export async function findItemByEan(companyId: string, raw: string) {
  const parsed = parseEan(raw);
  if (!parsed) return null;
  const bc = await prisma.itemBarcode.findFirst({
    where: { companyId, code: parsed.code, isActive: true },
    include: { item: true },
  });
  if (!bc || !bc.item.isActive) return null;
  return { item: bc.item, barcode: bc };
}

// Добавить EAN товару. Проверяет длину/контрольную цифру; коллизия с другим товаром — отказ (без
// молчаливой перепривязки). Идемпотентно, если EAN уже у этого товара (реактивирует при необходимости).
export async function addItemBarcode(input: { companyId: string; itemId: string; code: string }): Promise<void> {
  const parsed = parseEan(input.code);
  if (!parsed) throw new BarcodeError("Неверный EAN: ожидается 8 или 13 цифр с верной контрольной цифрой");
  await prisma.$transaction(async (tx) => {
    const item = await tx.item.findFirst({ where: { id: input.itemId, companyId: input.companyId } });
    if (!item) throw new BarcodeError("Товар не найден");
    if (item.source === "API") throw new BarcodeError("Товар из интеграции — ключевые поля только для чтения");
    const existing = await tx.itemBarcode.findFirst({ where: { companyId: input.companyId, code: parsed.code } });
    if (existing) {
      if (existing.itemId === input.itemId) {
        if (!existing.isActive) await tx.itemBarcode.update({ where: { id: existing.id }, data: { isActive: true } });
        return; // уже у этого товара — идемпотентно
      }
      throw new BarcodeError("Этот EAN уже назначен другому товару");
    }
    await tx.itemBarcode.create({
      data: { companyId: input.companyId, itemId: input.itemId, code: parsed.code, symbology: parsed.symbology, source: "MANUAL" },
    });
  });
}

// Деактивировать/активировать EAN (физического удаления нет — история сохраняется). API-коды read-only.
export async function setItemBarcodeActive(companyId: string, barcodeId: string, isActive: boolean): Promise<void> {
  const bc = await prisma.itemBarcode.findFirst({ where: { id: barcodeId, companyId } });
  if (!bc) throw new BarcodeError("Штрихкод не найден");
  if (bc.source === "API") throw new BarcodeError("Штрихкод из интеграции — только для чтения");
  await prisma.itemBarcode.update({ where: { id: bc.id }, data: { isActive } });
}

// Пакет 9B: EAN → itemId в ПЕРЕДАННОЙ транзакции (для операций Пакетов 4–8). Возвращает itemId
// только для валидного EAN активного штрихкода активного товара этой организации; иначе null
// (вызывающий бросает свою доменную ошибку «неизвестный/неактивный/чужой EAN»). Товар определяется
// EAN однозначно; конкретная группа/партия/ячейка выводится вызывающим из контекста задачи/заказа.
export async function eanItemIdInTx(tx: Prisma.TransactionClient, companyId: string, raw: string): Promise<string | null> {
  const parsed = parseEan(raw);
  if (!parsed) return null;
  const bc = await tx.itemBarcode.findFirst({
    where: { companyId, code: parsed.code, isActive: true },
    include: { item: { select: { id: true, isActive: true } } },
  });
  return bc && bc.item.isActive ? bc.itemId : null;
}

export function barcodeErrorMessage(e: unknown): string {
  if (e instanceof BarcodeError) return e.message;
  return "Не удалось выполнить действие со штрихкодом";
}
