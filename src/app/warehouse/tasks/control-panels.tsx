"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ScanLine } from "lucide-react";
import {
  scanOrderControlAction,
  markControlScanAction,
  finishControlAction,
  resolveShortageAction,
  resolveRemovalAction,
  completeCorrectionAction,
  type ControlActionState,
} from "@/app/actions/order-control";
import { Button, Badge } from "@/components/ui";
import { WorkflowSheet, type ScanFormat } from "@/components/workflow-sheet";
const PRODUCT: ScanFormat[] = ["ean_8", "ean_13"];
const ORDERF: ScanFormat[] = ["qr_code"];

// Этап 5/Пакет 7 (+коррекция): контролёр сканирует QR заказа, затем QR каждой группы/товара +
// количество (неожиданный товар — отдельной строкой). Сборщик исправляет КАЖДОЕ расхождение
// отдельным действием (скан удаляемого/добавляемого товара); общее завершение заблокировано,
// пока не разрешены все расхождения. Ручной ввод кодов — fallback к камере.

export interface ControlOrderCtx {
  taskId: string;
  orderId: string;
  externalId: string;
  scanConfirmed: boolean;
  attempt: number;
  lines: { lineId: string; item: string; required: string; counted: string | null; discrepancyType: string | null }[];
  extras: { item: string; counted: string; discrepancyType: string | null }[];
  allMarked: boolean;
  previousChecks: { attempt: number; status: string }[];
}
export interface CorrectOrderCtx {
  taskId: string;
  orderId: string;
  externalId: string;
  discrepancies: {
    checkLineId: string;
    item: string;
    type: string | null;
    expected: string;
    counted: string;
    comment: string | null;
    resolutionStatus: string;
    resolutionMethod: string | null;
    groupCode: string | null;
  }[];
  allResolved: boolean;
}

const DISCREPANCY_LABEL: Record<string, string> = {
  SHORTAGE: "Недостача",
  EXCESS: "Излишек",
  WRONG_ITEM: "Не тот товар",
  DAMAGED: "Повреждён",
  OTHER: "Другое",
};
const METHOD_LABEL: Record<string, string> = {
  ALIGNED: "добавлено (без движения)",
  RETURNED: "возвращено в хранение",
  ISOLATED_DISCREPANCY: "изолировано в DISCREPANCY",
};

// ── Скан QR заказа камерой (WorkflowSheet) ──
function ScanOrderCamera({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleScan(raw: string) {
    if (busy) return;
    startTransition(async () => {
      const fd = new FormData();
      fd.set("taskId", taskId);
      fd.set("orderCode", raw);
      const res = await scanOrderControlAction({}, fd);
      if (res.error) { setError(res.error); return; }
      setOpen(false); setScanning(false); router.refresh();
    });
  }

  if (!open)
    return (
      <Button type="button" variant="primary" onClick={() => { setOpen(true); setScanning(true); }} className="w-full">
        <ScanLine size={18} /> Сканировать QR заказа
      </Button>
    );

  return (
    <WorkflowSheet
      title="Контроль заказа"
      subtitle="Отсканируйте QR заказа"
      scanning={scanning}
      scanHint="Сканируйте QR заказа"
      scanFormats={ORDERF}
      onScan={handleScan}
      scanPaused={busy}
      busy={busy}
      onBackToList={() => setScanning(false)}
      onClose={() => { setOpen(false); setScanning(false); }}
      error={error}
      onErrorRetry={() => setError(null)}
      onErrorExit={() => { setError(null); setScanning(false); setOpen(false); }}
      footer={
        <Button type="button" variant="primary" onClick={() => setScanning(true)} className="w-full">
          <ScanLine size={18} /> Сканировать QR заказа
        </Button>
      }
    >
      <p className="text-sm text-neutral-500">Наведите камеру на QR-код заказа в зоне контроля.</p>
    </WorkflowSheet>
  );
}

function ScanOrderManual({ taskId }: { taskId: string }) {
  const [state, action, pending] = useActionState<ControlActionState, FormData>(scanOrderControlAction, {});
  return (
    <details className="text-xs text-neutral-500">
      <summary className="cursor-pointer">Ввести код заказа вручную (без камеры)</summary>
      <form action={action} className="mt-2 flex flex-col gap-2">
        <input type="hidden" name="taskId" value={taskId} />
        <input name="orderCode" required placeholder="Код QR заказа" className="rounded-lg border border-[#e4e4f0] px-3 py-1.5 text-sm" />
        {state.error && <p className="text-red-600">{state.error}</p>}
        <Button type="submit" variant="ghost" disabled={pending}>{pending ? "…" : "Подтвердить заказ"}</Button>
      </form>
    </details>
  );
}

// ── Контроль: строго пошагово (UI-004) — по одному полю на шаг ──
// EAN → количество → тип/состояние → комментарий → итоговое подтверждение (без полей). После успешной
// отметки: остались непроверенные строки → авто-переход к скану следующего EAN; все отмечены → закрыть
// мастер и показать завершение. Ошибка сервера сохраняет EAN/количество/тип/комментарий (остаёмся на итоге).
const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "без расхождения (по количеству)" },
  { value: "EXCESS", label: "излишек / неожиданный товар" },
  { value: "WRONG_ITEM", label: "не тот товар" },
  { value: "DAMAGED", label: "повреждён" },
  { value: "OTHER", label: "другое" },
];
function MarkGroupScanner({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [step, setStep] = useState<"product" | "qty" | "type" | "comment" | "confirm">("product");
  const [eanRaw, setEanRaw] = useState("");
  const [qty, setQty] = useState("");
  const [type, setType] = useState("");
  const [comment, setComment] = useState("");
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function reset() { setStep("product"); setEanRaw(""); setQty(""); setType(""); setComment(""); }
  function openScan() { setScanning(true); setStep("product"); }
  function handleScan(raw: string) {
    if (busy) return;
    const v = raw.trim();
    if (!v) { setError("Отсканируйте заводской штрихкод товара (EAN)"); return; }
    setEanRaw(v); setScanning(false); setStep("qty");
  }
  function submitQty() {
    const n = Number(qty.replace(",", "."));
    if (!Number.isFinite(n) || n < 0) { setError("Укажите фактическое количество"); return; }
    setStep("type");
  }
  function submit() {
    const n = Number(qty.replace(",", "."));
    if (!Number.isFinite(n) || n < 0) { setError("Укажите фактическое количество"); return; }
    startTransition(async () => {
      const fd = new FormData();
      fd.set("taskId", taskId); fd.set("ean", eanRaw); fd.set("countedQty", String(n));
      fd.set("discrepancyType", type); fd.set("comment", comment.trim());
      const res = await markControlScanAction({}, fd);
      if (res.error) { setError(res.error); return; } // остаёмся на итоге — EAN/кол-во/тип/коммент сохранены
      router.refresh();
      if (res.allMarked) { setOpen(false); reset(); }        // все строки отмечены → закрыть мастер
      else { reset(); setScanning(true); }                    // остались строки → сразу скан следующего EAN
    });
  }
  const inputCls = "rounded-lg border border-[#e4e4f0] px-3 py-2 text-sm outline-none focus:border-brand";
  const typeLabel = TYPE_OPTIONS.find((o) => o.value === type)?.label ?? "—";
  if (!open)
    return (
      <Button type="button" variant="primary" onClick={() => { setOpen(true); openScan(); }} className="w-full">
        <ScanLine size={18} /> Проверить товар (сканирование)
      </Button>
    );
  return (
    <WorkflowSheet
      title="Проверка товара"
      subtitle={step === "product" ? "Шаг 1 · штрихкод (EAN)" : step === "qty" ? "Шаг 2 · количество" : step === "type" ? "Шаг 3 · состояние" : step === "comment" ? "Шаг 4 · комментарий" : "Шаг 5 · подтверждение"}
      scanning={scanning}
      scanHint="Сканируйте заводской штрихкод товара (EAN)"
      scanFormats={PRODUCT}
      manualPlaceholder="EAN товара (8/13 цифр)"
      manualInputMode="numeric"
      onScan={handleScan}
      scanPaused={busy}
      busy={busy}
      onBackToList={() => setScanning(false)}
      onClose={() => { setOpen(false); setScanning(false); reset(); setError(null); }}
      error={error}
      onErrorRetry={() => setError(null)}
      onErrorExit={() => { setError(null); openScan(); }}
      footer={
        step === "qty" ? (
          <>
            <input autoFocus value={qty} onChange={(e) => setQty(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitQty(); } }} type="number" inputMode="decimal" step="1" placeholder="Фактическое количество" className={inputCls} />
            <Button type="button" variant="primary" onClick={submitQty} className="w-full">Дальше</Button>
            <Button type="button" variant="ghost" onClick={openScan} className="w-full">Назад</Button>
          </>
        ) : step === "type" ? (
          <>
            <select autoFocus value={type} onChange={(e) => setType(e.target.value)} className={inputCls}>
              {TYPE_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
            <Button type="button" variant="primary" onClick={() => setStep("comment")} className="w-full">Дальше</Button>
            <Button type="button" variant="ghost" onClick={() => setStep("qty")} className="w-full">Назад</Button>
          </>
        ) : step === "comment" ? (
          <>
            <input autoFocus value={comment} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setStep("confirm"); } }} placeholder="комментарий (необязательно)" className={inputCls} />
            <Button type="button" variant="primary" onClick={() => setStep("confirm")} className="w-full">Дальше</Button>
            <Button type="button" variant="ghost" onClick={() => setStep("type")} className="w-full">Назад</Button>
          </>
        ) : step === "confirm" ? (
          <>
            <Button type="button" variant="primary" disabled={busy} onClick={submit} className="w-full">{busy ? "…" : "Отметить"}</Button>
            <Button type="button" variant="ghost" onClick={() => setStep("comment")} className="w-full">Назад</Button>
          </>
        ) : (
          <Button type="button" variant="primary" onClick={openScan} className="w-full">
            <ScanLine size={18} /> Сканировать товар (EAN)
          </Button>
        )
      }
    >
      {step !== "product" && (
        <div className="mb-1 rounded-lg bg-[#f7f8fc] px-3 py-2 text-sm">
          <div className="flex justify-between gap-2"><span className="text-neutral-500">Товар (EAN)</span><span className="font-mono text-xs">{eanRaw}</span></div>
          {(step === "type" || step === "comment" || step === "confirm") && <div className="flex justify-between gap-2"><span className="text-neutral-500">Количество</span><span className="font-medium">{qty}</span></div>}
          {(step === "comment" || step === "confirm") && <div className="flex justify-between gap-2"><span className="text-neutral-500">Состояние</span><span className="font-medium">{typeLabel}</span></div>}
          {step === "confirm" && comment.trim() && <div className="flex justify-between gap-2"><span className="text-neutral-500">Комментарий</span><span className="font-medium">{comment.trim()}</span></div>}
        </div>
      )}
      <p className="text-sm text-neutral-500">Сканируйте заводской штрихкод (EAN) каждого товара заказа и вводите фактическое количество. Неожиданный товар отметьте как «излишек» или «не тот товар».</p>
    </WorkflowSheet>
  );
}


function FinishControlForm({ ctx }: { ctx: ControlOrderCtx }) {
  const [state, action, pending] = useActionState<ControlActionState, FormData>(finishControlAction, {});
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="taskId" value={ctx.taskId} />
      {state.error && <p className="text-xs text-red-600">{state.error}</p>}
      {state.status && (
        <p className="text-xs font-medium text-green-700">
          {state.status === "PASSED" ? "Проверка пройдена — заказ проверен." : "Отправлено на исправление (создана срочная задача сборщику)."}
        </p>
      )}
      <Button type="submit" disabled={pending || !ctx.allMarked} className="w-full">
        {pending ? "…" : ctx.allMarked ? "Завершить проверку" : "Отметьте все строки"}
      </Button>
    </form>
  );
}

export function ControlOrderPanel({ ctx }: { ctx: ControlOrderCtx }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium text-neutral-500">
        Контроль заказа {ctx.externalId} · попытка {ctx.attempt}
        {ctx.previousChecks.length > 0 && ` · ранее: ${ctx.previousChecks.map((p) => `#${p.attempt} ${p.status === "FAILED" ? "ошибка" : p.status === "PASSED" ? "ок" : "…"}`).join(", ")}`}
      </div>
      {!ctx.scanConfirmed ? (
        <>
          <ScanOrderCamera taskId={ctx.taskId} />
          <ScanOrderManual taskId={ctx.taskId} />
          <p className="text-xs text-neutral-400">Отсканируйте QR заказа, затем проверьте каждый товар по EAN.</p>
        </>
      ) : (
        <>
          <div className="text-xs font-medium text-neutral-500">Строки заказа — проверьте каждую по заводскому штрихкоду (EAN)</div>
          {ctx.lines.map((l) => {
            const marked = l.counted != null;
            const ok = marked && !l.discrepancyType;
            return (
              <div key={l.lineId} className="flex items-center justify-between rounded-xl bg-[#f7f8fc] px-3 py-2 text-sm">
                <span className="min-w-0 truncate">{l.item}</span>
                <Badge tone={!marked ? "neutral" : ok ? "green" : "red"}>
                  {!marked ? `нужно ${l.required}` : ok ? `✓ ${l.counted}` : `${DISCREPANCY_LABEL[l.discrepancyType ?? ""] ?? "расхождение"}: ${l.counted}/${l.required}`}
                </Badge>
              </div>
            );
          })}
          {ctx.extras.length > 0 && (
            <>
              <div className="pt-1 text-xs font-medium text-neutral-500">Неожиданные товары</div>
              {ctx.extras.map((e, i) => (
                <div key={i} className="flex items-center justify-between rounded-xl border border-red-100 bg-red-50/40 px-3 py-2 text-sm">
                  <span className="min-w-0 truncate">{e.item}</span>
                  <Badge tone="red">{DISCREPANCY_LABEL[e.discrepancyType ?? ""] ?? "лишний"}: {e.counted}</Badge>
                </div>
              ))}
            </>
          )}
          <MarkGroupScanner taskId={ctx.taskId} />
          <FinishControlForm ctx={ctx} />
        </>
      )}
    </div>
  );
}

// ── Исправление: КАЖДОЕ расхождение отдельным действием, пошагово (UI-004) ──
// открыть расхождение → EAN → количество → способ RETURN/DISCREPANCY (если применимо) →
// необязательный комментарий → итог → подтверждение. Одновременно виден только один шаг; камера и
// ручной ввод EAN — одна и та же машина состояний; ошибка сохраняет пройденные шаги.
function ResolveDiscrepancy({ taskId, disc }: { taskId: string; disc: CorrectOrderCtx["discrepancies"][number] }) {
  const router = useRouter();
  const isShortage = disc.type === "SHORTAGE";
  const isDamaged = disc.type === "DAMAGED" || disc.type === "OTHER";
  const canChooseMethod = !isShortage && !isDamaged; // EXCESS/WRONG_ITEM — есть выбор RETURN/DISCREPANCY
  const action = isShortage ? resolveShortageAction : resolveRemovalAction;
  const resolved = disc.resolutionStatus === "RESOLVED";

  type Step = "product" | "qty" | "method" | "comment" | "confirm";
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [step, setStep] = useState<Step>("product");
  const [ean, setEan] = useState("");
  const [qty, setQty] = useState("");
  const [disposition, setDisposition] = useState<"RETURN" | "DISCREPANCY">("RETURN");
  const [comment, setComment] = useState("");
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const inputCls = "rounded-lg border border-[#e4e4f0] px-3 py-2 text-sm outline-none focus:border-brand";

  function reset() { setStep("product"); setEan(""); setQty(""); setDisposition(isDamaged ? "DISCREPANCY" : "RETURN"); setComment(""); }
  function handleScan(raw: string) {
    if (busy) return;
    const v = raw.trim();
    if (!v) { setError(isShortage ? "Отсканируйте EAN добавляемого товара" : "Отсканируйте EAN удаляемого товара"); return; }
    setEan(v); setScanning(false); setStep("qty");
  }
  function submitQty() {
    const n = Number(qty.replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) { setError("Количество — число больше нуля"); return; }
    setStep(canChooseMethod ? "method" : "comment");
  }
  function submit() {
    const n = Number(qty.replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) { setError("Количество — число больше нуля"); return; }
    startTransition(async () => {
      const fd = new FormData();
      fd.set("taskId", taskId); fd.set("checkLineId", disc.checkLineId);
      fd.set("ean", ean); fd.set("qty", String(n)); fd.set("comment", comment.trim());
      if (!isShortage) fd.set("disposition", isDamaged ? "DISCREPANCY" : disposition);
      const res = await action({}, fd);
      if (res.error) { setError(res.error); return; }
      setOpen(false); reset(); router.refresh();
    });
  }

  const summary = (
    <div className="mb-1 rounded-lg bg-[#f7f8fc] px-3 py-2 text-sm">
      {ean && <div className="flex justify-between gap-2"><span className="text-neutral-500">{isShortage ? "Добавляемый EAN" : "Удаляемый EAN"}</span><span className="font-mono text-xs">{ean}</span></div>}
      {(step === "method" || step === "comment" || step === "confirm") && qty && <div className="flex justify-between gap-2"><span className="text-neutral-500">Количество</span><span className="font-medium">{qty}</span></div>}
      {step === "confirm" && !isShortage && <div className="flex justify-between gap-2"><span className="text-neutral-500">Способ</span><span className="font-medium">{(isDamaged ? "DISCREPANCY" : disposition) === "RETURN" ? "вернуть в хранение" : "изолировать в DISCREPANCY"}</span></div>}
    </div>
  );

  return (
    <div className="rounded-xl border border-[#eee] p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{disc.item}</span>
        <Badge tone={resolved ? "green" : "red"}>
          {resolved ? `✓ ${METHOD_LABEL[disc.resolutionMethod ?? ""] ?? "исправлено"}` : DISCREPANCY_LABEL[disc.type ?? ""] ?? "расхождение"}
        </Badge>
      </div>
      <div className="mt-0.5 text-xs text-neutral-600">нужно {disc.expected} · по факту {disc.counted}{disc.comment ? ` · ${disc.comment}` : ""}</div>
      {!resolved && (
        <Button type="button" variant="ghost" onClick={() => { setOpen(true); setScanning(true); reset(); setError(null); }} className="mt-2 w-full">
          <ScanLine size={16} /> {isShortage ? "Добавить товар" : "Удалить товар"}
        </Button>
      )}
      {open && (
        <WorkflowSheet
          title={isShortage ? "Добавить товар" : "Удалить товар"}
          subtitle={step === "product" ? "Шаг 1 · штрихкод" : step === "qty" ? "Шаг 2 · количество" : step === "method" ? "Шаг 3 · способ" : step === "comment" ? "Комментарий (необязательно)" : "Итог"}
          scanning={scanning}
          scanHint={isShortage ? "Сканируйте EAN добавляемого товара" : "Сканируйте EAN удаляемого товара"}
          scanFormats={PRODUCT}
          manualPlaceholder={isShortage ? "EAN добавляемого товара" : "EAN удаляемого товара"}
          manualInputMode="numeric"
          onScan={handleScan}
          scanPaused={busy}
          busy={busy}
          onBackToList={() => setScanning(false)}
          onClose={() => { setOpen(false); setScanning(false); reset(); setError(null); }}
          error={error}
          onErrorRetry={() => setError(null)}
          onErrorExit={() => { setError(null); setScanning(false); reset(); }}
          footer={
            step === "qty" ? (
              <>
                <input autoFocus value={qty} onChange={(e) => setQty(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitQty(); } }} type="number" inputMode="decimal" step="1" placeholder="Количество" className={inputCls} />
                <Button type="button" variant="primary" onClick={submitQty} className="w-full">Дальше</Button>
                <Button type="button" variant="ghost" onClick={() => { setScanning(true); setStep("product"); }} className="w-full">Назад</Button>
              </>
            ) : step === "method" ? (
              <>
                <select autoFocus value={disposition} onChange={(e) => setDisposition(e.target.value === "RETURN" ? "RETURN" : "DISCREPANCY")} className={inputCls}>
                  <option value="RETURN">вернуть в хранение</option>
                  <option value="DISCREPANCY">изолировать в DISCREPANCY</option>
                </select>
                <Button type="button" variant="primary" onClick={() => setStep("comment")} className="w-full">Дальше</Button>
                <Button type="button" variant="ghost" onClick={() => setStep("qty")} className="w-full">Назад</Button>
              </>
            ) : step === "comment" ? (
              <>
                <input autoFocus value={comment} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setStep("confirm"); } }} placeholder="комментарий (необязательно)" className={inputCls} />
                <Button type="button" variant="primary" onClick={() => setStep("confirm")} className="w-full">Дальше</Button>
                <Button type="button" variant="ghost" onClick={() => setStep(canChooseMethod ? "method" : "qty")} className="w-full">Назад</Button>
              </>
            ) : step === "confirm" ? (
              <>
                <Button type="button" variant="primary" disabled={busy} onClick={submit} className="w-full">{busy ? "…" : isShortage ? "Подтвердить добавление" : "Подтвердить удаление"}</Button>
                <Button type="button" variant="ghost" onClick={() => setStep("comment")} className="w-full">Назад</Button>
              </>
            ) : (
              <Button type="button" variant="primary" onClick={() => { setScanning(true); setStep("product"); }} className="w-full">
                <ScanLine size={18} /> Сканировать EAN
              </Button>
            )
          }
        >
          {step !== "product" && summary}
          <div className="text-xs text-neutral-600">нужно {disc.expected} · по факту {disc.counted}</div>
        </WorkflowSheet>
      )}
    </div>
  );
}

function CompleteCorrectionForm({ ctx }: { ctx: CorrectOrderCtx }) {
  const [state, action, pending] = useActionState<ControlActionState, FormData>(completeCorrectionAction, {});
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="taskId" value={ctx.taskId} />
      {state.error && <p className="text-xs text-red-600">{state.error}</p>}
      {state.ok && <p className="text-xs font-medium text-green-700">Исправление выполнено — заказ отправлен на полную повторную проверку.</p>}
      <Button type="submit" disabled={pending || !ctx.allResolved} className="w-full">
        {pending ? "…" : ctx.allResolved ? "Исправление выполнено" : "Разрешите все расхождения"}
      </Button>
      <p className="text-xs text-neutral-400">После разрешения ВСЕХ расхождений заказ проходит ПОЛНЫЙ повторный контроль.</p>
    </form>
  );
}

export function CorrectOrderPanel({ ctx }: { ctx: CorrectOrderCtx }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium text-neutral-500">Исправить заказ {ctx.externalId} — расхождения контроля (каждое отдельным действием)</div>
      {ctx.discrepancies.length === 0 ? (
        <p className="text-xs text-neutral-400">Нет данных о расхождениях.</p>
      ) : (
        ctx.discrepancies.map((d) => <ResolveDiscrepancy key={d.checkLineId} taskId={ctx.taskId} disc={d} />)
      )}
      <CompleteCorrectionForm ctx={ctx} />
    </div>
  );
}
