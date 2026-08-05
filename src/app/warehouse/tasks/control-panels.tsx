"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ScanLine } from "lucide-react";
import {
  scanOrderControlAction,
  markControlLineAction,
  finishControlAction,
  completeCorrectionAction,
  type ControlActionState,
} from "@/app/actions/order-control";
import { Button, Badge } from "@/components/ui";
import { WorkflowSheet } from "@/components/workflow-sheet";

// Этап 5/Пакет 7: панели контролёра (проверка всего заказа по QR) и сборщика (исправление).
// Настоящее сканирование QR заказа через WorkflowSheet/QrScanner + ручной ввод кода как fallback.

export interface ControlOrderCtx {
  taskId: string;
  orderId: string;
  externalId: string;
  scanConfirmed: boolean;
  attempt: number;
  lines: { lineId: string; item: string; required: string; counted: string | null; discrepancyType: string | null }[];
  allMarked: boolean;
  previousChecks: { attempt: number; status: string }[];
}
export interface CorrectOrderCtx {
  taskId: string;
  orderId: string;
  externalId: string;
  discrepancies: { item: string; type: string | null; expected: string; counted: string; comment: string | null }[];
}

const DISCREPANCY_LABEL: Record<string, string> = {
  SHORTAGE: "Недостача",
  EXCESS: "Излишек",
  WRONG_ITEM: "Не тот товар",
  DAMAGED: "Повреждён",
  OTHER: "Другое",
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

// ── Ручной ввод кода заказа (fallback без камеры) ──
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

// ── Отметка одной строки: фактическое количество + опц. тип расхождения и комментарий ──
function MarkLineForm({ taskId, line }: { taskId: string; line: ControlOrderCtx["lines"][number] }) {
  const [state, action, pending] = useActionState<ControlActionState, FormData>(markControlLineAction, {});
  const marked = line.counted != null;
  const ok = marked && !line.discrepancyType;
  return (
    <form action={action} className="rounded-xl border border-[#eee] p-2.5">
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="lineId" value={line.lineId} />
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{line.item}</span>
        <Badge tone={!marked ? "neutral" : ok ? "green" : "red"}>
          {!marked ? `нужно ${line.required}` : ok ? `✓ ${line.counted}` : `${DISCREPANCY_LABEL[line.discrepancyType ?? ""] ?? "расхождение"}: ${line.counted}/${line.required}`}
        </Badge>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input name="countedQty" required type="number" inputMode="decimal" step="1" defaultValue={line.counted ?? ""} placeholder={`факт (нужно ${line.required})`} className="w-28 rounded-lg border border-[#e4e4f0] px-2 py-1 text-sm" />
        <select name="discrepancyType" defaultValue={line.discrepancyType ?? ""} className="rounded-lg border border-[#e4e4f0] px-2 py-1 text-sm">
          <option value="">нет расхождения</option>
          <option value="SHORTAGE">недостача</option>
          <option value="EXCESS">излишек</option>
          <option value="WRONG_ITEM">не тот товар</option>
          <option value="DAMAGED">повреждён</option>
          <option value="OTHER">другое</option>
        </select>
        <input name="comment" placeholder="комментарий" className="min-w-0 flex-1 rounded-lg border border-[#e4e4f0] px-2 py-1 text-sm" />
        <Button type="submit" variant="ghost" disabled={pending}>{pending ? "…" : "Отметить"}</Button>
      </div>
      {state.error && <p className="mt-1 text-xs text-red-600">{state.error}</p>}
    </form>
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
          <p className="text-xs text-neutral-400">Отсканируйте QR заказа, затем проверьте каждую строку и количество.</p>
        </>
      ) : (
        <>
          <div className="text-xs font-medium text-neutral-500">Строки заказа — проверьте каждую</div>
          {ctx.lines.map((l) => (
            <MarkLineForm key={l.lineId} taskId={ctx.taskId} line={l} />
          ))}
          <FinishControlForm ctx={ctx} />
        </>
      )}
    </div>
  );
}

export function CorrectOrderPanel({ ctx }: { ctx: CorrectOrderCtx }) {
  const [state, action, pending] = useActionState<ControlActionState, FormData>(completeCorrectionAction, {});
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium text-neutral-500">Исправить заказ {ctx.externalId} — расхождения контроля</div>
      {ctx.discrepancies.length === 0 ? (
        <p className="text-xs text-neutral-400">Нет данных о расхождениях.</p>
      ) : (
        ctx.discrepancies.map((d, i) => (
          <div key={i} className="rounded-xl border border-red-100 bg-red-50/40 px-3 py-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-medium">{d.item}</span>
              <Badge tone="red">{DISCREPANCY_LABEL[d.type ?? ""] ?? "расхождение"}</Badge>
            </div>
            <div className="mt-0.5 text-xs text-neutral-600">нужно {d.expected} · по факту {d.counted}{d.comment ? ` · ${d.comment}` : ""}</div>
          </div>
        ))
      )}
      <form action={action} className="flex flex-col gap-1">
        <input type="hidden" name="taskId" value={ctx.taskId} />
        {state.error && <p className="text-xs text-red-600">{state.error}</p>}
        {state.ok && <p className="text-xs font-medium text-green-700">Исправление выполнено — заказ отправлен на полную повторную проверку.</p>}
        <Button type="submit" disabled={pending} className="w-full">{pending ? "…" : "Исправление выполнено"}</Button>
        <p className="text-xs text-neutral-400">После исправления заказ проходит ПОЛНЫЙ повторный контроль (все строки заново).</p>
      </form>
    </div>
  );
}
