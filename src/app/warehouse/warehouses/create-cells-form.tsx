"use client";

import { useState, useActionState } from "react";
import { clsx } from "clsx";
import { Button, Field } from "@/components/ui";
import { createCellsAction, type FormState } from "@/app/actions/warehouses";
import { ZONE_KIND_LABEL } from "@/lib/zones";
import type { ZoneKind } from "@prisma/client";

export interface PhysZone {
  id: string;
  name: string;
  kind: ZoneKind;
}

// Создание ячеек в физической зоне: выбор зоны плитками; для STORAGE — обязательный уровень.
export function CreateCellsForm({ warehouseId, zones }: { warehouseId: string; zones: PhysZone[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createCellsAction, {});
  const [zoneId, setZoneId] = useState(zones[0]?.id ?? "");
  const kind = zones.find((z) => z.id === zoneId)?.kind ?? null;

  if (zones.length === 0)
    return <p className="text-sm text-neutral-500">Нет физических зон — добавьте зону выше.</p>;

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="warehouseId" value={warehouseId} />
      <input type="hidden" name="zoneId" value={zoneId} />

      <div>
        <div className="mb-1.5 text-xs font-medium text-neutral-500">Зона</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {zones.map((z) => (
            <button
              key={z.id}
              type="button"
              onClick={() => setZoneId(z.id)}
              className={clsx(
                "flex flex-col items-center gap-0.5 rounded-lg border p-2 text-center text-sm transition",
                zoneId === z.id
                  ? "border-brand bg-brand/5 font-semibold"
                  : "border-neutral-200 bg-white active:bg-neutral-50",
              )}
            >
              <span className="truncate">{z.name}</span>
              <span className="text-[11px] text-neutral-400">{ZONE_KIND_LABEL[z.kind]}</span>
            </button>
          ))}
        </div>
      </div>

      <Field label="Префикс" name="prefix" required placeholder="А-" />
      <div className="grid grid-cols-2 gap-3">
        <Field label="С номера" name="from" type="number" required inputMode="numeric" placeholder="1" />
        <Field label="По номер" name="to" type="number" required inputMode="numeric" placeholder="20" />
      </div>
      {kind === "STORAGE" && (
        <Field
          label="Уровень (обязателен для хранения)"
          name="level"
          type="number"
          required
          inputMode="numeric"
          placeholder="1"
        />
      )}

      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <Button type="submit" disabled={pending}>
        {pending ? "…" : "Создать ячейки"}
      </Button>
      <p className="text-xs text-neutral-400">
        Одна ячейка — это диапазон из одного номера, например «Б-» с 1 по 1.
      </p>
    </form>
  );
}
