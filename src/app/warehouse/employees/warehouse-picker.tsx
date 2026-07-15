"use client";

import { useState } from "react";
import { ChipSelect } from "@/components/ui";

// Выбор доступа к складам: «Все склады» или несколько конкретных — плитками.
export function WarehousePicker({
  warehouses,
  initialAll = true,
  initialIds = [],
}: {
  warehouses: { id: string; name: string }[];
  initialAll?: boolean;
  initialIds?: string[];
}) {
  const [all, setAll] = useState(initialAll);
  return (
    <fieldset className="flex flex-col gap-2">
      <span className="text-sm font-medium text-[#555]">
        Доступ к складам <span className="text-red-500">*</span>
      </span>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="allWarehouses"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
          className="h-5 w-5"
        />
        Все склады
      </label>
      {!all &&
        (warehouses.length === 0 ? (
          <span className="text-sm text-neutral-400">Складов ещё нет</span>
        ) : (
          <ChipSelect
            name="wh"
            multiple
            options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
            defaultValue={initialIds}
          />
        ))}
    </fieldset>
  );
}
