// Проверка Этапа 5/Пакет 10 — нейтральный API интеграции (HTTP + прямой prisma для setup/проверок).
// Требует запущенный сервер с INTEGRATION_API_ENABLED=true и INTEGRATION_API_TOKEN, совпадающим с
// переменной окружения этого скрипта. Организация определяется по host (VERIFY_HOST).
// Запуск: VERIFY_BASE=http://localhost:3000 INTEGRATION_API_TOKEN=... \
//   npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-integration-api.ts
/* eslint-disable no-console */
import { PrismaClient } from "@prisma/client";
import http from "node:http";

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
  if (itemIds.length) {
    await prisma.itemBarcode.deleteMany({ where: { itemId: { in: itemIds } } });
    await prisma.item.deleteMany({ where: { id: { in: itemIds } } });
  }
  // тестовые склады + восстановление ранее активных
  await prisma.warehouse.deleteMany({ where: { companyId, name: { startsWith: P } } });
  if (deactivated.length) await prisma.warehouse.updateMany({ where: { id: { in: deactivated } }, data: { isActive: true } });
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
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ P10 (integration API) ПРОЙДЕНЫ ✓" : `\nПРОВАЛЕНО: ${failures}`);
    process.exit(failures === 0 ? 0 : 1);
  });
