import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/jwt";

// /warehouse/* — только авторизованные. Разграничение по ролям — в server actions
// (requireAdmin/requireUser) и в layout (навигация по роли).
// Публичные: /login, /auth/*, /q/* (резолвер QR сам отправит на /login с next=).
// Legacy: старый префикс /app/* редиректим на /warehouse/* (совместимость QR/закладок).

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Legacy-редирект старого модульного префикса /app → /warehouse.
  if (pathname === "/app" || pathname.startsWith("/app/")) {
    const url = req.nextUrl.clone();
    url.pathname = "/warehouse" + pathname.slice("/app".length);
    return NextResponse.redirect(url);
  }

  if (!pathname.startsWith("/warehouse")) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySessionToken(token) : null;

  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/warehouse/:path*", "/app/:path*"],
};
