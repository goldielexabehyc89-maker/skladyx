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
      <ManualForm title="Разместить по кодам/EAN (без камеры)" submit="Разместить по кодам" action={placeGroupAction} taskId={ctx.taskId}
        fields={[{ name: "orderCode", placeholder: "Код QR заказа" }, { name: "cellCode", placeholder: "Код QR ячейки выдачи" }, { name: "ean", placeholder: "EAN товара (8/13 цифр)" }]} />
      <ManualForm title="Добавить ячейку по коду" submit="Добавить ячейку" action={addCellAction} taskId={ctx.taskId}
        fields={[{ name: "cellCode", placeholder: "Код QR свободной ячейки выдачи" }]} />
      <FinishPlacementForm ctx={ctx} />
    </div>
  );
}

export function DeliverOrderPanel({ ctx }: { ctx: DeliverOrderCtx }) {
  const [state, action, pending] = useActionState<IssueActionState, FormData>(issueAction, {});
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium text-neutral-500">Выдача заказа {ctx.externalId} водителю · приезд {fmtArrival(ctx.arrivalAt)}</div>
      <div className="text-xs font-medium text-neutral-500">Отсканируйте ВСЕ ячейки выдачи заказа:</div>
      {ctx.cells.map((c, i) => (
        <div key={i} className="rounded-xl bg-[#f7f8fc] px-3 py-2 text-sm">{c.cell}</div>
      ))}
      <form action={action} className="flex flex-col gap-2">
        <input type="hidden" name="taskId" value={ctx.taskId} />
        <input name="orderCode" required placeholder="Код QR заказа" className="rounded-lg border border-[#e4e4f0] px-3 py-1.5 text-sm" />
        <input name="cellCodes" required placeholder="Коды всех ячеек через запятую" className="rounded-lg border border-[#e4e4f0] px-3 py-1.5 text-sm" />
        {state.error && <p className="text-xs text-red-600">{state.error}</p>}
        {state.ok && <p className="text-xs font-medium text-green-700">Заказ выдан водителю.</p>}
        <Button type="submit" disabled={pending} className="w-full">{pending ? "…" : "Подтвердить выдачу водителю"}</Button>
        <p className="text-xs text-neutral-400">Сервер проверит полный набор ячеек. Подтверждение водителя не требуется.</p>
      </form>
    </div>
  );
}
