import { requireUser } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { confirmIssueAction } from "@/app/actions/issues";
import { PushSubscribeButton } from "@/components/push-subscribe-button";
import { Card, CardTitle, PageTitle, Badge, Button, EmptyState } from "@/components/ui";
import { fmtDateTime, fmtQty, fmtRub } from "@/lib/format";

// «Мои ТМЦ»: что числится за мной + подтверждение получения выдач.
export default async function MyPage() {
  const session = await requireUser();
  const s = scoped(session);

  const [pendingIssues, balances, units] = await Promise.all([
    prisma.issue.findMany({
      where: { companyId: s.companyId, employeeId: session.userId, status: "PENDING" },
      include: { lines: true },
      orderBy: { issuedAt: "desc" },
    }),
    prisma.stockBalance.findMany({
      where: {
        companyId: s.companyId,
        employeeId: session.userId,
        locKey: { startsWith: "E:" },
        qty: { gt: 0 },
      },
    }),
    prisma.itemUnit.findMany({
      where: { companyId: s.companyId, employeeId: session.userId, status: "ISSUED" },
      orderBy: { serial: "asc" },
    }),
  ]);

  const itemIds = [
    ...new Set([
      ...balances.map((b) => b.itemId),
      ...units.map((u) => u.itemId),
      ...pendingIssues.flatMap((i) => i.lines.map((l) => l.itemId)),
    ]),
  ];
  const [items, lots] = await Promise.all([
    prisma.item.findMany({ where: { id: { in: itemIds } }, include: { uom: true } }),
    prisma.lot.findMany({ where: { id: { in: balances.map((b) => b.lotId) } } }),
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const lotById = new Map(lots.map((l) => [l.id, l]));

  const totalValue =
    balances.reduce((sum, b) => {
      const price = lotById.get(b.lotId)?.price;
      return sum + (price ? price.toNumber() * b.qty.toNumber() : 0);
    }, 0) + units.reduce((sum, u) => sum + (u.price ? u.price.toNumber() : 0), 0);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <PageTitle>Мои ТМЦ</PageTitle>

      {pendingIssues.length > 0 && (
        <div className="flex flex-col gap-2">
          {pendingIssues.map((issue) => (
            <Card key={issue.id} className="border-orange-300 bg-orange-50">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-semibold">Выдача №{issue.number}</span>
                <Badge tone="orange">подтвердите получение</Badge>
              </div>
              <p className="mb-2 text-sm text-neutral-500">{fmtDateTime(issue.issuedAt)}</p>
              <div className="mb-3 flex flex-col gap-1">
                {issue.lines.map((l) => {
                  const item = itemById.get(l.itemId);
                  return (
                    <div key={l.id} className="flex justify-between text-sm">
                      <span>{item?.name ?? "—"}</span>
                      <span>
                        {fmtQty(l.qty)} {item?.uom.name ?? ""}
                      </span>
                    </div>
                  );
                })}
              </div>
              <form action={confirmIssueAction}>
                <input type="hidden" name="issueId" value={issue.id} />
                <Button type="submit" className="w-full">
                  ✓ Подтверждаю получение
                </Button>
              </form>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardTitle>Числится за мной</CardTitle>
        {balances.length === 0 && units.length === 0 ? (
          <EmptyState>За вами ничего не числится.</EmptyState>
        ) : (
          <div className="flex flex-col gap-1">
            {balances.map((b) => {
              const item = itemById.get(b.itemId);
              return (
                <div key={b.id} className="flex justify-between text-sm">
                  <span>{item?.name ?? "—"}</span>
                  <span>
                    {fmtQty(b.qty)} {item?.uom.name ?? ""}
                  </span>
                </div>
              );
            })}
            {units.map((u) => {
              const item = itemById.get(u.itemId);
              return (
                <div key={u.id} className="flex justify-between text-sm">
                  <span>
                    {item?.name ?? "—"} · ед. №{u.serial}
                  </span>
                  <span>1 {item?.uom.name ?? ""}</span>
                </div>
              );
            })}
            {totalValue > 0 && (
              <p className="mt-2 text-right text-sm font-semibold">
                На сумму: {fmtRub(totalValue)}
              </p>
            )}
          </div>
        )}
      </Card>

      <div className="flex justify-center">
        <PushSubscribeButton />
      </div>
    </div>
  );
}
