import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { PageTitle } from "@/components/ui";
import { PushSubscribeButton } from "@/components/push-subscribe-button";

const LINKS: { href: string; title: string }[] = [
  { href: "/warehouse/items", title: "Номенклатура" },
  { href: "/warehouse/suppliers", title: "Поставщики" },
  { href: "/warehouse/warehouses", title: "Склады и ячейки" },
  { href: "/warehouse/employees", title: "Сотрудники и бейджи" },
  { href: "/warehouse/my", title: "Мои ТМЦ" },
  { href: "/warehouse/feed", title: "Лента событий" },
  { href: "/warehouse/settings", title: "Настройки" },
];

export default async function MorePage() {
  await requireAdminPage();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <PageTitle>Ещё</PageTitle>
      <div className="flex flex-col gap-2">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="rounded-2xl bg-white p-4 font-semibold shadow-[0_2px_8px_rgba(20,20,60,0.06)] active:bg-neutral-50"
          >
            {l.title}
          </Link>
        ))}
      </div>
      <div className="flex justify-center">
        <PushSubscribeButton />
      </div>
    </div>
  );
}
