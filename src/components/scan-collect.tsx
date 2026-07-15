"use client";

import { ScanLine } from "lucide-react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { WorkflowSheet } from "@/components/workflow-sheet";

export interface ScanResult {
  ok?: string;
  error?: string;
  done?: boolean; // сценарий завершён (например, собраны все позиции заявки)
}

// Переиспользуемый «скан подряд»: каждый скан отправляется в server action,
// успехи копятся счётчиком. Используется в раскладке по ячейкам, списаниях
// и инвентаризации. Каркас — общий WorkflowSheet.
export function ScanCollect({
  action,
  buttonLabel,
  title,
}: {
  action: (code: string) => Promise<ScanResult>;
  buttonLabel: string;
  title: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, startTransition] = useTransition();
  const [last, setLast] = useState<ScanResult | null>(null);
  const [errorModal, setErrorModal] = useState<string | null>(null);
  const [okCount, setOkCount] = useState(0);

  function closeAll() {
    setOpen(false);
    setLast(null);
    setOkCount(0);
    setErrorModal(null);
    router.refresh();
  }

  function handleScan(raw: string) {
    if (busy) return;
    startTransition(async () => {
      let res: ScanResult;
      try {
        res = await action(raw);
      } catch {
        // обрыв связи: скан не записан, ничего не потеряно — можно сканировать снова
        setErrorModal("Нет связи с сервером — проверьте интернет и отсканируйте ещё раз");
        return;
      }
      if (res.error) {
        setErrorModal(res.error);
        return;
      }
      setLast(res);
      if (res.ok) {
        setOkCount((n) => n + 1);
        router.refresh();
      }
      if (res.done) {
        closeAll();
      }
    });
  }

  if (!open) {
    return (
      <Button type="button" onClick={() => setOpen(true)} className="w-full">
        <ScanLine size={18} /> {buttonLabel}
      </Button>
    );
  }

  return (
    <WorkflowSheet
      title={title}
      subtitle={okCount > 0 ? `Отсканировано: ${okCount}` : undefined}
      scanning
      scanHint={
        last?.ok ? (
          <span className="text-green-600">✓ {last.ok}</span>
        ) : (
          "Сканируйте QR подряд — каждый скан записывается сразу"
        )
      }
      onScan={handleScan}
      scanPaused={busy}
      busy={busy}
      onBackToList={closeAll}
      onClose={closeAll}
      error={errorModal}
      onErrorRetry={() => setErrorModal(null)}
      onErrorExit={closeAll}
    >
      {null}
    </WorkflowSheet>
  );
}
