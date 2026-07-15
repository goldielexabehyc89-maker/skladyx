import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { PageTitle, EmptyState } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

const TYPE_RU: Record<string, string> = {
  receipt_posted: "Приемка",
  cell_assigned: "Ячейка",
  transfer_posted: "Перемещение",
  writeoff_posted: "Списание",
  picklist_created: "Заявка",
  picklist_picked: "Заявка",
  picklist_staged: "Заявка",
  issue_created: "Выдача",
  issue_confirmed: "Выдача",
  inventory_started: "Инвентаризация",
  inventory_posted: "Инвентаризация",
  user_created: "Сотрудник",
  warehouse_created: "Склад",
};

// Лента: журнал всех операций «кто, что, когда». Сотрудник видит только свои события.
export default async function FeedPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const session = await requireUser();
  const s = scoped(session);
  const { type } = await searchParams;
  const isAdmin = session.role === "ADMIN";

  const events = await prisma.event.findMany({
    where: {
      companyId: s.companyId,
      ...(isAdmin ? {} : { actorId: session.userId }),
      ...(type ? { type } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const actorIds = [...new Set(events.map((e) => e.actorId).filter((x): x is string => !!x))];
  const actors = await prisma.user.findMany({ where: { id: { in: actorIds } } });
  const actorById = new Map(actors.map((u) => [u.id, u.name]));

  const types = [...new Set(Object.keys(TYPE_RU))];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <PageTitle>Лента</PageTitle>

      {isAdmin && (
        <form data-realtime-ignore-dirty>
          <select
            name="type"
            defaultValue={type ?? ""}
            className="min-h-11 w-full rounded-xl border border-[#e4e4f0] bg-white px-3 py-2 text-sm outline-none"
          >
            <option value="">Все события</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {TYPE_RU[t]} — {t}
              </option>
            ))}
          </select>
          <button type="submit" className="mt-2 w-full rounded-xl border border-[#e4e4f0] bg-white px-4 py-2 text-sm font-medium active:bg-neutral-100">
            Показать
          </button>
        </form>
      )}

      {events.length === 0 ? (
        <EmptyState>Событий пока нет.</EmptyState>
      ) : (
        <div className="flex flex-col gap-2">
          {events.map((e) => {
            const inner = (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">{e.title}</span>
                  <span className="shrink-0 text-xs text-neutral-400">
                    {fmtDateTime(e.createdAt)}
                  </span>
                </div>
                <div className="mt-0.5 text-sm text-neutral-600">{e.body}</div>
                {e.actorId && (
                  <div className="mt-0.5 text-xs text-neutral-400">
                    {actorById.get(e.actorId) ?? "—"}
                  </div>
                )}
              </>
            );
            return e.url ? (
              <Link
                key={e.id}
                href={e.url}
                className="rounded-2xl bg-white p-3 shadow-[0_2px_8px_rgba(20,20,60,0.06)] active:bg-neutral-50"
              >
                {inner}
              </Link>
            ) : (
              <div key={e.id} className="rounded-2xl bg-white p-3 shadow-[0_2px_8px_rgba(20,20,60,0.06)]">
                {inner}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
