import "server-only";
import { headers } from "next/headers";
import { baseUrlFromHost } from "@/lib/tenant-host";

// R1/TENANT-001: базовый URL текущей организации из request-host (домен, на котором работает админ),
// а не из глобального APP_URL — иначе ссылки/QR второй организации вели бы на РостАгро.
// Безопасный fallback: вне HTTP-запроса (headers() недоступен) — process.env.APP_URL, затем localhost.
// Для РостАгро (host rostagro.skladyx.ru / staging-rostagro.skladyx.ru) результат совпадает с APP_URL.
export async function requestBaseUrl(): Promise<string> {
  try {
    const host = (await headers()).get("host");
    const base = baseUrlFromHost(host);
    if (base) return base;
  } catch {
    // вызов вне контекста запроса — переходим к APP_URL
  }
  return process.env.APP_URL || "http://localhost:3000";
}
