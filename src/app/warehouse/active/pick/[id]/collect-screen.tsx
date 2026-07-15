"use client";

import { Package, ScanLine } from "lucide-react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  checkPickItemAction,
  placePickToCellAction,
  type PickScanResult,
} from "@/app/actions/picklists";
import { Button, Badge } from "@/components/ui";
import { WorkflowSheet } from "@/components/workflow-sheet";

export interface CollectLine {
  id: string;
  code: string | null; // QR-id партии/единицы
  name: string;
  uom: string;
  qtyRequested: number;
  qtyPicked: number;
  sourceCell: string; // ячейка хранения — где лежит
  stagedCells: string[]; // ячейки выдачи — куда уже положили
  done: boolean; // проверено полностью
  placed: boolean; // проверено и размещено в ячейки выдачи целиком
}

// Сборка заявки/перемещения: сначала сканируются товары (статус «проверен», товар
// остаётся на месте), затем скан ячейки выдачи перемещает всё проверенное в неё
// разом. Частями можно: проверил часть → ячейка → дальше. Когда проверено всё —
// остаётся одна кнопка «Сканировать ячейку»; после неё документ в зоне выдачи.
export function CollectScreen({
  pickListId,
  pickNumber,
  kindLabel,
  lines,
  hasUnplaced,
}: {
  pickListId: string;
  pickNumber: number;
  kindLabel: "заявка" | "перемещение";
  lines: CollectLine[];
  hasUnplaced: boolean; // есть проверенные, но не размещённые в ячейку выдачи
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [mode, setMode] = useState<"good" | "cell">("good");
  const [busy, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const [finished, setFinished] = useState<string | null>(null); // ячейка последнего размещения
  const [errorModal, setErrorModal] = useState<string | null>(null);

  const doneCount = lines.filter((l) => l.done).length;
  const pct = lines.length > 0 ? Math.round((doneCount / lines.length) * 100) : 0;
  const allChecked = lines.length > 0 && doneCount >= lines.length;

  function handleScan(raw: string) {
    if (busy) return;
    startTransition(async () => {
      try {
        if (mode === "good") {
          const res: PickScanResult = await checkPickItemAction(pickListId, raw);
          if (res.error) {
            setErrorModal(res.error);
            return;
          }
          // после скана товара — назад к списку, статус позиции обновится
          setNotice(
            res.done
              ? `✓ ${res.itemLabel} — проверено. Все товары проверены — сканируйте ячейку`
              : `✓ ${res.itemLabel} — проверено`,
          );
          setScanning(false);
          router.refresh();
          return;
        }
        const res: PickScanResult = await placePickToCellAction(pickListId, raw);
        if (res.error) {
          setErrorModal(res.error);
          return;
        }
        if (res.done) {
          setFinished(res.cellCode ?? "");
          setScanning(false);
          router.refresh();
          return;
        }
        setNotice(`✓ Товары в ячейке ${res.cellCode} — продолжайте сканирование`);
        setScanning(false);
        router.refresh();
      } catch {
        setErrorModal("Нет связи с сервером — проверьте интернет и отсканируйте ещё раз");
      }
    });
  }

  function closeAll() {
    setScanning(false);
    setMode("good");
    setNotice(null);
    setFinished(null);
    setErrorModal(null);
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <Button type="button" variant="primary" onClick={() => setOpen(true)} className="w-full">
        <ScanLine size={18} /> Сканировать (сборка)
      </Button>
    );
  }

  return (
    <WorkflowSheet
      title={`Сборка · ${kindLabel} №${pickNumber}`}
      subtitle={`Проверено ${doneCount} из ${lines.length}`}
      progressPct={pct}
      scanning={scanning}
      scanHint={mode === "good" ? "Сканируйте QR товара" : "Сканируйте QR ячейки зоны выдачи"}
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
              title: kindLabel === "перемещение" ? "Перемещение собрано" : "Заявка собрана",
              body: (
                <>
                  Все товары проверены и находятся в зоне выдачи
                  {finished ? (
                    <>
                      {" · ячейка "}
                      <span className="rounded-md bg-[#eef0f8] px-2 py-0.5 font-mono font-semibold text-[#667eea]">
                        {finished}
                      </span>
                    </>
                  ) : null}
                </>
              ),
              actions: (
                <Button type="button" variant="primary" onClick={closeAll} className="w-full">
                  Ок
                </Button>
              ),
            }
          : null
      }
      footer={
        allChecked && hasUnplaced ? (
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              setScanning(true);
              setMode("cell");
              setNotice(null);
            }}
            className="w-full"
          >
            <Package size={18} /> Сканировать ячейку
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                setScanning(true);
                setMode("good");
                setNotice(null);
              }}
              className="w-full"
              disabled={allChecked}
            >
              <ScanLine size={18} /> {hasUnplaced ? "Ещё товар" : "Сканировать товар"}
            </Button>
            {hasUnplaced && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setScanning(true);
                  setMode("cell");
                  setNotice(null);
                }}
                className="w-full"
              >
                <Package size={18} /> Сканировать ячейку
              </Button>
            )}
          </>
        )
      }
    >
      {notice && <p className="pb-1 text-sm font-medium text-green-600">{notice}</p>}
      {lines.map((l) => {
        const status = l.done ? (
          <Badge tone="green">проверен</Badge>
        ) : l.qtyPicked > 0 ? (
          <Badge tone="orange">
            {l.qtyPicked} из {l.qtyRequested}
          </Badge>
        ) : (
          <Badge tone="neutral">ожидается</Badge>
        );
        // справа крупно одна ячейка: до размещения — где лежит, после — ячейка выдачи
        const staged = l.stagedCells.length > 0;
        const bigCells = staged ? l.stagedCells : l.sourceCell !== "—" ? [l.sourceCell] : [];
        return (
          <div key={l.id} className="rounded-xl bg-[#f7f8fc] px-3 py-2.5">
            <div className="flex items-stretch justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-[#1a1a1a]">{l.name}</div>
                <div className="text-xs text-neutral-500">
                  {l.qtyRequested} {l.uom}
                  {l.code ? ` · ${l.code}` : ""}
                </div>
                {bigCells.length > 0 && <div className="mt-1">{status}</div>}
              </div>
              {bigCells.length > 0 ? (
                <div
                  className={
                    "flex shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg px-3 py-1.5 " +
                    (staged ? "bg-[#e9ecfb]" : "bg-white ring-1 ring-inset ring-neutral-200")
                  }
                >
                  <span
                    className={
                      "text-[10px] uppercase tracking-wide " +
                      (staged ? "text-[#4c5fd7]" : "text-neutral-400")
                    }
                  >
                    {staged ? "выдача" : "лежит"}
                  </span>
                  {bigCells.map((c) => (
                    <span
                      key={c}
                      className={
                        "font-mono text-xl font-bold leading-tight " +
                        (staged ? "text-[#4c5fd7]" : "text-neutral-800")
                      }
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
