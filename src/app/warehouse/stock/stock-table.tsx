"use client";

import { useState } from "react";

export interface StockRow {
  name: string;
  ean: string;
  where: string; // код ячейки или название зоны
  warehouse: string;
  groupState: string; // состояние группы (пусто, если нет)
  groupTone: "neutral" | "blue" | "green" | "orange";
  qty: string;
  uom: string;
  reserved: string; // зарезервировано заказом (пусто, если нет)
  reservedOrders: string; // номера заказов через запятую
}

const toneCls: Record<StockRow["groupTone"], string> = {
  neutral: "bg-neutral-100 text-neutral-600",
  blue: "bg-blue-100 text-blue-700",
  green: "bg-green-100 text-green-700",
  orange: "bg-amber-100 text-amber-700",
};

// Остатки на новой модели: строка = одно текущее размещение партии.
// Десктоп — таблица (колонка «Склад» сворачиваемая), телефон — карточки.
export function StockTable({ rows }: { rows: StockRow[] }) {
  const [showWh, setShowWh] = useState(false);

  return (
    <>
      {/* Мобильный вид */}
      <div className="flex flex-col gap-2 lg:hidden">
        {rows.map((r, i) => (
          <div key={i} className="rounded-xl bg-white px-3.5 py-3 shadow-[0_2px_8px_rgba(20,20,60,0.06)]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-[#1a1a1a]">{r.name}</div>
                {r.ean && <div className="mt-0.5 font-mono text-xs text-neutral-500">{r.ean}</div>}
                {r.groupState && (
                  <span className={`mt-1 inline-flex rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${toneCls[r.groupTone]}`}>
                    {r.groupState}
                  </span>
                )}
              </div>
              <div className="shrink-0 text-right">
                <div className="font-mono text-base font-bold leading-tight text-neutral-800">{r.where}</div>
                <div className="mt-0.5 text-sm font-semibold tabular-nums">
                  {r.qty} <span className="text-xs font-normal text-neutral-500">{r.uom}</span>
                </div>
                {r.reserved && (
                  <div className="mt-0.5 inline-flex items-center gap-1 rounded-md bg-[#fff3e0] px-1.5 py-0.5 text-xs font-semibold text-[#e65100]">
                    Резерв {r.reserved}{r.reservedOrders ? ` · ${r.reservedOrders}` : ""}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Десктоп */}
      <div className="hidden overflow-x-auto rounded-xl bg-white shadow-[0_2px_8px_rgba(20,20,60,0.06)] lg:block">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="bg-neutral-50">
            <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
              <th className="px-3 py-2.5 font-medium">Товар</th>
              <th className="px-3 py-2.5 font-medium">EAN</th>
              <th className="px-3 py-2.5 font-medium">Где</th>
              <th className="px-2 py-2.5 font-medium">
                <button
                  type="button"
                  onClick={() => setShowWh((v) => !v)}
                  className="inline-flex items-center gap-1 uppercase tracking-wide text-neutral-500"
                  title={showWh ? "Свернуть колонку" : "Показать склад"}
                >
                  Склад <span className="text-[10px]">{showWh ? "▾" : "▸"}</span>
                </button>
              </th>
              <th className="px-3 py-2.5 font-medium">Группа</th>
              <th className="px-3 py-2.5 font-medium">Ед.</th>
              <th className="px-3 py-2.5 text-right font-medium">Кол-во</th>
              <th className="px-3 py-2.5 text-right font-medium">Резерв заказа</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-neutral-100 last:border-0">
                <td className="px-3 py-2.5 font-medium">{r.name}</td>
                <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-neutral-500">{r.ean || "—"}</td>
                <td className="whitespace-nowrap px-3 py-2.5 text-neutral-600">{r.where}</td>
                <td className="whitespace-nowrap px-2 py-2.5 text-neutral-500">{showWh ? r.warehouse || "—" : ""}</td>
                <td className="whitespace-nowrap px-3 py-2.5">
                  {r.groupState ? (
                    <span className={`inline-flex rounded-md px-1.5 py-0.5 text-xs font-semibold ${toneCls[r.groupTone]}`}>
                      {r.groupState}
                    </span>
                  ) : (
                    <span className="text-neutral-400">—</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-neutral-500">{r.uom}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{r.qty}</td>
                <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-orange-600">
                  {r.reserved ? `${r.reserved}${r.reservedOrders ? ` (${r.reservedOrders})` : ""}` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
