"use client";

import { useState, useEffect, useRef, useMemo, useActionState } from "react";
import { Plus } from "lucide-react";
import { addPickLineAction } from "@/app/actions/picklists";
import type { FormState } from "@/app/actions/warehouses";

export interface Placement {
  ref: string; // "L:lotId:cellId" | "U:unitId"
  kind: "LOT" | "UNIT";
  code: string; // ID (QR-код)
  name: string; // товар (+ №серии для единиц)
  qtyLabel: string; // доступное количество с ед.
  where: string; // ячейка
  uom: string;
  maxQty: number;
  search: string; // для фильтра
}

const initial: FormState = {};

// Строка добавления позиции: поиск остатка склада с подсказками (ID, товар, кол-во, где).
// Количество не подставляется автоматически — вводится вручную (для партии).
// Порядок столбцов: Товар | ID | Заказ | Где | Склад | Ед. | Кол-во.
export function PickAddRow({
  pickListId,
  placements,
  card = false,
}: {
  pickListId: string;
  placements: Placement[];
  card?: boolean; // мобильная карточка вместо строки таблицы
}) {
  // два инстанса на странице (таблица + карточка) — id форм должны различаться
  const formId = card ? "pick-add-card" : "pick-add";
  const [text, setText] = useState("");
  const [ref, setRef] = useState("");
  const [qty, setQty] = useState("");
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, formAction, pending] = useActionState(addPickLineAction, initial);
  const prev = useRef(state);
  useEffect(() => {
    if (state !== prev.current) {
      prev.current = state;
      if (!state.error) {
        setText("");
        setRef("");
        setQty("");
      }
    }
  }, [state]);

  const selected = placements.find((p) => p.ref === ref);
  const isLot = selected?.kind === "LOT";

  const matches = useMemo(() => {
    const q = text.trim().toLowerCase();
    const list = q ? placements.filter((p) => p.search.includes(q)) : placements;
    return list.slice(0, 10);
  }, [text, placements]);

  function pick(p: Placement) {
    setRef(p.ref);
    setText(p.name);
    setQty(""); // количество вводится вручную
    setOpen(false);
  }

  const searchBox = (
    <>
      <input
        type="text"
        value={text}
        placeholder="Начните вводить товар, ID или ячейку…"
        autoComplete="off"
        onChange={(e) => {
          setText(e.target.value);
          setRef("");
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          blurTimer.current = setTimeout(() => setOpen(false), 200);
        }}
        className="min-h-10 w-full rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-brand"
      />
      {open && matches.length > 0 && (
        <div className="mt-1 max-h-64 overflow-y-auto rounded-lg border border-neutral-200 bg-white shadow-sm">
          {matches.map((p) => (
            <button
              key={p.ref}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                if (blurTimer.current) clearTimeout(blurTimer.current);
                pick(p);
              }}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm active:bg-neutral-100"
            >
              <span className="w-24 shrink-0 truncate font-mono text-xs text-neutral-500">
                {p.code}
              </span>
              <span className="flex-1 truncate">
                {p.name}
                {p.kind === "UNIT" && (
                  <span className="ml-1 rounded bg-blue-100 px-1 text-[10px] text-blue-700">
                    серийн.
                  </span>
                )}
              </span>
              <span className="w-16 shrink-0 text-right tabular-nums text-neutral-600">
                {p.qtyLabel}
              </span>
              <span className="w-14 shrink-0 truncate text-right text-neutral-500">{p.where}</span>
            </button>
          ))}
        </div>
      )}
      {open && text.trim() && matches.length === 0 && (
        <p className="mt-1 text-xs text-neutral-400">Нет остатков по запросу</p>
      )}
      {state.error && <p className="mt-1 text-xs text-red-600">{state.error}</p>}
      {pending && <p className="mt-1 text-xs text-neutral-400">Добавление…</p>}
    </>
  );

  if (card) {
    return (
      <div className="rounded-xl border border-dashed border-[#d6d8ea] bg-neutral-50/60 px-3.5 py-3">
        <form id={formId} action={formAction}>
          <input type="hidden" name="pickListId" value={pickListId} />
          <input type="hidden" name="ref" value={ref} />
        </form>
        {searchBox}
        {selected && (
          <div className="mt-2 flex items-center justify-between gap-3 text-xs text-neutral-500">
            <span className="font-mono">{selected.code}</span>
            <span>
              {selected.where} · {selected.qtyLabel}
            </span>
          </div>
        )}
        <div className="mt-2 flex items-end gap-2">
          <label className="block flex-1">
            <span className="mb-0.5 block text-[11px] text-neutral-400">Количество</span>
            {isLot ? (
              <input
                name="qty"
                form={formId}
                type="text"
                inputMode="decimal"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                placeholder={selected ? `до ${selected.maxQty}` : "0"}
                className="w-full rounded-lg border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-brand"
              />
            ) : (
              <div className="rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-sm text-neutral-400">
                {selected ? "1 (единица)" : "—"}
              </div>
            )}
          </label>
          <button
            type="submit"
            form={formId}
            disabled={pending || !ref || (isLot && !qty.trim())}
            className="min-h-10 shrink-0 rounded-lg bg-brand px-4 text-sm font-semibold text-brand-fg active:opacity-80 disabled:opacity-40"
          >
            Добавить
          </button>
        </div>
      </div>
    );
  }

  return (
    <tr className="border-t border-neutral-200 bg-neutral-50/60 align-top">
      <td className="px-3 py-2">
        <form id={formId} action={formAction}>
          <input type="hidden" name="pickListId" value={pickListId} />
          <input type="hidden" name="ref" value={ref} />
        </form>
        <input
          type="text"
          value={text}
          placeholder="Начните вводить товар, ID или ячейку…"
          autoComplete="off"
          onChange={(e) => {
            setText(e.target.value);
            setRef("");
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            blurTimer.current = setTimeout(() => setOpen(false), 200);
          }}
          className="min-h-10 w-full rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-brand"
        />
        {open && matches.length > 0 && (
          <div className="mt-1 max-h-64 overflow-y-auto rounded-lg border border-neutral-200 bg-white shadow-sm">
            <div className="flex gap-2 border-b border-neutral-100 px-2 py-1 text-[10px] uppercase tracking-wide text-neutral-400">
              <span className="w-28 shrink-0">ID</span>
              <span className="flex-1">Товар</span>
              <span className="w-20 text-right">Кол-во</span>
              <span className="w-16 text-right">Где</span>
            </div>
            {matches.map((p) => (
              <button
                key={p.ref}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (blurTimer.current) clearTimeout(blurTimer.current);
                  pick(p);
                }}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm active:bg-neutral-100"
              >
                <span className="w-28 shrink-0 truncate font-mono text-xs text-neutral-500">{p.code}</span>
                <span className="flex-1 truncate">
                  {p.name}
                  {p.kind === "UNIT" && (
                    <span className="ml-1 rounded bg-blue-100 px-1 text-[10px] text-blue-700">серийн.</span>
                  )}
                </span>
                <span className="w-20 text-right tabular-nums text-neutral-600">{p.qtyLabel}</span>
                <span className="w-16 truncate text-right text-neutral-500">{p.where}</span>
              </button>
            ))}
          </div>
        )}
        {open && text.trim() && matches.length === 0 && (
          <p className="mt-1 text-xs text-neutral-400">Нет остатков по запросу</p>
        )}
        {state.error && <p className="mt-1 text-xs text-red-600">{state.error}</p>}
        {pending && <p className="mt-1 text-xs text-neutral-400">Добавление…</p>}
      </td>
      <td className="whitespace-nowrap px-3 py-3 font-mono text-xs text-neutral-400">
        {selected?.code ?? "—"}
      </td>
      <td className="px-3 py-3 text-neutral-300">—</td>
      <td className="whitespace-nowrap px-3 py-3 text-neutral-500">{selected?.where ?? "—"}</td>
      <td className="px-3 py-3 text-neutral-300">—</td>
      <td className="px-3 py-3 text-neutral-500">{selected?.uom ?? ""}</td>
      <td className="px-2 py-2">
        {isLot ? (
          <input
            name="qty"
            form={formId}
            type="text"
            inputMode="decimal"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder={selected ? `до ${selected.maxQty}` : "0"}
            className="w-full rounded-lg border border-neutral-300 px-2 py-1.5 text-right text-sm outline-none focus:border-brand"
          />
        ) : (
          <span className="block text-right text-sm text-neutral-400">{selected ? "1" : ""}</span>
        )}
      </td>
      <td className="px-1 py-2 text-center">
        <button
          type="submit"
          form={formId}
          disabled={pending || !ref || (isLot && !qty.trim())}
          title="Добавить позицию"
          className="rounded-lg bg-brand px-3 py-1.5 text-brand-fg active:opacity-80 disabled:opacity-40"
        >
          <Plus size={16} />
        </button>
      </td>
    </tr>
  );
}
