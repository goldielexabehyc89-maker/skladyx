"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ScanLine } from "lucide-react";
import { pickScanAction, completeMoveGroupAction } from "@/app/actions/external-orders";
import { Button, Badge } from "@/components/ui";
import { WorkflowSheet } from "@/components/workflow-sheet";
import type { PickOrderCtx, MoveGroupCtx } from "./tasks-screen";

// Этап 5/Пакет 6 (коррекция): НАСТОЯЩЕЕ сканирование через штатный QrScanner/WorkflowSheet.
// PICK_ORDER: QR ячейки → QR группы/партии → количество. MOVE_GROUP: QR группы → QR целевой ячейки.
// Серверная сверка (ячейка/группа/товар/резерв ↔ заказ/задача) — в actions/external-orders.

// ── Сборка заказа ──
export function PickOrderScanner({ ctx, taskId }: { ctx: PickOrderCtx; taskId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [step, setStep] = useState<"cell" | "group" | "qty">("cell");
  const [cellRaw, setCellRaw] = useState("");
  const [groupRaw, setGroupRaw] = useState("");
  const [qty, setQty] = useState("");
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  const pickedLines = ctx.lines.filter((l) => Number(l.picked) >= Number(l.required)).length;
  const pct = ctx.lines.length ? Math.round((pickedLines / ctx.lines.length) * 100) : 0;

  function reset() { setStep("cell"); setCellRaw(""); setGroupRaw(""); setQty(""); setNotice(null); }
  function closeAll() { setOpen(false); setScanning(false); reset(); setError(null); setFinished(false); router.refresh(); }

  function handleScan(raw: string) {
    if (busy) return;
    if (step === "cell") { setCellRaw(raw); setStep("group"); setNotice("Ячейка отсканирована — сканируйте QR группы"); return; }
    if (step === "group") { setGroupRaw(raw); setScanning(false); setStep("qty"); setNotice("Группа отсканирована — введите количество"); return; }
  }

  function submitQty() {
    const n = Number(qty.replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) { setError("Укажите количество"); return; }
    startTransition(async () => {
      const fd = new FormData();
      fd.set("taskId", taskId); fd.set("cellCode", cellRaw); fd.set("groupCode", groupRaw); fd.set("qty", String(n));
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
      scanHint={step === "cell" ? "Сканируйте QR ячейки (уровень 1-2)" : "Сканируйте QR группы/партии"}
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
    </WorkflowSheet>
  );
}

// ── Перестановка группы ──
export function MoveGroupScanner({ ctx }: { ctx: MoveGroupCtx }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [step, setStep] = useState<"group" | "cell">("group");
  const [groupRaw, setGroupRaw] = useState("");
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  function closeAll() { setOpen(false); setScanning(false); setStep("group"); setGroupRaw(""); setNotice(null); setError(null); setFinished(false); router.refresh(); }

  function handleScan(raw: string) {
    if (busy) return;
    if (step === "group") { setGroupRaw(raw); setStep("cell"); setNotice("Группа отсканирована — сканируйте QR целевой ячейки"); return; }
    // step === "cell": финализируем перестановку
    startTransition(async () => {
      const fd = new FormData();
      fd.set("taskId", ctx.taskId); fd.set("groupCode", groupRaw); fd.set("cellCode", raw);
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
      scanHint={step === "group" ? "Сканируйте QR перемещаемой группы" : "Сканируйте QR целевой ячейки"}
      onScan={handleScan}
      scanPaused={busy}
      busy={busy}
      onBackToList={() => setScanning(false)}
      onClose={closeAll}
      error={error}
      onErrorRetry={() => setError(null)}
      onErrorExit={() => { setError(null); setScanning(false); setStep("group"); setGroupRaw(""); }}
      modal={finished ? { title: "Группа переставлена", body: `→ ячейка ${ctx.toCell}`, actions: (<Button type="button" variant="primary" onClick={closeAll} className="w-full">Ок</Button>) } : null}
      footer={
        <Button type="button" variant="primary" onClick={() => { setScanning(true); setStep("group"); setNotice(null); }} className="w-full">
          <ScanLine size={18} /> Сканировать группу
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
