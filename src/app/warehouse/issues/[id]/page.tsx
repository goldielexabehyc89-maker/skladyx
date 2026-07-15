import { Undo2 } from "lucide-react";
import { redirect } from "next/navigation";
import { requireStaffPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { warehouseAccess, whereWh } from "@/lib/warehouse-access";
import { prisma } from "@/lib/db";
import { Card, CardTitle, PageTitle, Badge } from "@/components/ui";
import { DeleteDocButton } from "@/components/delete-doc-button";
import { cancelIssueAction } from "@/app/actions/issues";
import { fmtDateTime, fmtQty, fmtRub } from "@/lib/format";

export default async function IssuePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireStaffPage();
  const s = scoped(session);
  const { id } = await params;
  const issue = await s.issue(id);
  if (session.role !== "ADMIN") {
    // кладовщик — только выдачи по заявкам своих складов
    const access = await warehouseAccess(session);
    const ok = issue.pickListId
      ? await prisma.pickList.findFirst({
          where: { id: issue.pickListId, companyId: s.companyId, ...whereWh(access) },
          select: { id: true },
        })
      : null;
    if (!ok) redirect("/warehouse");
  }
  const [employee, issuedBy, items, units] = await Promise.all([
    s.user(issue.employeeId),
    prisma.user.findFirst({ where: { id: issue.issuedById, companyId: s.companyId } }),
    prisma.item.findMany({
      where: { id: { in: issue.lines.map((l) => l.itemId) } },
      include: { uom: true },
    }),
    prisma.itemUnit.findMany({
      where: { id: { in: issue.lines.map((l) => l.unitId).filter((x): x is string => !!x) } },
    }),
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const unitById = new Map(units.map((u) => [u.id, u]));

  const total = issue.lines.reduce(
    (sum, l) => sum + (l.price ? l.price.toNumber() * l.qty.toNumber() : 0),
    0,
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <PageTitle
        action={
          <Badge
            tone={
              issue.status === "CONFIRMED" ? "green" : issue.status === "CANCELLED" ? "red" : "orange"
            }
          >
            {issue.status === "CONFIRMED"
              ? "подтверждена"
              : issue.status === "CANCELLED"
                ? "отменена"
                : "ждёт подтверждения"}
          </Badge>
        }
      >
        Выдача №{issue.number}
      </PageTitle>
      <p className="-mt-3 text-sm text-neutral-500">
        Кому: <b>{employee.name}</b> · {fmtDateTime(issue.issuedAt)} · выдал{" "}
        {issuedBy?.name ?? "—"}
        {issue.confirmedAt ? ` · подтверждена ${fmtDateTime(issue.confirmedAt)}` : ""}
      </p>

      <Card>
        <CardTitle>Позиции ({issue.lines.length})</CardTitle>
        <div className="flex flex-col divide-y divide-neutral-100">
          {issue.lines.map((l) => {
            const item = itemById.get(l.itemId);
            const unit = l.unitId ? unitById.get(l.unitId) : null;
            return (
              <div key={l.id} className="flex items-center justify-between gap-2 py-2.5 text-sm">
                <span>
                  {item?.name ?? "—"}
                  {unit ? ` · ед. №${unit.serial}` : ""}
                </span>
                <span>
                  {fmtQty(l.qty)} {item?.uom.name ?? ""}
                  {l.price && (
                    <span className="text-neutral-400">
                      {" "}
                      · {fmtRub(l.price.toNumber() * l.qty.toNumber())}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
        {total > 0 && (
          <p className="mt-2 text-right text-sm font-semibold">Итого: {fmtRub(total)}</p>
        )}
      </Card>
      {session.role === "ADMIN" && issue.status !== "CANCELLED" && (
        <DeleteDocButton
          action={cancelIssueAction}
          hidden={{ issueId: issue.id }}
          label="Отменить выдачу"
          icon={<Undo2 size={14} />}
          confirmText={`Отменить выдачу №${issue.number}? Товар вернётся туда, откуда был выдан.`}
        />
      )}
    </div>
  );
}
