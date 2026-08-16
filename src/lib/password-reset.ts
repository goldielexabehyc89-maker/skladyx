import "server-only";
import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { requestBaseUrl } from "@/lib/request-url";

// Одноразовые ссылки установки/сброса пароля. Выдаёт администратор, почта не нужна.

const TOKEN_TTL_HOURS = 24;

export async function createPasswordToken(userId: string): Promise<string> {
  // старые неиспользованные ссылки гасим — активна только последняя
  await prisma.authToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });
  const token = crypto.randomBytes(32).toString("hex");
  await prisma.authToken.create({
    data: {
      userId,
      token,
      purpose: "set-password",
      expiresAt: new Date(Date.now() + TOKEN_TTL_HOURS * 3600 * 1000),
    },
  });
  return token;
}

// S3 tenant-safe: ссылка строится от host организации администратора (текущий запрос),
// а не от глобального APP_URL — иначе ссылка для второго tenant вела бы на РостАгро.
// R1: единый источник базового URL организации — requestBaseUrl() (тот же, что у QR).
export async function passwordLink(token: string): Promise<string> {
  return `${await requestBaseUrl()}/auth/set/${token}`;
}

export async function validateToken(token: string) {
  const t = await prisma.authToken.findUnique({ where: { token } });
  if (!t || t.usedAt || t.expiresAt < new Date()) return null;
  return t;
}
