import { requireUser } from "@/lib/auth";
import { PageTitle } from "@/components/ui";
import { ScanScreen } from "./scan-screen";

export default async function ScanPage() {
  const session = await requireUser();

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      <PageTitle>Сканирование</PageTitle>
      <ScanScreen isAdmin={session.role === "ADMIN"} />
    </div>
  );
}
