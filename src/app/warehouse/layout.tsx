import { redirect } from "next/navigation";
import { navRole, effectiveRoles, workflowTasksEnabled } from "@/lib/roles";
import { currentSession } from "@/lib/tenant-auth";
import { AppNav } from "@/components/app-nav";
import { AppRealtimeProvider } from "@/components/app-realtime";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // S3: свежая проверка (host==company, isActive, роли). null — нет сессии/mismatch/блокировка.
  const session = await currentSession();
  if (!session) redirect("/login");

  // На десктопе сайдбар фиксирован, контент прокручивается в <main> — тогда
  // закреплённый (sticky) заголовок страниц-списков прилипает надёжно.
  return (
    <div className="min-h-screen lg:flex lg:h-screen lg:overflow-hidden">
      <AppNav
        role={navRole(session)}
        roles={effectiveRoles(session)}
        name={session.name}
        tasksEnabled={workflowTasksEnabled()}
      />
      <main className="min-w-0 flex-1 px-4 pb-32 pt-4 lg:overflow-y-auto lg:px-8 lg:py-6">
        <div className="mx-auto w-full max-w-6xl">{children}</div>
      </main>
      <AppRealtimeProvider />
    </div>
  );
}
