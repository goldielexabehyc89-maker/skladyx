import "server-only";
import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { parseEan } from "@/lib/ean";
import { findItemByEan } from "@/lib/barcodes";
import { importExternalOrder, ExternalOrderError } from "@/lib/external-orders";
import { lockCompany } from "@/lib/workflow-tasks";

// Этап 5/Пакет 10: нейтральный API интеграции. Формат конкретной 1С НЕ зашивается — это общий
// контракт (наименование + заводской EAN для товаров; externalId/EAN/quantity для заказов).
// Организация определяется по host (в роуте, через resolveHostCompany); companyId/warehouseId/userId
// из payload НЕ принимаются. Токен сравнивается безопасно и не логируется.

export class IntegrationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// Безопасное сравнение Bearer-токена (constant-time). Пустой серверный токен → доступ закрыт.
export function bearerTokenValid(authHeader: string | null): boolean {
  const expected = process.env.INTEGRATION_API_TOKEN || "";
  if (!expected) return false;
  const m = /^Bearer\s+(.+)$/.exec(authHeader ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Пакет 10 (коррекция): токен привязан к организации. Организацию определяет host, но API разрешён
// ТОЛЬКО если slug этой организации совпадает с INTEGRATION_API_ORG_SLUG. Пустой slug при включённом
// API → доступ закрыт. Значит токен РостАгро не сработает на host другого существующего tenant'а.
export function integrationOrgSlugMatches(slug: string): boolean {
  const allowed = (process.env.INTEGRATION_API_ORG_SLUG || "").trim();
  if (!allowed) return false;
  return allowed === slug;
}

// ── Номенклатура: идемпотентный upsert по [companyId, externalId] ──
// источник API, учёт LOT, единица «шт»; EAN проверяется по длине/контрольной цифре; EAN другого
// товара не перепривязывается; повтор не создаёт дубль; новый EAN можно добавить тому же товару;
// отсутствующие в выгрузке товары не трогаются; весь пакет атомарен (одна ошибка — полный откат).
interface NormItem { externalId: string; name: string; sku: string | null; code: string; symbology: "EAN8" | "EAN13" }

export async function upsertApiItems(
  companyId: string,
  rawItems: unknown,
): Promise<{ processed: number; created: number; updated: number }> {
  if (!Array.isArray(rawItems) || rawItems.length === 0)
    throw new IntegrationError("Ожидался непустой массив items", 400);

  // Полная валидация до транзакции (быстрый отказ, единый формат ошибок).
  const items: NormItem[] = rawItems.map((it, idx) => {
    const o = (it ?? {}) as Record<string, unknown>;
    const externalId = typeof o.externalId === "string" ? o.externalId.trim() : "";
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const eanRaw = typeof o.ean === "string" ? o.ean.trim() : "";
    const sku = typeof o.sku === "string" && o.sku.trim() ? o.sku.trim() : null;
    if (!externalId) throw new IntegrationError(`items[${idx}]: externalId обязателен`, 400);
    if (!name) throw new IntegrationError(`items[${idx}]: name обязателен`, 400);
    const parsed = parseEan(eanRaw);
    if (!parsed) throw new IntegrationError(`items[${idx}]: неверный EAN (нужно 8 или 13 цифр с верной контрольной цифрой)`, 400);
    return { externalId, name, sku, code: parsed.code, symbology: parsed.symbology };
  });
  if (new Set(items.map((i) => i.externalId)).size !== items.length)
    throw new IntegrationError("Дублирующиеся externalId в пакете", 400);
  if (new Set(items.map((i) => i.code)).size !== items.length)
    throw new IntegrationError("Дублирующиеся EAN в пакете", 400);

  let created = 0;
  let updated = 0;
  await prisma.$transaction(async (tx) => {
    // Пакет 10 (коррекция): advisory-лок компании в начале транзакции — сериализует конкурентные
    // выгрузки одного tenant'а (одинаковые запросы не дают дубль item/EAN и не падают в 409/500).
    await lockCompany(tx, companyId);
    // Единица «шт» — get-or-create (пользователю/интеграции выбор не даём); tracking всегда LOT.
    const uom = await tx.uom.upsert({
      where: { companyId_name: { companyId, name: "шт" } },
      update: {},
      create: { companyId, name: "шт", allowFraction: false },
    });
    for (const it of items) {
      const existing = await tx.item.findFirst({ where: { companyId, externalId: it.externalId } });
      const bcOwner = await tx.itemBarcode.findFirst({ where: { companyId, code: it.code } });
      if (bcOwner && (!existing || bcOwner.itemId !== existing.id))
        throw new IntegrationError(`EAN ${it.code} уже привязан к другому товару — перепривязка запрещена`, 409);

      let itemId: string;
      if (existing) {
        await tx.item.update({ where: { id: existing.id }, data: { name: it.name, sku: it.sku, source: "API" } });
        itemId = existing.id;
        updated++;
      } else {
        const item = await tx.item.create({
          data: { companyId, name: it.name, sku: it.sku, uomId: uom.id, tracking: "LOT", source: "API", externalId: it.externalId },
        });
        itemId = item.id;
        created++;
      }
      if (!bcOwner) {
        await tx.itemBarcode.create({ data: { companyId, itemId, code: it.code, symbology: it.symbology, source: "API", isActive: true } });
      } else if (!bcOwner.isActive) {
        await tx.itemBarcode.update({ where: { id: bcOwner.id }, data: { isActive: true } });
      }
    }
  });
  return { processed: items.length, created, updated };
}

// ── Заказы: импорт через существующий importExternalOrder ──
// единственный активный склад организации; товар только по активному EAN; точный повтор идемпотентен;
// изменённый payload существующего заказа → 409 без частичной записи; createdById = null.
export async function importApiOrder(companyId: string, raw: unknown): Promise<{ orderId: string; created: boolean }> {
  const o = (raw ?? {}) as Record<string, unknown>;
  const externalId = typeof o.externalId === "string" ? o.externalId.trim() : "";
  if (!externalId) throw new IntegrationError("externalId обязателен", 400);
  // Пакет 10 (коррекция): arrivalAt валидируем ДО importExternalOrder — только корректный ISO-8601,
  // иначе new Date(...).toISOString() внутри импорта бросил бы неконтролируемый 500.
  let arrivalAt: string | null = null;
  if (o.arrivalAt != null && o.arrivalAt !== "") {
    if (typeof o.arrivalAt !== "string") throw new IntegrationError("arrivalAt должен быть строкой ISO-8601", 400);
    const d = new Date(o.arrivalAt);
    if (Number.isNaN(d.getTime())) throw new IntegrationError("arrivalAt: некорректная дата (нужен формат ISO-8601)", 400);
    arrivalAt = o.arrivalAt;
  }
  if (!Array.isArray(o.lines) || o.lines.length === 0) throw new IntegrationError("lines обязательны и не пусты", 400);

  // Единственный активный склад организации (иначе — понятная ошибка конфигурации).
  const whs = await prisma.warehouse.findMany({ where: { companyId, isActive: true }, select: { id: true } });
  if (whs.length === 0) throw new IntegrationError("Нет активного склада организации — импорт заказов невозможен", 409);
  if (whs.length > 1) throw new IntegrationError("У организации несколько активных складов — импорт заказов требует ровно один активный склад", 409);
  const warehouseId = whs[0].id;

  const lines: { externalLineId: string; itemId: string; requiredQty: number }[] = [];
  for (let i = 0; i < o.lines.length; i++) {
    const l = (o.lines[i] ?? {}) as Record<string, unknown>;
    const externalLineId = typeof l.externalLineId === "string" ? l.externalLineId.trim() : "";
    const eanRaw = typeof l.ean === "string" ? l.ean.trim() : "";
    const quantity = typeof l.quantity === "number" ? l.quantity : Number(l.quantity);
    if (!externalLineId) throw new IntegrationError(`lines[${i}]: externalLineId обязателен`, 400);
    if (!Number.isInteger(quantity) || quantity <= 0) throw new IntegrationError(`lines[${i}]: quantity — целое больше нуля`, 400);
    const found = await findItemByEan(companyId, eanRaw);
    if (!found) throw new IntegrationError(`lines[${i}]: неизвестный или неактивный EAN ${eanRaw}`, 400);
    lines.push({ externalLineId, itemId: found.item.id, requiredQty: quantity });
  }

  try {
    const res = await importExternalOrder({ companyId, warehouseId, externalId, createdById: null, arrivalAt, lines });
    return { orderId: res.orderId, created: res.created };
  } catch (e) {
    if (e instanceof ExternalOrderError) {
      const conflict = /уже импортирован|изменение импортированного/.test(e.message);
      throw new IntegrationError(e.message, conflict ? 409 : 400);
    }
    throw e;
  }
}
