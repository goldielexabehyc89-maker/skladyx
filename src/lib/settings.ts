import "server-only";
import { z } from "zod";
import { prisma } from "@/lib/db";

// Настройки компании — JSON-поле Company.settings с zod-схемой и дефолтами.

export const companySettingsSchema = z.object({
  // Прямая выдача (скан товаров → назначение сотрудника, минуя заявку)
  directIssueEnabled: z.boolean().default(true),
  // Требовать подтверждение получения сотрудником в телефоне
  issueConfirmationRequired: z.boolean().default(true),
  // Размер этикетки термопринтера, мм
  labelWidthMm: z.number().int().min(20).max(150).default(58),
  labelHeightMm: z.number().int().min(20).max(150).default(40),
});

export type CompanySettings = z.infer<typeof companySettingsSchema>;

export async function getSettings(companyId: string): Promise<CompanySettings> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { settings: true },
  });
  const parsed = companySettingsSchema.safeParse(company?.settings ?? {});
  return parsed.success ? parsed.data : companySettingsSchema.parse({});
}

export async function updateSettings(
  companyId: string,
  patch: Partial<CompanySettings>,
): Promise<CompanySettings> {
  const current = await getSettings(companyId);
  const next = companySettingsSchema.parse({ ...current, ...patch });
  await prisma.company.update({ where: { id: companyId }, data: { settings: next } });
  return next;
}
