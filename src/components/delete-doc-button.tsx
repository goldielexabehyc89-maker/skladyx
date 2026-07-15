"use client";

import { Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { useActionState } from "react";
import { ConfirmSheet } from "@/components/confirm-sheet";
import type { FormState } from "@/app/actions/warehouses";

// Кнопка удаления/отмены документа (только для админа): подтверждение единым
// ConfirmSheet, ошибка сервера показывается под кнопкой
// (например «Сначала удалите приёмку №5»).
export function DeleteDocButton({
  action,
  hidden,
  label,
  confirmText,
  icon,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  hidden: Record<string, string>;
  label: string;
  confirmText: string;
  icon?: React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, {} as FormState);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <>
      <form ref={formRef} action={formAction} className="flex flex-col items-center gap-1 text-center">
        {Object.entries(hidden).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          disabled={pending}
          className="text-sm text-red-500 underline-offset-2 active:underline disabled:opacity-50"
        >
          {pending ? (
            "Выполняется…"
          ) : (
            <span className="inline-flex items-center gap-1.5">
              {icon ?? <Trash2 size={14} />} {label}
            </span>
          )}
        </button>
        {state.error && <p className="max-w-md text-xs text-red-600">{state.error}</p>}
      </form>
      <ConfirmSheet
        open={confirmOpen}
        title={label}
        description={confirmText}
        confirmLabel={label}
        cancelLabel="Отмена"
        tone="danger"
        busy={pending}
        onConfirm={() => {
          setConfirmOpen(false);
          formRef.current?.requestSubmit();
        }}
        onClose={() => setConfirmOpen(false)}
      />
    </>
  );
}
