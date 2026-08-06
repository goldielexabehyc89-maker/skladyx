import { NextResponse } from "next/server";
import { integrationApiEnabled } from "@/lib/roles";
import { resolveHostCompany } from "@/lib/tenant-auth";
import { bearerTokenValid, integrationOrgSlugMatches, upsertApiItems, IntegrationError } from "@/lib/integration";

// Этап 5/Пакет 10: POST /api/integration/v1/items — идемпотентный upsert номенклатуры из интеграции.
// Организация — по host; companyId из payload не принимается. Токен — Bearer, безопасное сравнение.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!integrationApiEnabled()) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (!bearerTokenValid(req.headers.get("authorization")))
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const { company, error } = await resolveHostCompany();
  if (!company) return NextResponse.json({ error: error ?? "Организация не определена по host" }, { status: 404 });
  // Токен привязан к организации: работаем только с разрешённым slug (иначе — 404, существование скрыто).
  if (!integrationOrgSlugMatches(company.slug)) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Некорректный JSON" }, { status: 400 });
  }
  // Принимаем { items: [...] } или голый массив.
  const items = Array.isArray(body) ? body : (body as { items?: unknown } | null)?.items;

  try {
    const result = await upsertApiItems(company.id, items);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof IntegrationError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "P2002")
      return NextResponse.json({ error: "Конфликт уникального поля (EAN или SKU уже заняты)" }, { status: 409 });
    throw e;
  }
}
