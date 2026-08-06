"use client";

import { useState, useActionState, useEffect } from "react";
import { clsx } from "clsx";
import { Button, Card, CardTitle, Field, Badge } from "@/components/ui";
import { QrScanner } from "@/components/qr-scanner";
import { createGroupReceivingAction, type ReceivingState } from "@/app/actions/group-receiving";

interface ItemOpt { id: string; name: string; sku: string | null; uom: string }

// Пакет 9B: приёмка по заводскому EAN. Товар определяется сервером через findItemByEan; ручной выбор
// товара/SKU убран. Скан камерой (EAN-8/EAN-13) — основной путь, ручной ввод EAN — fallback.
// `items` больше не используется (совместимость сигнатуры со страницей).
export function ReceivingForm({ thresholdX }: { thresholdX: number; items?: ItemOpt[] }) {
  const [state, action, pending] = useActionState<ReceivingState, FormData>(createGroupReceivingAction, {});
  const [ean, setEan] = useState("");
  const [temp, setTemp] = useState("");
  const [token, setToken] = useState("");
  const [scanning, setScanning] = useState(false);
  const [entryKey, setEntryKey] = useState(0); // remount формы после успеха — чистит поля

  useEffect(() => { if (!token) setToken(crypto.randomUUID()); }, [token]);
  useEffect(() => {
    if (state.ok) { setEan(""); setTemp(""); setToken(crypto.randomUUID()); setEntryKey((k) => k + 1); }
  }, [state.ok]);

  const tempNum = temp.trim() === "" ? null : Number(temp.replace(",", "."));
  const routeHint = tempNum === null || !Number.isFinite(tempNum) ? null : tempNum <= thresholdX ? "хранение" : "охлаждение";

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
              <Badge tone={state.route === "COOLING" ? "blue" : "green"}>{state.route === "COOLING" ? "охлаждение" : "хранение"}</Badge>
            </div>
            <div className="flex justify-between"><span className="text-neutral-500">Задача погрузчику</span><span className="font-semibold">{state.taskCreated ? "создана" : "—"}</span></div>
            <p className="text-xs text-neutral-400">Пакет 9B: группа без собственного QR — товар определяется по EAN.</p>
          </div>
        </Card>
      )}

      <Card>
        <CardTitle>Новая группа</CardTitle>
        {scanning && (
          <div className="mb-3">
            <QrScanner formats={["ean_8", "ean_13"]} onScan={(raw) => { setEan(raw.trim()); setScanning(false); }} />
            <Button type="button" variant="ghost" onClick={() => setScanning(false)} className="mt-1 w-full">Отмена</Button>
          </div>
        )}
        <form key={entryKey} action={action} className="flex flex-col gap-3">
          <input type="hidden" name="dedupeKey" value={token} />

          <label className="text-xs font-medium text-neutral-500">Заводской штрихкод товара (EAN)</label>
          <div className="flex gap-2">
            <input
              name="ean"
              value={ean}
              onChange={(e) => setEan(e.target.value)}
              required
              inputMode="numeric"
              placeholder="EAN-8 / EAN-13"
              className="min-w-0 flex-1 rounded-lg border border-[#e4e4f0] px-3 py-2 text-sm"
            />
            <Button type="button" variant="ghost" onClick={() => setScanning(true)}>Сканировать</Button>
          </div>

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
          <Button type="submit" disabled={pending || !ean.trim()}>{pending ? "…" : "Принять группу"}</Button>
        </form>
      </Card>
    </div>
  );
}
