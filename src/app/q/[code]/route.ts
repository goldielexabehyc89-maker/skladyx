import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";
import { hasRole } from "@/lib/roles";
import { resolveQr } from "@/lib/qr";

// Публичный вход по QR (сканирование системной камерой телефона):
// без сессии → /login?next=, с сессией → карточка сущности.
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const url = req.nextUrl.clone();

  const session = await getSession();
  if (!session) {
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(`/q/${code}`)}`;
    return NextResponse.redirect(url);
  }

  const qr = await resolveQr(code);
  const redirectTo = async (): Promise<string> => {
    if (!qr || qr.companyId !== session.companyId) {
      // этикетка позиции заказа поставщику, ещё не принятой на склад → на заказ
      const clean = code.trim().toUpperCase();
      const base = clean.includes("-") ? clean.slice(0, clean.lastIndexOf("-")) : null;
      const line = await prisma.supplierOrderLine.findFirst({
        where: {
          companyId: session.companyId,
          lineCode: base ? { in: [clean, base] } : clean,
        },
      });
      return line ? `/warehouse/orders/${line.orderId}` : "/warehouse";
    }
    switch (qr.type) {
      case "LOT": {
        const lot = await prisma.lot.findUnique({ where: { id: qr.refId } });
        return lot ? `/warehouse/items/${lot.itemId}` : "/warehouse";
      }
      case "UNIT": {
        const unit = await prisma.itemUnit.findUnique({ where: { id: qr.refId } });
        return unit ? `/warehouse/items/${unit.itemId}` : "/warehouse";
      }
      case "CELL":
        return `/warehouse/cells/${qr.refId}`;
      case "EMPLOYEE":
        return hasRole(session, "ADMIN") ? `/warehouse/employees/${qr.refId}` : "/warehouse";
      case "PICKLIST":
        return `/warehouse/picklists/${qr.refId}`;
    }
  };

  url.pathname = await redirectTo();
  url.search = "";
  return NextResponse.redirect(url);
}
