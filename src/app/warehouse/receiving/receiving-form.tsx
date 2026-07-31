"use client";

import { useState, useMemo, useActionState, useEffect } from "react";
import { clsx } from "clsx";
import { Button, Card, CardTitle, Field, Badge } from "@/components/ui";
import { createGroupReceivingAction, type ReceivingState } from "@/app/actions/group-receiving";

interface ItemOpt {
  id: string;
  name: string;
  sku: string | null;
  uom: string;
}

export function ReceivingForm({ thresholdX, items }: { thresholdX: number; items: ItemOpt[] }) {
  const [state, action, pending] = useActionState<ReceivingState, FormData>(createGroupReceivingAction, {});
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ItemOpt | null>(null);
  const [temp, setTemp] = useState("");
  const [token, setToken] = useState("");
  const [entryKey, setEntryKey] = useState(0); // remount формы после успеха — чистит поля

  useEffect(() => {
    if (!token) setToken(crypto.randomUUID());
  }, [token]);
  // после успешной приёмки — очистить форму и выдать новый токен идемпотентности
  useEffect(() => {
    if (state.ok) {
      setSelected(null);
      setQuery("");
      setTemp("");
      setToken(crypto.randomUUID());
      setEntryKey((k) => k + 1);
    }
  }, [state.ok]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return items
      .filter((i) => i.name.toLowerCase().includes(q) || (i.sku ?? "").toLowerCase().includes(q))
      .slice(0, 20);
  }, [query, items]);

  const tempNum = temp.trim() === "" ? null : Number(temp.replace(",", "."));
  const routeHint =
    tempNum === null || !Number.isFinite(tempNum) ? null : tempNum <= thresholdX ? "хранение" : "охлаждение";

  return (
    <div className="flex flex-col gap-4">
      {state.ok && (
        <Card>
          <CardTitle>Группа принята ✓</CardTitle>
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex justify-between gap-3"><span className="text-neutral-500">Товар</span><span className="text-right font-semibold">{state.itemName}</span></div>
            <div className="flex justify-between"><span className="text-neutral-500">Количество</span><span className="font-semibold">{state.qty} шт</span></div>
            <div className="flex justify-between"><span className="text-neutral-500">Температура</span><span className="font-semibold">{state.temperature}°C</span></div>
            <div className="flex justify-between">
              <span className="text-neutral-500">Маршрут</span>
              <Badge tone={state.route === "COOLING" ? "blue" : "green"}>
                {state.route === "COOLING" ? "охлаждение" : "хранение"}
              </Badge>
            </div>
            <div className="flex justify-between"><span className="text-neutral-500">Задача погрузчику</span><span className="font-semibold">{state.taskCreated ? "создана" : "—"}</span></div>
            {state.qrUrl && (
              <div className="mt-1 rounded-xl border border-[#eee] bg-neutral-50 p-3">
                <div className="text-xs text-neutral-500">QR группы/паллеты</div>
                <a href={state.qrUrl} className="break-all font-mono text-xs text-brand underline-offset-2">{state.qrUrl}</a>
              </div>
            )}
          </div>
        </Card>
      )}

      <Card>
        <CardTitle>Новая группа</CardTitle>
        <form key={entryKey} action={action} className="flex flex-col gap-3">
          <input type="hidden" name="dedupeKey" value={token} />
          <input type="hidden" name="itemId" value={selected?.id ?? ""} />

          {selected ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-[#e4e4f0] px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{selected.name}</div>
                {selected.sku && <div className="text-xs text-neutral-400">арт. {selected.sku}</div>}
              </div>
              <button type="button" className="shrink-0 text-sm text-brand" onClick={() => setSelected(null)}>
                изменить
              </button>
            </div>
          ) : (
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-500">Товар (название или артикул)</label>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Начните вводить или отсканируйте артикул…"
                className="w-full rounded-lg border border-[#e4e4f0] px-3 py-2 text-sm"
              />
              {query.trim() !== "" && (
                <div className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-[#eee]">
                  {matches.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-neutral-400">Ничего не найдено</div>
                  ) : (
                    matches.map((i) => (
                      <button
                        key={i.id}
                        type="button"
                        onClick={() => { setSelected(i); setQuery(""); }}
                        className="flex w-full items-center justify-between gap-2 border-b border-[#f2f2f2] px-3 py-2 text-left text-sm last:border-0 active:bg-neutral-50"
                      >
                        <span className="min-w-0 truncate">{i.name}</span>
                        {i.sku && <span className="shrink-0 text-xs text-neutral-400">{i.sku}</span>}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}

          <Field label="Количество, шт" name="qty" type="number" inputMode="numeric" required placeholder="напр. 10" />

          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-500">Температура группы, °C</label>
            <input
              name="temperature"
              type="number"
              inputMode="decimal"
              step="0.1"
              required
              value={temp}
              onChange={(e) => setTemp(e.target.value)}
              placeholder="напр. 4"
              className="w-full rounded-lg border border-[#e4e4f0] px-3 py-2 text-sm"
            />
            {routeHint && (
              <p className={clsx("mt-1 text-xs", routeHint === "охлаждение" ? "text-blue-600" : "text-green-700")}>
                Порог X = {thresholdX}°C → маршрут: <b>{routeHint}</b>
              </p>
            )}
          </div>

          {state.error && <p className="text-sm text-red-600">{state.error}</p>}
          <Button type="submit" disabled={pending || !selected}>
            {pending ? "…" : "Принять группу"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
