// Резолвинг org-slug из host для SaaS-схемы <org-slug>.skladyx.ru/<module>.
//
// ВАЖНО (этап 1): это НЕ security boundary. Изоляция тенантов и вся безопасность
// сейчас держатся ИСКЛЮЧИТЕЛЬНО на session.companyId + scoped() (src/lib/tenant.ts).
// Эта функция — только точка расширения (для будущего роутинга/брендинга по домену)
// и удобный источник дефолтного slug.
//
// СЛЕДУЮЩИЙ ЭТАП (не сделано здесь): enforce-проверка «org-slug из host == компания
// из сессии»: резолвить Company по slug, сверять с session.companyId, отдавать 403
// при несовпадении, а также решить про cookie domain для поддоменов и уникальность
// User.phone/email в разрезе компании.

const DEFAULT_ORG_SLUG = "rostagro";

/** Хосты, для которых поддомен не является org-slug (dev/локалка/прямой IP). */
function isBareHost(hostname: string): boolean {
  if (!hostname) return true;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  // IPv4/IPv6-литерал — не домен с поддоменом-организацией.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  if (hostname.includes(":") && !hostname.includes(".")) return true;
  return false;
}

/**
 * Достаёт org-slug из host (`rostagro.skladyx.ru` → `rostagro`).
 * Фоллбэк — DEFAULT_ORG_SLUG env, затем встроенный дефолт `rostagro`.
 *
 * @param host значение заголовка Host / X-Forwarded-Host (может быть с портом).
 */
export function getOrgSlugFromHost(host?: string | null): string {
  const fallback = process.env.DEFAULT_ORG_SLUG || DEFAULT_ORG_SLUG;
  if (!host) return fallback;

  const hostname = host.split(":")[0].trim().toLowerCase();
  if (isBareHost(hostname)) return fallback;

  const labels = hostname.split(".");
  // Нужен реальный поддомен: <org>.<domain>.<tld> → минимум 3 лейбла.
  if (labels.length < 3) return fallback;

  const sub = labels[0];
  if (!sub || sub === "www") return fallback;
  return sub;
}

export { DEFAULT_ORG_SLUG };
