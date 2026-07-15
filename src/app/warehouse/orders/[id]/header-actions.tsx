"use client";

import { useRef, useState } from "react";
import { useActionState } from "react";
import { saveSupplierOrderAction, cancelSupplierOrderAction } from "@/app/actions/supplier-orders";
import { Button } from "@/components/ui";
import { ConfirmSheet } from "@/components/confirm-sheet";
import type { FormState } from "@/app/actions/warehouses";

// Кнопки «Сохранить»/«Отменить» для закреплённой панели заказа.
export function OrderHeaderActions({
  orderId,
  showSave,
  saveDisabled,
  showCancel,
}: {
  orderId: string;
  showSave: boolean;
  saveDisabled: boolean;
  showCancel: boolean;
}) {
  const [state, saveAction, saving] = useActionState(saveSupplierOrderAction, {} as FormState);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancelRef = useRef<HTMLFormElement>(null);

  return (
    <div className="flex items-center gap-2">
      {showCancel && (
        <form ref={cancelRef} action={cancelSupplierOrderAction}>
          <input type="hidden" name="orderId" value={orderId} />
          <Button type="button" variant="ghost" onClick={() => setConfirmCancel(true)}>
            Отменить
          </Button>
          <ConfirmSheet
            open={confirmCancel}
            title="Отменить заказ?"
            description="Заказ получит статус «отменён». Принять его на склад будет нельзя."
            confirmLabel="Отменить заказ"
            cancelLabel="Не отменять"
            onConfirm={() => {
              setConfirmCancel(false);
              cancelRef.current?.requestSubmit();
            }}
            onClose={() => setConfirmCancel(false)}
          />
        </form>
      )}
      {showSave && (
        <form action={saveAction}>
          <input type="hidden" name="orderId" value={orderId} />
          <Button
            type="submit"
            variant="primary"
            disabled={saving || saveDisabled}
          >
            {saving ? "Сохранение…" : "Сохранить"}
          </Button>
        </form>
      )}
      {state.error && (
        <div className="fixed inset-x-0 bottom-4 z-[60] mx-auto w-fit max-w-[90vw] rounded-xl bg-red-600 px-4 py-2 text-center text-sm text-white shadow-lg">
          {state.error}
        </div>
      )}
    </div>
  );
}
