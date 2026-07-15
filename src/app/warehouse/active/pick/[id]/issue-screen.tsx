"use client";

import { ScanLine, UserRound } from "lucide-react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  resolveIssueScanAction,
  issuePickListByBadgeAction,
  dispatchTransferByScanAction,
} from "@/app/actions/picklists";
import { Button, Badge } from "@/components/ui";
import { WorkflowSheet } from "@/components/workflow-sheet";
import type { CollectLine } from "./collect-screen";

// Выдача из зоны выдачи — сканированием: сначала проверяются все товары, затем
// для заявки сканируется QR-бейдж адресата (его скан = подтверждение получения);
// перемещение отправляется автоматически после проверки последнего товара.
// Прогресс проверки держит клиент; каркас шторки — общий WorkflowSheet.
export function IssueScreen({
  pickListId,
  pickNumber,
  kindLabel,
  targetName,
  lines,
}: {
  pickListId: string;
  pickNumber: number;
  kindLabel: "заявка" | "перемещение";
  targetName: string; // сотрудник или склад-назначение
  lines: CollectLine[];
}) {
  const router = useRouter();
  const isTransfer = kindLabel === "перемещение";
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [mode, setMode] = useState<"item" | "badge">("item");
  const [busy, startTransition] = useTransition();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [scannedUnits, setScannedUnits] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [finished, setFinished] = useState<string | null>(null); // текст финального окна
  const [errorModal, setErrorModal] = useState<string | null>(null);

  const countOf = (l: CollectLine) => counts[l.id] ?? 0;
  const lineDone = (l: CollectLine) => countOf(l) >= l.qtyRequested;
  const doneCount = lines.filter(lineDone).length;
  const allChecked = lines.length > 0 && doneCount >= lines.length;
  const pct = lines.length > 0 ? Math.round((doneCount / lines.length) * 100) : 0;

  function handleScan(raw: string) {
    if (busy) return;
    startTransition(async () => {
      try {
        if (mode === "badge") {
          const res = await issuePickListByBadgeAction(pickListId, raw);
          if (res.error) {
            setErrorModal(res.error);
            return;
          }
          setFinished(`${res.ok} — выдано: ${res.employeeName}. Подтверждено QR сотрудника.`);
          setScanning(false);
          router.refresh();
          return;
        }
        const res = await resolveIssueScanAction(pickListId, raw);
        if (res.error) {
          setErrorModal(res.error);
          return;
        }
        const line = lines.find((l) => l.id === res.lineId);
        if (!line) {
          setErrorModal("Позиция не найдена");
          return;
        }
        if (res.unitRefId && scannedUnits.includes(res.unitRefId)) {
          setErrorModal("Эта единица уже проверена");
          return;
        }
        const current = counts[line.id] ?? 0;
        if (current >= line.qtyRequested) {
          setErrorModal("По этой позиции всё уже проверено");
          return;
        }
        const add = Math.min(1, line.qtyRequested - current); // дробный остаток — последним сканом
        const nextCounts = { ...counts, [line.id]: current + add };
        setCounts(nextCounts);
        if (res.unitRefId) setScannedUnits((prev) => [...prev, res.unitRefId!]);

        const allNow = lines.every((l) => (nextCounts[l.id] ?? 0) >= l.qtyRequested);
        if (allNow && isTransfer) {
          // перемещение: после проверки последнего товара отправляется само
          const disp = await dispatchTransferByScanAction(pickListId);
          if (disp.error) {
            setErrorModal(disp.error);
            return;
          }
          setFinished(
            `${disp.ok} на склад «${disp.destName}». Разложите по ячейкам сканами на месте.`,
          );
          setScanning(false);
          router.refresh();
          return;
        }
        setNotice(
          allNow
            ? `✓ ${res.ok} — проверено. Все товары проверены — сканируйте QR сотрудника`
            : `✓ ${res.ok} — проверено`,
        );
        setScanning(false);
      } catch {
        setErrorModal("Нет связи с сервером — проверьте интернет и отсканируйте ещё раз");
      }
    });
  }

  function closeAll() {
    setScanning(false);
    setMode("item");
    setCounts({});
    setScannedUnits([]);
    setNotice(null);
    setFinished(null);
    setErrorModal(null);
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <Button type="button" variant="primary" onClick={() => setOpen(true)} className="w-full">
        <ScanLine size={18} /> Сканировать выдачу
      </Button>
    );
  }

  return (
    <WorkflowSheet
      title={`Выдача · ${kindLabel} №${pickNumber}`}
      subtitle={`${isTransfer ? "На склад" : "Для"}: ${targetName} · проверено ${doneCount} из ${lines.length}`}
      progressPct={pct}
      scanning={scanning}
      scanHint={mode === "item" ? "Сканируйте QR товара" : `Сканируйте QR-бейдж: ${targetName}`}
      onScan={handleScan}
      scanPaused={busy}
      busy={busy}
      onBackToList={() => setScanning(false)}
      onClose={closeAll}
      error={errorModal}
      onErrorRetry={() => setErrorModal(null)}
      onErrorExit={() => {
        setErrorModal(null);
        setScanning(false);
      }}
      modal={
        finished !== null
          ? {
              title: isTransfer ? "Перемещение отправлено" : "Выдано",
              body: finished,
              actions: (
                <Button type="button" variant="primary" onClick={closeAll} className="w-full">
                  Ок
                </Button>
              ),
            }
          : null
      }
      footer={
        allChecked && !isTransfer ? (
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              setScanning(true);
              setMode("badge");
              setNotice(null);
            }}
            className="w-full"
          >
            <UserRound size={18} /> Сканировать QR сотрудника
          </Button>
        ) : (
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              setScanning(true);
              setMode("item");
              setNotice(null);
            }}
            className="w-full"
            disabled={allChecked}
          >
            <ScanLine size={18} /> {doneCount > 0 ? "Ещё товар" : "Сканировать товар"}
          </Button>
        )
      }
    >
      {notice && <p className="pb-1 text-sm font-medium text-green-600">{notice}</p>}
      {lines.map((l) => {
        const status = lineDone(l) ? (
          <Badge tone="green">проверен</Badge>
        ) : countOf(l) > 0 ? (
          <Badge tone="orange">
            {countOf(l)} из {l.qtyRequested}
          </Badge>
        ) : (
          <Badge tone="neutral">к выдаче</Badge>
        );
        return (
          <div key={l.id} className="rounded-xl bg-[#f7f8fc] px-3 py-2.5">
            <div className="flex items-stretch justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-[#1a1a1a]">{l.name}</div>
                <div className="text-xs text-neutral-500">
                  {l.qtyRequested} {l.uom}
                  {l.code ? ` · ${l.code}` : ""}
                </div>
                {l.stagedCells.length > 0 && <div className="mt-1">{status}</div>}
              </div>
              {l.stagedCells.length > 0 ? (
                <div className="flex shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg bg-[#e9ecfb] px-3 py-1.5">
                  <span className="text-[10px] uppercase tracking-wide text-[#4c5fd7]">выдача</span>
                  {l.stagedCells.map((c) => (
                    <span
                      key={c}
                      className="font-mono text-xl font-bold leading-tight text-[#4c5fd7]"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="flex shrink-0 items-center">{status}</div>
              )}
            </div>
          </div>
        );
      })}
    </WorkflowSheet>
  );
}
