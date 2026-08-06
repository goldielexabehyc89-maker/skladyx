"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
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
    directIssueEnabled: formData.get("directIssueEnabled") === "on",
    issueConfirmationRequired: formData.get("issueConfirmationRequired") === "on",
    labelWidthMm,
    labelHeightMm,
  };

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
