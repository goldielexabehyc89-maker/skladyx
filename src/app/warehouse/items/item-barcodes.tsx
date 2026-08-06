"use client";

import { useActionState } from "react";
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

// Пакет 9A: EAN товара — несколько на товар, деактивация (без физического удаления). API-коды read-only.
export function ItemBarcodes({ itemId, barcodes, readOnly }: { itemId: string; barcodes: BC[]; readOnly: boolean }) {
  const [addState, addAction, addPending] = useActionState<FormState, FormData>(addBarcodeAction, {});
  const [actState, actAction] = useActionState<FormState, FormData>(setBarcodeActiveAction, {});
  return (
    <div className="flex flex-col gap-2">
      {barcodes.length === 0 && <p className="text-sm text-neutral-400">EAN пока не заданы.</p>}
      {barcodes.map((b) => (
        <div key={b.id} className="flex items-center justify-between gap-2 rounded-xl border border-[#eee] px-3 py-2">
          <span className="font-mono text-sm">{b.code}</span>
          <span className="flex items-center gap-1.5">
            <Badge tone="neutral">{b.symbology}</Badge>
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
      ))}
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
