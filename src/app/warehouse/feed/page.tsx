import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { hasRole } from "@/lib/roles";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { PageTitle, EmptyState, Badge } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import type { EventType } from "@/lib/events";

// Пакет 11: Лента складских событий. Понятные бизнес-события — приёмка, размещение,
// охлаждение, сборка, контроль, выдача — плюс задачи и справочники. Сотрудник видит
// только свои события. Фильтр — по бизнес-категориям (без внутренних кодов).

// Подпись и тон каждого типа события.
const TYPE_META: Partial<Record<EventType, { label: string; tone: "neutral" | "blue" | "green" | "orange" | "red" }>> = {
  group_received: { label: "Приёмка", tone: "blue" },
  receipt_posted: { label: "Приёмка", tone: "blue" },
  group_placed: { label: "Размещение", tone: "green" },
  cell_assigned: { label: "Размещение", tone: "green" },
  group_cooling: { label: "Охлаждение", tone: "blue" },
  picklist_created: { label: "Сборка", tone: "neutral" },
  picklist_picked: { label: "Сборка", tone: "green" },
  picklist_staged: { label: "Сборка", tone: "green" },
  order_control_passed: { label: "Контроль", tone: "green" },
  order_correction_required: { label: "Контроль", tone: "red" },
  order_ready_for_driver: { label: "Выдача", tone: "blue" },
  order_issued: { label: "Выдача", tone: "green" },
  issue_created: { label: "Выдача", tone: "blue" },
  issue_confirmed: { label: "Выдача", tone: "green" },
  transfer_posted: { label: "Перемещение", tone: "neutral" },
  writeoff_posted: { label: "Списание", tone: "orange" },
  inventory_started: { label: "Инвентаризация", tone: "neutral" },
  inventory_posted: { label: "Инвентаризация", tone: "neutral" },
  task_created: { label: "Задача", tone: "neutral" },
  task_assigned: { label: "Задача", tone: "neutral" },
  task_started: { label: "Задача", tone: "blue" },
  task_completed: { label: "Задача", tone: "green" },
  task_cancelled: { label: "Задача", tone: "neutral" },
  task_returned: { label: "Задача", tone: "orange" },
  task_needs_attention: { label: "Внимание", tone: "red" },
  user_created: { label: "Сотрудник", tone: "neutral" },
  warehouse_created: { label: "Склад", tone: "neutral" },
};

// Бизнес-категории для фильтра → наборы типов событий.
const CATEGORIES: { key: string; label: string; types: EventType[] }[] = [
  { key: "receiving", label: "Приёмка", types: ["group_received", "receipt_posted"] },
  { key: "placement", label: "Размещение", types: ["group_placed", "cell_assigned"] },
  { key: "cooling", label: "Охлаждение", types: ["group_cooling"] },
  { key: "picking", label: "Сборка", types: ["picklist_created", "picklist_picked", "picklist_staged"] },
  { key: "control", label: "Контроль", types: ["order_control_passed", "order_correction_required"] },
  { key: "issue", label: "Выдача", types: ["order_ready_for_driver", "order_issued", "issue_created", "issue_confirmed"] },
  {
    key: "tasks",
    label: "Задачи",
    types: ["task_created", "task_assigned", "task_started", "task_completed", "task_cancelled", "task_returned", "task_needs_attention"],
  },
  { key: "refs", label: "Справочники", types: ["user_created", "warehouse_created"] },
];

export default async function FeedPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string }>;
}) {
  const session = await requireUser();
  const s = scoped(session);
  const { cat } = await searchParams;
  const isAdmin = hasRole(session, "ADMIN");
  const category = CATEGORIES.find((c) => c.key === cat);

  const events = await prisma.event.findMany({
    where: {
      companyId: s.companyId,
      ...(isAdmin ? {} : { actorId: session.userId }),
      ...(category ? { type: { in: category.types } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const actorIds = [...new Set(events.map((e) => e.actorId).filter((x): x is string => !!x))];
  const actors = await prisma.user.findMany({ where: { id: { in: actorIds } } });
  const actorById = new Map(actors.map((u) => [u.id, u.name]));

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <PageTitle>Лента</PageTitle>

      <form data-realtime-ignore-dirty>
        <select
          name="cat"
          defaultValue={cat ?? ""}
          className="min-h-11 w-full rounded-xl border border-[#e4e4f0] bg-white px-3 py-2 text-sm outline-none"
        >
          <option value="">Все события</option>
          {CATEGORIES.map((c) => (
            <option key={c.key} value={c.key}>{c.label}</option>
          ))}
        </select>
        <button type="submit" className="mt-2 w-full rounded-xl border border-[#e4e4f0] bg-white px-4 py-2 text-sm font-medium active:bg-neutral-100">
          Показать
        </button>
      </form>

      {events.length === 0 ? (
        <EmptyState>Событий пока нет.</EmptyState>
      ) : (
        <div className="flex flex-col gap-2">
          {events.map((e) => {
            const meta = TYPE_META[e.type as EventType];
            const inner = (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    {meta && <Badge tone={meta.tone}>{meta.label}</Badge>}
                    <span className="truncate text-sm font-semibold">{e.title}</span>
                  </span>
                  <span className="shrink-0 text-xs text-neutral-400">{fmtDateTime(e.createdAt)}</span>
                </div>
                <div className="mt-0.5 text-sm text-neutral-600">{e.body}</div>
                {e.actorId && (
                  <div className="mt-0.5 text-xs text-neutral-400">{actorById.get(e.actorId) ?? "—"}</div>
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
