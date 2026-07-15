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
    { key: "uom", header: "Ед.", className: "text-neutral-500", cell: (i) => i.uom.name },
    {
      key: "tracking",
      header: "Тип учёта",
      cell: (i) => (
        <Badge tone={i.tracking === "UNIT" ? "blue" : "neutral"}>
          {i.tracking === "UNIT" ? "серийный" : "обычный"}
        </Badge>
      ),
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
          placeholder="Поиск по названию…"
          className="min-h-11 w-full rounded-xl border border-[#e4e4f0] px-3 py-2 text-base outline-none focus:border-brand sm:flex-1"
        />
        <FilterSubmit label="Найти" />
      </FilterBar>

      <DataTable
        columns={columns}
        rows={items}
        rowKey={(i) => i.id}
        minWidth="min-w-[560px]"
        empty={q ? "Ничего не найдено." : "Товаров пока нет — добавьте первый."}
        mobileCard={(i) => (
          <Link href={`/warehouse/items/${i.id}`} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-[#1a1a1a]">
                {i.name} {!i.isActive && <Badge tone="red">архив</Badge>}
              </div>
              <div className="text-xs text-neutral-500">{i.uom.name}</div>
            </div>
            <Badge tone={i.tracking === "UNIT" ? "blue" : "neutral"}>
              {i.tracking === "UNIT" ? "серийный" : "обычный"}
            </Badge>
          </Link>
        )}
      />
    </PageShell>
  );
}
