// Проверка Этапа 5/Пакет 10 — нейтральный API интеграции (HTTP + прямой prisma для setup/проверок).
// Требует запущенный сервер с INTEGRATION_API_ENABLED=true и INTEGRATION_API_TOKEN, совпадающим с
// переменной окружения этого скрипта. Организация определяется по host (VERIFY_HOST).
// Запуск: VERIFY_BASE=http://localhost:3000 INTEGRATION_API_TOKEN=... \
//   npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-integration-api.ts
/* eslint-disable no-console */
import { PrismaClient } from "@prisma/client";
import http from "node:http";
import { applyLotMovement } from "@/lib/stock";

const prisma = new PrismaClient();
const BASE = process.env.VERIFY_BASE || "http://localhost:3000";
const TOKEN = process.env.INTEGRATION_API_TOKEN || "";
const HOST = process.env.VERIFY_HOST || "rostagro.skladyx.ru";
const SLUG = process.env.SEED_COMPANY_SLUG || "rostagro";

let failures = 0;
const ok = (n: string, c: boolean, e = "") => (c ? console.log(`  ✓ ${n}`) : (failures++, console.error(`  ✗ ${n} ${e}`)));

const ean13 = (b: string) => {
  let s = 0;
  for (let i = 0; i < 12; i++) s += Number(b[i]) * (i % 2 === 0 ? 1 : 3);
  return b + String((10 - (s % 10)) % 10);
};

interface Resp { status: number; json: unknown }
// Низкоуровневый node:http — fetch/undici молча игнорирует заголовок Host (forbidden header),
// а организация определяется именно по Host. Через http.request Host передаётся явно.
function request(path: string, method: string, opts: { body?: unknown; token?: string | null; host?: string } = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE);
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { host: opts.host ?? HOST };
    const token = opts.token === undefined ? TOKEN : opts.token;
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (data !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(data));
    }
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path, method, headers }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let json: unknown = null;
        try { json = buf ? JSON.parse(buf) : null; } catch { /* нет тела */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}
const post = (path: string, body: unknown, opts: { token?: string | null; host?: string } = {}): Promise<Resp> =>
  request(path, "POST", { body, ...opts });
const raw = async (path: string, method: string): Promise<number> => (await request(path, method)).status;

// Уникальные для теста коды
const P = "IT10-";
const EAN_A = ean13("460000100001");
const EAN_B = ean13("460000100002");
const EAN_C = ean13("460000100003");
const EAN_UNKNOWN = ean13("460000100099");
const EAN_BAD = "4600001000015"; // неверная контрольная цифра
const EAN_CONC = ean13("460000100077"); // для конкурентного upsert
// ORDER-002: автопланирование заказа после импорта — товары с реальным остатком.
const EAN_STK1 = ean13("460000100111"); // полное покрытие
const EAN_STK2 = ean13("460000100112"); // частичное → дозаполнение
const EAN_STK3 = ean13("460000100113"); // без остатка
const EAN_STK4 = ean13("460000100114"); // параллельные запросы
// Вторая реальная тестовая организация (для проверки привязки токена к slug).
const SLUG2 = process.env.INTEGRATION_TEST_SLUG2 || "acme10test";
const FOREIGN_HOST = HOST.replace(SLUG, SLUG2); // тот же контур (префикс сохраняется), другой slug

// SAFE-режим (staging): НЕ трогаем существующие склады (в т.ч. «Тестовый») — используем единственный
// активный как есть, не создаём/не выключаем его, пропускаем деструктивную под-проверку «0 складов».
const SAFE = process.env.INTEGRATION_E2E_SAFE === "1";
let companyId = "";
let WT = ""; // рабочий склад теста
let deactivated: string[] = []; // склады, которые мы временно выключили (только не-SAFE)

async function setup() {
  companyId = (await prisma.company.findFirstOrThrow({ where: { slug: SLUG } })).id;
  if (SAFE) {
    const active = await prisma.warehouse.findMany({ where: { companyId, isActive: true }, select: { id: true } });
    if (active.length !== 1) throw new Error(`SAFE-режим требует ровно один активный склад, найдено ${active.length}`);
    WT = active[0].id; // используем существующий (напр. «Тестовый») без изменений
    return;
  }
  // Обычный режим (эфемерная CI-БД): выключаем существующие, создаём ровно один тестовый.
  const active = await prisma.warehouse.findMany({ where: { companyId, isActive: true }, select: { id: true } });
  deactivated = active.map((w) => w.id);
  if (deactivated.length) await prisma.warehouse.updateMany({ where: { id: { in: deactivated } }, data: { isActive: false } });
  WT = (await prisma.warehouse.create({ data: { companyId, name: `${P}WH`, isActive: true } })).id;
}

// Вторая реальная тестовая организация — для проверки привязки токена к slug (создаётся и в SAFE).
async function ensureCompany2(): Promise<string> {
  const c = await prisma.company.upsert({ where: { slug: SLUG2 }, update: {}, create: { name: `${P}Org2`, slug: SLUG2, settings: {} } });
  return c.id;
}
async function dropCompany2() {
  const c = await prisma.company.findUnique({ where: { slug: SLUG2 } });
  if (!c) return;
  const items = await prisma.item.findMany({ where: { companyId: c.id }, select: { id: true } });
  const ids = items.map((i) => i.id);
  if (ids.length) {
    await prisma.itemBarcode.deleteMany({ where: { itemId: { in: ids } } });
    await prisma.item.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.uom.deleteMany({ where: { companyId: c.id } });
  await prisma.company.delete({ where: { id: c.id } });
}

async function cleanup() {
  // заказы теста
  const orders = await prisma.externalOrder.findMany({ where: { companyId, externalId: { startsWith: P } }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);
  if (orderIds.length) {
    await prisma.externalOrderLine.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.qrCode.deleteMany({ where: { type: "ORDER", refId: { in: orderIds } } });
    await prisma.externalOrder.deleteMany({ where: { id: { in: orderIds } } });
  }
  // товары теста (source API, externalId с префиксом)
  const items = await prisma.item.findMany({ where: { companyId, externalId: { startsWith: P } }, select: { id: true } });
  const itemIds = items.map((i) => i.id);
  // ORDER-002: посеянный остаток в WT (эфемерная CI-БД). Чистим в FK-порядке (дети → родители),
  // best-effort — остаточная FK-ошибка не должна ронять прогон на выбрасываемой БД.
  if (!SAFE && WT) {
    try {
      const cells = await prisma.cell.findMany({ where: { warehouseId: WT }, select: { id: true } });
      const cellIds = cells.map((c) => c.id);
      if (cellIds.length) {
        await prisma.stockMovement.deleteMany({ where: { OR: [{ fromCellId: { in: cellIds } }, { toCellId: { in: cellIds } }] } });
        await prisma.stockBalance.deleteMany({ where: { cellId: { in: cellIds } } });
      }
      await prisma.cellReservation.deleteMany({ where: { warehouseId: WT } });
      await prisma.workflowTask.deleteMany({ where: { warehouseId: WT } }); // каскадит deps/handoffs
      await prisma.handlingGroup.deleteMany({ where: { warehouseId: WT } });
      if (itemIds.length) await prisma.lot.deleteMany({ where: { itemId: { in: itemIds } } });
      const receipts = await prisma.receipt.findMany({ where: { warehouseId: WT }, select: { id: true } });
      const rids = receipts.map((r) => r.id);
      if (rids.length) { await prisma.receiptLine.deleteMany({ where: { receiptId: { in: rids } } }); await prisma.receipt.deleteMany({ where: { id: { in: rids } } }); }
      await prisma.cell.deleteMany({ where: { warehouseId: WT } });
      await prisma.warehouseZone.deleteMany({ where: { warehouseId: WT } });
    } catch (e) { console.warn("  (очистка остатка WT best-effort):", (e as Error).message); }
  }
  if (itemIds.length) {
    await prisma.itemBarcode.deleteMany({ where: { itemId: { in: itemIds } } });
    await prisma.item.deleteMany({ where: { id: { in: itemIds } } });
  }
  // тестовые склады + восстановление ранее активных
  await prisma.warehouse.deleteMany({ where: { companyId, name: { startsWith: P } } });
  if (deactivated.length) await prisma.warehouse.updateMany({ where: { id: { in: deactivated } }, data: { isActive: true } });
  await dropCompany2();
}

async function main() {
  await setup();

  console.log("1) авторизация");
  ok("без токена → 401", (await post("/api/integration/v1/items", { items: [] }, { token: null })).status === 401);
  ok("неверный токен → 401", (await post("/api/integration/v1/items", { items: [] }, { token: "wrong" })).status === 401);

  console.log("3) создание API-товара");
  {
    const r = await post("/api/integration/v1/items", { items: [{ externalId: `${P}A`, name: "Товар A", ean: EAN_A, sku: `${P}SKU-A` }] });
    ok("создан (200, created=1)", r.status === 200 && (r.json as { created?: number })?.created === 1, JSON.stringify(r.json));
    const item = await prisma.item.findFirst({ where: { companyId, externalId: `${P}A` }, include: { uom: true, barcodes: true } });
    ok("item source=API, tracking=LOT, uom=шт, EAN активен source=API",
      !!item && item.source === "API" && item.tracking === "LOT" && item.uom.name === "шт" &&
      item.barcodes.length === 1 && item.barcodes[0].code === EAN_A && item.barcodes[0].source === "API" && item.barcodes[0].isActive);
  }

  console.log("4) точный повтор — без дубля");
  {
    const r = await post("/api/integration/v1/items", { items: [{ externalId: `${P}A`, name: "Товар A", ean: EAN_A, sku: `${P}SKU-A` }] });
    ok("повтор 200", r.status === 200);
    const items = await prisma.item.count({ where: { companyId, externalId: `${P}A` } });
    const bcs = await prisma.itemBarcode.count({ where: { companyId, code: EAN_A } });
    ok("нет дубля item и EAN", items === 1 && bcs === 1, `items=${items} bcs=${bcs}`);
  }

  console.log("4b) новый EAN тому же товару добавляется");
  {
    const r = await post("/api/integration/v1/items", { items: [{ externalId: `${P}A`, name: "Товар A", ean: EAN_C }] });
    ok("200", r.status === 200);
    const item = await prisma.item.findFirstOrThrow({ where: { companyId, externalId: `${P}A` }, include: { barcodes: true } });
    ok("у товара два EAN", item.barcodes.length === 2 && item.barcodes.some((b) => b.code === EAN_C));
  }

  console.log("5) коллизия EAN — перепривязка запрещена (409)");
  {
    const before = await prisma.item.count({ where: { companyId, externalId: `${P}B` } });
    const r = await post("/api/integration/v1/items", { items: [{ externalId: `${P}B`, name: "Товар B", ean: EAN_A }] });
    ok("409", r.status === 409, JSON.stringify(r.json));
    const after = await prisma.item.count({ where: { companyId, externalId: `${P}B` } });
    ok("товар B не создан (откат)", before === 0 && after === 0);
  }

  console.log("6) пакетный rollback (одна ошибка откатывает весь запрос)");
  {
    const r = await post("/api/integration/v1/items", { items: [
      { externalId: `${P}OK`, name: "Ок", ean: EAN_B },
      { externalId: `${P}BAD`, name: "Плохой EAN", ean: EAN_BAD },
    ] });
    ok("400", r.status === 400, JSON.stringify(r.json));
    const okItem = await prisma.item.count({ where: { companyId, externalId: `${P}OK` } });
    const bcB = await prisma.itemBarcode.count({ where: { companyId, code: EAN_B } });
    ok("валидный товар из пакета НЕ создан (атомарность)", okItem === 0 && bcB === 0, `okItem=${okItem} bcB=${bcB}`);
  }

  console.log("7) удаление через API невозможно");
  ok("DELETE /items → 405", (await raw("/api/integration/v1/items", "DELETE")) === 405);
  ok("DELETE /orders → 405", (await raw("/api/integration/v1/orders", "DELETE")) === 405);

  console.log("8) импорт заказа по EAN");
  {
    const r = await post("/api/integration/v1/orders", { externalId: `${P}ORD1`, arrivalAt: "2026-08-10T09:00:00Z", lines: [{ externalLineId: "L1", ean: EAN_A, quantity: 5 }] });
    ok("создан (201, created=true)", r.status === 201 && (r.json as { created?: boolean })?.created === true, JSON.stringify(r.json));
    const order = await prisma.externalOrder.findFirst({ where: { companyId, externalId: `${P}ORD1` }, include: { lines: true } });
    ok("заказ IMPORTED, createdById=null, одна строка qty=5", !!order && order.status === "IMPORTED" && order.createdById === null && order.lines.length === 1 && order.lines[0].requiredQty.toNumber() === 5);
  }

  console.log("9) точный повтор заказа — идемпотентно");
  {
    const r = await post("/api/integration/v1/orders", { externalId: `${P}ORD1`, arrivalAt: "2026-08-10T09:00:00Z", lines: [{ externalLineId: "L1", ean: EAN_A, quantity: 5 }] });
    ok("200, created=false", r.status === 200 && (r.json as { created?: boolean })?.created === false, JSON.stringify(r.json));
    ok("ровно один заказ", (await prisma.externalOrder.count({ where: { companyId, externalId: `${P}ORD1` } })) === 1);
  }

  console.log("10) изменённый payload заказа → 409 без частичной записи");
  {
    const r = await post("/api/integration/v1/orders", { externalId: `${P}ORD1`, arrivalAt: "2026-08-10T09:00:00Z", lines: [{ externalLineId: "L1", ean: EAN_A, quantity: 6 }] });
    ok("409", r.status === 409, JSON.stringify(r.json));
    const line = await prisma.externalOrderLine.findFirst({ where: { order: { companyId, externalId: `${P}ORD1` }, externalLineId: "L1" } });
    ok("количество не изменилось (5)", !!line && line.requiredQty.toNumber() === 5);
  }

  console.log("11) неизвестный EAN строки → отказ");
  {
    const r = await post("/api/integration/v1/orders", { externalId: `${P}ORD2`, lines: [{ externalLineId: "L1", ean: EAN_UNKNOWN, quantity: 1 }] });
    ok("400", r.status === 400, JSON.stringify(r.json));
    ok("заказ не создан", (await prisma.externalOrder.count({ where: { companyId, externalId: `${P}ORD2` } })) === 0);
  }

  console.log("12) >1 активных складов → отказ конфигурации" + (SAFE ? " (SAFE: под-проверку «0 складов» пропускаем — не трогаем единственный склад)" : ""));
  {
    const WT2 = (await prisma.warehouse.create({ data: { companyId, name: `${P}WH2`, isActive: true } })).id;
    const r2 = await post("/api/integration/v1/orders", { externalId: `${P}ORD3`, lines: [{ externalLineId: "L1", ean: EAN_A, quantity: 1 }] });
    ok("два активных склада → 409", r2.status === 409, JSON.stringify(r2.json));
    await prisma.warehouse.update({ where: { id: WT2 }, data: { isActive: false } });
    if (!SAFE) {
      // деактивируем единственный оставшийся склад — только в эфемерной CI-БД
      await prisma.warehouse.update({ where: { id: WT }, data: { isActive: false } });
      const r0 = await post("/api/integration/v1/orders", { externalId: `${P}ORD3`, lines: [{ externalLineId: "L1", ean: EAN_A, quantity: 1 }] });
      ok("ноль активных складов → 409", r0.status === 409, JSON.stringify(r0.json));
      await prisma.warehouse.update({ where: { id: WT }, data: { isActive: true } });
    }
    ok("заказ ORD3 не создан", (await prisma.externalOrder.count({ where: { companyId, externalId: `${P}ORD3` } })) === 0);
    await prisma.warehouse.deleteMany({ where: { id: WT2 } });
  }

  console.log("13) tenant-изоляция по host");
  {
    const foreignBefore = await prisma.item.count({ where: { externalId: `${P}FOREIGN` } });
    const r = await post("/api/integration/v1/items", { items: [{ externalId: `${P}FOREIGN`, name: "Чужой", ean: ean13("460000100055") }] }, { host: "acme.skladyx.ru" });
    ok("неизвестный host → 404", r.status === 404, JSON.stringify(r.json));
    const foreignAfter = await prisma.item.count({ where: { externalId: `${P}FOREIGN` } });
    ok("ничего не записано ни в одну организацию", foreignBefore === 0 && foreignAfter === 0);
  }

  console.log("14) привязка токена к организации: верный токен + host ДРУГОЙ реальной организации → отказ");
  {
    const c2 = await ensureCompany2();
    const before = await prisma.item.count({ where: { companyId: c2 } });
    const r = await post("/api/integration/v1/items", { items: [{ externalId: `${P}X2`, name: "Чужая орг", ean: ean13("460000100088") }] }, { host: FOREIGN_HOST });
    ok("host другой организации (slug ≠ INTEGRATION_API_ORG_SLUG) → 404", r.status === 404, JSON.stringify(r.json));
    const after = await prisma.item.count({ where: { companyId: c2 } });
    ok("во второй организации данные НЕ созданы", before === 0 && after === 0);
  }

  console.log("15) некорректный arrivalAt → 400 без создания заказа (без 500)");
  {
    const r = await post("/api/integration/v1/orders", { externalId: `${P}ORDBAD`, arrivalAt: "не-дата", lines: [{ externalLineId: "L1", ean: EAN_A, quantity: 1 }] });
    ok("400", r.status === 400, JSON.stringify(r.json));
    ok("заказ не создан", (await prisma.externalOrder.count({ where: { companyId, externalId: `${P}ORDBAD` } })) === 0);
  }

  console.log("16) конкурентный upsert одинаковых товаров → один Item/EAN, без 409/500");
  {
    const body = { items: [{ externalId: `${P}CONC`, name: "Конкурент", ean: EAN_CONC }] };
    const [r1, r2] = await Promise.all([
      post("/api/integration/v1/items", body),
      post("/api/integration/v1/items", body),
    ]);
    ok("оба ответа 200", r1.status === 200 && r2.status === 200, `r1=${r1.status} r2=${r2.status}`);
    ok("нет 409/500", ![r1.status, r2.status].some((s) => s === 409 || s >= 500));
    ok("ровно один Item", (await prisma.item.count({ where: { companyId, externalId: `${P}CONC` } })) === 1);
    ok("ровно один ItemBarcode", (await prisma.itemBarcode.count({ where: { companyId, code: EAN_CONC } })) === 1);
  }

  // ── ORDER-002: заказ из API автоматически резервируется/планируется (без ручного администратора) ──
  // Требует посева остатка в единственный активный склад WT (эфемерная CI-БД). В SAFE (staging) — пропуск,
  // чтобы не трогать данные владельца; логика планирования дополнительно покрыта verify-external-orders.
  if (SAFE) {
    console.log("17) автопланирование заказа после импорта — ПРОПУСК в SAFE (не сеем остаток на staging)");
  } else {
    console.log("17) автопланирование заказа после импорта (ORDER-002)");
    const anyUser = await prisma.user.findFirstOrThrow({ where: { companyId } });
    let zone = await prisma.warehouseZone.findFirst({ where: { companyId, warehouseId: WT, kind: "STORAGE" } });
    if (!zone) zone = await prisma.warehouseZone.create({ data: { companyId, warehouseId: WT, kind: "STORAGE", code: "STORAGE", name: "Хранение", sortOrder: 20 } });
    let recSeq = 770000;
    // Реальный остаток: партия + движение приёмки в STORAGE-ячейку ур.1 + группа IN_STORAGE.
    const seedStock = async (itemId: string, qty: number, cellCode: string) => {
      let cell = await prisma.cell.findFirst({ where: { companyId, warehouseId: WT, code: cellCode } });
      if (!cell) cell = await prisma.cell.create({ data: { companyId, warehouseId: WT, zoneId: zone!.id, code: cellCode, level: 1, isActive: true } });
      const receipt = await prisma.receipt.create({ data: { companyId, number: ++recSeq, warehouseId: WT, status: "POSTED", postedAt: new Date(), createdById: anyUser.id } });
      const line = await prisma.receiptLine.create({ data: { companyId, receiptId: receipt.id, itemId, qty } });
      const lot = await prisma.lot.create({ data: { companyId, itemId, receiptLineId: line.id, qtyReceived: qty } });
      await prisma.$transaction((tx) => applyLotMovement(tx, { companyId, docType: "RECEIPT", docId: receipt.id, itemId, lotId: lot.id, qty, from: null, to: { kind: "cell", warehouseId: WT, cellId: cell!.id }, createdById: anyUser.id }));
      await prisma.handlingGroup.create({ data: { companyId, warehouseId: WT, itemId, lotId: lot.id, qty, temperature: 0, thresholdX: 8, status: "IN_STORAGE", dedupeKey: `it10-grp-${lot.id}`, acceptedById: anyUser.id } });
    };
    const mkItem = async (ext: string, ean: string) =>
      (await post("/api/integration/v1/items", { items: [{ externalId: ext, name: `Товар ${ext}`, ean }] })).status;
    const orderState = async (ext: string) => {
      const o = await prisma.externalOrder.findFirstOrThrow({ where: { companyId, externalId: ext }, include: { lines: true } });
      const resv = await prisma.stockReservation.findMany({ where: { orderId: o.id, status: "ACTIVE" } });
      const picks = await prisma.workflowTask.count({ where: { companyId, type: "PICK_ORDER", subjectId: o.id } });
      const resvQty = resv.reduce((s, r) => s + r.qty.toNumber(), 0);
      return { id: o.id, status: o.status, resvCount: resv.length, resvQty, picks, reserved: o.lines.reduce((s, l) => s + l.reservedQty.toNumber(), 0) };
    };
    const movCount = () => prisma.stockMovement.count({ where: { companyId } });

    // 17a) полное покрытие (ур.1) → READY_TO_PICK + одна PICK_ORDER, точные резервы, без StockMovement от импорта
    await mkItem(`${P}STK1`, EAN_STK1);
    const it1 = await prisma.item.findFirstOrThrow({ where: { companyId, externalId: `${P}STK1` } });
    await seedStock(it1.id, 2, `${P}C1`);
    const mov0 = await movCount();
    {
      const r = await post("/api/integration/v1/orders", { externalId: `${P}OS1`, lines: [{ externalLineId: "L1", ean: EAN_STK1, quantity: 2 }] });
      ok("17a полное покрытие: 201 + status READY_TO_PICK в ответе", r.status === 201 && (r.json as { status?: string })?.status === "READY_TO_PICK", JSON.stringify(r.json));
      const st = await orderState(`${P}OS1`);
      ok("17a: заказ READY_TO_PICK, покрытие 2, ровно одна PICK_ORDER", st.status === "READY_TO_PICK" && st.reserved === 2 && st.picks === 1, JSON.stringify(st));
      ok("17a: активный резерв ровно на 2 шт (FIFO из посеянной партии)", st.resvQty === 2, JSON.stringify(st));
      ok("17a: импорт+планирование НЕ создали StockMovement", (await movCount()) === mov0, `${mov0}->${await movCount()}`);
    }
    // 17a') точный повтор → created:false, без дублей резервов/задач
    {
      const r = await post("/api/integration/v1/orders", { externalId: `${P}OS1`, lines: [{ externalLineId: "L1", ean: EAN_STK1, quantity: 2 }] });
      ok("17a' повтор: 200 created:false, status READY_TO_PICK", r.status === 200 && (r.json as { created?: boolean; status?: string })?.created === false && (r.json as { status?: string })?.status === "READY_TO_PICK", JSON.stringify(r.json));
      const st = await orderState(`${P}OS1`);
      ok("17a' идемпотентно: один резерв-комплект (2 шт), одна PICK_ORDER", st.resvQty === 2 && st.picks === 1, JSON.stringify(st));
      ok("17a' один заказ", (await prisma.externalOrder.count({ where: { companyId, externalId: `${P}OS1` } })) === 1);
    }
    // 17b) частичное покрытие → PARTIALLY_RESERVED без PICK; появился остаток → повтор дозаполняет и создаёт задачу один раз
    await mkItem(`${P}STK2`, EAN_STK2);
    const it2 = await prisma.item.findFirstOrThrow({ where: { companyId, externalId: `${P}STK2` } });
    await seedStock(it2.id, 1, `${P}C2`);
    {
      const r = await post("/api/integration/v1/orders", { externalId: `${P}OS2`, lines: [{ externalLineId: "L1", ean: EAN_STK2, quantity: 3 }] });
      ok("17b частичное: status PARTIALLY_RESERVED", r.status === 201 && (r.json as { status?: string })?.status === "PARTIALLY_RESERVED", JSON.stringify(r.json));
      const st = await orderState(`${P}OS2`);
      ok("17b: покрытие 1 из 3, PICK_ORDER не создан", st.reserved === 1 && st.picks === 0, JSON.stringify(st));
    }
    await seedStock(it2.id, 2, `${P}C2b`); // остаток появился
    {
      const r = await post("/api/integration/v1/orders", { externalId: `${P}OS2`, lines: [{ externalLineId: "L1", ean: EAN_STK2, quantity: 3 }] });
      ok("17b' повтор после появления остатка: created:false, READY_TO_PICK", r.status === 200 && (r.json as { created?: boolean; status?: string })?.created === false && (r.json as { status?: string })?.status === "READY_TO_PICK", JSON.stringify(r.json));
      const st = await orderState(`${P}OS2`);
      ok("17b' дозаполнено до 3, ровно одна PICK_ORDER", st.reserved === 3 && st.resvQty === 3 && st.picks === 1, JSON.stringify(st));
    }
    // 17c) без остатка → IMPORTED, без резервов и задач
    await mkItem(`${P}STK3`, EAN_STK3);
    {
      const r = await post("/api/integration/v1/orders", { externalId: `${P}OS3`, lines: [{ externalLineId: "L1", ean: EAN_STK3, quantity: 1 }] });
      ok("17c без остатка: 201 + status IMPORTED", r.status === 201 && (r.json as { status?: string })?.status === "IMPORTED", JSON.stringify(r.json));
      const st = await orderState(`${P}OS3`);
      ok("17c: нет резервов и PICK_ORDER", st.resvCount === 0 && st.picks === 0, JSON.stringify(st));
    }
    // 17d) два параллельных одинаковых запроса → один заказ/резервы/задача, без 409/500
    await mkItem(`${P}STK4`, EAN_STK4);
    const it4 = await prisma.item.findFirstOrThrow({ where: { companyId, externalId: `${P}STK4` } });
    await seedStock(it4.id, 1, `${P}C4`);
    {
      const body = { externalId: `${P}OS4`, lines: [{ externalLineId: "L1", ean: EAN_STK4, quantity: 1 }] };
      const [r1, r2] = await Promise.all([post("/api/integration/v1/orders", body), post("/api/integration/v1/orders", body)]);
      ok("17d параллельно: без 409/500", ![r1.status, r2.status].some((s) => s === 409 || s >= 500), `r1=${r1.status} r2=${r2.status}`);
      ok("17d: ровно один ExternalOrder", (await prisma.externalOrder.count({ where: { companyId, externalId: `${P}OS4` } })) === 1);
      const st = await orderState(`${P}OS4`);
      ok("17d: один комплект резервов (1 шт) и одна PICK_ORDER, READY_TO_PICK", st.status === "READY_TO_PICK" && st.resvQty === 1 && st.picks === 1, JSON.stringify(st));
    }
  }
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ P10 (integration API) ПРОЙДЕНЫ ✓" : `\nПРОВАЛЕНО: ${failures}`);
    process.exit(failures === 0 ? 0 : 1);
  });
