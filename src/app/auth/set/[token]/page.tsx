import { validateToken } from "@/lib/password-reset";
import { prisma } from "@/lib/db";
import { Card } from "@/components/ui";
import { SetPasswordForm } from "@/components/set-password-form";

export default async function SetPasswordPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const t = await validateToken(token);
  const user = t ? await prisma.user.findUnique({ where: { id: t.userId } }) : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-bold">Установка пароля</h1>
        {user && <p className="mt-1 text-sm text-neutral-500">{user.phone ?? user.email}</p>}
      </div>
      <Card>
        {t && user ? (
          <SetPasswordForm token={token} />
        ) : (
          <p className="text-sm text-red-600">
            Ссылка недействительна или устарела. Запросите новую у администратора.
          </p>
        )}
      </Card>
    </main>
  );
}
