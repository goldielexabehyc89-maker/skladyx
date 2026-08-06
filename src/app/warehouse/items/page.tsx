import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { PageShell } from "@/components/page-shell";
import { LinkButton, Badge, FilterBar, FilterSubmit } from "@/components/ui";
import { DataTable, type Column } from "@/components/data-table";

export default async function ItemsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await requireAdminPage();
  const s = scoped(session);
  const { q } = await searchParams;
  const items = await s.items(q);

  type Row = (typeof items)[number];
  // Пакет 9B: EAN — главный идентификатор товара. Активные штрихкоды через запятую (обычно один).
  const activeEans = (i: Row) => i.barcodes.filter((b) => b.isActive).map((b) => b.code);
  const columns: Column<Row>[] = [
    {
      key: "name",
      header: "Наименование",
      cell: (i) => (
        <Link href={`/warehouse/items/${i.id}`} className="font-semibold text-brand">
          {i.name}
        </Link>
      ),
    },
    {
      key: "ean",
      header: "EAN",
      cell: (i) => {
        const eans = activeEans(i);
        return eans.length ? (
          <span className="font-mono text-sm">{eans.join(", ")}</span>
        ) : (
          <span className="text-xs text-neutral-400">нет EAN</span>
        );
      },
    },
    {
      key: "source",
      header: "Источник",
      cell: (i) => <Badge tone={i.source === "API" ? "blue" : "neutral"}>{i.source === "API" ? "API" : "ручной"}</Badge>,
    },
    {
      key: "status",
      header: "Статус",
      cell: (i) =>
        i.isActive ? <Badge tone="green">активен</Badge> : <Badge tone="red">архив</Badge>,
    },
  ];

  return (
    <PageShell
      title="Номенклатура"
      action={
        <LinkButton href="/warehouse/items/new" variant="primary">
          + Товар
        </LinkButton>
      }
    >
      <FilterBar>
        <input
          name="q"
          defaultValue={q ?? ""}
          placeholder="Поиск по названию, EAN, SKU…"
          className="min-h-11 w-full rounded-xl border border-[#e4e4f0] px-3 py-2 text-base outline-none focus:border-brand sm:flex-1"
        />
        <FilterSubmit label="Найти" />
      </FilterBar>

      <DataTable
        columns={columns}
        rows={items}
        rowKey={(i) => i.id}
        minWidth="min-w-[480px]"
        empty={q ? "Ничего не найдено." : "Товаров пока нет — добавьте первый."}
        mobileCard={(i) => {
          const eans = activeEans(i);
          return (
            <Link href={`/warehouse/items/${i.id}`} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-[#1a1a1a]">
                  {i.name} {!i.isActive && <Badge tone="red">архив</Badge>}
                </div>
                <div className="font-mono text-xs text-neutral-500">{eans.length ? eans.join(", ") : "нет EAN"}</div>
              </div>
              <Badge tone={i.source === "API" ? "blue" : "neutral"}>{i.source === "API" ? "API" : "ручной"}</Badge>
            </Link>
          );
        }}
      />
    </PageShell>
  );
}
