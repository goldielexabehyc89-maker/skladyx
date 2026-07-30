import "server-only";

// Онлайн-обновления (SSE): внутрипроцессная шина событий «что-то изменилось».
// Сервер шлёт клиентам только факт изменения (тип/сущность/склады) — данные
// клиент перечитывает сам через router.refresh(). Держим шину в globalThis,
// чтобы пережить HMR в dev; в prod процесс один (next start), этого достаточно.
//
// ОГРАНИЧЕНИЕ АРХИТЕКТУРЫ: шина живёт в памяти одного Node-процесса. Пока app
// разворачивается одним контейнером (docker compose, next start) — этого хватает.
// При 2+ репликах app события перестанут доходить между процессами: тогда шину
// нужно вынести в Redis pub/sub или Postgres LISTEN/NOTIFY, сохранив этот же
// интерфейс subscribeRealtime/broadcastRealtime.

export type RealtimeEntity =
  | "order"
  | "receipt"
  | "picklist"
  | "transfer"
  | "issue"
  | "writeoff"
  | "inventory"
  | "stock"
  | "cell"
  | "item"
  | "warehouse"
  | "employee"
  | "task"
  | "attention";

export interface RealtimeEvent {
  type: string; // document.created | document.updated | document.deleted | stock.updated | …
  entity: RealtimeEntity;
  entityId?: string;
  companyId: string;
  // склады, которых касается изменение; пусто/нет — событие общее для компании
  warehouseIds?: string[];
  // адресаты-сотрудники (EMPLOYEE получает только события со своим id)
  userIds?: string[];
  actorUserId?: string;
  createdAt: string;
}

type Listener = (ev: RealtimeEvent) => void;

interface Bus {
  listeners: Set<Listener>;
}

const globalBus = globalThis as unknown as { __realtimeBus?: Bus };
function bus(): Bus {
  globalBus.__realtimeBus ??= { listeners: new Set() };
  return globalBus.__realtimeBus;
}

export function subscribeRealtime(listener: Listener): () => void {
  bus().listeners.add(listener);
  return () => bus().listeners.delete(listener);
}

// Вызывать ПОСЛЕ успешного коммита транзакции. Ошибки слушателей не должны
// ломать основной сценарий.
export function broadcastRealtime(
  ev: Omit<RealtimeEvent, "createdAt"> & { createdAt?: string },
): void {
  const full: RealtimeEvent = { createdAt: new Date().toISOString(), ...ev };
  for (const l of bus().listeners) {
    try {
      l(full);
    } catch {
      // слушатель умер — соединение закроется само
    }
  }
}
