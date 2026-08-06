"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ScanLine } from "lucide-react";
import { pickScanAction, completeMoveGroupAction } from "@/app/actions/external-orders";
import { completeGroupPlacementAction } from "@/app/actions/group-receiving";
import { prepareCoolingRetrievalAction, placeCoolingRetrievalAction } from "@/app/actions/tasks";
import { Button, Badge } from "@/components/ui";
import { WorkflowSheet, type ScanFormat } from "@/components/workflow-sheet";
import type { PickOrderCtx, MoveGroupCtx, Placement, Cooling } from "./tasks-screen";

// Этап 5/Пакет 9B: товар сканируется по заводскому EAN, группа/партия выводится сервером из контекста
// (задача/заказ/ячейка/резервы). PICK_ORDER: ячейка → EAN товара → количество. MOVE_GROUP: исходная
// ячейка → EAN товара → целевая ячейка. Форматы сканера переключаются по шагу.
const CELL: ScanFormat[] = ["qr_code", "code_128"];
const PRODUCT: ScanFormat[] = ["ean_8", "ean_13"];

// ── Сборка заказа ──
export function PickOrderScanner({ ctx, taskId }: { ctx: PickOrderCtx; taskId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [step, setStep] = useState<"cell" | "product" | "qty">("cell");
  const [cellRaw, setCellRaw] = useState("");
  const [eanRaw, setEanRaw] = useState("");
  const [qty, setQty] = useState("");
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  const pickedLines = ctx.lines.filter((l) => Number(l.picked) >= Number(l.required)).length;
  const pct = ctx.lines.length ? Math.round((pickedLines / ctx.lines.length) * 100) : 0;

  function reset() { setStep("cell"); setCellRaw(""); setEanRaw(""); setQty(""); setNotice(null); }
  function closeAll() { setOpen(false); setScanning(false); reset(); setError(null); setFinished(false); router.refresh(); }

  function handleScan(raw: string) {
    if (busy) return;
    if (step === "cell") { setCellRaw(raw); setStep("product"); setNotice("Ячейка отсканирована — сканируйте EAN товара"); return; }
    if (step === "product") { setEanRaw(raw); setScanning(false); setStep("qty"); setNotice("Товар отсканирован — введите количество"); return; }
  }

  function submitQty() {
    const n = Number(qty.replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) { setError("Укажите количество"); return; }
    startTransition(async () => {
      const fd = new FormData();
      fd.set("taskId", taskId); fd.set("cellCode", cellRaw); fd.set("ean", eanRaw); fd.set("qty", String(n));
      const res = await pickScanAction({}, fd);
      if (res.error) { setError(res.error); return; }
      if (res.status === "IN_CONTROL") { setFinished(true); return; }
      reset(); setNotice("✓ Собрано — продолжайте сканирование"); router.refresh();
    });
  }

  if (!open)
    return (
      <Button type="button" variant="primary" onClick={() => setOpen(true)} className="w-full">
        <ScanLine size={18} /> Собрать (сканирование)
      </Button>
    );

  return (
    <WorkflowSheet
      title={`Сборка · заказ ${ctx.externalId}`}
      subtitle={`Строк собрано ${pickedLines} из ${ctx.lines.length}`}
      progressPct={pct}
      scanning={scanning}
      scanHint={step === "cell" ? "Сканируйте ячейку (QR/Code 128, уровень 1-2)" : "Сканируйте EAN товара"}
      scanFormats={step === "cell" ? CELL : PRODUCT}
      onScan={handleScan}
      scanPaused={busy}
      busy={busy}
      onBackToList={() => setScanning(false)}
      onClose={closeAll}
      error={error}
      onErrorRetry={() => setError(null)}
      onErrorExit={() => { setError(null); setScanning(false); reset(); }}
      modal={finished ? { title: "Заказ собран", body: "Товар в зоне контроля", actions: (<Button type="button" variant="primary" onClick={closeAll} className="w-full">Ок</Button>) } : null}
      footer={
        step === "qty" ? (
          <>
            <input value={qty} onChange={(e) => setQty(e.target.value)} type="number" inputMode="decimal" step="1" placeholder="Количество" className="rounded-lg border border-[#e4e4f0] px-3 py-2 text-sm" />
            <Button type="button" variant="primary" disabled={busy} onClick={submitQty} className="w-full">{busy ? "…" : "Собрать"}</Button>
            <Button type="button" variant="ghost" onClick={reset} className="w-full">Заново сканировать</Button>
          </>
        ) : (
          <Button type="button" variant="primary" onClick={() => { setScanning(true); setStep("cell"); setNotice(null); }} className="w-full">
            <ScanLine size={18} /> Сканировать ячейку
          </Button>
        )
      }
    >
      {notice && <p className="pb-1 text-sm font-medium text-green-600">{notice}</p>}
      <div className="text-xs font-medium text-neutral-500">Строки заказа</div>
      {ctx.lines.map((l) => (
        <div key={l.id} className="flex items-center justify-between rounded-xl bg-[#f7f8fc] px-3 py-2 text-sm">
          <span className="min-w-0 truncate">{l.item}</span>
          <Badge tone={Number(l.picked) >= Number(l.required) ? "green" : "neutral"}>{l.picked}/{l.required}</Badge>
        </div>
      ))}
      {ctx.picks.length > 0 && (
        <>
          <div className="pt-1 text-xs font-medium text-neutral-500">Резервы (что и откуда собирать)</div>
          {ctx.picks.map((p, i) => (
            <div key={`${p.cellId}:${i}`} className="rounded-xl border border-[#eee] px-3 py-2 text-xs text-neutral-600">
              {p.item}: ячейка <b>{p.cell}</b>{p.level != null ? ` (ур.${p.level})` : ""} · {p.qty} шт
            </div>
          ))}
        </>
      )}
      <div className="pt-1 text-xs text-neutral-400">Без камеры: коды ниже, в списке задач — ручной ввод.</div>
    </WorkflowSheet>
  );
}

// ── Первичное размещение группы (PLACE_GROUP): EAN товара → QR/Code128 целевой ячейки ──
// Сервер сам резолвит отсканированный код ячейки и проверяет его (не доверяет выбранному id).
export function PlaceGroupScanner({ placement }: { placement: Placement }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [step, setStep] = useState<"product" | "cell">("product");
  const [eanRaw, setEanRaw] = useState("");
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  function reset() { setStep("product"); setEanRaw(""); setNotice(null); }
  function closeAll() { setOpen(false); setScanning(false); reset(); setError(null); setFinished(false); router.refresh(); }

  function handleScan(raw: string) {
    if (busy) return;
    if (step === "product") { setEanRaw(raw); setStep("cell"); setNotice("Товар отсканирован — сканируйте целевую ячейку"); return; }
    // step === "cell": финализируем размещение
    startTransition(async () => {
      const fd = new FormData();
      fd.set("taskId", placement.taskId); fd.set("ean", eanRaw); fd.set("cellCode", raw);
      const res = await completeGroupPlacementAction({}, fd);
      if (res.error) { setError(res.error); return; }
      setScanning(false); setFinished(true);
    });
  }

  if (!open)
    return (
      <Button type="button" variant="primary" onClick={() => setOpen(true)} className="w-full">
        <ScanLine size={18} /> Разместить (сканирование)
      </Button>
    );

  return (
    <WorkflowSheet
      title="Размещение группы"
      subtitle={`Зона «${placement.routeLabel}»`}
      scanning={scanning}
      scanHint={step === "product" ? "Сканируйте EAN товара" : "Сканируйте целевую ячейку (QR/Code 128)"}
      scanFormats={step === "product" ? PRODUCT : CELL}
      onScan={handleScan}
      scanPaused={busy}
      busy={busy}
      onBackToList={() => setScanning(false)}
      onClose={closeAll}
      error={error}
      onErrorRetry={() => setError(null)}
      onErrorExit={() => { setError(null); setScanning(false); reset(); }}
      modal={finished ? { title: "Группа размещена", body: "Товар размещён в отсканированную ячейку", actions: (<Button type="button" variant="primary" onClick={closeAll} className="w-full">Ок</Button>) } : null}
      footer={
        <Button type="button" variant="primary" onClick={() => { setScanning(true); reset(); }} className="w-full">
          <ScanLine size={18} /> Сканировать товар (EAN)
        </Button>
      }
    >
      {notice && <p className="pb-1 text-sm font-medium text-green-600">{notice}</p>}
      <p className="text-sm text-neutral-500">Отсканируйте EAN товара, затем QR/Code 128 целевой ячейки зоны «{placement.routeLabel}».</p>
      {placement.cells.length > 0 && (
        <>
          <div className="pt-1 text-xs font-medium text-neutral-500">Рекомендуемые пустые ячейки</div>
          {placement.cells.slice(0, 6).map((c) => (
            <div key={c.id} className="rounded-xl bg-[#f7f8fc] px-3 py-2 text-xs text-neutral-600">
              <b>{c.code}</b>{c.level != null ? ` · ур.${c.level}` : ""}{c.recommended ? " · рекомендуется" : ""}
            </div>
          ))}
        </>
      )}
    </WorkflowSheet>
  );
}

// ── Забор из охлаждения (RETRIEVE_COOLING), двухфазно ──
// Фаза 1 (замер): ячейка охлаждения → EAN → температура. ≤ X — назначается целевая ячейка.
// Фаза 2 (размещение): повторное подтверждение ячейки охлаждения/EAN → скан назначенной ячейки.
export function CoolingRetrievalScanner({ cooling }: { cooling: Cooling }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [phase, setPhase] = useState<"measure" | "place">("measure");
  const [step, setStep] = useState<"cell" | "product" | "temp" | "target">("cell");
  const [fromRaw, setFromRaw] = useState("");
  const [eanRaw, setEanRaw] = useState("");
  const [temp, setTemp] = useState("");
  const [targetCode, setTargetCode] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [recycled, setRecycled] = useState(false);

  function resetMeasure() { setPhase("measure"); setStep("cell"); setFromRaw(""); setEanRaw(""); setTemp(""); setNotice(null); }
  function resetPlace() { setStep("cell"); setFromRaw(""); setEanRaw(""); setNotice(null); }
  function closeAll() { setOpen(false); setScanning(false); resetMeasure(); setTargetCode(null); setError(null); setFinished(false); setRecycled(false); router.refresh(); }

  function submitMeasure() {
    const t = Number(temp.replace(",", "."));
    if (!Number.isFinite(t)) { setError("Укажите фактическую температуру"); return; }
    startTransition(async () => {
      const fd = new FormData();
      fd.set("taskId", cooling.taskId); fd.set("fromCellCode", fromRaw); fd.set("ean", eanRaw); fd.set("temperature", String(t));
      const res = await prepareCoolingRetrievalAction({}, fd);
      if (res.error) { setError(res.error); return; }
      if (res.ready && res.targetCellCode) {
        setTargetCode(res.targetCellCode); setPhase("place"); resetPlace(); setScanning(false);
        setNotice(`Готово к вывозу → ячейка ${res.targetCellCode}. Подтвердите ячейку охлаждения, EAN и целевую ячейку сканированием.`);
      } else {
        setScanning(false); setRecycled(true); // выше X — назначен повторный замер позже
      }
    });
  }

  function submitPlace(targetRaw: string) {
    startTransition(async () => {
      const fd = new FormData();
      fd.set("taskId", cooling.taskId); fd.set("fromCellCode", fromRaw); fd.set("ean", eanRaw); fd.set("targetCellCode", targetRaw);
      const res = await placeCoolingRetrievalAction({}, fd);
      if (res.error) { setError(res.error); return; }
      setScanning(false); setFinished(true);
    });
  }

  function handleScan(raw: string) {
    if (busy) return;
    if (step === "cell") { setFromRaw(raw); setStep("product"); setNotice("Ячейка охлаждения — сканируйте EAN товара"); return; }
    if (step === "product") {
      setEanRaw(raw);
      if (phase === "measure") { setScanning(false); setStep("temp"); setNotice("Товар отсканирован — введите фактическую температуру"); }
      else { setStep("target"); setNotice("Товар отсканирован — сканируйте назначенную ячейку"); }
      return;
    }
    if (step === "target") submitPlace(raw); // phase === "place"
  }

  if (!open)
    return (
      <Button type="button" variant="primary" onClick={() => setOpen(true)} className="w-full">
        <ScanLine size={18} /> Забрать из охлаждения (сканирование)
      </Button>
    );

  return (
    <WorkflowSheet
      title="Забор из охлаждения"
      subtitle={cooling.label}
      scanning={scanning}
      scanHint={step === "product" ? "Сканируйте EAN товара" : step === "target" ? "Сканируйте назначенную ячейку" : "Сканируйте ячейку охлаждения"}
      scanFormats={step === "product" ? PRODUCT : CELL}
      onScan={handleScan}
      scanPaused={busy}
      busy={busy}
      onBackToList={() => setScanning(false)}
      onClose={closeAll}
      error={error}
      onErrorRetry={() => setError(null)}
      onErrorExit={() => { setError(null); setScanning(false); if (phase === "measure") resetMeasure(); else resetPlace(); }}
      modal={
        finished
          ? { title: "Забрано из охлаждения", body: targetCode ? `→ ячейка ${targetCode}` : "Группа размещена в хранение", actions: (<Button type="button" variant="primary" onClick={closeAll} className="w-full">Ок</Button>) }
          : recycled
            ? { title: "Ещё охлаждается", body: "Температура выше порога — назначен повторный замер позже.", actions: (<Button type="button" variant="primary" onClick={closeAll} className="w-full">Ок</Button>) }
            : null
      }
      footer={
        step === "temp" ? (
          <>
            <input value={temp} onChange={(e) => setTemp(e.target.value)} type="number" inputMode="decimal" step="0.1" placeholder="Температура, °C" className="rounded-lg border border-[#e4e4f0] px-3 py-2 text-sm" />
            <Button type="button" variant="primary" disabled={busy} onClick={submitMeasure} className="w-full">{busy ? "…" : "Записать замер"}</Button>
            <Button type="button" variant="ghost" onClick={resetMeasure} className="w-full">Заново сканировать</Button>
          </>
        ) : (
          <Button type="button" variant="primary" onClick={() => setScanning(true)} className="w-full">
            <ScanLine size={18} /> Сканировать ячейку охлаждения
          </Button>
        )
      }
    >
      {notice && <p className="pb-1 text-sm font-medium text-green-600">{notice}</p>}
      {phase === "measure" ? (
        <p className="text-sm text-neutral-500">Фаза 1 · замер (порог X = {cooling.thresholdX}°C). Отсканируйте ячейку охлаждения, EAN товара и введите фактическую температуру.</p>
      ) : (
        <p className="text-sm font-medium text-green-700">Фаза 2 · размещение. Готово к вывозу → ячейка <b>{targetCode}</b>. Подтвердите ячейку охлаждения, EAN и отсканируйте назначенную ячейку.</p>
      )}
    </WorkflowSheet>
  );
}

// ── Перестановка группы ──
export function MoveGroupScanner({ ctx }: { ctx: MoveGroupCtx }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [step, setStep] = useState<"from" | "product" | "to">("from");
  const [fromRaw, setFromRaw] = useState("");
  const [eanRaw, setEanRaw] = useState("");
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  function reset() { setStep("from"); setFromRaw(""); setEanRaw(""); setNotice(null); }
  function closeAll() { setOpen(false); setScanning(false); reset(); setError(null); setFinished(false); router.refresh(); }

  function handleScan(raw: string) {
    if (busy) return;
    if (step === "from") { setFromRaw(raw); setStep("product"); setNotice("Исходная ячейка — сканируйте EAN товара"); return; }
    if (step === "product") { setEanRaw(raw); setStep("to"); setNotice("Товар отсканирован — сканируйте целевую ячейку"); return; }
    // step === "to": финализируем перестановку
    startTransition(async () => {
      const fd = new FormData();
      fd.set("taskId", ctx.taskId); fd.set("fromCellCode", fromRaw); fd.set("ean", eanRaw); fd.set("cellCode", raw);
      const res = await completeMoveGroupAction({}, fd);
      if (res.error) { setError(res.error); return; }
      setScanning(false); setFinished(true);
    });
  }

  if (!open)
    return (
      <Button type="button" variant="primary" onClick={() => setOpen(true)} className="w-full">
        <ScanLine size={18} /> Переставить (сканирование)
      </Button>
    );

  return (
    <WorkflowSheet
      title="Перестановка группы"
      subtitle={`${ctx.item} · ${ctx.qty} шт`}
      scanning={scanning}
      scanHint={step === "from" ? "Сканируйте исходную ячейку" : step === "product" ? "Сканируйте EAN товара" : "Сканируйте целевую ячейку"}
      scanFormats={step === "product" ? PRODUCT : CELL}
      onScan={handleScan}
      scanPaused={busy}
      busy={busy}
      onBackToList={() => setScanning(false)}
      onClose={closeAll}
      error={error}
      onErrorRetry={() => setError(null)}
      onErrorExit={() => { setError(null); setScanning(false); reset(); }}
      modal={finished ? { title: "Группа переставлена", body: `→ ячейка ${ctx.toCell}`, actions: (<Button type="button" variant="primary" onClick={closeAll} className="w-full">Ок</Button>) } : null}
      footer={
        <Button type="button" variant="primary" onClick={() => { setScanning(true); reset(); }} className="w-full">
          <ScanLine size={18} /> Сканировать исходную ячейку
        </Button>
      }
    >
      {notice && <p className="pb-1 text-sm font-medium text-green-600">{notice}</p>}
      <div className="rounded-xl bg-[#f7f8fc] p-3 text-sm">
        <div className="font-medium">{ctx.item} · {ctx.qty} шт</div>
        <div className="mt-1 text-xs text-neutral-500">
          Из {ctx.fromCell}{ctx.fromLevel != null ? ` (ур.${ctx.fromLevel})` : ""} → в {ctx.toCell}{ctx.toLevel != null ? ` (ур.${ctx.toLevel})` : ""}
        </div>
      </div>
    </WorkflowSheet>
  );
}
