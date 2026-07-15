"use client";

import { ScanLine } from "lucide-react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  checkOrderReceiveScanAction,
  receiveOrderScanAction,
} from "@/app/actions/supplier-orders";
import { Button, Badge } from "@/components/ui";
import { WorkflowSheet } from "@/components/workflow-sheet";

export interface ReceiveLine {
  id: string;
  code: string | null;
  name: string;
  uom: string;
  qty: number;
  receivedQty: number;
  tracking: "LOT" | "UNIT";
  receivedSerials: number[]; // для серийных — какие № уже приняты
}

// Приёмка заказа: скан товара → окно подтверждения → скан ячейки. «1 скан = 1 штука»
// для любого товара. Каркас шторки, окна ошибки и финала — общий WorkflowSheet.
export function ReceiveScreen({
  orderId,
  orderNumber,
  lines,
}: {
  orderId: string;
  orderNumber: number;
  lines: ReceiveLine[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [cellMode, setCellMode] = useState(false); // товар подтверждён → сканируем ячейку
  const [pendingItem, setPendingItem] = useState<{ raw: string; title: string; sub: string } | null>(
    null,
  );
  const [cellDone, setCellDone] = useState<{ itemLabel: string; cellCode: string; done: boolean } | null>(
    null,
  );
  const [busy, startTransition] = useTransition();
  const [errorModal, setErrorModal] = useState<string | null>(null);

  // прогресс в «единицах скана»: 1 скан = 1 штука (дробный остаток — последним сканом)
  const scansOf = (l: ReceiveLine) => Math.ceil(l.qty);
  const doneOf = (l: ReceiveLine) => Math.min(Math.ceil(l.receivedQty), Math.ceil(l.qty));
  const totalScans = lines.reduce((s, l) => s + scansOf(l), 0);
  const doneScans = lines.reduce((s, l) => s + doneOf(l), 0);
  const pct = totalScans > 0 ? Math.round((doneScans / totalScans) * 100) : 0;

  const pendingConfirm = !!pendingItem && !cellMode; // окно «товар отсканирован»

  function handleScan(raw: string) {
    if (busy) return;
    startTransition(async () => {
      try {
        if (!pendingItem) {
          const res = await checkOrderReceiveScanAction(orderId, raw);
          if (res.error) setErrorModal(res.error);
          else setPendingItem({ raw, title: res.title ?? "", sub: res.sub ?? "" });
          return;
        }
        const res = await receiveOrderScanAction(orderId, pendingItem.raw, raw);
        if (res.error) {
          setErrorModal(res.error);
          return;
        }
        setPendingItem(null);
        setCellMode(false);
        setCellDone({
          itemLabel: res.itemLabel ?? res.ok ?? "",
          cellCode: res.cellCode ?? "",
          done: !!res.done,
        });
        router.refresh();
      } catch {
        setErrorModal("Нет связи с сервером — проверьте интернет и отсканируйте ещё раз");
      }
    });
  }

  function closeAll() {
    setScanning(false);
    setCellMode(false);
    setCellDone(null);
    setErrorModal(null);
    setOpen(false);
    setPendingItem(null);
    router.refresh();
  }

  if (!open) {
    return (
      <Button type="button" variant="primary" onClick={() => setOpen(true)} className="w-full">
        <ScanLine size={18} /> Приемка сканированием
      </Button>
    );
  }

  return (
    <WorkflowSheet
      title={`Приемка · заказ №${orderNumber}`}
      subtitle={`Принято ${doneScans} из ${totalScans}`}
      progressPct={pct}
      scanning={scanning && !pendingConfirm}
      scanHint={
        cellMode ? `Сканируйте QR ячейки для «${pendingItem?.title}»` : "Сканируйте QR товара"
      }
      onScan={handleScan}
      scanPaused={busy}
      busy={busy}
      onBackToList={() => {
        setScanning(false);
        setPendingItem(null);
        setCellMode(false);
      }}
      onClose={closeAll}
      error={errorModal}
      onErrorRetry={() => setErrorModal(null)}
      onErrorExit={() => {
        setErrorModal(null);
        setPendingItem(null);
        setCellMode(false);
        setScanning(false);
      }}
      modal={
        cellDone
          ? cellDone.done
            ? {
                title: "Все товары приняты",
                body: <>Заказ №{orderNumber} принят на склад</>,
                actions: (
                  <Button type="button" variant="primary" onClick={closeAll} className="w-full">
                    Ок
                  </Button>
                ),
              }
            : {
                title: "Товар добавлен в ячейку",
                body: (
                  <>
                    <span className="block text-base font-semibold leading-tight text-[#1a1a1a]">
                      {cellDone.itemLabel}
                    </span>
                    <span className="mt-1.5 block">
                      ячейка{" "}
                      <span className="rounded-md bg-[#eef0f8] px-2 py-0.5 font-mono font-semibold text-[#667eea]">
                        {cellDone.cellCode}
                      </span>
                    </span>
                  </>
                ),
                actions: (
                  <>
                    <Button
                      type="button"
                      variant="primary"
                      onClick={() => setCellDone(null)}
                      className="w-full"
                    >
                      <ScanLine size={18} /> Сканировать следующий
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setCellDone(null);
                        setScanning(false);
                      }}
                      className="w-full"
                    >
                      К списку
                    </Button>
                  </>
                ),
              }
          : null
      }
      footer={
        !scanning ? (
          <Button
            type="button"
            variant="primary"
            onClick={() => setScanning(true)}
            className="w-full"
            disabled={doneScans >= totalScans}
          >
            {doneScans >= totalScans ? (
              "Всё принято"
            ) : (
              <>
                <ScanLine size={18} /> Сканировать товар
              </>
            )}
          </Button>
        ) : undefined
      }
    >
      {pendingConfirm ? (
        // товар отсканирован — подтверждение перед сканом ячейки (камера выключена)
        <div className="flex flex-col gap-4">
          <div className="rounded-xl bg-[#f0f2fb] p-5 text-center">
            <div className="text-xs font-medium uppercase tracking-wide text-[#667eea]">
              Товар отсканирован
            </div>
            <div className="mt-1.5 text-lg font-bold leading-tight text-[#1a1a1a]">
              {pendingItem?.title}
            </div>
            {pendingItem?.sub && (
              <div className="mt-1 text-sm text-neutral-500">{pendingItem.sub}</div>
            )}
          </div>
          <Button
            type="button"
            variant="primary"
            onClick={() => setCellMode(true)}
            className="w-full"
          >
            <ScanLine size={18} /> Сканировать ячейку
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setPendingItem(null);
              setCellMode(false);
            }}
            className="w-full"
          >
            Отмена
          </Button>
        </div>
      ) : (
        lines.map((l) => {
          const full = l.receivedQty >= l.qty;
          const partial = l.receivedQty > 0 && !full;
          const isUnit = l.tracking === "UNIT" && l.qty > 1;
          const received = new Set(l.receivedSerials);
          return (
            <div key={l.id} className="rounded-xl bg-[#f7f8fc] px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-[#1a1a1a]">
                    {l.name} {l.tracking === "UNIT" && <Badge tone="blue">серийн.</Badge>}
                  </div>
                  <div className="text-xs text-neutral-500">
                    {l.qty} {l.uom}
                    {l.code ? ` · ${l.code}` : ""}
                  </div>
                </div>
                {full ? (
                  <Badge tone="green">принято</Badge>
                ) : partial ? (
                  <Badge tone="orange">
                    {l.receivedQty} из {l.qty}
                  </Badge>
                ) : (
                  <Badge tone="neutral">ожидается</Badge>
                )}
              </div>
              {isUnit && !full && (
                <details className="mt-2" open={partial}>
                  <summary className="cursor-pointer text-xs text-[#667eea]">
                    Показать единицы ({l.receivedSerials.length} из {l.qty})
                  </summary>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {Array.from({ length: l.qty }, (_, i) => i + 1).map((n) => {
                      const done = received.has(n);
                      return (
                        <span
                          key={n}
                          title={l.code ? `${l.code}-${n}` : `№${n}`}
                          className={
                            "inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-medium " +
                            (done
                              ? "bg-[#e8f5e9] text-[#2e7d32]"
                              : "bg-white text-neutral-400 ring-1 ring-inset ring-neutral-200")
                          }
                        >
                          {done ? "✓" : ""}№{n}
                        </span>
                      );
                    })}
                  </div>
                </details>
              )}
            </div>
          );
        })
      )}
    </WorkflowSheet>
  );
}
