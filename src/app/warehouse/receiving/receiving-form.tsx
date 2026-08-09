"use client";

import { useState, useRef, useEffect, useTransition } from "react";
import { clsx } from "clsx";
import { Button, Card, CardTitle, Badge } from "@/components/ui";
import { QrScanner } from "@/components/qr-scanner";
import { createGroupReceivingAction, resolveReceivingEanAction } from "@/app/actions/group-receiving";

// UI-004: пошаговая приёмка. Одновременно виден только текущий шаг; после успешного шага система сама
// переходит к следующему и ставит фокус. EAN → серверная проверка и название → количество → температура
// → маршрут (STORAGE/COOLING) → подтверждение (единственное движение) → результат → новый цикл с EAN.
// Пройденные шаги показываются компактным резюме с «Назад» до финального движения. Камера и ручной ввод
// используют одну и ту же машину состояний; ручной ввод не показывает много пустых полей сразу.
type Step = "ean" | "qty" | "temp" | "confirm" | "done";

export function ReceivingForm({ thresholdX }: { thresholdX: number }) {
  const [step, setStep] = useState<Step>("ean");
  const [scanning, setScanning] = useState(false);
  const [ean, setEan] = useState("");
  const [itemName, setItemName] = useState("");
  const [qty, setQty] = useState("");
  const [temp, setTemp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  const [token, setToken] = useState("");
  const [result, setResult] = useState<{ itemName: string; qty: number; temperature: number; route: "STORAGE" | "COOLING"; taskCreated: boolean } | null>(null);

  const eanInput = useRef<HTMLInputElement>(null);
  const qtyInput = useRef<HTMLInputElement>(null);
  const tempInput = useRef<HTMLInputElement>(null);

  useEffect(() => { if (!token) setToken(crypto.randomUUID()); }, [token]);
  // автофокус на текущем шаге (UI-004)
  useEffect(() => {
    if (scanning) return;
    if (step === "ean") eanInput.current?.focus();
    else if (step === "qty") qtyInput.current?.focus();
    else if (step === "temp") tempInput.current?.focus();
  }, [step, scanning]);

  const qtyNum = Number(qty.trim());
  const tempNum = temp.trim() === "" ? NaN : Number(temp.replace(",", "."));
  const route: "STORAGE" | "COOLING" | null = Number.isFinite(tempNum) ? (tempNum <= thresholdX ? "STORAGE" : "COOLING") : null;
  const routeLabel = route === "COOLING" ? "охлаждение" : "хранение";

  function resetAll() {
    setStep("ean"); setEan(""); setItemName(""); setQty(""); setTemp(""); setError(null);
    setResult(null); setScanning(false); setToken(crypto.randomUUID());
  }

  // Шаг EAN: серверная проверка штрихкода → название товара → шаг «количество».
  function submitEan(raw: string) {
    const value = raw.trim();
    if (!value) { setError("Отсканируйте или введите EAN"); return; }
    setError(null); setScanning(false);
    startTransition(async () => {
      const fd = new FormData(); fd.set("ean", value);
      const res = await resolveReceivingEanAction({}, fd);
      if (res.error || !res.itemName) { setError(res.error ?? "Товар не найден"); return; }
      setEan(value); setItemName(res.itemName); setStep("qty");
    });
  }

  function submitQty() {
    if (!Number.isInteger(qtyNum) || qtyNum <= 0) { setError("Количество — целое число больше нуля"); return; }
    setError(null); setStep("temp");
  }
  function submitTemp() {
    if (!Number.isFinite(tempNum)) { setError("Укажите температуру группы, °C"); return; }
    setError(null); setStep("confirm");
  }

  // Подтверждение — единственное серверное движение (createHandlingGroup).
  function confirm() {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("ean", ean); fd.set("qty", String(qtyNum)); fd.set("temperature", String(tempNum)); fd.set("dedupeKey", token);
      const res = await createGroupReceivingAction({}, fd);
      if (res.error) { setError(res.error); return; }
      setResult({ itemName: res.itemName ?? itemName, qty: res.qty ?? qtyNum, temperature: res.temperature ?? tempNum, route: (res.route ?? route ?? "STORAGE"), taskCreated: !!res.taskCreated });
      setStep("done");
    });
  }

  const inputCls = "w-full rounded-lg border border-[#e4e4f0] px-3 py-2 text-base outline-none focus:border-brand";

  // Компактное резюме пройденных шагов + «Назад» (до движения).
  const summary = (
    <div className="flex flex-col gap-1 text-sm">
      {ean && step !== "ean" && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-neutral-500">Товар</span>
          <span className="text-right font-medium">{itemName} <span className="font-mono text-xs text-neutral-400">{ean}</span></span>
        </div>
      )}
      {qty && (step === "temp" || step === "confirm") && (
        <div className="flex items-center justify-between gap-2"><span className="text-neutral-500">Количество</span><span className="font-medium">{qtyNum} шт</span></div>
      )}
      {temp !== "" && step === "confirm" && (
        <div className="flex items-center justify-between gap-2"><span className="text-neutral-500">Температура</span><span className="font-medium">{tempNum}°C</span></div>
      )}
    </div>
  );

  if (step === "done" && result) {
    return (
      <Card>
        <CardTitle>Группа принята ✓</CardTitle>
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex justify-between gap-3"><span className="text-neutral-500">Товар</span><span className="text-right font-semibold">{result.itemName}</span></div>
          <div className="flex justify-between"><span className="text-neutral-500">Количество</span><span className="font-semibold">{result.qty} шт</span></div>
          <div className="flex justify-between"><span className="text-neutral-500">Температура</span><span className="font-semibold">{result.temperature}°C</span></div>
          <div className="flex justify-between"><span className="text-neutral-500">Маршрут</span><Badge tone={result.route === "COOLING" ? "blue" : "green"}>{result.route === "COOLING" ? "охлаждение" : "хранение"}</Badge></div>
          <div className="flex justify-between"><span className="text-neutral-500">Задача погрузчику</span><span className="font-semibold">{result.taskCreated ? "создана" : "—"}</span></div>
        </div>
        <Button type="button" onClick={resetAll} className="mt-3 w-full">Новая приёмка</Button>
      </Card>
    );
  }

  return (
    <Card>
      <CardTitle>Приёмка · шаг {step === "ean" ? "1 · штрихкод" : step === "qty" ? "2 · количество" : step === "temp" ? "3 · температура" : "4 · подтверждение"}</CardTitle>

      {(step !== "ean") && <div className="mb-2 rounded-lg bg-[#f7f8fc] px-3 py-2">{summary}</div>}

      {scanning && step === "ean" && (
        <div className="mb-3">
          <QrScanner formats={["ean_8", "ean_13"]} onScan={(raw) => submitEan(raw)} />
          <Button type="button" variant="ghost" onClick={() => setScanning(false)} className="mt-1 w-full">Отмена</Button>
        </div>
      )}

      {!scanning && step === "ean" && (
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-neutral-500">Заводской штрихкод товара (EAN)</label>
          <div className="flex gap-2">
            <input
              ref={eanInput}
              value={ean}
              onChange={(e) => setEan(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitEan(ean); } }}
              inputMode="numeric"
              placeholder="EAN-8 / EAN-13"
              className={inputCls}
            />
            <Button type="button" variant="ghost" onClick={() => { setError(null); setScanning(true); }}>Сканировать</Button>
          </div>
          <Button type="button" onClick={() => submitEan(ean)} disabled={busy || !ean.trim()}>{busy ? "Проверка…" : "Дальше"}</Button>
        </div>
      )}

      {step === "qty" && (
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-neutral-500">Количество, шт</label>
          <input
            ref={qtyInput}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitQty(); } }}
            type="number"
            inputMode="numeric"
            placeholder="напр. 10"
            className={inputCls}
          />
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => { setError(null); setStep("ean"); }}>Назад</Button>
            <Button type="button" onClick={submitQty} className="flex-1">Дальше</Button>
          </div>
        </div>
      )}

      {step === "temp" && (
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-neutral-500">Температура группы, °C</label>
          <input
            ref={tempInput}
            value={temp}
            onChange={(e) => setTemp(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitTemp(); } }}
            type="number"
            inputMode="decimal"
            step="0.1"
            placeholder="напр. 4"
            className={inputCls}
          />
          {route && (
            <p className={clsx("text-xs", route === "COOLING" ? "text-blue-600" : "text-green-700")}>
              Порог X = {thresholdX}°C → маршрут: <b>{routeLabel}</b>
            </p>
          )}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => { setError(null); setStep("qty"); }}>Назад</Button>
            <Button type="button" onClick={submitTemp} className="flex-1">Дальше</Button>
          </div>
        </div>
      )}

      {step === "confirm" && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="text-neutral-500">Маршрут</span>
            <Badge tone={route === "COOLING" ? "blue" : "green"}>{routeLabel}</Badge>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => { setError(null); setStep("temp"); }}>Назад</Button>
            <Button type="button" onClick={confirm} disabled={busy} className="flex-1">{busy ? "…" : "Принять группу"}</Button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </Card>
  );
}
