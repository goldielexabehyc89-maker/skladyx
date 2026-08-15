import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { currentSession } from "@/lib/tenant-auth";
import { hasRole } from "@/lib/roles";
import { parseEan } from "@/lib/ean";
import { eanBarcodePng, eanFileName } from "@/lib/ean-barcode";

// ITEM-EAN-001: PNG активного EAN активного товара — для скачивания/печати и round-trip проверки.
// Read-only (никаких QrCode/Event/иных записей). Только ADMIN; tenant-изоляция по companyId.
// Неверный/неактивный/чужой EAN, архивный или чужой товар → контролируемый 404 (никогда 500).
// Имя файла с кириллицей — через RFC 5987 filename*=UTF-8'' + ASCII-fallback (сырое не-ASCII в
// заголовке недопустимо).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; code: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  if (!hasRole(session, "ADMIN")) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const { id, code } = await params;
  if (!parseEan(code)) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  // Активный товар этой компании + активный EAN именно этого товара.
  const item = await prisma.item.findFirst({ where: { id, companyId: session.companyId } });
  if (!item || !item.isActive) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  const bc = await prisma.itemBarcode.findFirst({
    where: { companyId: session.companyId, itemId: id, code, isActive: true },
  });
  if (!bc) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  try {
    const png = await eanBarcodePng(code);
    const fname = eanFileName(item.name, code);
    return new NextResponse(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(png.length),
        "Content-Disposition": `attachment; filename="item-EAN-${code}.png"; filename*=UTF-8''${encodeURIComponent(fname)}`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
}
