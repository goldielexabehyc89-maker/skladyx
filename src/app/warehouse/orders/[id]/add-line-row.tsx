"use client";

import { useState, useEffect, useRef, useActionState } from "react";
import { Plus } from "lucide-react";
import { addOrderLineAction } from "@/app/actions/supplier-orders";
import { AutocompleteField } from "@/components/autocomplete-field";
import type { FormState } from "@/app/actions/warehouses";

const initial: FormState = {};

// Строка добавления позиции в таблице заказа (как в МойСклад).
// После успешного добавления все поля очищаются для следующего товара.
export function AddLineRow({
  orderId,
  items,
  card = false,
}: {
  orderId: string;
  items: { id: string; name: string; hint?: string }[];
  card?: boolean; // мобильная карточка вместо строки таблицы
}) {
  // два инстанса на странице (таблица + карточка) — id форм должны различаться
  const formId = card ? "add-line-card" : "add-line";
  const [qty, setQty] = useState("");
  const [price, setPrice] = useState("");
  const [acKey, setAcKey] = useState(0); // remount автокомплита = сброс выбранного товара

  // Server action передаётся напрямую (нужно для работы формы и без JS);
  // очистка полей — по завершении успешного добавления.
  const [state, formAction, pending] = useActionState(addOrderLineAction, initial);
  const prevState = useRef(state);
  useEffect(() => {
    if (state !== prevState.current) {
      prevState.current = state;
      if (!state.error) {
        setQty("");
        setPrice("");
        setAcKey((k) => k + 1);
      }
    }
  }, [state]);

  const inputCls =
    "w-full rounded-lg border border-[#e4e4f0] px-2 py-1.5 text-right text-sm outline-none focus:border-brand";

  if (card) {
    return (
      <div className="rounded-xl border border-dashed border-[#d6d8ea] bg-neutral-50/60 px-3.5 py-3">
        <form id={formId} action={formAction}>
          <input type="hidden" name="orderId" value={orderId} />
        </form>
        <AutocompleteField
          key={acKey}
          name="itemId"
          formId={formId}
          inline
          placeholder="Начните вводить название товара…"
          options={items}
        />
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-0.5 block text-[11px] text-neutral-400">Кол-во</span>
            <input
              name="qty"
              form={formId}
              type="text"
              inputMode="decimal"
              placeholder="0"
              required
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="mb-0.5 block text-[11px] text-neutral-400">Цена ₽</span>
            <input
              name="price"
              form={formId}
              type="text"
              inputMode="decimal"
              placeholder="—"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className={inputCls}
            />
          </label>
        </div>
        <button
          type="submit"
          form={formId}
          disabled={pending}
          className="mt-2 w-full rounded-xl bg-brand px-3 py-2 text-sm font-semibold text-brand-fg active:opacity-80 disabled:opacity-50"
        >
          {pending ? (
            "Добавление…"
          ) : (
            <span className="inline-flex items-center justify-center gap-1.5">
              <Plus size={16} /> Добавить позицию
            </span>
          )}
        </button>
        {!pending && state.error && <p className="mt-1 text-xs text-red-600">{state.error}</p>}
      </div>
    );
  }

  return (
    <tr className="border-t border-neutral-200 bg-neutral-50/60 align-top">
      <td className="px-3 py-3 text-neutral-400">
        +
        <form id={formId} action={formAction}>
          <input type="hidden" name="orderId" value={orderId} />
        </form>
      </td>
      <td className="px-3 py-2">
        <AutocompleteField
          key={acKey}
          name="itemId"
          formId={formId}
          inline
          placeholder="Начните вводить название товара…"
          options={items}
        />
        {!pending && state.error && <p className="mt-1 text-xs text-red-600">{state.error}</p>}
        {pending && <p className="mt-1 text-xs text-neutral-400">Добавление…</p>}
      </td>
      <td className="px-3 py-3 font-mono text-xs text-neutral-300">—</td>
      <td className="px-3 py-3 text-neutral-300">—</td>
      <td className="px-2 py-2">
        <input
          name="qty"
          form={formId}
          type="text"
          inputMode="decimal"
          placeholder="0"
          required
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          className={inputCls}
        />
      </td>
      <td className="px-2 py-2">
        <input
          name="price"
          form={formId}
          type="text"
          inputMode="decimal"
          placeholder="—"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          className={inputCls}
        />
      </td>
      <td className="px-3 py-3 text-right text-neutral-300">—</td>
      <td className="px-1 py-2 text-center">
        <button
          type="submit"
          form={formId}
          disabled={pending}
          title="Добавить позицию"
          className="rounded-lg bg-brand px-3 py-1.5 text-brand-fg active:opacity-80 disabled:opacity-50"
        >
          <Plus size={16} />
        </button>
      </td>
    </tr>
  );
}
