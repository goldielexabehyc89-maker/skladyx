"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { updateSettings, type CompanySettings } from "@/lib/settings";
import { groupReceivingEnabled } from "@/lib/roles";
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

  // Этап 5/Пакет 4: порог температуры X (только когда поле отрисовано — иначе X не трогаем).
  if (groupReceivingEnabled()) {
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

  try {
    await updateSettings(s.companyId, patch);
  } catch {
    return { error: "Размер этикетки: от 20 до 150 мм" };
  }
  revalidatePath("/warehouse/settings");
  revalidatePath("/warehouse");
  return {};
}
