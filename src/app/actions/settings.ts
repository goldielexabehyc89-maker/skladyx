"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { updateSettings, type CompanySettings } from "@/lib/settings";
import type { FormState } from "@/app/actions/warehouses";

export async function updateCompanySettingsAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);

  const labelWidthMm = Number(formData.get("labelWidthMm"));
  const labelHeightMm = Number(formData.get("labelHeightMm"));
  if (!Number.isInteger(labelWidthMm) || !Number.isInteger(labelHeightMm))
    return { error: "Размер этикетки — целые числа в мм" };

  const patch: Partial<CompanySettings> = {
    labelWidthMm,
    labelHeightMm,
  };

  // Пакет 10: legacy-настройки прямой выдачи/подтверждения правим ТОЛЬКО когда их секция отрисована
  // (скрытый маркер legacySettingsPresent). При скрытом старом интерфейсе значения не сбрасываем.
  if (formData.has("legacySettingsPresent")) {
    patch.directIssueEnabled = formData.get("directIssueEnabled") === "on";
    patch.issueConfirmationRequired = formData.get("issueConfirmationRequired") === "on";
  }

  // Пакет 9A: порог температуры X настраивается ВСЕГДА (даже при выключенных бизнес-флагах).
  // Отправляется формой только когда поле присутствует в разметке (patch не трогает X иначе).
  if (formData.has("tempThresholdX")) {
    const xRaw = String(formData.get("tempThresholdX") ?? "").trim().replace(",", ".");
    if (xRaw === "") {
      patch.tempThresholdX = null;
    } else {
      const x = Number(xRaw);
      if (!Number.isFinite(x) || x < -100 || x > 100)
        return { error: "Порог температуры X: число от −100 до 100 °C" };
      patch.tempThresholdX = x;
    }
  }

  // Пакет 9A: формат этикетки ячейки (QR/CODE128/BOTH).
  const fmt = String(formData.get("cellLabelFormat") ?? "");
  if (fmt === "QR" || fmt === "CODE128" || fmt === "BOTH") patch.cellLabelFormat = fmt;

  try {
    await updateSettings(s.companyId, patch);
  } catch {
    return { error: "Размер этикетки: от 20 до 150 мм" };
  }
  revalidatePath("/warehouse/settings");
  revalidatePath("/warehouse");
  return {};
}

// Пакет 10: warehouse-scoped R (°C/час) — редактирование прямо со страницы настроек для единственного
// активного склада. Меняем ТОЛЬКО coolingRate (без риска задеть name/isActive). nullable, при заполнении > 0.
export async function updateWarehouseRateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);
  const id = String(formData.get("id") ?? "");
  await s.warehouse(id); // проверка принадлежности компании (бросит, если чужой/не найден)
  const rRaw = String(formData.get("coolingRate") ?? "").trim().replace(",", ".");
  let coolingRate: number | null;
  if (rRaw === "") coolingRate = null;
  else {
    const r = Number(rRaw);
    if (!Number.isFinite(r) || r <= 0) return { error: "Скорость охлаждения R должна быть больше 0 (°C/час)" };
    coolingRate = r;
  }
  await prisma.warehouse.update({ where: { id }, data: { coolingRate } });
  revalidatePath("/warehouse/settings");
  revalidatePath(`/warehouse/warehouses/${id}`);
  return {};
}
