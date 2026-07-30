import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { currentSession } from "@/lib/tenant-auth";
import { readStoredFile } from "@/lib/files";

// Отдача файла с проверкой сессии и компании (S3: свежая проверка host==company/isActive).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const { id } = await params;
  const attachment = await prisma.attachment.findFirst({
    where: { id, companyId: session.companyId },
  });
  if (!attachment) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  try {
    const buf = await readStoredFile(attachment.storedPath);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": attachment.mime,
        "Content-Length": String(attachment.size),
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "Файл не найден на диске" }, { status: 404 });
  }
}
