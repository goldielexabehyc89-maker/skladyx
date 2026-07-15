import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { prisma } from "@/lib/db";

// Файлы-вложения (сертификаты, накладные): локальный диск (UPLOAD_DIR — volume в docker),
// метаданные в Attachment. Отдача — через /api/files/[id] с проверкой прав.

const MAX_SIZE = 25 * 1024 * 1024; // 25 МБ
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/pdf",
]);

function uploadDir(): string {
  return process.env.UPLOAD_DIR || "./uploads";
}

export async function saveUpload(args: {
  companyId: string;
  ownerType: string;
  ownerId: string;
  uploadedById: string;
  file: File;
}) {
  const { file } = args;
  if (file.size === 0) throw new Error("Пустой файл");
  if (file.size > MAX_SIZE) throw new Error("Файл больше 25 МБ");
  if (!ALLOWED_MIME.has(file.type)) throw new Error("Допустимы фото (JPEG/PNG/WebP/HEIC) и PDF");

  const key = crypto.randomBytes(16).toString("hex");
  const rel = path.join(args.companyId, key);
  const abs = path.join(uploadDir(), rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, Buffer.from(await file.arrayBuffer()));

  return prisma.attachment.create({
    data: {
      companyId: args.companyId,
      ownerType: args.ownerType,
      ownerId: args.ownerId,
      fileName: file.name,
      mime: file.type,
      size: file.size,
      storedPath: rel,
      uploadedById: args.uploadedById,
    },
  });
}

export async function readStoredFile(storedPath: string): Promise<Buffer> {
  return fs.readFile(path.join(uploadDir(), storedPath));
}

export async function deleteStoredFile(storedPath: string): Promise<void> {
  await fs.unlink(path.join(uploadDir(), storedPath)).catch(() => {});
}
