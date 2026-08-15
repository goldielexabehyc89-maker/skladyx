import { notFound } from "next/navigation";
import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { parseEan } from "@/lib/ean";
import { eanBarcodeSvg, eanFileName } from "@/lib/ean-barcode";
import { Button } from "@/components/ui";
import { PrintButton } from "@/app/warehouse/print/labels/print-button";

// ITEM-EAN-001: крупный/печатный вид EAN — удобно сканировать телефоном с экрана и печатать этикетку.
// Печатная версия содержит ТОЛЬКО название товара, EAN, тип и штрихкод — без внутренних ID и техполей.
// ADMIN + tenant; read-only. Неверный/неактивный/чужой EAN или архивный/чужой товар → notFound (404).
export default async function ItemEanBarcodePage({ params }: { params: Promise<{ id: string; code: string }> }) {
  const session = await requireAdminPage();
  const s = scoped(session);
  const { id, code } = await params;

  const parsed = parseEan(code);
  if (!parsed) notFound();
  const item = await s.item(id).catch(() => null);
  if (!item || !item.isActive) notFound();
  const bc = await prisma.itemBarcode.findFirst({
    where: { companyId: s.companyId, itemId: id, code, isActive: true },
  });
  if (!bc) notFound();

  const svg = eanBarcodeSvg(code);
  const typeLabel = parsed!.symbology === "EAN13" ? "EAN-13" : "EAN-8";
  const pngHref = `/warehouse/items/${id}/barcode/${code}/image`;

  return (
    <div className="mx-auto w-full max-w-md p-4 print:p-0">
      {/* Печатная версия: только название, EAN, тип, штрихкод. Без внутренних ID/техполей. */}
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-[#eee] bg-white p-6 text-center print:border-0 print:p-0">
        <div className="text-lg font-semibold text-[#1a1a1a]">{item.name}</div>
        <div className="w-full max-w-sm overflow-x-auto" dangerouslySetInnerHTML={{ __html: svg }} aria-label={`Штрихкод ${typeLabel} ${code}`} />
        <div className="font-mono text-base tracking-wider text-[#1a1a1a]">{code}</div>
        <div className="text-sm text-neutral-500">{typeLabel}</div>
      </div>
      <div className="mt-4 flex flex-col gap-2 print:hidden">
        <PrintButton />
        <a href={pngHref} download={eanFileName(item.name, code)}>
          <Button type="button" variant="ghost" className="w-full">Скачать PNG</Button>
        </a>
        <Link href={`/warehouse/items/${id}`} className="text-center text-sm text-neutral-500 underline">← К карточке товара</Link>
      </div>
    </div>
  );
}
