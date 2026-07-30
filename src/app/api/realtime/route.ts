import { getSession } from "@/lib/session";
import { hasRole } from "@/lib/roles";
import { warehouseAccess } from "@/lib/warehouse-access";
import { subscribeRealtime, type RealtimeEvent } from "@/lib/realtime";

// SSE-поток онлайн-обновлений для авторизованной части /warehouse.
// Клиент получает только факт изменения (тип/сущность/склады) и сам
// перечитывает данные; фильтрация — по компании, роли и доступным складам.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_MS = 20_000;

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return new Response("unauthorized", { status: 401 });
  const access = await warehouseAccess(session);

  // видно ли событие этому пользователю (по effective roles, приоритет ADMIN > STOREKEEPER > EMPLOYEE)
  function visible(ev: RealtimeEvent): boolean {
    if (ev.companyId !== session!.companyId) return false;
    if (hasRole(session!, "ADMIN")) return true;
    if (hasRole(session!, "STOREKEEPER")) {
      // кладовщик: события без складов — общие; со складами — только доступные.
      // STOREKEEPER + EMPLOYEE не должен попасть в employee-ветку — эта проверка выше.
      if (!ev.warehouseIds || ev.warehouseIds.length === 0) return true;
      if (access.all) return true;
      return ev.warehouseIds.some((id) => access.ids.includes(id));
    }
    // только сотрудник — только адресованные ему события (его выдачи/ТМЦ)
    return !!ev.userIds?.includes(session!.userId);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };

      // рекомендация браузеру по паузе reconnect + первое событие-приветствие
      write(`retry: 3000\n\n`);
      write(`data: {"type":"hello","createdAt":"${new Date().toISOString()}"}\n\n`);

      const unsubscribe = subscribeRealtime((ev) => {
        if (!visible(ev)) return;
        // не выдаём клиенту чужие поля (userIds/companyId не нужны на клиенте)
        const payload = {
          type: ev.type,
          entity: ev.entity,
          entityId: ev.entityId,
          warehouseIds: ev.warehouseIds,
          actorUserId: ev.actorUserId,
          createdAt: ev.createdAt,
        };
        write(`data: ${JSON.stringify(payload)}\n\n`);
      });

      const heartbeat = setInterval(() => write(`: ping\n\n`), HEARTBEAT_MS);

      function cleanup() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {}
      }

      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // отключаем буферизацию у реверс-прокси
      "X-Accel-Buffering": "no",
    },
  });
}
