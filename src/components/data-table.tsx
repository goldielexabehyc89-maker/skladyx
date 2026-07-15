import { clsx } from "clsx";
import { EmptyState } from "@/components/ui";

// Таблица 1 — единый вид всех списков. Настраиваются только колонки и данные,
// внешний вид одинаковый везде.
export interface Column<T> {
  key: string;
  header: string;
  align?: "left" | "right";
  className?: string; // доп. классы ячейки (напр. whitespace-nowrap)
  cell: (row: T) => React.ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  minWidth = "min-w-[720px]",
  empty = "Нет данных.",
  mobileCard,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  minWidth?: string;
  empty?: React.ReactNode;
  // Мобильный вид: если задан, на экранах < lg вместо широкой таблицы
  // рисуется список карточек строк (телефону не нужен горизонтальный скролл).
  mobileCard?: (row: T) => React.ReactNode;
}) {
  // строка — оборачивается в EmptyState; готовый элемент (например EmptyState
  // с кнопкой-действием) рендерится как есть
  if (rows.length === 0)
    return typeof empty === "string" ? <EmptyState>{empty}</EmptyState> : <>{empty}</>;

  return (
    <>
    {mobileCard && (
      <div className="flex flex-col gap-2 lg:hidden">
        {rows.map((row) => (
          <div
            key={rowKey(row)}
            className="rounded-xl bg-white px-3.5 py-3 shadow-[0_2px_8px_rgba(20,20,60,0.06)]"
          >
            {mobileCard(row)}
          </div>
        ))}
      </div>
    )}
    <div
      className={clsx(
        "overflow-x-auto rounded-xl bg-white shadow-[0_2px_8px_rgba(20,20,60,0.06)]",
        mobileCard && "hidden lg:block",
      )}
    >
      <table className={clsx("w-full text-sm", minWidth)}>
        <thead className="bg-neutral-50">
          <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
            {columns.map((c) => (
              <th
                key={c.key}
                className={clsx("px-3 py-2.5 font-medium", c.align === "right" && "text-right")}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-b border-neutral-100 last:border-0">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={clsx(
                    "px-3 py-2.5",
                    c.align === "right" && "text-right",
                    c.className,
                  )}
                >
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  );
}
