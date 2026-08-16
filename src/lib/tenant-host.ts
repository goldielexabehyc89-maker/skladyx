// Резолвинг org-slug из host для SaaS-схемы <org-slug>.<base-domain>/<module>.
//
// Чистый модуль (без prisma / server-only): используется и в server-коде, и в verify-скриптах.
// Разрешение Company по slug и сверка host==session.companyId — в server-only @/lib/tenant-auth.
//
// Поведение (S3):
//  - <org>.<base>                       → <org>
//  - <prefix><org>.<base> (HOST_ORG_PREFIX) → <org>   (staging-<org> на staging)
//  - неизвестный slug                    → Company не найдётся (обрабатывает tenant-auth)
//  - apex/www/чужой домен/голый host/IP  → production: отказ (fail-closed); development: DEFAULT_ORG_SLUG
//  - localhost                           → только development: DEFAULT_ORG_SLUG

export type HostResolveResult = { slug: string } | { slug: null; error: string };

export interface HostResolveOpts {
  baseDomain: string; // напр. skladyx.ru
  prefix: string; // '' в prod; 'staging-' на staging
  defaultSlug: string; // применяется ТОЛЬКО в development
  isProd: boolean;
}

/** Хосты, где поддомен не является org-slug (dev/локалка/прямой IP). */
function isBareHost(hostname: string): boolean {
  if (!hostname) return true;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true; // IPv4-литерал
  if (hostname.includes(":") && !hostname.includes(".")) return true; // IPv6-литерал
  return false;
}

export function resolveOrgSlug(host: string | null | undefined, opts: HostResolveOpts): HostResolveResult {
  const { baseDomain, prefix, defaultSlug, isProd } = opts;
  // fail-closed в production; мягкий дефолт в development
  const fallback = (): HostResolveResult =>
    isProd ? { slug: null, error: "Организация не найдена" } : { slug: defaultSlug };

  const hostname = (host ?? "").split(":")[0].trim().toLowerCase();
  if (isBareHost(hostname)) return fallback();

  const suffix = "." + baseDomain.toLowerCase();
  if (!hostname.endsWith(suffix)) return fallback(); // apex, www на apex, чужой домен

  let sub = hostname.slice(0, -suffix.length); // 'rostagro' | 'staging-rostagro' | 'www' | 'a.b'
  if (!sub || sub === "www") return fallback();
  if (sub.includes(".")) return fallback(); // многоуровневый поддомен — не наша схема

  if (prefix) {
    // На контуре с префиксом принимаем только host этого контура.
    if (!sub.startsWith(prefix)) return fallback();
    sub = sub.slice(prefix.length);
  }

  if (!/^[a-z0-9-]+$/.test(sub)) return fallback();
  return { slug: sub };
}

// R1/TENANT-001: базовый URL организации по её request-host (не глобальный APP_URL) — чтобы QR/ссылки
// вели на домен конкретной организации. localhost/IPv4/IPv6-литерал → http, иначе https. Чистая функция.
export function baseUrlFromHost(host: string | null | undefined): string | null {
  const raw = (host ?? "").trim();
  if (!raw) return null;
  const hostname = raw.split(":")[0].toLowerCase();
  const isLocal = hostname === "localhost" || hostname.endsWith(".localhost") || /^127\./.test(hostname) || hostname === "::1" || hostname === "[::1]" || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
  return `${isLocal ? "http" : "https"}://${raw}`;
}

/** Резолвит slug из host по переменным окружения контура. */
export function orgSlugFromHost(host: string | null | undefined): HostResolveResult {
  return resolveOrgSlug(host, {
    baseDomain: process.env.TENANT_BASE_DOMAIN || "skladyx.ru",
    prefix: process.env.HOST_ORG_PREFIX || "",
    defaultSlug: process.env.DEFAULT_ORG_SLUG || "rostagro",
    isProd: process.env.NODE_ENV === "production",
  });
}
