"use client";

import { Button } from "@/components/ui";

// Единое подтверждение опасных действий вместо window.confirm: на телефоне —
// нижний лист, на десктопе — центрированное окно. Кнопка подтверждения красная
// (tone="danger") или обычная.
export function ConfirmSheet({
  open,
  title,
  description,
  confirmLabel = "Подтвердить",
  cancelLabel = "Отмена",
  tone = "danger",
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-t-2xl bg-white p-5 shadow-[0_-8px_40px_rgba(0,0,0,0.25)] sm:rounded-2xl sm:shadow-[0_20px_60px_rgba(0,0,0,0.35)]"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 20px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-bold text-[#1a1a1a]">{title}</div>
        {description && <p className="mt-1.5 text-sm text-neutral-500">{description}</p>}
        <div className="mt-4 flex flex-col gap-2">
          <Button
            type="button"
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={onConfirm}
            disabled={busy}
            className="w-full"
          >
            {busy ? "Выполняется…" : confirmLabel}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose} className="w-full">
            {cancelLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
