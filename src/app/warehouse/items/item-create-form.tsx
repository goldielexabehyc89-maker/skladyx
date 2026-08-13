"use client";

import { useEffect, useState } from "react";
import { useActionState } from "react";
import { createItemAction } from "@/app/actions/items";
import { Button } from "@/components/ui";
import type { FormState } from "@/app/actions/warehouses";

// Пакет 10 (коррекция): управляемая форма создания товара. React 19 сбрасывает НЕуправляемую форму
// после server action — из-за этого при ошибке терялись введённые поля. Управляемое состояние (useState)
// сохраняет наименование, EAN и SKU при ошибке.
// P3B-FIX-1: при успехе createItemAction возвращает redirectTo="/warehouse/items" (без server-action
// redirect()). Клиент делает полную навигацию window.location.assign — свежий HTTP-рендер списка по
// актуальным Host/session/tenant, без промежуточного перехода в монитор. Ошибка → навигации нет, поля целы.
export function ItemCreateForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(createItemAction, {});
  const [name, setName] = useState("");
  const [ean, setEan] = useState("");
  const [sku, setSku] = useState("");
  useEffect(() => {
    if (state.redirectTo) window.location.assign(state.redirectTo);
  }, [state.redirectTo]);
  const input = "rounded-lg border border-[#e4e4f0] px-3 py-2 text-sm";

  return (
    <form action={action} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-[#555]">Наименование</span>
        <input name="name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="напр. Сырок глазированный 40 г" className={input} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-[#555]">Заводской EAN (8 или 13 цифр)</span>
        <input name="ean" required inputMode="numeric" value={ean} onChange={(e) => setEan(e.target.value)} placeholder="напр. 4607750000012" className={input} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-[#555]">SKU / внешний код (необязательно)</span>
        <input name="sku" value={sku} onChange={(e) => setSku(e.target.value)} placeholder="необязательно" className={input} />
      </label>
      <p className="text-xs text-neutral-400">
        Единица измерения «шт» и партионный учёт назначаются автоматически. EAN — главный
        идентификатор товара; контрольная цифра проверяется при сохранении.
      </p>
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <Button type="submit" disabled={pending}>{pending ? "Сохранение…" : "Создать товар"}</Button>
    </form>
  );
}
