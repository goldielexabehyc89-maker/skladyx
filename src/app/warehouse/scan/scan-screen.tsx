"use client";

import { ScanLine } from "lucide-react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { QrScanner } from "@/components/qr-scanner";
import { resolveScanAction, assignCellAction, type ScanInfo } from "@/app/actions/scan";
import { Button } from "@/components/ui";
import { clsx } from "clsx";

type Mode = "info" | "assign";

// Экран сканирования: режим «карточка» (что это?) и «товар → ячейка».
export function ScanScreen({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("info");
  const [busy, startTransition] = useTransition();
  const [info, setInfo] = useState<ScanInfo | null>(null);
  const [pendingItem, setPendingItem] = useState<{ raw: string; title: string } | null>(null);
  const [assignMsg, setAssignMsg] = useState<{ ok?: string; error?: string } | null>(null);

  function handleScan(raw: string) {
    if (busy) return;
    startTransition(async () => {
      const offline = "Нет связи с сервером — проверьте интернет и отсканируйте ещё раз";
      if (mode === "info") {
        try {
          setInfo(await resolveScanAction(raw));
        } catch {
          setInfo({ error: offline });
        }
        return;
      }
      // режим «товар → ячейка»
      try {
        if (!pendingItem) {
          const res = await resolveScanAction(raw);
          if (res.error) {
            setAssignMsg({ error: res.error });
          } else if (res.type === "LOT" || res.type === "UNIT") {
            setPendingItem({ raw, title: res.title ?? "" });
            setAssignMsg(null);
          } else {
            setAssignMsg({ error: "Первым сканируйте QR партии или единицы" });
          }
          return;
        }
        const res = await assignCellAction(pendingItem.raw, raw);
        setAssignMsg(res);
        if (res.ok) setPendingItem(null);
      } catch {
        setAssignMsg({ error: offline });
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {isAdmin && (
        <div className="flex rounded-xl bg-white p-1 shadow-[0_2px_8px_rgba(20,20,60,0.06)]">
          {(
            [
              ["info", "Карточка"],
              ["assign", "Товар → ячейка"],
            ] as [Mode, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setInfo(null);
                setPendingItem(null);
                setAssignMsg(null);
              }}
              className={clsx(
                "flex-1 rounded-lg py-2 text-sm font-medium",
                mode === m ? "bg-brand text-brand-fg" : "text-neutral-600",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <QrScanner onScan={handleScan} paused={busy || (mode === "info" && !!info)} />

      {mode === "assign" && (
        <div className="rounded-2xl bg-white p-4 text-center shadow-[0_2px_8px_rgba(20,20,60,0.06)] text-sm">
          {pendingItem ? (
            <>
              <p className="font-semibold">{pendingItem.title}</p>
              <p className="mt-1 text-neutral-500">Теперь сканируйте QR ячейки</p>
              <button
                type="button"
                onClick={() => setPendingItem(null)}
                className="mt-2 text-xs text-neutral-400 underline-offset-2 active:underline"
              >
                Отменить
              </button>
            </>
          ) : (
            <p className="text-neutral-500">Сканируйте QR партии или единицы товара</p>
          )}
          {assignMsg?.ok && <p className="mt-2 font-medium text-green-600">✓ {assignMsg.ok}</p>}
          {assignMsg?.error && <p className="mt-2 font-medium text-red-600">{assignMsg.error}</p>}
        </div>
      )}

      {mode === "info" && info && (
        // результат скана — отдельным окном по центру (как окна ошибок/подтверждений)
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-6">
          <div className="w-full max-w-xs rounded-3xl bg-white p-6 text-center shadow-[0_20px_60px_rgba(0,0,0,0.35)]">
            {info.error ? (
              <>
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#ffebee] text-3xl text-[#c62828]">
                  !
                </div>
                <div className="mt-3 text-base font-bold text-[#1a1a1a]">Ошибка сканирования</div>
                <div className="mt-2 text-sm text-neutral-600">{info.error}</div>
              </>
            ) : (
              <>
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#e9ecfb] text-2xl font-bold text-[#4c5fd7]">
                  i
                </div>
                <div className="mt-3 text-base font-bold leading-tight text-[#1a1a1a]">
                  {info.title}
                </div>
                <div className="mt-2 flex flex-col gap-1">
                  {info.lines?.map((l, i) => (
                    <p key={i} className="text-sm text-neutral-600">
                      {l}
                    </p>
                  ))}
                </div>
              </>
            )}
            <div className="mt-5 flex flex-col gap-2">
              {!info.error && info.url && (
                <Button type="button" onClick={() => router.push(info.url!)} className="w-full">
                  Открыть
                </Button>
              )}
              <Button
                type="button"
                variant={!info.error && info.url ? "ghost" : "primary"}
                onClick={() => setInfo(null)}
                className="w-full"
              >
                <ScanLine size={18} /> Сканировать ещё
              </Button>
            </div>
          </div>
        </div>
      )}

      {busy && <p className="text-center text-sm text-neutral-400">Обработка…</p>}
    </div>
  );
}
