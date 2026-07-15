"use client";

import { useMemo, useRef, useState, useTransition } from "react";

// Поле с подсказками по вводу: изначально пустое, выбор из вариантов,
// опционально — создание нового значения прямо из списка (createAction).
// В форму уходит hidden <input name={name}> с id выбранного варианта.
export function AutocompleteField({
  label,
  name,
  options,
  placeholder = "Начните вводить…",
  createAction,
  createLabel = "Создать",
  formId,
  inline = false,
}: {
  label?: string;
  name: string;
  options: { id: string; name: string; hint?: string }[];
  placeholder?: string;
  createAction?: (name: string) => Promise<{ error?: string; id?: string; name?: string }>;
  createLabel?: string;
  // id внешней <form>: позволяет ставить поле внутрь таблицы (атрибут form=)
  formId?: string;
  // подсказки в потоке (не поверх) — для ячеек таблиц, где absolute обрезается прокруткой
  inline?: boolean;
}) {
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const matches = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return options.slice(0, 8);
    return options.filter((o) => o.name.toLowerCase().includes(q)).slice(0, 8);
  }, [text, options]);

  const exactMatch = options.some((o) => o.name.toLowerCase() === text.trim().toLowerCase());

  function pick(o: { id: string; name: string }) {
    setSelected(o);
    setText(o.name);
    setOpen(false);
    setError(null);
  }

  function createNew() {
    const value = text.trim();
    if (!value || busy || !createAction) return;
    startTransition(async () => {
      try {
        const res = await createAction(value);
        if (res.error) setError(res.error);
        else if (res.id && res.name) pick({ id: res.id, name: res.name });
      } catch {
        setError("Нет связи с сервером — попробуйте ещё раз");
      }
    });
  }

  return (
    <div className="relative">
      {label && <span className="mb-1 block text-sm font-medium text-neutral-700">{label}</span>}
      <input type="hidden" name={name} value={selected?.id ?? ""} form={formId} />
      <input
        type="text"
        value={text}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => {
          setText(e.target.value);
          setSelected(null);
          setOpen(true);
          setError(null);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // даём клику по подсказке успеть сработать
          blurTimer.current = setTimeout(() => setOpen(false), 200);
        }}
        className="min-h-11 w-full rounded-xl border border-[#e4e4f0] px-3 py-2 text-base outline-none focus:border-brand"
      />
      {open && (matches.length > 0 || (text.trim() && createAction)) && (
        <div
          className={
            inline
              ? "mt-1 max-h-56 overflow-y-auto rounded-2xl bg-white shadow-[0_2px_8px_rgba(20,20,60,0.06)]"
              : "absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-xl bg-white shadow-[0_8px_24px_rgba(0,0,0,0.14)]"
          }
        >
          {matches.map((o) => (
            <button
              key={o.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                if (blurTimer.current) clearTimeout(blurTimer.current);
                pick(o);
              }}
              className="block w-full px-3 py-2.5 text-left text-sm active:bg-neutral-100"
            >
              {o.name}
              {o.hint && <span className="text-neutral-400"> · {o.hint}</span>}
            </button>
          ))}
          {matches.length === 0 && !createAction && (
            <p className="px-3 py-2.5 text-sm text-neutral-400">Ничего не найдено</p>
          )}
          {text.trim() && !exactMatch && createAction && (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                if (blurTimer.current) clearTimeout(blurTimer.current);
                createNew();
              }}
              disabled={busy}
              className="block w-full border-t border-neutral-100 px-3 py-2.5 text-left text-sm font-medium text-brand active:bg-neutral-100"
            >
              {busy ? "Создание…" : `+ ${createLabel} «${text.trim()}»`}
            </button>
          )}
        </div>
      )}
      {selected && (
        <p className="mt-1 text-xs text-green-600">
          ✓ {selected.name}
          {options.find((o) => o.id === selected.id)?.hint
            ? ` (${options.find((o) => o.id === selected.id)?.hint})`
            : ""}
        </p>
      )}
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
    </div>
  );
}
