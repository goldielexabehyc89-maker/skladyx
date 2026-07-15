import "server-only";
import crypto from "node:crypto";
import { prisma } from "@/lib/db";

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

export function passwordLink(token: string): string {
  const base = process.env.APP_URL || "http://localhost:3000";
  return `${base}/auth/set/${token}`;
}

export async function validateToken(token: string) {
  const t = await prisma.authToken.findUnique({ where: { token } });
  if (!t || t.usedAt || t.expiresAt < new Date()) return null;
  return t;
}
