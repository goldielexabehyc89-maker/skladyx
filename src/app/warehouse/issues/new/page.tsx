import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { getSettings } from "@/lib/settings";
import { PageTitle, EmptyState, LinkButton } from "@/components/ui";
import { DirectIssueScreen } from "./direct-issue-screen";

export default async function NewIssuePage() {
  const session = await requireAdminPage();
  const s = scoped(session);
  const settings = await getSettings(s.companyId);
  const employees = (await s.users()).filter((u) => u.isActive);

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      <PageTitle>Прямая выдача</PageTitle>
      {!settings.directIssueEnabled ? (
        <>
          <EmptyState>
            Прямая выдача отключена в настройках компании. Используйте заявки на сбор или включите
            её в настройках.
          </EmptyState>
          <LinkButton href="/warehouse/settings">Открыть настройки</LinkButton>
        </>
      ) : (
        <DirectIssueScreen employees={employees.map((u) => ({ id: u.id, name: u.name }))} />
      )}
    </div>
  );
}
