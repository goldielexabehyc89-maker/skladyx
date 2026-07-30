import { SignJWT, jwtVerify } from "jose";

// Edge-safe (без next/headers и server-only): используется и в middleware, и на сервере.

export const SESSION_COOKIE = "skx_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 дней

export type Role = "ADMIN" | "STOREKEEPER" | "EMPLOYEE";

const VALID_ROLES: readonly Role[] = ["ADMIN", "STOREKEEPER", "EMPLOYEE"];

// Приводит произвольные данные к валидному набору ролей: оставляет только
// известные значения, убирает дубли; пустой/битый вход → [fallback] (legacy-роль).
// Edge-safe: без обращений к БД и server-only. Права из JWT не удаляем — только чистим.
export function sanitizeRoles(input: unknown, fallback: Role): Role[] {
  const arr = Array.isArray(input) ? input : [];
  const valid = arr.filter((r): r is Role => VALID_ROLES.includes(r as Role));
  const unique = Array.from(new Set(valid));
  return unique.length > 0 ? unique : [fallback];
}

export interface SessionData {
  userId: string;
  login: string; // телефон (+7XXXXXXXXXX) или email у старых учёток
  name: string;
  role: Role; // legacy: основная роль из User.role (сохраняется в переходный период)
  roles: Role[]; // S2 dual-read: набор ролей из UserRole (fallback [role])
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
    const role = payload.role as Role;
    return {
      userId: String(payload.userId),
      // старые сессии несут email — принимаем оба ключа
      login: String(payload.login ?? payload.email ?? ""),
      name: String(payload.name ?? ""),
      role,
      // старые JWT без roles → [role]; невалидные значения отбрасываются
      roles: sanitizeRoles(payload.roles, role),
      companyId: String(payload.companyId),
    };
  } catch {
    return null;
  }
}
