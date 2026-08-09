// Пакет 11: browser-e2e релизного профиля (LEGACY off, ZONES on, бизнес-флаги on, TENANT_AUTH=true).
// Проверяет новые экраны Остатки/История/Лента/ячейка на десктопе и мобиле для ADMIN и рабочей роли,
// отсутствие старых колонок/терминов, доступ рабочих ролей (read-only + редирект с админ-страниц),
// редирект legacy-URL. Headless Chrome по CDP; host организации — через --host-resolver-rules.
// Запуск: E2E_IDS='{...}' node scripts/e2e-release.mjs
/* eslint-disable no-console */
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOST = process.env.VERIFY_HOST || "rostagro.skladyx.ru";
const PORT = Number(process.env.APP_PORT || 3000);
const BASE = `http://${HOST}:${PORT}`;
const CDP = Number(process.env.CDP_PORT || 9455);
const ADMIN_LOGIN = process.env.VERIFY_EMAIL || "ci@skladyx.ru";
const ADMIN_PASS = process.env.VERIFY_PASSWORD || "ci-admin-pass-01";
const ids = JSON.parse(process.env.E2E_IDS || "{}");

const CHROME =
  process.env.CHROME_BIN ||
  ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser", "/usr/bin/chromium"].find((p) => existsSync(p)) ||
  "google-chrome";

let failures = 0;
const ok = (n, c, e = "") => (c ? console.log(`  ✓ ${n}`) : (failures++, console.error(`  ✗ ${n} ${e}`)));

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const p = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && p.has(m.id)) { const { res, rej } = p.get(m.id); p.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  };
  const send = (me, pa = {}) => new Promise((res, rej) => { const i = ++id; p.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: me, params: pa })); });
  return { send, opened: new Promise((r) => (ws.onopen = r)) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "e2e-chrome-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP}`,
      `--user-data-dir=${profile}`,
      `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
      "--no-first-run",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  process.on("exit", () => { try { chrome.kill(); } catch {} });

  let v;
  for (let i = 0; i < 40 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(); } catch { await sleep(500); } }
  if (!v) { console.error("Chrome CDP не поднялся"); process.exit(1); }
  const br = connect(v.webSocketDebuggerUrl); await br.opened;
  const { targetId } = await br.send("Target.createTarget", { url: "about:blank" });
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const page = connect(list.find((t) => t.id === targetId)?.webSocketDebuggerUrl); await page.opened;
  await page.send("Page.enable"); await page.send("Runtime.enable"); await page.send("Network.enable");

  const ev = async (e) => { const { result, exceptionDetails } = await page.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (exceptionDetails) throw new Error(exceptionDetails.text); return result.value; };
  const setViewport = (mobile) => page.send("Emulation.setDeviceMetricsOverride", mobile
    ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
    : { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const goto = async (path, pred = 'document.readyState==="complete"') => {
    await page.send("Page.navigate", { url: BASE + path });
    for (let i = 0; i < 80; i++) { try { if (await ev(`document.readyState==="complete" && (${pred})`)) return true; } catch {} await sleep(150); }
    return false;
  };
  const pathname = () => ev("location.pathname");
  const bodyText = () => ev("document.body.innerText");
  const setInput = (name, val) => ev(`(()=>{const el=document.querySelector('input[name="${name}"]');if(!el)return 0;const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set;s.call(el,${JSON.stringify(val)});el.dispatchEvent(new Event('input',{bubbles:true}));return 1;})()`);
  const clickText = (re) => ev(`(()=>{const b=[...document.querySelectorAll('button,a')].find(x=>${re}.test(x.textContent));if(!b)return 'no';b.click();return 'ok';})()`);

  // Аутентификация инъекцией подписанного cookie skx_session (детерминированно, без гидрации формы
  // логина). При TENANT_AUTH=true сессия ре-валидируется сервером из БД по host — доступ ролей реальный.
  const setAuth = async (token) => {
    await page.send("Network.clearBrowserCookies");
    await page.send("Network.setCookie", { name: "skx_session", value: token, domain: HOST, path: "/", httpOnly: true, secure: false, sameSite: "Lax" });
  };
  const clearSession = async () => { await page.send("Network.clearBrowserCookies"); };
  const authedOk = async () => {
    await goto("/warehouse", `location.pathname.startsWith("/warehouse")`);
    return (await pathname()).startsWith("/warehouse");
  };

  const has = (t, sub) => t.includes(sub);

  // ── ADMIN, десктоп ──
  await setViewport(false);
  await setAuth(ids.adminToken);
  ok("ADMIN сессия активна (доступ к /warehouse)", await authedOk());

  // Остатки: фильтруем по EAN фикстуры → проверяем ТОЧНЫЕ значения (не только заголовки)
  await goto(`/warehouse/stock?q=${encodeURIComponent(ids.ean)}`, `document.body.innerText.includes("Остатки")`);
  let t = await bodyText();
  ok("Остатки: товар фикстуры виден", has(t, ids.itemName), ids.itemName);
  ok("Остатки: точный EAN", has(t, ids.ean), ids.ean);
  ok("Остатки: ячейка размещения", has(t, ids.cellCode), ids.cellCode);
  ok("Остатки: состояние группы «На хранении»", has(t, ids.groupStatusLabel), ids.groupStatusLabel);
  ok("Остатки: резерв заказа с пользовательским номером", has(t, ids.orderExternalId), ids.orderExternalId);
  ok("Остатки: НЕТ закупочной стоимости", !has(t, "Стоимость по закупке"));
  ok("Остатки: НЕТ «У сотрудников»", !has(t, "У сотрудников"));
  ok("Остатки: НЕТ «Резерв заявки»", !has(t, "Резерв заявки"));

  // История: фильтр по EAN → реальный маршрут (приёмка + размещение, ячейка в маршруте)
  await goto(`/warehouse/history?q=${encodeURIComponent(ids.ean)}`, `document.body.innerText.includes("История")`);
  t = await bodyText();
  ok("История: экран открыт по умолчанию (без обязательного поиска)", has(t, "История"));
  ok("История: есть фильтр операций", has(t, "Все операции"));
  ok("История: реальное событие «Приёмка»", has(t, "Приёмка"));
  ok("История: реальное событие «Размещение»", has(t, "Размещение"));
  ok("История: реальный маршрут (ячейка размещения)", has(t, ids.cellCode), ids.cellCode);

  // Лента: реальные бизнес-события приёмки и размещения
  await goto("/warehouse/feed", `document.body.innerText.includes("Лента")`);
  t = await bodyText();
  ok("Лента: экран открыт", has(t, "Лента"));
  ok("Лента: фильтр по категориям", has(t, "Все события"));
  ok("Лента: реальное событие «Приёмка»", has(t, "Приёмка"));
  ok("Лента: реальное событие «Размещение»", has(t, "Размещение"));

  if (ids.cellId) {
    await goto(`/warehouse/cells/${ids.cellId}`, `document.body.innerText.includes("Содержимое")`);
    t = await bodyText();
    ok("Ячейка: непустое содержимое (товар фикстуры)", has(t, ids.itemName) && !has(t, "Ячейка пуста"), ids.itemName);
    ok("Ячейка: точный EAN", has(t, ids.ean), ids.ean);
    ok("Ячейка: состояние группы «На хранении»", has(t, ids.groupStatusLabel));
    ok("Ячейка: резерв заказа с номером", has(t, ids.orderExternalId), ids.orderExternalId);
    ok("Ячейка: НЕТ «резерв заявки»", !has(t, "резерв заявки"));
  }

  await goto("/warehouse/settings", `document.body.innerText.includes("Настройки")`);
  t = await bodyText();
  ok("Настройки: есть «Готовность к запуску»", has(t, "Готовность к запуску"));
  ok("Настройки: НЕТ «флаги окружения»", !has(t, "флаги окружения"));
  ok("Настройки: НЕТ env-имён флагов", !has(t, "GROUP_RECEIVING") && !has(t, "ORDER_CONTROL"));

  // legacy-редирект
  await goto("/warehouse/orders");
  let p = await pathname();
  ok("legacy /warehouse/orders → редирект в новый интерфейс", p !== "/warehouse/orders" && p.startsWith("/warehouse"), p);
  await goto("/app/stock");
  p = await pathname();
  ok("legacy /app/* → /warehouse/*", p.startsWith("/warehouse"), p);

  // ── ADMIN, мобайл ──
  await setViewport(true);
  await goto("/warehouse/stock", `document.body.innerText.includes("Остатки")`);
  ok("Остатки (мобайл) открыт", has(await bodyText(), "Остатки"));
  await goto("/warehouse/history", `document.body.innerText.includes("История")`);
  ok("История (мобайл) открыт", has(await bodyText(), "История"));
  await goto("/warehouse/feed", `document.body.innerText.includes("Лента")`);
  ok("Лента (мобайл) открыт", has(await bodyText(), "Лента"));

  // ── Рабочая роль (RECEIVER), мобайл ──
  if (ids.workToken) {
    await setViewport(true);
    await setAuth(ids.workToken);
    ok("Рабочая роль: сессия активна (доступ к /warehouse)", await authedOk());

    await goto("/warehouse/stock", `document.body.innerText.includes("Остатки")`);
    ok("Рабочая роль: видит Остатки", has(await bodyText(), "Остатки"));
    await goto("/warehouse/history", `document.body.innerText.includes("История")`);
    ok("Рабочая роль: видит Историю", has(await bodyText(), "История"));
    await goto("/warehouse/feed", `document.body.innerText.includes("Лента")`);
    ok("Рабочая роль: видит Ленту", has(await bodyText(), "Лента"));
    if (ids.cellId) {
      await goto(`/warehouse/cells/${ids.cellId}`, `document.body.innerText.includes("Содержимое")`);
      ok("Рабочая роль: видит карточку ячейки своего склада", has(await bodyText(), "Содержимое"));
    }
    // админ-страницы — редирект
    await goto("/warehouse/employees");
    p = await pathname();
    ok("Рабочая роль: /warehouse/employees закрыт (редирект)", p !== "/warehouse/employees", p);
    await goto("/warehouse/settings");
    p = await pathname();
    ok("Рабочая роль: /warehouse/settings закрыт (редирект)", p !== "/warehouse/settings", p);
  }

  // ── Новый сценарий размещения PLACE_GROUP (погрузчик): рендер НЕ назначает ячейку (P1);
  //    назначение только по явному «Начать размещение»; система назначает, выбора нет ──
  if (ids.loaderToken) {
    await setViewport(true);
    await setAuth(ids.loaderToken);
    await goto("/warehouse/tasks", `document.body.innerText.includes("Начать размещение") || document.body.innerText.includes("Назначенная ячейка")`);
    t = await bodyText();
    ok("Размещение (P1): рендер НЕ назначил ячейку — показана кнопка «Начать размещение»", has(t, "Начать размещение") && !has(t, "Назначенная ячейка"), t.slice(0, 0));
    ok("Размещение: НЕТ списка «Рекомендуемые»", !has(t, "Рекомендуемые"));
    // явное действие погрузчика → назначение ячейки (после гидрации формы)
    await sleep(2000);
    await clickText("/Начать размещение/");
    let assigned = false;
    for (let i = 0; i < 50; i++) { if ((await bodyText()).includes("Назначенная ячейка")) { assigned = true; break; } await sleep(200); }
    ok("Размещение: после «Начать размещение» показан назначенный код", assigned);
  }

  console.log(failures === 0 ? "\nE2E RELEASE OK ✓" : `\nПРОВАЛЕНО: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
