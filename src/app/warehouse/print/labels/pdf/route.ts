import { readFile } from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";
import { PDFDocument, rgb, type PDFFont, type PDFPage, type PDFImage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { currentSession } from "@/lib/tenant-auth";
import { hasAnyRole } from "@/lib/roles";
import { getSettings } from "@/lib/settings";
import { qrUrl } from "@/lib/qr";
import { code128Png } from "@/lib/code128";
import { buildLabels, type Label } from "../build-labels";

// Скачивание этикеток PDF-файлом (QR не показываются в браузере, а скачиваются).
// По умолчанию — термолента (страница = этикетка WxH из настроек), ?format=a4 — сетка.
// Параметры те же, что у страницы печати: ?order | ?cells | ?cell | ?receipt |
// ?employee | ?picklist.

const MM = 72 / 25.4; // мм → pt

export async function GET(req: Request) {
  const session = await currentSession();
  if (!session || !hasAnyRole(session, ["ADMIN", "STOREKEEPER"]))
    return new Response("Доступ запрещён", { status: 403 });

  const url = new URL(req.url);
  const sp = Object.fromEntries(url.searchParams.entries()) as Record<string, string>;
  const settings = await getSettings(session.companyId);
  const W = settings.labelWidthMm;
  const H = settings.labelHeightMm;
  const a4 = sp.format === "a4";
  // формат кода: параметр bc, иначе настройка cellLabelFormat. Те же режимы, что на странице печати.
  const bc = sp.bc === "QR" || sp.bc === "CODE128" || sp.bc === "BOTH" ? sp.bc : settings.cellLabelFormat;
  const showQr = bc === "QR" || bc === "BOTH";
  const showBc = bc === "CODE128" || bc === "BOTH";

  const { title, labels } = await buildLabels(session.companyId, sp);
  if (labels.length === 0) return new Response("Нет этикеток для печати", { status: 404 });

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(title);
  const fontsDir = path.join(process.cwd(), "node_modules", "dejavu-fonts-ttf", "ttf");
  const [regularTtf, boldTtf, monoTtf] = await Promise.all([
    readFile(path.join(fontsDir, "DejaVuSans.ttf")),
    readFile(path.join(fontsDir, "DejaVuSans-Bold.ttf")),
    readFile(path.join(fontsDir, "DejaVuSansMono.ttf")),
  ]);
  const fReg = await doc.embedFont(regularTtf, { subset: true });
  const fBold = await doc.embedFont(boldTtf, { subset: true });
  const fMono = await doc.embedFont(monoTtf, { subset: true });

  // одинаковые коды кодируются один раз: QR (URL /q/<code>) и/или Code 128 (сам <code>) — по формату.
  const qrByCode = new Map<string, PDFImage>();
  const bcByCode = new Map<string, PDFImage>();
  for (const l of labels) {
    if (showQr && !qrByCode.has(l.code)) {
      const png = await QRCode.toBuffer(qrUrl(l.code), { type: "png", margin: 0, errorCorrectionLevel: "M", scale: 8 });
      qrByCode.set(l.code, await doc.embedPng(png));
    }
    if (showBc && !bcByCode.has(l.code)) {
      bcByCode.set(l.code, await doc.embedPng(await code128Png(l.code, 3)));
    }
  }

  // QR занимает левый квадрат, только если печатается. Если QR нет — текст/штрихкод шире.
  const qrSide = showQr ? Math.min(H - 6, W * 0.45) : 0; // мм — как на странице печати
  const bcH = showBc ? Math.min(9, H * 0.32) : 0; // высота полосы Code 128, мм (снизу этикетки)

  // перенос текста по ширине, не больше maxLines строк (лишнее отбрасывается)
  function wrap(text: string, font: PDFFont, size: number, maxWidthPt: number, maxLines: number) {
    const fits = (t: string) => font.widthOfTextAtSize(t, size) <= maxWidthPt;
    const lines: string[] = [];
    let cur = "";
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const probe = cur ? `${cur} ${word}` : word;
      if (fits(probe)) {
        cur = probe;
        continue;
      }
      if (cur) lines.push(cur);
      cur = word;
      while (!fits(cur) && cur.length > 1) cur = cur.slice(0, -1); // слово шире строки
      if (lines.length >= maxLines) break;
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    return lines.slice(0, maxLines);
  }

  // этикетка с началом в (x0, yTop) мм от левого верхнего угла страницы
  function drawLabel(page: PDFPage, l: Label, x0: number, yTop: number, pageHmm: number) {
    const pad = 2; // мм
    const textAreaH = H - bcH; // верхняя часть под QR/текст, нижняя bcH — под Code 128
    // QR слева (если печатается), вертикально по центру текстовой области
    if (showQr) {
      page.drawImage(qrByCode.get(l.code)!, {
        x: (x0 + pad) * MM,
        y: (pageHmm - (yTop + (textAreaH - qrSide) / 2) - qrSide) * MM,
        width: qrSide * MM,
        height: qrSide * MM,
      });
    }
    // Code 128 — полоса снизу на всю ширину (если печатается)
    if (showBc) {
      const bw = W - pad * 2;
      page.drawImage(bcByCode.get(l.code)!, {
        x: (x0 + pad) * MM,
        y: (pageHmm - (yTop + H - 1) ) * MM,
        width: bw * MM,
        height: (bcH - 1) * MM,
      });
    }
    const textX = (x0 + pad + qrSide + (showQr ? 2 : 0)) * MM;
    const maxW = (W - pad * 2 - qrSide - (showQr ? 2 : 0)) * MM;
    // блоки текста считаются заранее — чтобы отцентрировать по вертикали в текстовой области
    const blocks: { lines: string[]; font: PDFFont; size: number; gray: number }[] = [
      { lines: wrap(l.line1, fBold, 9, maxW, 2), font: fBold, size: 9, gray: 0 },
    ];
    if (l.line2) blocks.push({ lines: wrap(l.line2, fReg, 7, maxW, 2), font: fReg, size: 7, gray: 0.25 });
    if (l.line3) blocks.push({ lines: wrap(l.line3, fReg, 7, maxW, 1), font: fReg, size: 7, gray: 0.25 });
    blocks.push({ lines: [l.code], font: fMono, size: 6, gray: 0.45 });
    const totalH = blocks.reduce((sum, b) => sum + b.lines.length * (b.size / MM + 0.6), 0);
    let cursor = yTop + Math.max(1.5, (textAreaH - totalH) / 2); // мм от верха этикетки
    for (const b of blocks) {
      for (const line of b.lines) {
        cursor += b.size / MM; // высота строки ≈ кегль
        page.drawText(line, {
          x: textX,
          y: (pageHmm - cursor) * MM,
          size: b.size,
          font: b.font,
          color: rgb(b.gray, b.gray, b.gray),
        });
        cursor += 0.6;
      }
    }
  }

  if (!a4) {
    // термолента: страница = этикетка
    for (const l of labels) {
      const page = doc.addPage([W * MM, H * MM]);
      drawLabel(page, l, 0, 0, H);
    }
  } else {
    // А4-сетка с рамками для резки
    const pageW = 210;
    const pageH = 297;
    const margin = 8;
    const gap = 3;
    const cols = Math.max(1, Math.floor((pageW - margin * 2 + gap) / (W + gap)));
    const rows = Math.max(1, Math.floor((pageH - margin * 2 + gap) / (H + gap)));
    const perPage = cols * rows;
    let page: PDFPage | null = null;
    labels.forEach((l, i) => {
      const k = i % perPage;
      if (k === 0) page = doc.addPage([pageW * MM, pageH * MM]);
      const x0 = margin + (k % cols) * (W + gap);
      const yTop = margin + Math.floor(k / cols) * (H + gap);
      page!.drawRectangle({
        x: x0 * MM,
        y: (pageH - yTop - H) * MM,
        width: W * MM,
        height: H * MM,
        borderColor: rgb(0.85, 0.85, 0.85),
        borderWidth: 0.5,
      });
      drawLabel(page!, l, x0, yTop, pageH);
    });
  }

  const bytes = await doc.save();
  const utfName = encodeURIComponent(`${title}.pdf`.replace(/[/\\]/g, "-"));
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="labels.pdf"; filename*=UTF-8''${utfName}`,
      "Cache-Control": "no-store",
    },
  });
}
