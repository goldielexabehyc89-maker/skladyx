"use server";

import { revalidatePath } from "next/cache";
import { broadcastRealtime } from "@/lib/realtime";
import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { addItemBarcode, setItemBarcodeActive, barcodeErrorMessage } from "@/lib/barcodes";
import type { FormState } from "@/app/actions/warehouses";

const itemSchema = z.object({
  name: z.string().trim().min(1, "Укажите наименование"),
  uomId: z.string().min(1, "Выберите единицу измерения"),
  tracking: z.enum(["LOT", "UNIT"]),
});

export async function createItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);

  const parsed = itemSchema.safeParse({
    name: formData.get("name"),
    uomId: formData.get("uomId"),
    tracking: formData.get("tracking"),
  });
  if (!parsed.success) return { error: parsed.error.errors[0].message };

  const uom = await prisma.uom.findFirst({
    where: { id: parsed.data.uomId, companyId: s.companyId },
  });
  if (!uom) return { error: "Единица измерения не найдена" };

  await prisma.item.create({
    data: {
      companyId: s.companyId,
      name: parsed.data.name,
      uomId: parsed.data.uomId,
      tracking: parsed.data.tracking,
    },
  });
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

  const parsed = itemSchema.safeParse({
    name: formData.get("name"),
    uomId: formData.get("uomId"),
    tracking: formData.get("tracking"),
  });
  if (!parsed.success) return { error: parsed.error.errors[0].message };

  await prisma.item.update({
    where: { id },
    data: {
      name: parsed.data.name,
      uomId: parsed.data.uomId,
      tracking: parsed.data.tracking,
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
