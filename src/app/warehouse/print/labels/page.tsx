import QRCode from "qrcode";
import Link from "next/link";
import { requireStaffPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { getSettings } from "@/lib/settings";
import { qrUrl } from "@/lib/qr";
import { code128Svg } from "@/lib/code128";
import { PageTitle, EmptyState } from "@/components/ui";
import { PrintButton } from "./print-button";
import { buildLabels } from "./build-labels";

// Универсальная печать этикеток: ?cells=<warehouseId> | ?zone=<zoneId> | ?cell=<cellId> |
// ?receipt=<receiptId> | ?employee=<userId> | ?picklist=<id>; &format=thermo|a4; &bc=QR|CODE128|BOTH.
// QR (SVG) и Code 128 (SVG) генерируются на сервере из ОДНОГО и того же внутреннего кода.

export default async function PrintLabelsPage({
  searchParams,
}: {
  searchParams: Promise<{
    cells?: string;
    zone?: string;
    cell?: string;
    receipt?: string;
    order?: string;
    employee?: string;
    picklist?: string;
    format?: string;
    bc?: string;
  }>;
}) {
  const session = await requireStaffPage();
  const s = scoped(session);
  const sp = await searchParams;
  const settings = await getSettings(s.companyId);
  const format = sp.format === "a4" ? "a4" : "thermo";
  // формат кода: из параметра bc, иначе — настройка ячеек cellLabelFormat
  const bc = sp.bc === "QR" || sp.bc === "CODE128" || sp.bc === "BOTH" ? sp.bc : settings.cellLabelFormat;
  const showQr = bc === "QR" || bc === "BOTH";
  const showBc = bc === "CODE128" || bc === "BOTH";
  const W = settings.labelWidthMm;
  const H = settings.labelHeightMm;

  const { title, labels } = await buildLabels(s.companyId, sp);

  // QR и Code128 кодируют один и тот же payload: QR — URL /q/<code>, Code128 — сам <code>.
  const svgs = showQr
    ? await Promise.all(
        labels.map(async (l) =>
          QRCode.toString(await qrUrl(l.code), { type: "svg", margin: 0, errorCorrectionLevel: "M" }),
        ),
      )
    : labels.map(() => "");
  const bcSvgs = showBc ? labels.map((l) => code128Svg(l.code)) : labels.map(() => "");

  const qrSide = Math.min(H - 6, W * 0.45);
  const pageCss =
    format === "thermo"
      ? `@page { size: ${W}mm ${H}mm; margin: 0; }`
      : `@page { size: A4; margin: 8mm; }`;

  const otherFormat = format === "thermo" ? "a4" : "thermo";
  const otherQuery = new URLSearchParams(
    Object.entries({ ...sp, format: otherFormat }).filter(([, v]) => v) as [string, string][],
  ).toString();

  return (
    <div className="flex flex-col gap-4">
      <style
        dangerouslySetInnerHTML={{
          __html: `
${pageCss}
@media print {
  main { padding: 0 !important; }
  .label { box-shadow: none !important; border-color: ${format === "a4" ? "#ddd" : "transparent"} !important; }
  ${format === "thermo" ? ".label { page-break-after: always; margin: 0 !important; }" : ""}
}
.label { width: ${W}mm; height: ${H}mm; }
.label-qr { width: ${qrSide}mm; height: ${qrSide}mm; }
.label-qr svg { width: 100%; height: 100%; }
.label-bc { width: 100%; height: 7mm; }
.label-bc svg { width: 100%; height: 100%; }
`,
        }}
      />

      <div className="no-print flex flex-col gap-3">
        <PageTitle>{title}</PageTitle>
        <div className="flex items-center gap-3">
          <span className="text-sm text-neutral-500">
            {labels.length} шт · {format === "thermo" ? `термо ${W}×${H} мм` : "А4-сетка"}
          </span>
          <Link
            href={`/warehouse/print/labels?${otherQuery}`}
            className="text-sm text-brand underline-offset-2 hover:underline"
          >
            {format === "thermo" ? "→ печать на А4" : `→ термо ${W}×${H}`}
          </Link>
        </div>
        {labels.length > 0 && <PrintButton />}
        {labels.length === 0 && <EmptyState>Нет этикеток для печати.</EmptyState>}
      </div>

      <div className={format === "a4" ? "flex flex-wrap gap-[3mm]" : "flex flex-col gap-2"}>
        {labels.map((l, idx) => (
          <div
            key={`${l.code}-${idx}`}
            className="label flex items-center gap-[2mm] overflow-hidden border border-[#e4e4f0] bg-white p-[2mm] shadow-sm"
          >
            {showQr && (
              <div className="label-qr shrink-0" dangerouslySetInnerHTML={{ __html: svgs[idx] }} />
            )}
            <div className="flex min-w-0 grow flex-col justify-center gap-[1mm]">
              <div className="line-clamp-2 text-[9pt] font-bold leading-tight">{l.line1}</div>
              {l.line2 && (
                <div className="line-clamp-1 text-[7pt] leading-tight text-neutral-700">{l.line2}</div>
              )}
              {l.line3 && (
                <div className="line-clamp-1 text-[7pt] leading-tight text-neutral-700">{l.line3}</div>
              )}
              {showBc && (
                <div className="label-bc" dangerouslySetInnerHTML={{ __html: bcSvgs[idx] }} />
              )}
              <div className="font-mono text-[6pt] text-neutral-500">{l.code}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
