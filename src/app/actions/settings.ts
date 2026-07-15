"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { updateSettings } from "@/lib/settings";
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

  try {
    await updateSettings(s.companyId, {
      directIssueEnabled: formData.get("directIssueEnabled") === "on",
      issueConfirmationRequired: formData.get("issueConfirmationRequired") === "on",
      labelWidthMm,
      labelHeightMm,
    });
  } catch {
    return { error: "Размер этикетки: от 20 до 150 мм" };
  }
  revalidatePath("/warehouse/settings");
  revalidatePath("/warehouse");
  return {};
}
