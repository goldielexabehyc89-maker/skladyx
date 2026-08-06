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
  // Этап 5/Пакет 4: общий порог допустимой температуры X, °C (nullable, без prod-default).
  // Пока null — групповая приёмка заблокирована. temperature <= X → STORAGE, иначе COOLING.
  tempThresholdX: z.number().min(-100).max(100).nullable().default(null),
  // Пакет 9A: формат этикетки ячейки. Не влияет на базу/логику — только на печать. Один и тот же
  // внутренний 10-символьный код кодируется как QR и/или Code 128.
  cellLabelFormat: z.enum(["QR", "CODE128", "BOTH"]).default("QR"),
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
