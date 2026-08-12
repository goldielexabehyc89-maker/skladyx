"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ScanLine } from "lucide-react";
import {
  verifyIssueScanAction,
  placeWholeOrderAction,
  verifyDeliverScanAction,
  deliverWholeOrderAction,
} from "@/app/actions/order-issue";
import { Button } from "@/components/ui";
import { WorkflowSheet, type ScanFormat } from "@/components/workflow-sheet";

// Пакет 9B: форматы по шагу
const CELL: ScanFormat[] = ["qr_code", "code_128"];
const ORDER: ScanFormat[] = ["qr_code"];

// ISSUE-002 v1 (Задача N): панель погрузчика — размещение ЦЕЛОГО заказа в назначенную ячейку выдачи.
// Два скана без EAN: QR заказа (немедленная read-only проверка) → назначенная ячейка (атомарное
// перемещение всего заказа + DELIVER_ORDER). Настоящее сканирование через WorkflowSheet/QrScanner.

export interface IssueOrderCtx {
  taskId: string;
  orderId: string;
  externalId: string;
  arrivalAt: string | null;
  cells: { cell: string; code: string | null; status: string }[];
  positions: number;
  units: string;
  assignedCellCode: string | null;
  remainingInControl: string;
  canFinish: boolean;
}
export interface DeliverOrderCtx {
  taskId: string;
  orderId: string;
  externalId: string;
  arrivalAt: string | null;
  cells: { cell: string }[];
  positions: number;
  units: string;
  assignedCellCode: string | null;
}

// ── ISSUE-002 v1: скан QR заказа → зелёное подтверждение → скан назначенной ячейки → атомарное
// размещение всего заказа. Одна машина состояний (камера + ручной ввод). Без EAN/списка статусов. ──
function PlaceScanner({ ctx }: { ctx: IssueOrderCtx }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [step, setStep] = useState<"order" | "cell">("order");
  const [orderRaw, setOrderRaw] = useState("");
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false); // UI-005: зелёное подтверждение заказа перед ячейкой
  const [done, setDone] = useState(false);           // финальный успех — держится до «Ок»

  function openAt(s: "order" | "cell") { setOpen(true); setStep(s); setScanning(true); setError(null); }
  function closeAll() { setOpen(false); setScanning(false); setStep("order"); setOrderRaw(""); setConfirmed(false); setDone(false); setError(null); router.refresh(); }

  function handleScan(raw: string) {
    if (busy || confirmed || done) return;
    if (step === "order") {
      startTransition(async () => {
        const fd = new FormData();
        fd.set("taskId", ctx.taskId); fd.set("orderCode", raw);
        const res = await verifyIssueScanAction({}, fd);
        if (res.error) { setError(res.error); return; } // неверный QR — шаг не меняется, БД не меняется
        setOrderRaw(raw); setScanning(false); setConfirmed(true);
        // заметное зелёное подтверждение (UI-005), затем автоматически открывается скан ячейки
        setTimeout(() => { setConfirmed(false); setStep("cell"); setScanning(true); }, 1200);
      });
      return;
    }
    // step === cell → атомарное размещение всего заказа
    startTransition(async () => {
      const fd = new FormData();
      fd.set("taskId", ctx.taskId); fd.set("orderCode", orderRaw); fd.set("cellCode", raw);
      const res = await placeWholeOrderAction({}, fd);
      if (res.error) { setError(res.error); return; } // неверная ячейка — без движения, шаг не меняется
      setScanning(false); setDone(true); // финальное уведомление до «Ок»
    });
  }

  if (!open)
    return (
      <Button type="button" variant="primary" onClick={() => openAt("order")} className="w-full">
        <ScanLine size={18} /> Разместить заказ (сканирование)
      </Button>
    );
  return (
    <WorkflowSheet
      title="Разместить заказ в выдаче"
      subtitle={confirmed || done ? undefined : step === "order" ? `№ ${ctx.externalId}` : `Ячейка ${ctx.assignedCellCode ?? "—"}`}
      scanning={scanning}
      scanHint={step === "order" ? `Сканируйте QR заказа ${ctx.externalId}` : `Сканируйте ячейку ${ctx.assignedCellCode ?? ""}`}
      scanFormats={step === "order" ? ORDER : CELL}
      manualPlaceholder={step === "order" ? "Код QR заказа" : "Код назначенной ячейки"}
      onScan={handleScan}
      scanPaused={busy || confirmed || done}
      busy={busy}
      onBackToList={() => setScanning(false)}
      onClose={() => { setOpen(false); setScanning(false); setError(null); }}
      error={error}
      onErrorRetry={() => setError(null)}
      onErrorExit={() => { setError(null); setScanning(false); setOpen(false); }}
      modal={
        done
          ? { title: "Заказ размещён в выдаче", body: `№ ${ctx.externalId} — передан в зону выдачи`, actions: (<Button type="button" variant="primary" onClick={closeAll} className="w-full">Ок</Button>) }
          : confirmed
            ? { title: "Заказ подтверждён", body: `№ ${ctx.externalId} — сканируйте ячейку ${ctx.assignedCellCode ?? ""}` }
            : null
      }
      footer={
        <Button type="button" variant="primary" onClick={() => setScanning(true)} className="w-full">
          <ScanLine size={18} /> {step === "order" ? "Сканировать QR заказа" : "Сканировать ячейку"}
        </Button>
      }
    >
      <p className="text-sm text-neutral-500">
        {step === "order" ? "Отсканируйте QR заказа." : `Отсканируйте назначенную ячейку выдачи ${ctx.assignedCellCode ?? ""}.`}
      </p>
    </WorkflowSheet>
  );
}

export function IssueOrderPanel({ ctx }: { ctx: IssueOrderCtx }) {
  // Fail-closed: заказу должна быть назначена ровно одна ячейка. Иначе — без действия и без движения.
  if (!ctx.assignedCellCode)
    return (
      <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3">
        <div className="text-sm font-semibold text-red-700">Ячейка выдачи не назначена</div>
        <div className="mt-0.5 text-sm text-neutral-600">Обновите страницу или обратитесь к администратору — разместить заказ нельзя.</div>
      </div>
    );
  return (
    <div className="flex flex-col gap-2">
      <PlaceScanner ctx={ctx} />
    </div>
  );
}

// ── ISSUE-003 v1 (Задача O): выдача — скан QR заказа → зелёное подтверждение → скан единственной
// ячейки выдачи → атомарная выдача. Одна машина состояний (камера + ручной ввод). Без EAN и списков. ──
function DeliverScanner({ ctx }: { ctx: DeliverOrderCtx }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [step, setStep] = useState<"order" | "cell">("order");
  const [orderRaw, setOrderRaw] = useState("");
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false); // UI-005: зелёное подтверждение заказа перед ячейкой
  const [done, setDone] = useState(false);           // финальный успех — держится до «Ок»

  function closeAll() { setOpen(false); setScanning(false); setStep("order"); setOrderRaw(""); setConfirmed(false); setDone(false); setError(null); router.refresh(); }

  function handleScan(raw: string) {
    if (busy || confirmed || done) return;
    if (step === "order") {
      startTransition(async () => {
        const fd = new FormData();
        fd.set("taskId", ctx.taskId); fd.set("orderCode", raw);
        const res = await verifyDeliverScanAction({}, fd);
        if (res.error) { setError(res.error); return; } // неверный QR — шаг не меняется, БД не меняется
        setOrderRaw(raw); setScanning(false); setConfirmed(true);
        // заметное зелёное подтверждение (UI-005), затем автоматически открывается скан ячейки
        setTimeout(() => { setConfirmed(false); setStep("cell"); setScanning(true); }, 1200);
      });
      return;
    }
    // step === cell → атомарная выдача из единственной ячейки
    startTransition(async () => {
      const fd = new FormData();
      fd.set("taskId", ctx.taskId); fd.set("orderCode", orderRaw); fd.set("cellCode", raw);
      const res = await deliverWholeOrderAction({}, fd);
      if (res.error) { setError(res.error); return; } // неверная ячейка — без движения, шаг не меняется
      setScanning(false); setDone(true); // финальное уведомление до «Ок»
    });
  }

  if (!open)
    return (
      <Button type="button" variant="primary" onClick={() => { setOpen(true); setStep("order"); setScanning(true); setError(null); }} className="w-full">
        <ScanLine size={18} /> Выдать водителю (сканирование)
      </Button>
    );
  return (
    <WorkflowSheet
      title="Выдать водителю"
      subtitle={confirmed || done ? undefined : step === "order" ? `№ ${ctx.externalId}` : `Ячейка ${ctx.assignedCellCode ?? "—"}`}
      scanning={scanning}
      scanHint={step === "order" ? `Сканируйте QR заказа ${ctx.externalId}` : `Сканируйте ячейку ${ctx.assignedCellCode ?? ""}`}
      scanFormats={step === "order" ? ORDER : CELL}
      manualPlaceholder={step === "order" ? "Код QR заказа" : "Код ячейки выдачи"}
      onScan={handleScan}
      scanPaused={busy || confirmed || done}
      busy={busy}
      onBackToList={() => setScanning(false)}
      onClose={() => { setOpen(false); setScanning(false); setError(null); }}
      error={error}
      onErrorRetry={() => setError(null)}
      onErrorExit={() => { setError(null); setScanning(false); setOpen(false); }}
      modal={
        done
          ? { title: "Заказ выдан водителю", body: `№ ${ctx.externalId} — передан водителю`, actions: (<Button type="button" variant="primary" onClick={closeAll} className="w-full">Ок</Button>) }
          : confirmed
            ? { title: "Заказ подтверждён", body: `№ ${ctx.externalId} — сканируйте ячейку ${ctx.assignedCellCode ?? ""}` }
            : null
      }
      footer={
        <Button type="button" variant="primary" onClick={() => setScanning(true)} className="w-full">
          <ScanLine size={18} /> {step === "order" ? "Сканировать QR заказа" : "Сканировать ячейку"}
        </Button>
      }
    >
      <p className="text-sm text-neutral-500">
        {step === "order" ? `Отсканируйте QR заказа ${ctx.externalId}.` : `Отсканируйте ячейку выдачи ${ctx.assignedCellCode ?? ""}.`}
      </p>
    </WorkflowSheet>
  );
}

export function DeliverOrderPanel({ ctx }: { ctx: DeliverOrderCtx }) {
  // Fail-closed v1: у заказа должна быть ровно одна фактическая ячейка выдачи.
  if (!ctx.assignedCellCode)
    return (
      <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3">
        <div className="text-sm font-semibold text-red-700">Ячейка выдачи не определена</div>
        <div className="mt-0.5 text-sm text-neutral-600">Обновите страницу или обратитесь к администратору — выдать заказ нельзя.</div>
      </div>
    );
  return (
    <div className="flex flex-col gap-2">
      <DeliverScanner ctx={ctx} />
    </div>
  );
}
