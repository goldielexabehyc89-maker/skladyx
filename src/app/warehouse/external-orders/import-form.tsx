"use client";

import { useActionState } from "react";
import { importOrderAction, type OrderActionState } from "@/app/actions/external-orders";
import { Button } from "@/components/ui";

// Этап 5/Пакет 6: ручной импорт заказа (мост до интеграционного webhook-адаптера). ADMIN.
// lines — JSON-массив [{externalLineId,itemId,requiredQty}]. Импорт идемпотентен по externalId.
export function ImportOrderForm({ warehouses }: { warehouses: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState<OrderActionState, FormData>(importOrderAction, {});
  return (
    <form action={action} className="flex flex-col gap-2">
      <label className="text-xs font-medium text-neutral-500">Внешний ID заказа</label>
      <input name="externalId" required placeholder="напр. ORD-1001" className="rounded-lg border border-[#e4e4f0] px-3 py-2 text-sm" />
      <label className="text-xs font-medium text-neutral-500">Склад</label>
      <select name="warehouseId" required className="rounded-lg border border-[#e4e4f0] px-3 py-2 text-sm">
        {warehouses.map((w) => (
          <option key={w.id} value={w.id}>{w.name}</option>
        ))}
      </select>
      <label className="text-xs font-medium text-neutral-500">Срок (arrivalAt), опционально</label>
      <input name="arrivalAt" type="datetime-local" className="rounded-lg border border-[#e4e4f0] px-3 py-2 text-sm" />
      <label className="text-xs font-medium text-neutral-500">Строки (JSON)</label>
      <textarea
        name="lines"
        required
        rows={4}
        placeholder='[{"externalLineId":"1","itemId":"<id товара>","requiredQty":6}]'
        className="rounded-lg border border-[#e4e4f0] px-3 py-2 font-mono text-xs"
      />
      {state.error && <p className="text-xs text-red-600">{state.error}</p>}
      {state.ok && <p className="text-xs text-green-600">Импортирован. Статус: {state.status}</p>}
      <Button type="submit" disabled={pending}>{pending ? "…" : "Импортировать и зарезервировать"}</Button>
    </form>
  );
}
