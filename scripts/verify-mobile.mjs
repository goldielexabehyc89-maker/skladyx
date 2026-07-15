// Проверка мобильной вёрстки через headless Chrome (CDP, без зависимостей):
// на 390×844 — body.scrollWidth === innerWidth === 390 и ноль видимых <table>,
// на 1440×900 — desktop-таблицы видны. При переполнении печатает элементы-виновники.
//
// Требует: dev-сервер на localhost:3000 с заполненной базой (после verify-http.mjs)
// и Google Chrome. Запуск: VERIFY_PASSWORD=<пароль> node scripts/verify-mobile.mjs
/* eslint-disable no-console */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.VERIFY_BASE || "http://localhost:3000";
const EMAIL = process.env.VERIFY_EMAIL || "goldielexabehyc89@gmail.com";
const PASSWORD = process.env.VERIFY_PASSWORD;
const CDP_PORT = Number(process.env.CDP_PORT || 9224);
const CHROME =
  process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

if (!PASSWORD) {
  console.error("Задайте VERIFY_PASSWORD");
  process.exit(1);
}

let cookie = "";
function updateCookie(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    if (pair.startsWith("skx_session=")) cookie = pair;
  }
}
async function get(path) {
  const res = await fetch(BASE + path, { headers: { cookie }, redirect: "manual" });
  updateCookie(res);
  return res;
}
function parseForms(html) {
  const forms = [];
  for (const m of html.match(/<form[\s\S]*?<\/form>/g) ?? []) {
    const fields = {};
    for (const inp of m.match(/<input[^>]*>/g) ?? []) {
      const name = /name="([^"]*)"/.exec(inp)?.[1];
      if (!name) continue;
      fields[name] = (/value="([^"]*)"/.exec(inp)?.[1] ?? "")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&");
    }
    forms.push({ fields, html: m });
  }
  return forms;
}
async function submitForm(path, form, values) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form.fields)) fd.set(k, v);
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { cookie },
    body: fd,
    redirect: "manual",
  });
  updateCookie(res);
  return res;
}

// ---- CDP мини-клиент на встроенном WebSocket (Node 22+) ----
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) events.push(msg);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const waitEvent = (method, timeoutMs = 20000) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        const i = events.findIndex((e) => e.method === method);
        if (i >= 0) {
          clearInterval(timer);
          resolve(events.splice(i, 1)[0]);
        } else if (Date.now() - t0 > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`timeout waiting ${method}`));
        }
      }, 50);
    });
  const opened = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error(`не удалось подключиться к ${wsUrl}`));
  });
  return { ws, send, waitEvent, opened };
}

let failures = 0;
function ok(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

async function main() {
  // 1) логин и сбор реальных id документов
  const loginHtml = await (await get("/login")).text();
  const loginForm = parseForms(loginHtml).find((f) => "login" in f.fields);
  if (!loginForm) throw new Error("форма логина не найдена");
  await submitForm("/login", loginForm, { login: EMAIL, password: PASSWORD });
  if (!cookie) throw new Error("логин не удался");

  const ordersHtml = await (await get("/warehouse/orders")).text();
  const orderIds = [...ordersHtml.matchAll(/href="\/warehouse\/orders\/(?!new")([a-z0-9]+)"/g)].map(
    (m) => m[1],
  );
  // редактируемый черновик (со строкой добавления) — самый склонный к переполнению
  let draftId = "";
  for (const oid of orderIds) {
    const h = await (await get(`/warehouse/orders/${oid}`)).text();
    if (h.includes("add-line")) {
      draftId = oid;
      break;
    }
  }
  const plHtml = await (await get("/warehouse/picklists")).text();
  const pickId = /href="\/warehouse\/picklists\/(?!new")([a-z0-9]+)"/.exec(plHtml)?.[1];

  // 2) headless Chrome
  const profile = mkdtempSync(join(tmpdir(), "bld-chrome-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--disable-extensions",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const cleanup = () => {
    try {
      chrome.kill();
    } catch {}
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  };
  process.on("exit", cleanup);

  let version = null;
  for (let i = 0; i < 30 && !version; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!version) throw new Error("Chrome CDP не поднялся");

  const browser = connect(version.webSocketDebuggerUrl);
  await browser.opened;
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = connect(targets.find((t) => t.id === targetId)?.webSocketDebuggerUrl);
  await page.opened;
  await page.send("Page.enable");
  await page.send("Network.setCookie", {
    name: "skx_session",
    value: cookie.split("=").slice(1).join("="),
    url: BASE,
  });

  // ждём полной загрузки нужной страницы опросом readyState (события Page.load
  // могут теряться/дублироваться при длинной серии навигаций)
  async function waitLoaded(path, timeoutMs = 25000) {
    const t0 = Date.now();
    for (;;) {
      try {
        const { result } = await page.send("Runtime.evaluate", {
          expression: `document.readyState === "complete" && location.pathname === ${JSON.stringify(path)}`,
          returnByValue: true,
        });
        if (result.value === true) return;
      } catch {}
      if (Date.now() - t0 > timeoutMs) throw new Error(`timeout loading ${path}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async function measure(path, width, height, mobile) {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: mobile ? 2 : 1,
      mobile,
    });
    await page.send("Page.navigate", { url: BASE + path });
    await waitLoaded(path);
    await new Promise((r) => setTimeout(r, 500));
    const { result } = await page.send("Runtime.evaluate", {
      expression: `JSON.stringify((() => {
        const culprits = [...document.querySelectorAll("*")]
          .filter(el => el.getBoundingClientRect().right > window.innerWidth + 1 && el.offsetParent !== null)
          .slice(0, 5)
          .map(el => el.tagName + "." + String(el.className).split(" ").slice(0, 4).join(".") +
            " right=" + Math.round(el.getBoundingClientRect().right));
        return {
          scrollW: document.body.scrollWidth,
          docW: document.documentElement.scrollWidth,
          innerW: window.innerWidth,
          visibleTables: [...document.querySelectorAll("table")].filter(t => t.offsetParent !== null).length,
          culprits,
        };
      })())`,
      returnByValue: true,
    });
    return JSON.parse(result.value);
  }

  const NEW_PAGES = [
    ["/warehouse/items/new", "Новый товар"],
    ["/warehouse/warehouses/new", "Новый склад"],
    ["/warehouse/employees/new", "Новый сотрудник"],
    ["/warehouse/suppliers/new", "Новый поставщик"],
    ["/warehouse/orders/new", "Новый заказ"],
    ["/warehouse/picklists/new", "Новая заявка"],
    ["/warehouse/transfers/new", "Новое перемещение"],
    ["/warehouse/writeoffs/new", "Новое списание"],
    ["/warehouse/inventories/new", "Новая инвентаризация"],
  ];

  const mobilePages = [
    ["/warehouse/active", "Активные"],
    ["/warehouse/orders", "Журнал заказов"],
    orderIds[0] ? [`/warehouse/orders/${orderIds[0]}`, "Заказ (детали)"] : null,
    draftId && draftId !== orderIds[0]
      ? [`/warehouse/orders/${draftId}`, "Заказ (черновик, редактирование)"]
      : null,
    ["/warehouse/picklists", "Журнал заявок"],
    pickId ? [`/warehouse/picklists/${pickId}`, "Заявка (детали)"] : null,
    ["/warehouse/transfers", "Перемещения"],
    ["/warehouse/receipts", "Приёмки"],
    ["/warehouse/issues", "Выдачи"],
    ["/warehouse/stock", "Остатки"],
    ["/warehouse/history", "История"],
    ["/warehouse/items", "Номенклатура"],
    ...NEW_PAGES,
  ].filter(Boolean);

  console.log("Мобильная вёрстка 390×844:");
  for (const [path, label] of mobilePages) {
    const m = await measure(path, 390, 844, true);
    ok(
      `${label}: scrollWidth === innerWidth === 390`,
      m.scrollW === 390 && m.docW === 390 && m.innerW === 390,
      `body=${m.scrollW} doc=${m.docW} inner=${m.innerW}${m.culprits.length ? " | " + m.culprits.join(" | ") : ""}`,
    );
    ok(`${label}: видимых таблиц 0`, m.visibleTables === 0, `видимых=${m.visibleTables}`);
  }

  console.log("Десктоп 1440×900:");
  for (const [path, label] of [
    orderIds[0] ? [`/warehouse/orders/${orderIds[0]}`, "Заказ (детали)"] : null,
    pickId ? [`/warehouse/picklists/${pickId}`, "Заявка (детали)"] : null,
    ["/warehouse/orders", "Журнал заказов"],
    ["/warehouse/items", "Номенклатура"],
  ].filter(Boolean)) {
    const m = await measure(path, 1440, 900, false);
    ok(`${label}: таблица видна на десктопе`, m.visibleTables >= 1, `видимых=${m.visibleTables}`);
    ok(`${label}: без переполнения на десктопе`, m.docW <= 1440, `doc=${m.docW}`);
  }

  console.log("Формы создания, 1440×900: шапка и карточка одной ширины и края:");
  for (const [path, label] of NEW_PAGES) {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.send("Page.navigate", { url: BASE + path });
    await waitLoaded(path);
    await new Promise((r) => setTimeout(r, 400));
    const { result } = await page.send("Runtime.evaluate", {
      expression: `JSON.stringify((() => {
        const h1 = document.querySelector("h1");
        const header = h1 && h1.closest("div");
        if (!header) return { error: "нет шапки" };
        const card = [...header.parentElement.children].find(
          (el) => el !== header && el.matches("div.rounded-xl"),
        );
        if (!card) return { error: "нет карточки" };
        const hr = header.getBoundingClientRect();
        const cr = card.getBoundingClientRect();
        return {
          dLeft: Math.abs(hr.left - cr.left),
          dWidth: Math.abs(hr.width - cr.width),
          headerW: Math.round(hr.width),
        };
      })())`,
      returnByValue: true,
    });
    const m = JSON.parse(result.value);
    if (m.error) {
      ok(`${label}: шапка и карточка найдены`, false, m.error);
      continue;
    }
    ok(
      `${label}: края и ширина совпадают (шапка ${m.headerW}px)`,
      m.dLeft <= 4 && m.dWidth <= 4,
      `dLeft=${Math.round(m.dLeft)} dWidth=${Math.round(m.dWidth)}`,
    );
  }

  page.ws.close();
  browser.ws.close();
  cleanup();
  console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ ✓" : `\nПРОВАЛОВ: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
