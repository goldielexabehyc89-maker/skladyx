import "server-only";
import { prisma } from "@/lib/db";
import { broadcastRealtime, type RealtimeEntity } from "@/lib/realtime";
import type { Prisma } from "@prisma/client";

// Журнал событий («Лента»). key — идемпотентность: событие с тем же ключом
// обновляется, а не дублируется. actorId — кто совершил действие.

export type EventType =
  | "receipt_posted"
  | "supplier_order_saved"
  | "cell_assigned"
  | "transfer_posted"
  | "writeoff_posted"
  | "picklist_created"
  | "picklist_picked"
  | "picklist_staged"
  | "issue_created"
  | "issue_confirmed"
  | "issue_cancelled"
  | "inventory_started"
  | "inventory_posted"
  | "user_created"
  | "warehouse_created"
  // удаление документов (админ)
  | "supplier_order_deleted"
  | "receipt_deleted"
  | "picklist_deleted"
  | "transfer_deleted"
  | "writeoff_deleted"
  | "inventory_deleted";

// Карта «событие журнала → realtime-сущность и действие» для онлайн-обновлений.
// stock: true — изменение затрагивает остатки, клиентам дополнительно уходит stock.updated.
const REALTIME_MAP: Record<EventType, { entity: RealtimeEntity; action: string; stock?: boolean }> = {
  receipt_posted: { entity: "receipt", action: "updated", stock: true },
  supplier_order_saved: { entity: "order", action: "updated" },
  cell_assigned: { entity: "cell", action: "updated", stock: true },
  transfer_posted: { entity: "transfer", action: "updated", stock: true },
  writeoff_posted: { entity: "writeoff", action: "updated", stock: true },
  picklist_created: { entity: "picklist", action: "created" },
  picklist_picked: { entity: "picklist", action: "updated", stock: true },
  picklist_staged: { entity: "picklist", action: "updated", stock: true },
  issue_created: { entity: "issue", action: "created", stock: true },
  issue_confirmed: { entity: "issue", action: "updated" },
  issue_cancelled: { entity: "issue", action: "updated", stock: true },
  inventory_started: { entity: "inventory", action: "created" },
  inventory_posted: { entity: "inventory", action: "updated", stock: true },
  user_created: { entity: "employee", action: "created" },
  warehouse_created: { entity: "warehouse", action: "created" },
  supplier_order_deleted: { entity: "order", action: "deleted" },
  receipt_deleted: { entity: "receipt", action: "deleted", stock: true },
  picklist_deleted: { entity: "picklist", action: "deleted", stock: true },
  transfer_deleted: { entity: "transfer", action: "deleted", stock: true },
  writeoff_deleted: { entity: "writeoff", action: "deleted", stock: true },
  inventory_deleted: { entity: "inventory", action: "deleted", stock: true },
};

export async function logEvent(args: {
  companyId: string;
  type: EventType;
  key?: string;
  title: string;
  body: string;
  url?: string;
  actorId?: string;
  meta?: Record<string, unknown>;
  // онлайн-обновления: каких складов/сотрудников касается изменение
  warehouseIds?: string[];
  userIds?: string[];
}): Promise<void> {
  const { companyId, type, key, title, body, url, actorId, meta, warehouseIds, userIds } = args;
  const metaJson = meta as Prisma.InputJsonValue | undefined;
  try {
    if (key) {
      await prisma.event.upsert({
        where: { companyId_key: { companyId, key } },
        update: { title, body, url, actorId, meta: metaJson, createdAt: new Date() },
        create: { companyId, type, key, title, body, url, actorId, meta: metaJson },
      });
    } else {
      await prisma.event.create({
        data: { companyId, type, title, body, url, actorId, meta: metaJson },
      });
    }
  } catch {
    // журнал не должен ломать основной сценарий
  }

  // онлайн-обновления открытым вкладкам (после записи, т.е. после коммита документа)
  try {
    const rt = REALTIME_MAP[type];
    // id сущности — из url события (/warehouse/<раздел>/<id>)
    const entityId = url?.split("?")[0].split("/").pop();
    broadcastRealtime({
      type: `document.${rt.action}`,
      entity: rt.entity,
      entityId,
      companyId,
      warehouseIds,
      userIds,
      actorUserId: actorId,
    });
    if (rt.stock) {
      broadcastRealtime({
        type: "stock.updated",
        entity: "stock",
        companyId,
        warehouseIds,
        actorUserId: actorId,
      });
    }
  } catch {
    // онлайн-обновления не должны ломать основной сценарий
  }
}
