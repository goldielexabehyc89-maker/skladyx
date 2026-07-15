import Link from "next/link";
import { requireStaffPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { warehouseAccess, whereWh } from "@/lib/warehouse-access";
import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { PageHeader, Badge, LinkButton } from "@/components/ui";
import { DataTable, type Column } from "@/components/data-table";
import { fmtDateTime } from "@/lib/format";

const STATUS_RU = {
  PENDING: { label: "ждёт подтверждения", tone: "orange" as const },
  CONFIRMED: { label: "подтверждена", tone: "green" as const },
  CANCELLED: { label: "отменена", tone: "red" as const },
};

// Выдачи (Таблица 1): журнал выдач сотрудникам. Кладовщик видит только выдачи
// по заявкам своих складов; прямая выдача — только у админа.
export default async function IssuesPage() {
  const session = await requireStaffPage();
  const s = scoped(session);
  const isAdmin = session.role === "ADMIN";
  const settings = await getSettings(s.companyId);
  let issues = await prisma.issue.findMany({
    where: { companyId: s.companyId },
    include: { _count: { select: { lines: true } } },
    orderBy: [{ status: "desc" }, { issuedAt: "desc" }],
    take: 100,
  });
  if (!isAdmin) {
    // кладовщик видит только выдачи по заявкам своих складов (прямые — админские)
    const access = await warehouseAccess(session);
    const plIds = issues.map((i) => i.pickListId).filter((x): x is string => !!x);
    const pls = plIds.length
      ? await prisma.pickList.findMany({
          where: { id: { in: plIds }, ...whereWh(access) },
          select: { id: true },
        })
      : [];
    const okIds = new Set(pls.map((p) => p.id));
    issues = issues.filter((i) => i.pickListId && okIds.has(i.pickListId));
  }
  const users = await s.users();
  const userById = new Map(users.map((u) => [u.id, u.name]));

  type Row = (typeof issues)[number];
  const columns: Column<Row>[] = [
    {
      key: "number",
      header: "№",
      className: "whitespace-nowrap",
      cell: (i) => (
        <Link href={`/warehouse/issues/${i.id}`} className="font-semibold text-brand">
          №{i.number}
        </Link>
      ),
    },
    {
      key: "date",
      header: "Дата и время",
      className: "whitespace-nowrap text-neutral-500",
      cell: (i) => fmtDateTime(i.issuedAt),
    },
    { key: "emp", header: "Сотрудник", cell: (i) => userById.get(i.employeeId) ?? "—" },
    { key: "lines", header: "Позиций", align: "right", cell: (i) => i._count.lines },
    {
      key: "source",
      header: "Источник",
      cell: (i) => (i.source === "DIRECT" ? "прямая" : "по заявке"),
    },
    {
      key: "status",
      header: "Статус",
      cell: (i) => <Badge tone={STATUS_RU[i.status].tone}>{STATUS_RU[i.status].label}</Badge>,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Выдачи"
        action={
          isAdmin && settings.directIssueEnabled ? (
            <LinkButton href="/warehouse/issues/new" variant="primary">
              + Выдача
            </LinkButton>
          ) : undefined
        }
      />
      <DataTable
        columns={columns}
        rows={issues}
        rowKey={(i) => i.id}
        empty="Выдач пока нет."
        mobileCard={(i) => (
          <Link href={`/warehouse/issues/${i.id}`} className="block">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-[#1a1a1a]">Выдача №{i.number}</span>
              <Badge tone={STATUS_RU[i.status].tone}>{STATUS_RU[i.status].label}</Badge>
            </div>
            <div className="mt-0.5 truncate text-xs text-neutral-500">
              {userById.get(i.employeeId) ?? "—"} · {i._count.lines} поз. ·{" "}
              {i.source === "DIRECT" ? "прямая" : "по заявке"} · {fmtDateTime(i.issuedAt)}
            </div>
          </Link>
        )}
      />
    </div>
  );
}
