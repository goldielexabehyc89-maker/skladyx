"use client";

import { Trash2 } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateOrderLineAction, removeOrderLineAction } from "@/app/actions/supplier-orders";
import { fmtRub } from "@/lib/format";

// Строка черновика заказа: количество и цена правятся прямо в ячейках,
// сохранение — автоматически при уходе из поля (как в МойСклад).
// card=true — мобильная карточка вместо строки таблицы (та же логика).
export function DraftLineRow({
  lineId,
  index,
  itemName,
  uomName,
  isUnit,
  initialQty,
  initialPrice,
  card = false,
}: {
  lineId: string;
  index: number;
  itemName: string;
  uomName: string;
  isUnit: boolean;
  initialQty: string;
  initialPrice: string;
  card?: boolean;
}) {
  const router = useRouter();
  const [qty, setQty] = useState(initialQty);
  const [price, setPrice] = useState(initialPrice);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  const saved = useRef({ qty: initialQty, price: initialPrice });

  const sum =
    Number(qty) > 0 && Number(price) > 0 ? fmtRub(Number(qty) * Number(price)) : "—";

  function save() {
    if (qty === saved.current.qty && price === saved.current.price) return;
    const fd = new FormData();
    fd.set("lineId", lineId);
    fd.set("qty", qty);
    fd.set("price", price);
    startTransition(async () => {
      try {
        const res = await updateOrderLineAction({}, fd);
        if (res.error) {
          setError(res.error);
        } else {
          setError(null);
          saved.current = { qty, price };
          router.refresh();
        }
      } catch {
        setError("Нет связи с сервером — изменение не сохранено");
      }
    });
  }

  function remove() {
    const fd = new FormData();
    fd.set("lineId", lineId);
    startTransition(async () => {
      try {
        await removeOrderLineAction(fd);
        router.refresh();
      } catch {
        setError("Нет связи с сервером");
      }
    });
  }

  const inputCls =
    "w-full rounded-lg border border-[#e4e4f0] px-2 py-1.5 text-right text-sm outline-none focus:border-brand disabled:opacity-50";

  const unitBadge = isUnit && (
    <span className="ml-1.5 rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">
      серийн.
    </span>
  );

  if (card) {
    return (
      <div className="rounded-xl bg-white px-3.5 py-3 shadow-[0_2px_8px_rgba(20,20,60,0.06)]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="text-sm font-semibold text-[#1a1a1a]">{itemName}</span>
            {unitBadge}
            <div className="text-xs text-neutral-500">{uomName}</div>
          </div>
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="shrink-0 rounded-lg p-2 text-neutral-400 active:bg-red-50 active:text-red-500 disabled:opacity-50"
            title="Удалить позицию"
          >
            <Trash2 size={16} />
          </button>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-0.5 block text-[11px] text-neutral-400">Кол-во</span>
            <input
              type="text"
              inputMode="decimal"
              value={qty}
              disabled={busy}
              onChange={(e) => setQty(e.target.value)}
              onBlur={save}
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="mb-0.5 block text-[11px] text-neutral-400">Цена ₽</span>
            <input
              type="text"
              inputMode="decimal"
              placeholder="—"
              value={price}
              disabled={busy}
              onChange={(e) => setPrice(e.target.value)}
              onBlur={save}
              className={inputCls}
            />
          </label>
        </div>
        <div className="mt-1.5 text-right text-sm font-medium tabular-nums">Сумма: {sum}</div>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </div>
    );
  }

  return (
    <tr className="border-b border-neutral-100 last:border-0">
      <td className="px-3 py-2.5 text-neutral-400">{index}</td>
      <td className="px-3 py-2.5">
        <span className="font-medium">{itemName}</span>
        {unitBadge}
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-neutral-300">—</td>
      <td className="px-3 py-2.5 text-neutral-500">{uomName}</td>
      <td className="px-2 py-1.5">
        <input
          type="text"
          inputMode="decimal"
          value={qty}
          disabled={busy}
          onChange={(e) => setQty(e.target.value)}
          onBlur={save}
          className={inputCls}
        />
      </td>
      <td className="px-2 py-1.5">
        <input
          type="text"
          inputMode="decimal"
          placeholder="—"
          value={price}
          disabled={busy}
          onChange={(e) => setPrice(e.target.value)}
          onBlur={save}
          className={inputCls}
        />
      </td>
      <td className="px-3 py-2.5 text-right font-medium tabular-nums">{sum}</td>
      <td className="px-1 py-2.5 text-center">
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          className="p-1.5 text-neutral-400 hover:text-red-500 disabled:opacity-50"
          title="Удалить позицию"
        >
          <Trash2 size={16} />
        </button>
      </td>
    </tr>
  );
}
