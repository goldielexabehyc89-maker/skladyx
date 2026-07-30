import { prisma } from "@/lib/db";
import { currentSession } from "@/lib/tenant-auth";
import { effectiveRoles, tenantAuthEnabled } from "@/lib/roles";
import { sanitizeRoles, type Role } from "@/lib/jwt";
import { warehouseAccess, type WhAccess } from "@/lib/warehouse-access";
import { subscribeRealtime, type RealtimeEvent } from "@/lib/realtime";

// SSE-поток онлайн-обновлений для авторизованной части /warehouse.
// Клиент получает только факт изменения (тип/сущность/склады) и сам перечитывает данные;
// фильтрация — по компании, ролям и доступным складам.
// S3: при TENANT_AUTH открытие проходит свежую проверку (host==company, isActive, роли),
// а на каждом heartbeat заново читаются isActive/роли/склады из БД — блокировка или смена
// ролей закрывает поток / меняет фильтр не позже следующего heartbeat (без релогина).

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_MS = 20_000;

export async function GET(req: Request) {
  const session = await currentSession();
  if (!session) return new Response("unauthorized", { status: 401 });

  const tenant = tenantAuthEnabled();
  const companyId = session.companyId; // фиксирован для соединения (host не меняется)

  // Снимок авторизации; при TENANT_AUTH обновляется на heartbeat.
  let roles: Role[] = effectiveRoles(session);
  let access: WhAccess = await warehouseAccess(session);

  // видно ли событие этому пользователю (приоритет ADMIN > STOREKEEPER > EMPLOYEE)
  function visible(ev: RealtimeEvent): boolean {
    if (ev.companyId !== companyId) return false;
    if (roles.includes("ADMIN")) return true;
    if (roles.includes("STOREKEEPER")) {
      if (!ev.warehouseIds || ev.warehouseIds.length === 0) return true;
      if (access.all) return true;
      return ev.warehouseIds.some((id) => access.ids.includes(id));
    }
    // только сотрудник — только адресованные ему события
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

      write(`retry: 3000\n\n`);
      write(`data: {"type":"hello","createdAt":"${new Date().toISOString()}"}\n\n`);

      const unsubscribe = subscribeRealtime((ev) => {
        if (!visible(ev)) return;
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

      // S3: свежая перепроверка на heartbeat. host/company фиксированы за соединение,
      // поэтому здесь достаточно перечитать по (userId, companyId) — без headers().
      async function refreshAuthz(): Promise<boolean> {
        const u = await prisma.user.findFirst({
          where: { id: session!.userId, companyId },
          select: {
            isActive: true,
            role: true,
            allWarehouses: true,
            userRoles: { select: { role: true } },
            warehouseLinks: { select: { warehouseId: true } },
          },
        });
        if (!u || !u.isActive) return false; // заблокирован/удалён → закрыть поток
        roles = sanitizeRoles(u.userRoles.map((r) => r.role), u.role as Role);
        access = u.allWarehouses
          ? { all: true, ids: [] }
          : { all: false, ids: u.warehouseLinks.map((l) => l.warehouseId) };
        return true;
      }

      const heartbeat = setInterval(() => {
        if (!tenant) {
          write(`: ping\n\n`);
          return;
        }
        refreshAuthz()
          .then((okAuth) => (okAuth ? write(`: ping\n\n`) : cleanup()))
          .catch(() => cleanup());
      }, HEARTBEAT_MS);

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
      "X-Accel-Buffering": "no",
    },
  });
}
