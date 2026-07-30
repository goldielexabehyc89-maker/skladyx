import { redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { currentSession, resolveHostCompany } from "@/lib/tenant-auth";
import { tenantAuthEnabled } from "@/lib/roles";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await currentSession();
  if (session) redirect("/warehouse");
  const { next } = await searchParams;

  // Организация из host (для брендинга и, при TENANT_AUTH, для fail-closed на неизвестном host).
  const { company } = await resolveHostCompany();
  if (tenantAuthEnabled() && !company) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold">Организация не найдена</h1>
          <p className="mt-2 text-sm text-neutral-500">
            Проверьте адрес входа вашей организации: <code>&lt;организация&gt;.skladyx.ru</code>.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-bold">{company?.name ?? "Склад"}</h1>
        <p className="mt-1 text-sm text-neutral-500">Вход в систему складского учёта</p>
      </div>
      <Card>
        <LoginForm next={next} />
      </Card>
      <p className="mt-4 text-center text-xs text-neutral-400">
        Нет пароля? Запросите ссылку для входа у администратора.
      </p>
    </main>
  );
}
