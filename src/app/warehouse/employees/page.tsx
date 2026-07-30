import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { allowedWarehouses } from "@/lib/warehouse-access";
import { ROLE_LABEL, ROLE_TONE, ROLE_ORDER } from "@/lib/role-labels";
import type { Role } from "@/lib/jwt";
import { PageShell } from "@/components/page-shell";
import { LinkButton, Badge, FilterBar, FilterSubmit, SelectField } from "@/components/ui";
import { DataTable, type Column } from "@/components/data-table";

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
    include: {
      warehouseLinks: { select: { warehouseId: true } },
      userRoles: { select: { role: true } },
    },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });

  // активные смены по пользователям (для статуса «На смене»)
  const openShifts = await prisma.workShift.findMany({
    where: { companyId: s.companyId, endedAt: null },
    select: { userId: true, role: true, warehouseId: true },
  });
  const shiftByUser = new Map(openShifts.map((sh) => [sh.userId, sh]));

  type Row = (typeof users)[number];
  const rolesOf = (u: Row) => ROLE_ORDER.filter((r) => u.userRoles.some((ur) => ur.role === r));
  const whLabel = (u: Row) =>
    u.allWarehouses
      ? "Все склады"
      : u.warehouseLinks.map((l) => whById.get(l.warehouseId) ?? "—").join(", ") || "—";
  const RoleBadges = ({ roles }: { roles: Role[] }) => (
    <span className="flex flex-wrap gap-1">
      {roles.map((r) => (
        <Badge key={r} tone={ROLE_TONE[r]}>
          {ROLE_LABEL[r]}
        </Badge>
      ))}
    </span>
  );

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
    { key: "role", header: "Роли", cell: (u) => <RoleBadges roles={rolesOf(u)} /> },
    { key: "wh", header: "Склады", className: "text-neutral-500", cell: (u) => whLabel(u) },
    {
      key: "status",
      header: "Статус",
      cell: (u) => {
        const sh = shiftByUser.get(u.id);
        return (
          <span className="flex flex-wrap gap-1">
            {sh && <Badge tone="green">На смене · {ROLE_LABEL[sh.role as Role]}</Badge>}
            {!u.isActive && <Badge tone="red">откл</Badge>}
            {!u.passwordHash && <Badge tone="orange">без пароля</Badge>}
            {u.isActive && u.passwordHash && !sh && <Badge tone="green">активен</Badge>}
          </span>
        );
      },
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
        minWidth="min-w-[760px]"
        empty="Сотрудников нет."
        mobileCard={(u) => {
          const sh = shiftByUser.get(u.id);
          return (
            <Link href={`/warehouse/employees/${u.id}`} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-[#1a1a1a]">{u.name}</div>
                <div className="text-xs text-neutral-500">{u.phone ?? u.email ?? "—"}</div>
                <div className="mt-0.5 truncate text-xs text-neutral-400">{whLabel(u)}</div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <RoleBadges roles={rolesOf(u)} />
                {sh && <Badge tone="green">На смене</Badge>}
                {!u.isActive && <Badge tone="red">откл</Badge>}
                {!u.passwordHash && <Badge tone="orange">без пароля</Badge>}
              </div>
            </Link>
          );
        }}
      />
    </PageShell>
  );
}
