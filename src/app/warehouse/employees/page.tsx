import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { allowedWarehouses } from "@/lib/warehouse-access";
import { PageShell } from "@/components/page-shell";
import { LinkButton, Badge, FilterBar, FilterSubmit, SelectField } from "@/components/ui";
import { DataTable, type Column } from "@/components/data-table";

const ROLE_RU: Record<string, { label: string; tone: "blue" | "orange" | "neutral" }> = {
  ADMIN: { label: "админ", tone: "blue" },
  STOREKEEPER: { label: "кладовщик", tone: "orange" },
  EMPLOYEE: { label: "сотрудник", tone: "neutral" },
};

export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ warehouse?: string }>;
}) {
  const session = await requireAdminPage();
  const s = scoped(session);
  const sp = await searchParams;

  const warehouses = await allowedWarehouses(session, s.companyId);
  const whById = new Map(warehouses.map((w) => [w.id, w.name]));

  const users = await prisma.user.findMany({
    where: {
      companyId: s.companyId,
      ...(sp.warehouse
        ? { OR: [{ allWarehouses: true }, { warehouseLinks: { some: { warehouseId: sp.warehouse } } }] }
        : {}),
    },
    include: { warehouseLinks: { select: { warehouseId: true } } },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });
  const whLabel = (u: (typeof users)[number]) =>
    u.allWarehouses
      ? "Все склады"
      : u.warehouseLinks.map((l) => whById.get(l.warehouseId) ?? "—").join(", ") || "—";

  type Row = (typeof users)[number];
  const columns: Column<Row>[] = [
    {
      key: "name",
      header: "Имя",
      cell: (u) => (
        <Link href={`/warehouse/employees/${u.id}`} className="font-semibold text-brand">
          {u.name}
        </Link>
      ),
    },
    { key: "phone", header: "Телефон", className: "text-neutral-500 whitespace-nowrap", cell: (u) => u.phone ?? u.email ?? "—" },
    {
      key: "role",
      header: "Роль",
      cell: (u) => <Badge tone={ROLE_RU[u.role]?.tone ?? "neutral"}>{ROLE_RU[u.role]?.label ?? u.role}</Badge>,
    },
    { key: "wh", header: "Склады", className: "text-neutral-500", cell: (u) => whLabel(u) },
    {
      key: "status",
      header: "Статус",
      cell: (u) => (
        <span className="flex gap-1">
          {!u.isActive && <Badge tone="red">откл</Badge>}
          {!u.passwordHash && <Badge tone="orange">без пароля</Badge>}
          {u.isActive && u.passwordHash && <Badge tone="green">активен</Badge>}
        </span>
      ),
    },
  ];

  return (
    <PageShell
      title="Сотрудники"
      action={
        <LinkButton href="/warehouse/employees/new" variant="primary">
          + Сотрудник
        </LinkButton>
      }
    >
      <FilterBar>
        <SelectField name="warehouse" defaultValue={sp.warehouse ?? ""} className="text-sm sm:flex-1">
          <option value="">Все склады</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </SelectField>
        <FilterSubmit label="Фильтр" />
      </FilterBar>

      <DataTable
        columns={columns}
        rows={users}
        rowKey={(u) => u.id}
        minWidth="min-w-[720px]"
        empty="Сотрудников нет."
        mobileCard={(u) => (
          <Link href={`/warehouse/employees/${u.id}`} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-[#1a1a1a]">{u.name}</div>
              <div className="text-xs text-neutral-500">{u.phone ?? u.email ?? "—"}</div>
              <div className="mt-0.5 truncate text-xs text-neutral-400">{whLabel(u)}</div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <Badge tone={ROLE_RU[u.role]?.tone ?? "neutral"}>{ROLE_RU[u.role]?.label ?? u.role}</Badge>
              {!u.isActive && <Badge tone="red">откл</Badge>}
              {!u.passwordHash && <Badge tone="orange">без пароля</Badge>}
            </div>
          </Link>
        )}
      />
    </PageShell>
  );
}
