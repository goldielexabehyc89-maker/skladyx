"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ScanLine } from "lucide-react";
import {
  placeGroupAction,
  addCellAction,
  finishPlacementAction,
  issueAction,
  type IssueActionState,
} from "@/app/actions/order-issue";
import { Button, Badge } from "@/components/ui";
import { WorkflowSheet, type ScanFormat } from "@/components/workflow-sheet";

// Пакет 9B: форматы по шагу
const CELL: ScanFormat[] = ["qr_code", "code_128"];
const PRODUCT: ScanFormat[] = ["ean_8", "ean_13"];
const ORDER: ScanFormat[] = ["qr_code"];

// Этап 5/Пакет 8: панели погрузчика — размещение проверенного заказа в ячейки выдачи и выдача
// водителю. Настоящее сканирование через WorkflowSheet/QrScanner + ручной ввод кодов как fallback.

export interface IssueOrderCtx {
  taskId: string;
  orderId: string;
  externalId: string;
  arrivalAt: string | null;
  cells: { cell: string; code: string | null; status: string }[];
  remainingInControl: string;
  canFinish: boolean;
}
export interface DeliverOrderCtx {
  taskId: string;
  orderId: string;
  externalId: string;
  arrivalAt: string | null;
  cells: { cell: string }[];
}

const fmtArrival = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// ── Размещение: скан QR заказа → ячейки → группы камерой ──
function PlaceScanner({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [step, setStep] = useState<"order" | "cell" | "product">("order");
  const [orderRaw, setOrderRaw] = useState("");
  const [cellRaw, setCellRaw] = useState("");
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function reset(keepOrder = false) { setStep(keepOrder ? "cell" : "order"); if (!keepOrder) setOrderRaw(""); setCellRaw(""); setNotice(null); }
  function handleScan(raw: string) {
    if (busy) return;
    if (step === "order") { setOrderRaw(raw); setStep("cell"); setNotice("Заказ отсканирован — сканируйте QR/Code 128 ячейки выдачи"); return; }
    if (step === "cell") { setCellRaw(raw); setStep("product"); setNotice("Ячейка отсканирована — сканируйте EAN товара"); return; }
    // step === group → размещаем
    startTransition(async () => {
      const fd = new FormData();
      fd.set("taskId", taskId); fd.set("orderCode", orderRaw); fd.set("cellCode", cellRaw); fd.set("ean", raw);
      const res = await placeGroupAction({}, fd);
      if (res.error) { setError(res.error); return; }
      reset(true); setNotice("✓ Размещено — сканируйте следующий товар/ячейку"); router.refresh();
    });
  }
  if (!open)
    return (
      <Button type="button" variant="primary" onClick={() => { setOpen(true); setScanning(true); setStep("order"); }} className="w-full">
        <ScanLine size={18} /> Разместить (сканирование)
      </Button>
    );
  return (
    <WorkflowSheet
      title="Размещение в выдаче"
      subtitle="QR заказа → ячейка → EAN товара"
      scanning={scanning}
      scanHint={step === "order" ? "Сканируйте QR заказа" : step === "cell" ? "Сканируйте QR/Code 128 ячейки выдачи" : "Сканируйте EAN товара"}
      scanFormats={step === "order" ? ORDER : step === "cell" ? CELL : PRODUCT}
      manualPlaceholder={step === "order" ? "Код QR заказа" : step === "cell" ? "Код ячейки выдачи" : "EAN товара (8/13 цифр)"}
      manualInputMode={step === "product" ? "numeric" : "text"}
      onScan={handleScan}
      scanPaused={busy}
      busy={busy}
      onBackToList={() => setScanning(false)}
      onClose={() => { setOpen(false); setScanning(false); reset(); setError(null); }}
      error={error}
      onErrorRetry={() => setError(null)}
      onErrorExit={() => { setError(null); setScanning(false); reset(); }}
      footer={
        <Button type="button" variant="primary" onClick={() => setScanning(true)} className="w-full">
          <ScanLine size={18} /> Сканировать
        </Button>
      }
    >
      {notice && <p className="pb-1 text-sm font-medium text-green-600">{notice}</p>}
      <p className="text-sm text-neutral-500">Сканируйте QR заказа, затем ячейку выдачи и группу. Для большого заказа добавьте ещё ячейку.</p>
    </WorkflowSheet>
  );
}

function ManualForm({ title, submit, action, fields, taskId }: { title: string; submit: string; action: (p: IssueActionState, f: FormData) => Promise<IssueActionState>; fields: { name: string; placeholder: string }[]; taskId: string }) {
  const [state, formAction, pending] = useActionState<IssueActionState, FormData>(action, {});
  return (
    <details className="text-xs text-neutral-500">
      <summary className="cursor-pointer">{title}</summary>
      <form action={formAction} className="mt-2 flex flex-col gap-2">
        <input type="hidden" name="taskId" value={taskId} />
        {fields.map((f) => (
          <input key={f.name} name={f.name} required placeholder={f.placeholder} className="rounded-lg border border-[#e4e4f0] px-3 py-1.5 text-sm" />
        ))}
        {state.error && <p className="text-red-600">{state.error}</p>}
        {state.ok && <p className="text-green-700">✓ Готово</p>}
        <Button type="submit" variant="ghost" disabled={pending}>{pending ? "…" : submit}</Button>
      </form>
    </details>
  );
}

function FinishPlacementForm({ ctx }: { ctx: IssueOrderCtx }) {
  const [state, action, pending] = useActionState<IssueActionState, FormData>(finishPlacementAction, {});
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="taskId" value={ctx.taskId} />
      {state.error && <p className="text-xs text-red-600">{state.error}</p>}
      {state.ok && <p className="text-xs font-medium text-green-700">Заказ размещён — создана задача выдачи водителю.</p>}
      <Button type="submit" disabled={pending || !ctx.canFinish} className="w-full">
        {pending ? "…" : ctx.canFinish ? "Готово (весь заказ размещён)" : `В зоне контроля ещё ${ctx.remainingInControl}`}
      </Button>
    </form>
  );
}

export function IssueOrderPanel({ ctx }: { ctx: IssueOrderCtx }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium text-neutral-500">Размещение заказа {ctx.externalId} · приезд {fmtArrival(ctx.arrivalAt)} · в контроле ещё {ctx.remainingInControl}</div>
      <div className="text-xs font-medium text-neutral-500">Ячейки выдачи</div>
      {ctx.cells.length === 0 ? (
        <p className="text-xs text-neutral-400">Ячейка ещё не зарезервирована.</p>
      ) : (
        ctx.cells.map((c, i) => (
          <div key={i} className="flex items-center justify-between rounded-xl bg-[#f7f8fc] px-3 py-2 text-sm">
            <span className="min-w-0 truncate">{c.cell}</span>
            <Badge tone={c.status === "PLACED" ? "green" : "blue"}>{c.status === "PLACED" ? "размещено" : "зарезервирована"}</Badge>
          </div>
        ))
      )}
      <PlaceScanner taskId={ctx.taskId} />
      {/* UI-004: ручной ввод — пошагово в шторке сканера (одно поле). Отдельное действие «Добавить
          ячейку» — одно поле, допустимо. Многополевой ручной ввод размещения убран. */}
      <ManualForm title="Добавить ячейку по коду" submit="Добавить ячейку" action={addCellAction} taskId={ctx.taskId}
        fields={[{ name: "cellCode", placeholder: "Код QR свободной ячейки выдачи" }]} />
      <FinishPlacementForm ctx={ctx} />
    </div>
  );
}

// UI-004: выдача водителю — пошаговый скан: QR заказа → каждая ячейка выдачи по очереди → авто-подтверждение
// (сервер проверит полный набор ячеек). Камера и ручной ввод — одна машина состояний; не набор полей.
function DeliverScanner({ ctx }: { ctx: DeliverOrderCtx }) {
  const total = ctx.cells.length;
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [step, setStep] = useState<"order" | "cell">("order");
  const [orderRaw, setOrderRaw] = useState("");
  const [cells, setCells] = useState<string[]>([]);
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  function reset() { setStep("order"); setOrderRaw(""); setCells([]); setNotice(null); }
  function closeAll() { setOpen(false); setScanning(false); reset(); setError(null); setFinished(false); router.refresh(); }

  function handleScan(raw: string) {
    if (busy) return;
    if (step === "order") { setOrderRaw(raw.trim()); setStep("cell"); setNotice(`Заказ отсканирован — сканируйте ячейки выдачи (0/${total})`); return; }
    const v = raw.trim(); if (!v) return;
    const next = cells.includes(v) ? cells : [...cells, v];
    setCells(next);
    if (next.length >= total) {
      startTransition(async () => {
        const fd = new FormData();
        fd.set("taskId", ctx.taskId); fd.set("orderCode", orderRaw); fd.set("cellCodes", next.join(","));
        const res = await issueAction({}, fd);
        if (res.error) { setError(res.error); return; }
        setScanning(false); setFinished(true);
      });
    } else setNotice(`Отсканировано ячеек ${next.length}/${total}`);
  }

  if (!open)
    return (
      <Button type="button" variant="primary" onClick={() => { setOpen(true); setScanning(true); setStep("order"); }} className="w-full">
        <ScanLine size={18} /> Выдать водителю (сканирование)
      </Button>
    );

  return (
    <WorkflowSheet
      title={`Выдача заказа ${ctx.externalId}`}
      subtitle={step === "order" ? "Сканируйте QR заказа" : `Ячейки выдачи ${cells.length}/${total}`}
      scanning={scanning}
      scanHint={step === "order" ? "Сканируйте QR заказа" : "Сканируйте ячейку выдачи (QR/Code 128)"}
      scanFormats={step === "order" ? ORDER : CELL}
      manualPlaceholder={step === "order" ? "Код QR заказа" : "Код ячейки выдачи"}
      onScan={handleScan}
      scanPaused={busy}
      busy={busy}
      onBackToList={() => setScanning(false)}
      onClose={closeAll}
      error={error}
      onErrorRetry={() => setError(null)}
      onErrorExit={() => { setError(null); setScanning(false); reset(); }}
      modal={finished ? { title: "Заказ выдан водителю", body: "Все ячейки подтверждены.", actions: (<Button type="button" variant="primary" onClick={closeAll} className="w-full">Ок</Button>) } : null}
      footer={
        <Button type="button" variant="primary" onClick={() => { setScanning(true); }} className="w-full">
          <ScanLine size={18} /> {step === "order" ? "Сканировать QR заказа" : "Сканировать ячейку"}
        </Button>
      }
    >
      {notice && <p className="pb-1 text-sm font-medium text-green-600">{notice}</p>}
      <p className="text-sm text-neutral-500">Отсканируйте QR заказа, затем поочерёдно все ячейки выдачи. Подтверждение — автоматически после последней ячейки.</p>
    </WorkflowSheet>
  );
}

export function DeliverOrderPanel({ ctx }: { ctx: DeliverOrderCtx }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium text-neutral-500">Выдача заказа {ctx.externalId} водителю · приезд {fmtArrival(ctx.arrivalAt)}</div>
      <div className="text-xs font-medium text-neutral-500">Ячейки выдачи заказа ({ctx.cells.length}):</div>
      {ctx.cells.map((c, i) => (
        <div key={i} className="rounded-xl bg-[#f7f8fc] px-3 py-2 text-sm">{c.cell}</div>
      ))}
      <DeliverScanner ctx={ctx} />
      <p className="text-xs text-neutral-400">Сервер проверит полный набор ячеек. Подтверждение водителя не требуется.</p>
    </div>
  );
}
