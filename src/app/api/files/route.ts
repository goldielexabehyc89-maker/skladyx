import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";
import { hasRole } from "@/lib/roles";
import { saveUpload } from "@/lib/files";

// Загрузка файла (multipart): у server actions лимит тела, поэтому route handler.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  if (!hasRole(session, "ADMIN")) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const form = await req.formData();
  const file = form.get("file");
  const ownerType = String(form.get("ownerType") ?? "");
  const ownerId = String(form.get("ownerId") ?? "");

  if (!(file instanceof File)) return NextResponse.json({ error: "Нет файла" }, { status: 400 });

  // Владелец вложения должен принадлежать компании сессии.
  if (ownerType === "receipt") {
    const receipt = await prisma.receipt.findFirst({
      where: { id: ownerId, companyId: session.companyId },
    });
    if (!receipt) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  } else if (ownerType === "receipt_line") {
    const line = await prisma.receiptLine.findFirst({
      where: { id: ownerId, companyId: session.companyId },
    });
    if (!line) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  } else {
    return NextResponse.json({ error: "Неизвестный тип владельца" }, { status: 400 });
  }

  try {
    const attachment = await saveUpload({
      companyId: session.companyId,
      ownerType,
      ownerId,
      uploadedById: session.userId,
      file,
    });
    return NextResponse.json({ id: attachment.id, fileName: attachment.fileName });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Ошибка загрузки" },
      { status: 400 },
    );
  }
}
