import { NextResponse } from "next/server";
import { integrationApiEnabled } from "@/lib/roles";
import { resolveHostCompany } from "@/lib/tenant-auth";
import { bearerTokenValid, integrationOrgSlugMatches, importApiOrder, IntegrationError } from "@/lib/integration";

// Этап 5/Пакет 10: POST /api/integration/v1/orders — импорт внешнего заказа (реюз importExternalOrder).
// Организация — по host; склад — единственный активный; товар — по активному EAN; createdById = null.
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

  try {
    const { orderId, created } = await importApiOrder(company.id, body);
    return NextResponse.json({ ok: true, orderId, created }, { status: created ? 201 : 200 });
  } catch (e) {
    if (e instanceof IntegrationError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
