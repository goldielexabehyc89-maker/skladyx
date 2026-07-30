import { getSession } from "@/lib/session";
import { navRole } from "@/lib/roles";
import { AppNav } from "@/components/app-nav";
import { AppRealtimeProvider } from "@/components/app-realtime";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) return null; // middleware не пустит сюда без сессии

  // На десктопе сайдбар фиксирован, контент прокручивается в <main> — тогда
  // закреплённый (sticky) заголовок страниц-списков прилипает надёжно.
  return (
    <div className="min-h-screen lg:flex lg:h-screen lg:overflow-hidden">
      <AppNav role={navRole(session)} name={session.name} />
      <main className="min-w-0 flex-1 px-4 pb-32 pt-4 lg:overflow-y-auto lg:px-8 lg:py-6">
        <div className="mx-auto w-full max-w-6xl">{children}</div>
      </main>
      <AppRealtimeProvider />
    </div>
  );
}
