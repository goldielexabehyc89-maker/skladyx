import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { Card } from "@/components/ui";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await getSession();
  if (session) redirect("/warehouse");
  const { next } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-bold">Склад</h1>
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
