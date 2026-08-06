"use server";

import { revalidatePath } from "next/cache";
import { broadcastRealtime } from "@/lib/realtime";
import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { addItemBarcode, setItemBarcodeActive, barcodeErrorMessage, BarcodeError } from "@/lib/barcodes";
import { parseEan } from "@/lib/ean";
import type { FormState } from "@/app/actions/warehouses";

// Пакет 9B: ручной товар для тестового наполнения — название + заводской EAN-8/13 (с контрольной
// цифрой) + необязательный SKU/externalId. Единица «шт» и tracking LOT назначаются автоматически;
// выбор UNIT/LOT и единицы измерения пользователю не показывается.
const createItemSchema = z.object({
  name: z.string().trim().min(1, "Укажите наименование"),
  ean: z.string().trim().min(1, "Укажите заводской EAN (8 или 13 цифр)"),
  sku: z.string().trim().optional(),
});
// Обновление ручного товара: правим только название и статус (единица/tracking скрыты и не меняются).
const updateItemSchema = z.object({
  name: z.string().trim().min(1, "Укажите наименование"),
});

export async function createItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);

  const parsed = createItemSchema.safeParse({
    name: formData.get("name"),
    ean: formData.get("ean"),
    sku: formData.get("sku"),
  });
  if (!parsed.success) return { error: parsed.error.errors[0].message };

  const parsedEan = parseEan(parsed.data.ean);
  if (!parsedEan) return { error: "Неверный EAN — нужно 8 или 13 цифр с верной контрольной цифрой" };
  const sku = parsed.data.sku && parsed.data.sku.length > 0 ? parsed.data.sku : null;

  try {
    // Товар + EAN создаём атомарно: невалидный/чужой EAN не оставит товар-сироту.
    await prisma.$transaction(async (tx) => {
      const clash = await tx.itemBarcode.findFirst({ where: { companyId: s.companyId, code: parsedEan.code } });
      if (clash) throw new BarcodeError("Этот EAN уже привязан к другому товару");
      // Единица «шт» (get-or-create) — пользователю не показываем; tracking всегда LOT.
      const uom = await tx.uom.upsert({
        where: { companyId_name: { companyId: s.companyId, name: "шт" } },
        update: {},
        create: { companyId: s.companyId, name: "шт", allowFraction: false },
      });
      const item = await tx.item.create({
        data: { companyId: s.companyId, name: parsed.data.name, sku, uomId: uom.id, tracking: "LOT", source: "MANUAL" },
      });
      await tx.itemBarcode.create({
        data: { companyId: s.companyId, itemId: item.id, code: parsedEan.code, symbology: parsedEan.symbology, source: "MANUAL", isActive: true },
      });
    });
  } catch (e) {
    if (e instanceof BarcodeError) return { error: e.message };
    if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "P2002") {
      const target = String((e as { meta?: { target?: unknown } }).meta?.target ?? "");
      return { error: target.includes("sku") ? "Такой SKU уже есть" : "Этот EAN уже привязан к другому товару" };
    }
    throw e;
  }
  broadcastRealtime({
    type: "document.created",
    entity: "item",
    companyId: s.companyId,
    actorUserId: session.userId,
  });
  revalidatePath("/warehouse/items");
  redirect("/warehouse/items");
}

export async function updateItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);
  const id = String(formData.get("id") ?? "");
  const current = await s.item(id);
  // Пакет 9A: товары из интеграции (source=API) — ключевые поля только для чтения.
  if (current.source === "API") return { error: "Товар из интеграции — ключевые поля только для чтения" };

  const parsed = updateItemSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) return { error: parsed.error.errors[0].message };

  await prisma.item.update({
    where: { id },
    data: {
      name: parsed.data.name,
      isActive: formData.get("isActive") === "on",
    },
  });
  broadcastRealtime({
    type: "document.updated",
    entity: "item",
    entityId: id,
    companyId: s.companyId,
    actorUserId: session.userId,
  });
  revalidatePath("/warehouse/items");
  revalidatePath(`/warehouse/items/${id}`);
  return {};
}

export async function createUomAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Укажите название единицы измерения" };

  const exists = await prisma.uom.findUnique({
    where: { companyId_name: { companyId: s.companyId, name } },
  });
  if (exists) return { error: `«${name}» уже есть` };

  await prisma.uom.create({
    data: {
      companyId: s.companyId,
      name,
      allowFraction: formData.get("allowFraction") === "on",
    },
  });
  broadcastRealtime({
    type: "document.updated",
    entity: "item",
    companyId: s.companyId,
    actorUserId: session.userId,
  });
  revalidatePath("/warehouse/items/new");
  return {};
}

// Удаление товара (админ): только если товар нигде не использован — нет строк
// заказов поставщикам и складских данных (партий/единиц/движений).
export async function deleteItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);
  const id = String(formData.get("id") ?? "");
  const item = await prisma.item.findFirst({ where: { id, companyId: s.companyId } });
  if (!item) return { error: "Товар не найден" };
  // Пакет 9A: товар из интеграции нельзя удалять (отсутствие в API-sync ≠ удаление/деактивация).
  if (item.source === "API") return { error: "Товар из интеграции — удаление недоступно" };

  const orderLine = await prisma.supplierOrderLine.findFirst({
    where: { companyId: s.companyId, itemId: item.id },
    include: { order: true },
  });
  if (orderLine)
    return {
      error: `Товар в заказе поставщику №${orderLine.order.number} — сначала удалите заказ`,
    };
  const [lot, unit, movement, barcode] = await Promise.all([
    prisma.lot.findFirst({ where: { companyId: s.companyId, itemId: item.id } }),
    prisma.itemUnit.findFirst({ where: { companyId: s.companyId, itemId: item.id } }),
    prisma.stockMovement.findFirst({ where: { companyId: s.companyId, itemId: item.id } }),
    prisma.itemBarcode.findFirst({ where: { companyId: s.companyId, itemId: item.id } }),
  ]);
  if (lot || unit || movement) return { error: "По товару есть складские данные — удалить нельзя" };
  if (barcode) return { error: "У товара есть штрихкоды (EAN) — удаление недоступно" };

  await prisma.item.delete({ where: { id: item.id } });
  broadcastRealtime({
    type: "document.deleted",
    entity: "item",
    entityId: id,
    companyId: s.companyId,
    actorUserId: session.userId,
  });
  revalidatePath("/warehouse/items");
  redirect("/warehouse/items");
}

// Пакет 9A: добавить EAN товару (проверка длины/контрольной цифры; коллизия — отказ без перепривязки).
export async function addBarcodeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);
  const itemId = String(formData.get("itemId") ?? "");
  await s.item(itemId);
  try {
    await addItemBarcode({ companyId: s.companyId, itemId, code: String(formData.get("code") ?? "") });
  } catch (e) {
    return { error: barcodeErrorMessage(e) };
  }
  revalidatePath(`/warehouse/items/${itemId}`);
  return { ok: "EAN добавлен" };
}

// Деактивировать/активировать EAN (физического удаления нет — история сохраняется).
export async function setBarcodeActiveAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);
  const barcodeId = String(formData.get("barcodeId") ?? "");
  const itemId = String(formData.get("itemId") ?? "");
  await s.item(itemId);
  const active = String(formData.get("active") ?? "") === "true";
  try {
    await setItemBarcodeActive(s.companyId, barcodeId, active);
  } catch (e) {
    return { error: barcodeErrorMessage(e) };
  }
  revalidatePath(`/warehouse/items/${itemId}`);
  return { ok: active ? "EAN активирован" : "EAN деактивирован" };
}
