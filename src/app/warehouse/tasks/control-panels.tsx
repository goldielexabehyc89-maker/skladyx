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

// ── Контроль: скан QR группы/товара камерой → количество (+ опц. тип для неожиданного товара) ──
function MarkGroupScanner({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [step, setStep] = useState<"product" | "qty">("product");
  const [eanRaw, setEanRaw] = useState("");
  const [qty, setQty] = useState("");
  const [type, setType] = useState("");
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function reset() { setStep("product"); setEanRaw(""); setQty(""); setType(""); setNotice(null); }
  function handleScan(raw: string) {
    if (busy) return;
    setEanRaw(raw); setScanning(false); setStep("qty"); setNotice("Товар отсканирован — введите количество");
  }
  function submit() {
    const n = Number(qty.replace(",", "."));
    if (!Number.isFinite(n) || n < 0) { setError("Укажите количество"); return; }
    startTransition(async () => {
      const fd = new FormData();
      fd.set("taskId", taskId); fd.set("ean", eanRaw); fd.set("countedQty", String(n)); fd.set("discrepancyType", type);
      const res = await markControlScanAction({}, fd);
      if (res.error) { setError(res.error); return; }
      reset(); router.refresh();
    });
  }
  if (!open)
    return (
      <Button type="button" variant="primary" onClick={() => { setOpen(true); setScanning(true); setStep("product"); }} className="w-full">
        <ScanLine size={18} /> Проверить группу (сканирование)
      </Button>
    );
  return (
    <WorkflowSheet
      title="Проверка группы"
      subtitle="Сканируйте EAN товара, затем количество"
      scanning={scanning}
      scanHint="Сканируйте EAN товара"
      scanFormats={PRODUCT}
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
            <input value={qty} onChange={(e) => setQty(e.target.value)} type="number" inputMode="decimal" step="1" placeholder="Фактическое количество" className="rounded-lg border border-[#e4e4f0] px-3 py-2 text-sm" />
            <select value={type} onChange={(e) => setType(e.target.value)} className="rounded-lg border border-[#e4e4f0] px-3 py-2 text-sm">
              <option value="">авто (по количеству)</option>
              <option value="EXCESS">излишек / неожиданный товар</option>
              <option value="WRONG_ITEM">не тот товар</option>
              <option value="DAMAGED">повреждён</option>
              <option value="OTHER">другое</option>
            </select>
            <Button type="button" variant="primary" disabled={busy} onClick={submit} className="w-full">{busy ? "…" : "Отметить"}</Button>
            <Button type="button" variant="ghost" onClick={reset} className="w-full">Заново сканировать</Button>
          </>
        ) : (
          <Button type="button" variant="primary" onClick={() => { setScanning(true); setStep("product"); setNotice(null); }} className="w-full">
            <ScanLine size={18} /> Сканировать товар (EAN)
          </Button>
        )
      }
    >
      {notice && <p className="pb-1 text-sm font-medium text-green-600">{notice}</p>}
      <p className="text-sm text-neutral-500">Сканируйте каждый товар заказа и вводите фактическое количество. Неожиданный товар отметьте как «излишек» или «не тот товар».</p>
    </WorkflowSheet>
  );
}

function MarkGroupManual({ taskId }: { taskId: string }) {
  const [state, action, pending] = useActionState<ControlActionState, FormData>(markControlScanAction, {});
  return (
    <details className="text-xs text-neutral-500">
      <summary className="cursor-pointer">Ввести код группы вручную (без камеры)</summary>
      <form action={action} className="mt-2 flex flex-col gap-2">
        <input type="hidden" name="taskId" value={taskId} />
        <input name="ean" required placeholder="EAN товара (8/13 цифр)" className="rounded-lg border border-[#e4e4f0] px-3 py-1.5 text-sm" />
        <input name="countedQty" required type="number" inputMode="decimal" step="1" placeholder="Фактическое количество" className="rounded-lg border border-[#e4e4f0] px-3 py-1.5 text-sm" />
        <select name="discrepancyType" className="rounded-lg border border-[#e4e4f0] px-3 py-1.5 text-sm">
          <option value="">авто (по количеству)</option>
          <option value="EXCESS">излишек / неожиданный товар</option>
          <option value="WRONG_ITEM">не тот товар</option>
          <option value="DAMAGED">повреждён</option>
          <option value="OTHER">другое</option>
        </select>
        <input name="comment" placeholder="комментарий" className="rounded-lg border border-[#e4e4f0] px-3 py-1.5 text-sm" />
        {state.error && <p className="text-red-600">{state.error}</p>}
        <Button type="submit" variant="ghost" disabled={pending}>{pending ? "…" : "Отметить по коду"}</Button>
      </form>
    </details>
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
          <div className="text-xs font-medium text-neutral-500">Строки заказа — проверьте каждую по QR</div>
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
          <MarkGroupManual taskId={ctx.taskId} />
          <FinishControlForm ctx={ctx} />
        </>
      )}
    </div>
  );
}

// ── Исправление: отдельное действие на каждое расхождение ──
function ResolveDiscrepancy({ taskId, disc }: { taskId: string; disc: CorrectOrderCtx["discrepancies"][number] }) {
  const isShortage = disc.type === "SHORTAGE";
  const isDamaged = disc.type === "DAMAGED" || disc.type === "OTHER";
  const action = isShortage ? resolveShortageAction : resolveRemovalAction;
  const [state, formAction, pending] = useActionState<ControlActionState, FormData>(action, {});
  const resolved = disc.resolutionStatus === "RESOLVED";
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
        <form action={formAction} className="mt-2 flex flex-col gap-2">
          <input type="hidden" name="taskId" value={taskId} />
          <input type="hidden" name="checkLineId" value={disc.checkLineId} />
          <input name="ean" required inputMode="numeric" placeholder={isShortage ? "EAN добавляемого товара" : "EAN удаляемого товара"} className="rounded-lg border border-[#e4e4f0] px-2 py-1 text-sm" />
          <input name="qty" required type="number" inputMode="decimal" step="1" placeholder="Количество" className="rounded-lg border border-[#e4e4f0] px-2 py-1 text-sm" />
          {!isShortage && (
            <select name="disposition" defaultValue={isDamaged ? "DISCREPANCY" : "RETURN"} className="rounded-lg border border-[#e4e4f0] px-2 py-1 text-sm">
              {!isDamaged && <option value="RETURN">вернуть в хранение</option>}
              <option value="DISCREPANCY">изолировать в DISCREPANCY</option>
            </select>
          )}
          <input name="comment" placeholder="комментарий" className="rounded-lg border border-[#e4e4f0] px-2 py-1 text-sm" />
          {state.error && <p className="text-xs text-red-600">{state.error}</p>}
          <Button type="submit" variant="ghost" disabled={pending}>{pending ? "…" : isShortage ? "Подтвердить добавление" : "Подтвердить удаление"}</Button>
        </form>
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
