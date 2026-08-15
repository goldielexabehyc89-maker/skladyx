"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Badge, Button } from "@/components/ui";
import { addBarcodeAction, setBarcodeActiveAction } from "@/app/actions/items";
import type { FormState } from "@/app/actions/warehouses";

interface BC {
  id: string;
  code: string;
  symbology: string;
  isActive: boolean;
  source: string;
}

const typeLabel = (sym: string) => (sym === "EAN13" ? "EAN-13" : sym === "EAN8" ? "EAN-8" : sym);

// Пакет 9A: EAN товара — несколько на товар, деактивация (без физического удаления). API-коды read-only.
// Задача Q (ITEM-EAN-001): для активного EAN активного товара показываем сканируемый линейный штрихкод
// (SVG приходит с сервера в svgByCode), «Открыть крупно» и «Скачать/распечатать». Изображение — только у
// активных EAN активного товара (сервер не кладёт svg для остальных), неактивные остаются текстом + «откл».
export function ItemBarcodes({
  itemId,
  barcodes,
  readOnly,
  svgByCode = {},
  fileNameByCode = {},
}: {
  itemId: string;
  barcodes: BC[];
  readOnly: boolean;
  svgByCode?: Record<string, string>;
  fileNameByCode?: Record<string, string>;
}) {
  const [addState, addAction, addPending] = useActionState<FormState, FormData>(addBarcodeAction, {});
  const [actState, actAction] = useActionState<FormState, FormData>(setBarcodeActiveAction, {});
  return (
    <div className="flex flex-col gap-2">
      {barcodes.length === 0 && <p className="text-sm text-neutral-400">EAN пока не заданы.</p>}
      {barcodes.map((b) => {
        const svg = b.isActive ? svgByCode[b.code] : undefined;
        return (
          <div key={b.id} className="flex flex-col gap-2 rounded-xl border border-[#eee] px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-sm">{b.code}</span>
              <span className="flex items-center gap-1.5">
                <Badge tone="neutral">{typeLabel(b.symbology)}</Badge>
                {b.source === "API" && <Badge tone="blue">API</Badge>}
                {!b.isActive && <Badge tone="red">откл</Badge>}
                {!readOnly && b.source !== "API" && (
                  <form action={actAction}>
                    <input type="hidden" name="itemId" value={itemId} />
                    <input type="hidden" name="barcodeId" value={b.id} />
                    <input type="hidden" name="active" value={b.isActive ? "false" : "true"} />
                    <button type="submit" className="rounded-lg border border-[#e4e4f0] px-2 py-1 text-xs active:bg-neutral-50">
                      {b.isActive ? "Отключить" : "Включить"}
                    </button>
                  </form>
                )}
              </span>
            </div>
            {/* ITEM-EAN-001: сканируемый штрихкод + действия — только для активного EAN активного товара. */}
            {svg && (
              <div className="flex flex-col gap-1.5">
                <div
                  className="max-w-full overflow-x-auto rounded-lg border border-[#eee] bg-white p-2"
                  style={{ maxWidth: 260 }}
                  dangerouslySetInnerHTML={{ __html: svg }}
                  aria-label={`Штрихкод ${typeLabel(b.symbology)} ${b.code}`}
                />
                <div className="flex flex-wrap gap-2">
                  <Link href={`/warehouse/items/${itemId}/barcode/${b.code}`}>
                    <Button type="button" variant="ghost">Открыть крупно</Button>
                  </Link>
                  <a href={`/warehouse/items/${itemId}/barcode/${b.code}/image`} download={fileNameByCode[b.code] ?? `EAN-${b.code}.png`}>
                    <Button type="button" variant="ghost">Скачать / распечатать</Button>
                  </a>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {actState.error && <p className="text-xs text-red-600">{actState.error}</p>}
      {readOnly ? (
        <p className="mt-1 text-xs text-neutral-400">Товар из интеграции — EAN только для чтения.</p>
      ) : (
        <form action={addAction} className="mt-1 flex flex-col gap-2 border-t border-[#eee] pt-2">
          <input type="hidden" name="itemId" value={itemId} />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-neutral-500">Новый EAN (8 или 13 цифр)</span>
            <input name="code" inputMode="numeric" placeholder="4600000000000" className="rounded-lg border border-[#e4e4f0] px-3 py-2 text-sm" />
          </label>
          {addState.error && <p className="text-xs text-red-600">{addState.error}</p>}
          {addState.ok && <p className="text-xs text-green-700">{addState.ok}</p>}
          <Button type="submit" variant="ghost" disabled={addPending}>{addPending ? "…" : "Добавить EAN"}</Button>
        </form>
      )}
    </div>
  );
}
