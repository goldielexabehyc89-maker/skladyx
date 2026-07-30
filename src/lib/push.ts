import "server-only";
import webpush from "web-push";
import { prisma } from "@/lib/db";
import { rolesDualReadEnabled } from "@/lib/roles";

let configured = false;
function ensureVapid(): boolean {
  if (configured) return true;
  const pub = process.env.VAPID_PUBLIC;
  const priv = process.env.VAPID_PRIVATE;
  const subj = process.env.VAPID_SUBJECT || "mailto:goldielexabehyc89@gmail.com";
  if (!pub || !priv) return false;
  webpush.setVapidDetails(subj, pub, priv);
  configured = true;
  return true;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

async function sendToSubs(
  subs: { id: string; endpoint: string; p256dh: string; auth: string }[],
  payload: PushPayload,
): Promise<{ sent: number; total: number }> {
  if (!ensureVapid()) return { sent: 0, total: 0 };
  const data = JSON.stringify(payload);

  const results = await Promise.allSettled(
    subs.map((s) =>
      webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        data,
      ),
    ),
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "rejected") {
      const code = (r.reason as { statusCode?: number })?.statusCode;
      if (code === 410 || code === 404) {
        await prisma.pushSubscription.delete({ where: { id: subs[i].id } }).catch(() => {});
      }
    }
  }

  return { sent: results.filter((r) => r.status === "fulfilled").length, total: subs.length };
}

// Пуш конкретному пользователю (все его устройства).
export async function sendPushToUser(userId: string, payload: PushPayload) {
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  return sendToSubs(subs, payload);
}

// Пуш кладовщикам склада (включая кладовщиков с доступом ко всем складам) —
// о новых задачах во вкладке «Активные».
export async function sendPushToWarehouseStorekeepers(
  companyId: string,
  warehouseId: string,
  payload: PushPayload,
) {
  // S2 dual-read: кто считается кладовщиком.
  //  flag off → legacy User.role = STOREKEEPER;
  //  flag on  → есть строка UserRole=STOREKEEPER; если строк UserRole нет вовсе — fallback на User.role.
  // Обязательные фильтры companyId/isActive/доступ к складу сохраняются в любом режиме.
  const roleFilter = rolesDualReadEnabled()
    ? {
        OR: [
          { userRoles: { some: { role: "STOREKEEPER" as const } } },
          { AND: [{ userRoles: { none: {} } }, { role: "STOREKEEPER" as const }] },
        ],
      }
    : { role: "STOREKEEPER" as const };

  const users = await prisma.user.findMany({
    where: {
      companyId,
      isActive: true,
      AND: [
        roleFilter,
        { OR: [{ allWarehouses: true }, { warehouseLinks: { some: { warehouseId } } }] },
      ],
    },
    select: { id: true },
  });
  if (users.length === 0) return { sent: 0, total: 0 };
  const subs = await prisma.pushSubscription.findMany({
    where: { userId: { in: users.map((u) => u.id) } },
  });
  return sendToSubs(subs, payload);
}

// Пуш всем подписанным устройствам компании.
export async function sendPushToCompany(companyId: string, payload: PushPayload) {
  const subs = await prisma.pushSubscription.findMany({ where: { companyId } });
  return sendToSubs(subs, payload);
}
