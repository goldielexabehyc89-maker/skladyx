import Link from "next/link";
import { clsx } from "clsx";
import { requireStaffPage } from "@/lib/auth";
import { hasRole } from "@/lib/roles";
import { scoped } from "@/lib/tenant";
import { warehouseAccess, whereWh, allowedWarehouses } from "@/lib/warehouse-access";
import { prisma } from "@/lib/db";
import { Badge, EmptyState } from "@/components/ui";
import { PageShell } from "@/components/page-shell";
import { fmtDate } from "@/lib/format";

// «Активные» — очередь работы склада: приёмка заказов, сборка и выдача заявок
// и перемещений. Быстрые фильтры-чипы; проблемные документы (без позиций,
// позиции без ячейки, зависшие подтверждения) — в отдельном блоке
// «Требуют внимания» у админа, не смешиваясь с рабочей очередью кладовщика.

const FILTERS = [
  { value: "all", label: "Все" },
  { value: "receipt", label: "Приёмка" },
  { value: "pick", label: "Сборка" },
  { value: "issue", label: "Выдача" },
  { value: "draft", label: "Черновики", adminOnly: true },
] as const;
type FilterValue = (typeof FILTERS)[number]["value"];

// Карточка задачи: тип слева, статус справа, номер крупно, подпись, прогресс.
function TaskCard({
  href,
  kind,
  status,
  title,
  sub,
  done,
  total,
  problem,
}: {
  href: string;
  kind: string;
  status: React.ReactNode;
  title: string;
  sub: string;
  done?: number;
  total?: number;
  problem?: boolean;
}) {
  const showProgress = total !== undefined && total > 0;
  const pct = showProgress ? Math.round(((done ?? 0) / total) * 100) : 0;
  return (
    <Link
      href={href}
      className={
        "block rounded-xl px-3.5 py-3 shadow-[0_2px_8px_rgba(20,20,60,0.06)] active:bg-neutral-50 " +
        (problem ? "border border-amber-200 bg-amber-50" : "bg-white")
      }
    >
      <div className="flex items-center justify-between gap-3">
        <span
          className={
            "text-[11px] font-bold uppercase tracking-wider " +
            (problem ? "text-amber-600" : "text-neutral-400")
          }
        >
          {kind}
        </span>
        <span className="shrink-0">{status}</span>
      </div>
      <div className="mt-1 text-base font-bold leading-tight text-[#1a1a1a]">{title}</div>
      <div className="mt-0.5 truncate text-sm text-neutral-500">{sub}</div>
      {showProgress && (
        <div className="mt-2">
          <div className="text-xs text-neutral-500">
            {done ?? 0} из {total} позиций
          </div>
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[#eef0f8]">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[#667eea] to-[#764ba2]"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}
    </Link>
  );
}

export default async function ActivePage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const session = await requireStaffPage();
  const s = scoped(session);
  const isAdmin = hasRole(session, "ADMIN");
  const access = await warehouseAccess(session);
  const sp = await searchParams;
  const typ: FilterValue = (FILTERS.some((f) => f.value === sp.type)
    ? sp.type
    : "all") as FilterValue;

  const orders = await prisma.supplierOrder.findMany({
    where: { companyId: s.companyId, status: "ORDERED", ...whereWh(access) },
    include: { supplier: true, lines: true },
    orderBy: { orderedAt: "desc" },
    take: 100,
  });
  const warehouses = await allowedWarehouses(session, s.companyId);
  const whById = new Map(warehouses.map((w) => [w.id, w.name]));

  const pickLists = await prisma.pickList.findMany({
    where: {
      companyId: s.companyId,
      status: { in: ["NEW", "PICKING", "PICKED", "STAGED"] },
      ...whereWh(access),
    },
    include: {
      _count: { select: { lines: true } },
      lines: { select: { qtyPicked: true, qtyRequested: true, cellId: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const employees = await s.users();
  const allWh = await prisma.warehouse.findMany({ where: { companyId: s.companyId } });
  const anyWhById = new Map(allWh.map((w) => [w.id, w.name]));
  const empById = new Map(employees.map((u) => [u.id, u.name]));
  const PICK_STATUS: Record<string, { label: string; tone: "blue" | "orange" }> = {
    NEW: { label: "к сборке", tone: "orange" },
    PICKING: { label: "в сборке", tone: "blue" },
    PICKED: { label: "собрана", tone: "blue" },
  };

  const docTitle = (p: (typeof pickLists)[number]) =>
    p.targetWarehouseId ? `Перемещение №${p.number}` : `Заявка №${p.number}`;
  const docSub = (p: (typeof pickLists)[number]) =>
    p.targetWarehouseId
      ? `${(p.warehouseId && anyWhById.get(p.warehouseId)) ?? "—"} → ${anyWhById.get(p.targetWarehouseId) ?? "—"}`
      : `Для: ${(p.targetEmployeeId && empById.get(p.targetEmployeeId)) ?? "—"} · ${(p.warehouseId && anyWhById.get(p.warehouseId)) ?? "—"}`;

  // черновик = не сохранён админом (или пустой): в рабочую очередь не попадает
  const isDraft = (p: (typeof pickLists)[number]) =>
    p.status === "NEW" && (!p.savedAt || p._count.lines === 0);
  const drafts = pickLists.filter(isDraft);
  const collecting = pickLists.filter(
    (p) => p.status !== "STAGED" && p._count.lines > 0 && !isDraft(p),
  );
  const staged = pickLists.filter((p) => p.status === "STAGED" && p._count.lines > 0);

  // проблемные состояния (админ): позиции без ячейки хранения, зависшие подтверждения
  const noCellDocs = isAdmin
    ? collecting.filter((p) => p.lines.some((l) => !l.cellId))
    : [];
  const pendingIssues = isAdmin
    ? await prisma.issue.findMany({
        where: { companyId: s.companyId, status: "PENDING" },
        orderBy: { issuedAt: "asc" },
        take: 20,
      })
    : [];
  const attentionCount = drafts.length + noCellDocs.length + pendingIssues.length;

  const counts: Record<FilterValue, number> = {
    all: orders.length + collecting.length + staged.length,
    receipt: orders.length,
    pick: collecting.length,
    issue: staged.length,
    draft: drafts.length,
  };

  const show = (v: FilterValue) => typ === "all" || typ === v;

  return (
    <PageShell
      title="Активные"
      description="Задачи склада, требующие действия: приёмка, сборка, выдача."
    >
      {/* Быстрые фильтры */}
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {FILTERS.filter((f) => !("adminOnly" in f && f.adminOnly) || isAdmin).map((f) => {
          const active = typ === f.value;
          return (
            <Link
              key={f.value}
              href={f.value === "all" ? "/warehouse/active" : `/warehouse/active?type=${f.value}`}
              className={clsx(
                "shrink-0 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-sm font-semibold transition",
                active
                  ? "border-[#1a1a1a] bg-[#1a1a1a] text-white"
                  : "border-[#e4e4f0] bg-white text-[#555] active:bg-neutral-100",
              )}
            >
              {f.label}
              {counts[f.value] > 0 && (
                <span className={clsx("ml-1.5 text-xs", active ? "text-white/70" : "text-neutral-400")}>
                  {counts[f.value]}
                </span>
              )}
            </Link>
          );
        })}
      </div>

      {/* Требуют внимания — только админ, не смешивается с очередью кладовщика */}
      {isAdmin && typ === "all" && attentionCount > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-amber-600">Требуют внимания</h2>
          {drafts.map((p) => (
            <TaskCard
              key={p.id}
              href={`/warehouse/picklists/${p.id}`}
              kind="Проблема"
              problem
              status={
                <Badge tone="orange">
                  {p._count.lines === 0 ? "без позиций" : "не сохранена"}
                </Badge>
              }
              title={
                p._count.lines === 0
                  ? `${docTitle(p)} без позиций`
                  : `${docTitle(p)} — черновик не сохранён`
              }
              sub={
                p._count.lines === 0
                  ? "Добавьте позиции или удалите документ"
                  : "Сохраните документ — кладовщики его ещё не видят"
              }
            />
          ))}
          {noCellDocs.map((p) => (
            <TaskCard
              key={`nc-${p.id}`}
              href={`/warehouse/active/pick/${p.id}`}
              kind="Проблема"
              problem
              status={<Badge tone="orange">нет ячейки</Badge>}
              title={`${docTitle(p)}: позиция без ячейки хранения`}
              sub="У части позиций не указана ячейка — проверьте остатки"
            />
          ))}
          {pendingIssues.map((i) => (
            <TaskCard
              key={`pi-${i.id}`}
              href={`/warehouse/issues/${i.id}`}
              kind="Проблема"
              problem
              status={<Badge tone="orange">ждёт подтверждения</Badge>}
              title={`Выдача №${i.number} не подтверждена`}
              sub={`${empById.get(i.employeeId) ?? "Сотрудник"} ещё не подтвердил получение (${fmtDate(i.issuedAt)})`}
            />
          ))}
        </div>
      )}

      {show("receipt") &&
        (orders.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h2 className="mt-2 text-sm font-semibold text-neutral-500">Приёмка заказов</h2>
            {orders.map((o) => {
              const total = o.lines.length;
              const done = o.lines.filter((l) => l.receivedQty.gte(l.qty)).length;
              const started = o.lines.some((l) => l.receivedQty.gt(0));
              return (
                <TaskCard
                  key={o.id}
                  href={`/warehouse/receipts/${o.id}`}
                  kind="Приёмка"
                  status={
                    <Badge tone={started ? "orange" : "blue"}>
                      {started ? "частично принят" : "ожидает"}
                    </Badge>
                  }
                  title={`Заказ №${o.number}`}
                  sub={`${o.supplier.name} · ${whById.get(o.warehouseId) ?? "—"} · ${fmtDate(o.createdAt)}`}
                  done={done}
                  total={total}
                />
              );
            })}
          </div>
        ) : (
          typ === "receipt" && (
            <EmptyState title="Приёмок нет">Все заказы поставщиков приняты.</EmptyState>
          )
        ))}

      {show("pick") &&
        (collecting.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h2 className="mt-2 text-sm font-semibold text-neutral-500">Сборка заявок</h2>
            {collecting.map((p) => {
              const done = p.lines.filter((l) => l.qtyPicked.gte(l.qtyRequested)).length;
              const st = PICK_STATUS[p.status] ?? PICK_STATUS.NEW;
              return (
                <TaskCard
                  key={p.id}
                  href={`/warehouse/active/pick/${p.id}`}
                  kind="Сборка"
                  status={<Badge tone={st.tone}>{st.label}</Badge>}
                  title={docTitle(p)}
                  sub={docSub(p)}
                  done={done}
                  total={p._count.lines}
                />
              );
            })}
          </div>
        ) : (
          typ === "pick" && (
            <EmptyState title="Сборок нет">Нет заявок и перемещений, ожидающих сборки.</EmptyState>
          )
        ))}

      {show("issue") &&
        (staged.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h2 className="mt-2 text-sm font-semibold text-neutral-500">Выдача заявок</h2>
            {staged.map((p) => (
              <TaskCard
                key={p.id}
                href={`/warehouse/active/pick/${p.id}`}
                kind="Выдача"
                status={<Badge tone="green">в зоне выдачи</Badge>}
                title={docTitle(p)}
                sub={docSub(p)}
                done={p._count.lines}
                total={p._count.lines}
              />
            ))}
          </div>
        ) : (
          typ === "issue" && (
            <EmptyState title="Выдач нет">В зоне выдачи ничего не ждёт.</EmptyState>
          )
        ))}

      {typ === "draft" &&
        isAdmin &&
        (drafts.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h2 className="mt-2 text-sm font-semibold text-neutral-500">
              Черновики — требуют заполнения
            </h2>
            {drafts.map((p) => (
              <TaskCard
                key={p.id}
                href={`/warehouse/picklists/${p.id}`}
                kind="Черновик"
                status={
                  <Badge tone="neutral">
                    {p._count.lines === 0 ? "без позиций" : "не сохранена"}
                  </Badge>
                }
                title={docTitle(p)}
                sub={docSub(p)}
              />
            ))}
          </div>
        ) : (
          <EmptyState title="Черновиков нет">Все документы заполнены.</EmptyState>
        ))}

      {typ === "all" && counts.all === 0 && attentionCount === 0 && (
        <EmptyState title="Активных задач нет">Все складские задачи закрыты.</EmptyState>
      )}
    </PageShell>
  );
}
