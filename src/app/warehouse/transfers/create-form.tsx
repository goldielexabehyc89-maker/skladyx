"use client";

import { useState } from "react";
import { useActionState } from "react";
import { createTransferPickAction } from "@/app/actions/picklists";
import { Button, ChipSelect, Field } from "@/components/ui";
import type { FormState } from "@/app/actions/warehouses";

const initial: FormState = {};

// Создание перемещения: склады — плитками (источник, затем назначение).
// Дальше — как заявка на сбор: таблица позиций, сканирование, зона выдачи.
export function TransferCreateForm({
  warehouses,
}: {
  warehouses: { id: string; name: string }[];
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [state, formAction, pending] = useActionState(createTransferPickAction, initial);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-2">
        <span className="text-sm font-medium text-[#555]">Склад-источник (откуда собираем)</span>
        <ChipSelect
          name="warehouseId"
          required
          options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
          value={from}
          onChange={(next) => {
            const v = next[0] ?? "";
            setFrom(v);
            if (v === to) setTo("");
          }}
        />
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <span className="text-sm font-medium text-[#555]">Для склада (назначение)</span>
        {!from ? (
          <p className="text-sm text-neutral-400">Сначала выберите склад-источник.</p>
        ) : (
          <ChipSelect
            name="targetWarehouseId"
            required
            options={warehouses
              .filter((w) => w.id !== from)
              .map((w) => ({ value: w.id, label: w.name }))}
            value={to}
            onChange={(next) => setTo(next[0] ?? "")}
          />
        )}
      </fieldset>

      <Field label="Комментарий (необязательно)" name="note" />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <Button type="submit" disabled={pending}>
        {pending ? "Создание…" : "Создать перемещение"}
      </Button>
    </form>
  );
}
