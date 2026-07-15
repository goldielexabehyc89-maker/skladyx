"use client";

import { useState } from "react";
import { clsx } from "clsx";
import { Badge, Button } from "@/components/ui";
import { toggleCellStagingAction, toggleCellActiveAction } from "@/app/actions/warehouses";

// Плитка ячейки: крупная тап-цель; действия («зона выдачи», «отключить») —
// в маленьком листе по тапу вместо микро-ссылок.
export function CellTile({
  cell,
}: {
  cell: { id: string; code: string; isStaging: boolean; isActive: boolean };
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={clsx(
          "flex min-h-16 flex-col items-center justify-center gap-1 rounded-lg border p-2 text-center transition active:bg-neutral-50",
          cell.isActive
            ? "border-neutral-200 bg-white"
            : "border-neutral-100 bg-neutral-50 opacity-50",
        )}
      >
        <span className="font-mono text-base font-bold">{cell.code}</span>
        <span className="flex flex-wrap justify-center gap-1">
          {cell.isStaging && <Badge tone="blue">выдача</Badge>}
          {!cell.isActive && <Badge tone="red">откл</Badge>}
        </span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-t-2xl bg-white p-5 shadow-[0_-8px_40px_rgba(0,0,0,0.25)] sm:rounded-2xl"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 20px)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 text-center">
              <div className="font-mono text-2xl font-bold text-[#1a1a1a]">{cell.code}</div>
              <div className="mt-1.5 flex justify-center gap-1.5">
                <Badge tone={cell.isStaging ? "blue" : "neutral"}>
                  {cell.isStaging ? "зона выдачи" : "ячейка хранения"}
                </Badge>
                {!cell.isActive && <Badge tone="red">отключена</Badge>}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <form action={toggleCellStagingAction}>
                <input type="hidden" name="cellId" value={cell.id} />
                <Button type="submit" variant="ghost" className="w-full">
                  {cell.isStaging ? "Сделать ячейкой хранения" : "Сделать ячейкой зоны выдачи"}
                </Button>
              </form>
              <form action={toggleCellActiveAction}>
                <input type="hidden" name="cellId" value={cell.id} />
                <Button type="submit" variant="ghost" className="w-full">
                  {cell.isActive ? "Отключить ячейку" : "Включить ячейку"}
                </Button>
              </form>
              <Button type="button" variant="primary" onClick={() => setOpen(false)} className="w-full">
                Закрыть
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
