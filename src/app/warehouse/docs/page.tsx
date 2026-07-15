import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { PageTitle, Badge } from "@/components/ui";

// Хаб документов: все виды складских документов с количеством незавершённых.
export default async function DocsPage() {
  const session = await requireAdminPage();
  const s = scoped(session);

  const [activeOrders, draftOrders, draftTransfers, draftWriteOffs, activePicks, staged, pendingIssues, activeInv] =
    await Promise.all([
      prisma.supplierOrder.count({ where: { companyId: s.companyId, status: "ORDERED" } }),
      prisma.supplierOrder.count({ where: { companyId: s.companyId, status: "DRAFT" } }),
      prisma.transfer.count({ where: { companyId: s.companyId, status: "DRAFT" } }),
      prisma.writeOff.count({ where: { companyId: s.companyId, status: "DRAFT" } }),
      prisma.pickList.count({
        where: { companyId: s.companyId, status: { in: ["NEW", "PICKING", "PICKED"] } },
      }),
      prisma.pickList.count({ where: { companyId: s.companyId, status: "STAGED" } }),
      prisma.issue.count({ where: { companyId: s.companyId, status: "PENDING" } }),
      prisma.inventory.count({
        where: { companyId: s.companyId, status: { in: ["IN_PROGRESS", "REVIEW"] } },
      }),
    ]);

  const sections: { href: string; title: string; desc: string; count: number }[] = [
    { href: "/warehouse/active", title: "Активные", desc: "к приёмке", count: activeOrders },
    { href: "/warehouse/orders", title: "Заказы поставщикам", desc: "черновиков", count: draftOrders },
    { href: "/warehouse/receipts", title: "Приемка", desc: "", count: 0 },
    { href: "/warehouse/picklists", title: "Заявки на сбор", desc: "в работе", count: activePicks },
    { href: "/warehouse/staging", title: "Зона выдачи", desc: "ждут выдачи", count: staged },
    { href: "/warehouse/issues", title: "Выдачи", desc: "ждут подтверждения", count: pendingIssues },
    { href: "/warehouse/transfers", title: "Перемещения", desc: "черновиков", count: draftTransfers },
    { href: "/warehouse/writeoffs", title: "Списания", desc: "черновиков", count: draftWriteOffs },
    { href: "/warehouse/inventories", title: "Инвентаризации", desc: "активных", count: activeInv },
  ];

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <PageTitle>Документы</PageTitle>
      <div className="flex flex-col gap-2">
        {sections.map((sec) => (
          <Link
            key={sec.href}
            href={sec.href}
            className="flex items-center justify-between rounded-2xl bg-white p-4 shadow-[0_2px_8px_rgba(20,20,60,0.06)] active:bg-neutral-50"
          >
            <span className="font-semibold">{sec.title}</span>
            {sec.count > 0 && (
              <Badge tone="orange">
                {sec.count} {sec.desc}
              </Badge>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
