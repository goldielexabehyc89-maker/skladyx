import { SignJWT, jwtVerify } from "jose";

// Edge-safe (без next/headers и server-only): используется и в middleware, и на сервере.

export const SESSION_COOKIE = "skx_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 дней

export type Role = "ADMIN" | "STOREKEEPER" | "EMPLOYEE";

export interface SessionData {
  userId: string;
  login: string; // телефон (+7XXXXXXXXXX) или email у старых учёток
  name: string;
  role: Role;
  companyId: string;
}

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET не задан в окружении");
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(data: SessionData): Promise<string> {
  return new SignJWT({ ...data })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(secretKey());
}

export async function verifySessionToken(token: string): Promise<SessionData | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    return {
      userId: String(payload.userId),
      // старые сессии несут email — принимаем оба ключа
      login: String(payload.login ?? payload.email ?? ""),
      name: String(payload.name ?? ""),
      role: payload.role as Role,
      companyId: String(payload.companyId),
    };
  } catch {
    return null;
  }
}
