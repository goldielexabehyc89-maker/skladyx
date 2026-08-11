"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ScanLine } from "lucide-react";
import {
  verifyIssueScanAction,
  placeWholeOrderAction,
  issueAction,
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
      scanHint={step === "order" ? "Сканируйте QR заказа" : `Сканируйте назначенную ячейку ${ctx.assignedCellCode ?? ""}`}
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
      {/* TASK-006 (расширение): технический заголовок убран — заказ/маршрут в компактной карточке. */}
      <div className="text-xs font-medium text-neutral-500">Ячейки выдачи заказа ({ctx.cells.length}):</div>
      {ctx.cells.map((c, i) => (
        <div key={i} className="rounded-xl bg-[#f7f8fc] px-3 py-2 text-sm">{c.cell}</div>
      ))}
      <DeliverScanner ctx={ctx} />
      <p className="text-xs text-neutral-400">Сервер проверит полный набор ячеек. Подтверждение водителя не требуется.</p>
    </div>
  );
}
