"use client";

import { useState } from "react";
import Link from "next/link";

export interface StockRow {
  time: string;
  order: string;
  id: string;
  name: string;
  where: string;
  warehouse: string;
  uom: string;
  qty: string | null; // доступно (null, если строка — резерв)
  reserve: string | null; // резерв (null, если обычный остаток)
  value: string;
}

// Таблица остатков: на десктопе — таблица (колонка «Склад» сворачиваемая),
// на телефоне — карточки строк: товар и крупно ячейка/количество, без скролла вбок.
export function StockTable({ rows }: { rows: StockRow[] }) {
  const [showWh, setShowWh] = useState(false);

  const idLink = (r: StockRow, className: string) =>
    r.id !== "—" ? (
      <Link href={`/warehouse/history?id=${r.id}`} className={className}>
        {r.id}
      </Link>
    ) : (
      <span className={className}>{r.id}</span>
    );

  return (
    <>
      {/* Мобильный вид: карточки строк */}
      <div className="flex flex-col gap-2 lg:hidden">
        {rows.map((r, i) => (
          <div
            key={`${r.id}-${i}`}
            className="rounded-xl bg-white px-3.5 py-3 shadow-[0_2px_8px_rgba(20,20,60,0.06)]"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-[#1a1a1a]">{r.name}</div>
                <div className="mt-0.5 text-xs text-neutral-500">
                  {idLink(r, "font-mono text-brand underline-offset-2")}
                  {r.order !== "—" ? ` · заказ ${r.order}` : ""}
                </div>
                <div className="mt-0.5 text-[11px] text-neutral-400">{r.time}</div>
              </div>
              <div className="shrink-0 text-right">
                <div
                  className={
                    r.where === "без ячейки"
                      ? "rounded-md bg-amber-100 px-2 py-0.5 text-sm font-semibold text-amber-700"
                      : "font-mono text-base font-bold leading-tight text-neutral-800"
                  }
                >
                  {r.where}
                </div>
                {r.qty && (
                  <div className="mt-0.5 text-sm font-semibold tabular-nums">
                    {r.qty} <span className="text-xs font-normal text-neutral-500">{r.uom}</span>
                  </div>
                )}
                {r.reserve && (
                  <div className="mt-0.5 inline-flex items-center gap-1 rounded-md bg-[#fff3e0] px-1.5 py-0.5 text-xs font-semibold text-[#e65100]">
                    Резерв {r.reserve} {r.uom}
                  </div>
                )}
                {r.where.includes("ждёт подтв") && (
                  <div className="mt-0.5 inline-flex rounded-md bg-[#fff3e0] px-1.5 py-0.5 text-[11px] font-semibold text-[#e65100]">
                    ждёт подтверждения
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Десктоп: таблица */}
      <div className="hidden overflow-x-auto rounded-xl bg-white shadow-[0_2px_8px_rgba(20,20,60,0.06)] lg:block">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-neutral-50">
            <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
              <th className="px-3 py-2.5 font-medium">Дата и время</th>
              <th className="px-3 py-2.5 font-medium">Заказ</th>
              <th className="px-3 py-2.5 font-medium">ID</th>
              <th className="px-3 py-2.5 font-medium">Товар</th>
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
              <th className="px-3 py-2.5 font-medium">Ед.</th>
              <th className="px-3 py-2.5 text-right font-medium">Кол-во</th>
              <th className="px-3 py-2.5 text-right font-medium">Резерв</th>
              <th className="px-3 py-2.5 text-right font-medium">Сумма</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.id}-${i}`} className="border-b border-neutral-100 last:border-0">
                <td className="whitespace-nowrap px-3 py-2.5 text-neutral-500">{r.time}</td>
                <td className="whitespace-nowrap px-3 py-2.5 text-neutral-600">{r.order}</td>
                <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs">
                  {idLink(r, "text-brand underline-offset-2 hover:underline")}
                </td>
                <td className="px-3 py-2.5 font-medium">{r.name}</td>
                <td className="whitespace-nowrap px-3 py-2.5 text-neutral-600">{r.where}</td>
                <td className="whitespace-nowrap px-2 py-2.5 text-neutral-500">
                  {showWh ? r.warehouse || "—" : ""}
                </td>
                <td className="px-3 py-2.5 text-neutral-500">{r.uom}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{r.qty ?? ""}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-orange-600">
                  {r.reserve ?? ""}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-neutral-500">
                  {r.value || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
