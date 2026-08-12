"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ScanLine } from "lucide-react";
import {
  scanOrderControlAction,
  confirmControlLineAction,
  finishControlAction,
  verifyCorrectionEanAction,
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
  positions: number;
  units: string;
  marked: number;
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
function ScanOrderCamera({ taskId, externalId }: { taskId: string; externalId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false); // UI-005: заметное зелёное подтверждение перед переходом

  function handleScan(raw: string) {
    if (busy || confirmed) return;
    startTransition(async () => {
      const fd = new FormData();
      fd.set("taskId", taskId);
      fd.set("orderCode", raw);
      // Сервер авторитетно сверяет, что QR относится ИМЕННО к этому заказу/задаче (иначе ошибка, БД не меняется).
      const res = await scanOrderControlAction({}, fd);
      if (res.error) { setError(res.error); return; } // неправильный QR — шаг не меняется
      setScanning(false); setConfirmed(true);
      // заметная пауза на зелёное подтверждение (UI-005), затем открывается пошаговый контроль товаров
      setTimeout(() => { setOpen(false); router.refresh(); }, 1500);
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
      title="Проверить заказ"
      subtitle={confirmed ? undefined : `№ ${externalId}`}
      scanning={scanning}
      scanHint={`Сканируйте QR заказа ${externalId}`}
      scanFormats={ORDERF}
      manualPlaceholder="Код QR заказа"
      onScan={handleScan}
      scanPaused={busy || confirmed}
      busy={busy}
      onBackToList={() => setScanning(false)}
      onClose={() => { setOpen(false); setScanning(false); }}
      error={error}
      onErrorRetry={() => setError(null)}
      onErrorExit={() => { setError(null); setScanning(false); setOpen(false); }}
      modal={confirmed ? { title: "Заказ подтверждён", body: `№ ${externalId} — проверьте товары` } : null}
      footer={
        <Button type="button" variant="primary" onClick={() => setScanning(true)} className="w-full">
          <ScanLine size={18} /> Сканировать QR заказа
        </Button>
      }
    >
      <p className="text-sm text-neutral-500">Отсканируйте QR заказа в зоне контроля.</p>
    </WorkflowSheet>
  );
}

// ── CONTROL-001 (Задача N): контролёр подтверждает строку заказа КЛИКОМ (без EAN/количества/мастера).
// Неподтверждённая строка — крупная кнопка (наименование + ожидаемое количество). Нажатие серверно
// подтверждает строку (countedQty=requiredQty, без расхождения). Подтверждённая — с галкой, не нажимается.
function ConfirmLineButton({ taskId, line }: { taskId: string; line: ControlOrderCtx["lines"][number] }) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const confirmed = line.counted != null;
  if (confirmed)
    return (
      <div className="flex items-center justify-between rounded-xl border border-green-200 bg-green-50 px-3 py-3 text-sm">
        <span className="min-w-0 truncate font-medium text-[#1a1a1a]">{line.item}</span>
        <Badge tone="green">✓ {line.counted}</Badge>
      </div>
    );
  function confirm() {
    if (busy) return;
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("taskId", taskId); fd.set("lineId", line.lineId);
      const res = await confirmControlLineAction({}, fd);
      if (res.error) { setError(res.error); return; } // строка не подтверждена, состояние не меняется
      router.refresh();
    });
  }
  return (
    <div className="flex flex-col gap-1">
      <button type="button" onClick={confirm} disabled={busy} aria-busy={busy}
        className="flex w-full items-center justify-between rounded-xl border border-[#d7dbf5] bg-white px-3 py-3 text-left text-sm active:bg-[#f2f4fd] disabled:opacity-60">
        <span className="min-w-0 truncate font-semibold text-[#1a1a1a]">{line.item}</span>
        <Badge tone="neutral">{busy ? "…" : `нужно ${line.required}`}</Badge>
      </button>
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
    </div>
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
      {/* Задача M Этап2: попытку/историю показываем только при повторном контроле (компактно). Номер
          заказа и позиции/единицы — в карточке; здесь их не дублируем. */}
      {ctx.previousChecks.length > 0 && (
        <div className="text-xs font-medium text-neutral-500">
          Попытка {ctx.attempt} · ранее: {ctx.previousChecks.map((p) => `#${p.attempt} ${p.status === "FAILED" ? "ошибка" : p.status === "PASSED" ? "ок" : "…"}`).join(", ")}
        </div>
      )}
      {!ctx.scanConfirmed ? (
        // Один вход: сканер QR заказа (внутри — ручной ввод кода как fallback). Отдельный блок ручного
        // ввода убран как дублирующий; серверная проверка QR остаётся авторитетной.
        <ScanOrderCamera taskId={ctx.taskId} externalId={ctx.externalId} />
      ) : (
        // CONTROL-001 (Задача N): подтверждение строк кликом — без EAN/количества/состояния/комментария.
        <>
          {ctx.lines.map((l) => (<ConfirmLineButton key={l.lineId} taskId={ctx.taskId} line={l} />))}
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
  const [confirmed, setConfirmed] = useState(false); // UI-005: зелёное подтверждение товара расхождения
  const inputCls = "rounded-lg border border-[#e4e4f0] px-3 py-2 text-sm outline-none focus:border-brand";

  function reset() { setStep("product"); setEan(""); setQty(""); setDisposition(isDamaged ? "DISCREPANCY" : "RETURN"); setComment(""); setConfirmed(false); }
  // Задача O: EAN расхождения проверяется сервером НЕМЕДЛЕННО (verifyCorrectionEanAction) — не клиентским
  // setStep. Неверный товар → красная ошибка, шаг не меняется, БД не мутирует. Верный → зелёное → количество.
  function handleScan(raw: string) {
    if (busy || confirmed) return;
    const v = raw.trim();
    if (!v) { setError(`Отсканируйте товар ${disc.item}`); return; }
    startTransition(async () => {
      const fd = new FormData();
      fd.set("taskId", taskId); fd.set("checkLineId", disc.checkLineId); fd.set("ean", v);
      const res = await verifyCorrectionEanAction({}, fd);
      if (res.error) { setError(res.error); return; } // товар не тот — шаг не меняется
      setEan(v); setScanning(false); setConfirmed(true);
      setTimeout(() => { setConfirmed(false); setStep("qty"); }, 900);
    });
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
          scanHint={`Сканируйте товар ${disc.item}`}
          scanFormats={PRODUCT}
          manualPlaceholder={`EAN товара ${disc.item}`}
          manualInputMode="numeric"
          onScan={handleScan}
          scanPaused={busy || confirmed}
          busy={busy}
          onBackToList={() => setScanning(false)}
          onClose={() => { setOpen(false); setScanning(false); reset(); setError(null); }}
          error={error}
          onErrorRetry={() => { setError(null); setScanning(true); }}
          onErrorExit={() => { setError(null); setScanning(false); reset(); }}
          modal={confirmed ? { title: "Товар подтверждён", body: disc.item } : null}
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
