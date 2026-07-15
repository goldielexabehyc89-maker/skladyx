"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import type { FormState } from "@/app/actions/warehouses";

export async function createSupplierAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Укажите название поставщика" };

  const exists = await prisma.supplier.findUnique({
    where: { companyId_name: { companyId: s.companyId, name } },
  });
  if (exists) return { error: `Поставщик «${name}» уже есть` };

  await prisma.supplier.create({
    data: {
      companyId: s.companyId,
      name,
      phone: String(formData.get("phone") ?? "").trim() || null,
      note: String(formData.get("note") ?? "").trim() || null,
    },
  });
  revalidatePath("/warehouse/suppliers");
  revalidatePath("/warehouse/orders/new");
  return {};
}

// Создание поставщика из автокомплита в форме заказа.
export async function createSupplierInlineAction(
  name: string,
): Promise<{ error?: string; id?: string; name?: string }> {
  const session = await requireAdmin();
  const s = scoped(session);

  const trimmed = name.trim();
  if (!trimmed) return { error: "Укажите название поставщика" };

  const exists = await prisma.supplier.findUnique({
    where: { companyId_name: { companyId: s.companyId, name: trimmed } },
  });
  if (exists) {
    if (!exists.isActive) return { error: `Поставщик «${trimmed}» в архиве — активируйте его в справочнике` };
    return { id: exists.id, name: exists.name };
  }

  const supplier = await prisma.supplier.create({
    data: { companyId: s.companyId, name: trimmed },
  });
  revalidatePath("/warehouse/suppliers");
  return { id: supplier.id, name: supplier.name };
}

export async function updateSupplierAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);
  const id = String(formData.get("id") ?? "");
  const supplier = await prisma.supplier.findFirst({ where: { id, companyId: s.companyId } });
  if (!supplier) return { error: "Поставщик не найден" };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Укажите название" };
  const dup = await prisma.supplier.findFirst({
    where: { companyId: s.companyId, name, id: { not: id } },
  });
  if (dup) return { error: `Поставщик «${name}» уже есть` };

  await prisma.supplier.update({
    where: { id },
    data: {
      name,
      phone: String(formData.get("phone") ?? "").trim() || null,
      note: String(formData.get("note") ?? "").trim() || null,
      isActive: formData.get("isActive") === "on",
    },
  });
  revalidatePath("/warehouse/suppliers");
  return {};
}
