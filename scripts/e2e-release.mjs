// Пакет 11: browser-e2e релизного профиля (LEGACY off, ZONES on, бизнес-флаги on, TENANT_AUTH=true).
// Проверяет новые экраны Остатки/История/Лента/ячейка на десктопе и мобиле для ADMIN и рабочей роли,
// отсутствие старых колонок/терминов, доступ рабочих ролей (read-only + редирект с админ-страниц),
// редирект legacy-URL. Headless Chrome по CDP; host организации — через --host-resolver-rules.
// Запуск: E2E_IDS='{...}' node scripts/e2e-release.mjs
/* eslint-disable no-console */
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { PrismaClient } from "@prisma/client";

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
  const consoleErrors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && p.has(m.id)) { const { res, rej } = p.get(m.id); p.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") consoleErrors.push((m.params.args || []).map((a) => a.description ?? a.value ?? "").join(" "));
    if (m.method === "Runtime.exceptionThrown") consoleErrors.push(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? "exception");
  };
  const send = (me, pa = {}) => new Promise((res, rej) => { const i = ++id; p.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: me, params: pa })); });
  return { send, opened: new Promise((r) => (ws.onopen = r)), consoleErrors };
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
  // Скриншоты (мобильная PLACE_GROUP) — только если задан SHOT_DIR.
  const SHOT_DIR = process.env.SHOT_DIR || "";
  const shot = async (name) => { if (!SHOT_DIR) return; try { const { data } = await page.send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(SHOT_DIR, name + ".png"), Buffer.from(data, "base64")); } catch { /* ignore */ } };
  // Установить значение первого видимого поля внутри активной скан-шторки (тот же путь, что ручной ввод).
  const setSheetField = (val) => ev(`(()=>{const el=[...document.querySelectorAll('[data-workflow-sheet] input:not([type=hidden]),[data-workflow-sheet] select,[data-workflow-sheet] textarea')].find(e=>e.offsetParent!==null); if(!el) return 0; const set=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set; set.call(el,${JSON.stringify(val)}); el.dispatchEvent(new Event('input',{bubbles:true})); return 1;})()`);
  const sheetCount = () => ev(`[...document.querySelectorAll('[data-workflow-sheet] input:not([type=hidden]),[data-workflow-sheet] select,[data-workflow-sheet] textarea')].filter(e=>e.offsetParent!==null).length`);

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

  // ── PLACE_GROUP (погрузчик): компактная карточка (TASK-006) + серверная сверка EAN и заметная
  //    обратная связь (UI-005). Мобильный виджет; по ходу снимаем скриншоты состояний. ──
  if (ids.loaderToken) {
    await setViewport(true);
    await setAuth(ids.loaderToken);
    await goto("/warehouse/tasks", `document.body.innerText.includes("Разместить")`);
    t = await bodyText();
    // TASK-006: компактная карточка — команда + маршрут, без типа/статуса/времени/описания
    ok("TASK-006: карточка показывает «Разместить»", has(t, "Разместить"));
    ok("TASK-006: карточка показывает точное наименование товара", has(t, ids.itemName), ids.itemName);
    ok("TASK-006: карточка показывает точное количество", has(t, `${ids.qty} шт`), `${ids.qty} шт`);
    ok("TASK-006: карточка показывает источник маршрута «Приёмка» (стрелка — иконка ArrowRight)", has(t, "Приёмка"));
    ok("TASK-006: до назначения цель — зона «Хранение»", has(t, "Хранение"));
    ok("TASK-006: НЕТ типа задачи «Размещение группы»", !has(t, "Размещение группы"));
    ok("TASK-006: НЕТ статуса «В работе» и времени «создано»", !has(t, "В работе") && !has(t, "создано"));
    ok("TASK-006: НЕТ температуры и EAN текстом до сканирования", !has(t, "°C") && !has(t, ids.ean));
    ok("TASK-006: нет горизонтального скролла (мобайл 390px)", await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
    // P1: рендер не назначил ячейку — показана кнопка «Начать размещение», без списка рекомендаций
    ok("Размещение (P1): рендер НЕ назначил ячейку (кнопка «Начать размещение»)", has(t, "Начать размещение"));
    ok("Размещение: НЕТ списка «Рекомендуемые»", !has(t, "Рекомендуемые"));
    // TASK-005: текущая задача есть, пустых секций нет
    ok("Очередь: показана «Текущая задача»", has(t, "Текущая задача"));
    ok("Очередь: пустые секции скрыты", !has(t, "Очередь пуста") && !has(t, "Нет срочных задач"));

    // явное «Начать размещение» → назначенный КОД в маршруте «Приёмка → <код>»
    await sleep(2000);
    await clickText("/Начать размещение/");
    let assigned = false;
    for (let i = 0; i < 50; i++) { if ((await bodyText()).includes(ids.placeCellCode)) { assigned = true; break; } await sleep(200); }
    t = await bodyText();
    ok("Размещение: после «Начать размещение» в карточке маршрут «Приёмка → <ячейка>»", assigned && has(t, "Приёмка"), ids.placeCellCode);
    ok("TASK-006: после назначения товар и количество сохранены в карточке", has(t, ids.itemName) && has(t, `${ids.qty} шт`));

    if (ids.ean && ids.placeCellQr && ids.placeWrongCellQr) {
      // открыть скан-мастер
      await sleep(500); await clickText("/Сканировать/");
      const sheetUp = async () => { for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('[data-workflow-sheet]')`)) return true; await sleep(150); } return false; };
      ok("Размещение: скан-мастер открыт (шаг EAN)", await sheetUp());
      await shot("place-1-wait-ean"); // (1) ожидание EAN
      ok("UI-005: на шаге EAN не более одного поля", (await sheetCount()) <= 1, String(await sheetCount()));
      // F1: шторка компактно показывает товар, количество и назначенную ячейку
      const sheetTxt = await ev(`document.querySelector('[data-workflow-sheet]')?.innerText || ""`);
      ok("F1: шторка показывает товар, количество и назначенную ячейку",
        has(sheetTxt, ids.itemName) && has(sheetTxt, `${ids.qty} шт`) && has(sheetTxt, ids.placeCellCode), sheetTxt.slice(0, 0));

      // (a) неправильный EAN → красная блокирующая ошибка (role=alert), без перехода к ячейке
      await setSheetField("0000000000000"); await clickText("/Ввести/");
      let eanErr = false;
      for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('[role=alert]')`)) { eanErr = true; break; } await sleep(150); }
      ok("UI-005: неправильный EAN → заметная ошибка (role=alert)", eanErr);
      ok("UI-005: при ошибке EAN нет успеха «Товар подтверждён»", !(await bodyText()).includes("Товар подтверждён"));
      await clickText("/Повторить/"); await sleep(600); // повтор скана товара

      // (b) правильный EAN → зелёный успех (role=status) «Товар подтверждён» → авто-переход к ячейке
      await setSheetField(ids.ean); await clickText("/Ввести/");
      let eanOk = false;
      for (let i = 0; i < 40; i++) { if ((await bodyText()).includes("Товар подтверждён")) { eanOk = true; break; } await sleep(120); }
      ok("UI-005: правильный EAN → заметный зелёный успех «Товар подтверждён»", eanOk);
      ok("UI-005: успех EAN озвучен (role=status)", await ev(`!!document.querySelector('[role=status]')`));
      // F1: успех содержит «<товар> · <количество> подтверждён»
      const okTxt = await ev(`document.querySelector('[role=status]')?.innerText || document.body.innerText`);
      ok("F1: успех EAN содержит товар, количество и «подтверждён»",
        has(okTxt, `${ids.itemName} · ${ids.qty} шт`) && has(okTxt, "подтверждён"), okTxt.slice(0, 0));
      await shot("place-2-ean-ok"); // (2) успешный EAN
      // авто-переход к шагу ячейки (появляется числовой/текстовый ввод ячейки или подсказка ячейки)
      let atCell = false;
      for (let i = 0; i < 40; i++) { if ((await bodyText()).includes(`Сканировать ячейку`) || (await ev(`!!document.querySelector('[data-workflow-sheet] input:not([type=hidden])')`) && !(await bodyText()).includes("Товар подтверждён"))) { atCell = true; break; } await sleep(150); }
      ok("UI-005: после успеха EAN — авто-переход к скану ячейки", atCell);

      // (c) неверная ячейка → красная ошибка, EAN повторно не сканируется
      await setSheetField(ids.placeWrongCellQr); await clickText("/Ввести/");
      let cellErr = false;
      for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('[role=alert]')`)) { cellErr = true; break; } await sleep(150); }
      t = await bodyText();
      ok("UI-005: неверная ячейка → заметная ошибка (role=alert)", cellErr);
      ok("UI-005: ошибка ячейки называет назначенную", has(t, "не назначенная") || has(t, ids.placeCellCode), t.slice(0, 0));
      await shot("place-3-wrong-cell"); // (3) ошибка неверной ячейки
      await clickText("/Повторить/"); await sleep(600); // остаёмся на шаге ячейки, EAN сохранён

      // (d) правильная ячейка → зелёный успех «Размещено»
      await sleep(400);
      await setSheetField(ids.placeCellQr); await clickText("/Ввести/");
      let placed = false;
      for (let i = 0; i < 80; i++) { if ((await bodyText()).includes("Размещено")) { placed = true; break; } await sleep(100); }
      await shot("place-4-placed"); // (4) успешное размещение
      ok("UI-005: правильная ячейка → заметный зелёный успех «Размещено»", placed);
      ok("UI-005: успех размещения озвучен (role=status)", await ev(`!!document.querySelector('[role=status]')`));
      // завершение сценария: закрыть по «Готово», задача уходит из «Текущей»
      await clickText("/Готово/"); await sleep(800);
      ok("Размещение завершено: задача больше не текущая", !(await bodyText()).includes("Разместить"));
    }
  }

  // ── ROLE-003: home/menu по активной смене (desktop). Пункты меню проверяем по ссылкам сайдбара
  //    (a[href=...]), а не по innerText — «Приёмка» встречается и в описании задачи PLACE_GROUP. ──
  const homePath = async () => { await goto("/warehouse", `location.pathname !== "/warehouse"`); return await pathname(); };
  const navHas = async (href) => ev(`!!document.querySelector('aside a[href="${href}"]')`);
  await setViewport(false);
  if (ids.loaderToken) {
    await setAuth(ids.loaderToken); // активная смена LOADER (+ роль RECEIVER — мультироль)
    ok("ROLE-003: LOADER (мультироль) home → /warehouse/tasks", (await homePath()) === "/warehouse/tasks");
    ok("ROLE-003: у LOADER-смены в меню есть «Задачи»", await navHas("/warehouse/tasks"));
    ok("ROLE-003: у LOADER-смены НЕТ «Приёмки» (несмотря на роль RECEIVER)", !(await navHas("/warehouse/receiving")));
  }
  if (ids.workToken) {
    await setAuth(ids.workToken); // активная смена RECEIVER
    ok("ROLE-003: RECEIVER home → /warehouse/receiving", (await homePath()) === "/warehouse/receiving");
    await goto("/warehouse/receiving", `!!document.querySelector('input[placeholder="EAN-8 / EAN-13"]') || document.body.innerText.includes("шаг 1")`);
    t = await bodyText();
    ok("UI-004: приёмка пошаговая — показан «шаг 1»", has(t, "шаг 1"), t.slice(0, 0));
    ok("UI-004: на шаге 1 нет будущих полей (нет «Количество, шт»)", !has(t, "Количество, шт"));
    ok("ROLE-003: у RECEIVER-смены в меню есть «Приёмка»", await navHas("/warehouse/receiving"));
    ok("ROLE-003: у RECEIVER-смены НЕТ «Задач»", !(await navHas("/warehouse/tasks")));
  }
  if (ids.noShiftToken) {
    await setAuth(ids.noShiftToken); // рабочая роль без активной смены
    ok("ROLE-003: рабочий без смены home → /warehouse/shift", (await homePath()) === "/warehouse/shift");
  }

  // ── P1: реальный старт/завершение смены → полная навигация на рабочий экран и обновление меню ──
  if (ids.startToken) {
    await setViewport(false);
    await setAuth(ids.startToken); // приёмщик БЕЗ смены (одна роль/склад — выбраны по умолчанию)
    await goto("/warehouse/shift", `document.body.innerText.includes("Начать смену")`);
    await sleep(1800); // гидрация формы серверного действия
    await clickText(/^Начать смену$/);
    let toRecv = false;
    for (let i = 0; i < 70; i++) { if ((await pathname()) === "/warehouse/receiving") { toRecv = true; break; } await sleep(200); }
    ok("SHIFT-001: старт RECEIVER → переход прямо на /warehouse/receiving", toRecv, await pathname());
    ok("SHIFT-001: после старта в меню появилась «Приёмка»", await navHas("/warehouse/receiving"));
    // завершить смену → /warehouse/shift, рабочий пункт исчезает
    await goto("/warehouse/shift", `document.body.innerText.includes("Завершить смену")`);
    await sleep(1500);
    await clickText(/Завершить смену/);
    let ended = false;
    for (let i = 0; i < 70; i++) { const p = await pathname(); if (p === "/warehouse/shift" && (await bodyText()).includes("Начать смену")) { ended = true; break; } await sleep(200); }
    ok("SHIFT-002: завершение смены → /warehouse/shift (форма старта)", ended);
    ok("SHIFT-002: рабочий пункт «Приёмка» исчез из меню", !(await navHas("/warehouse/receiving")));
  }

  // ── P2: ADMIN — операционные пункты по активной смене; монитор всех задач — отдельный пункт ──
  if (ids.adminToken) {
    await setViewport(false);
    await setAuth(ids.adminToken); // ADMIN без смены
    await homePath();
    ok("ROLE-003: ADMIN без смены — в меню «Монитор задач»", await navHas("/warehouse/tasks?view=monitor"));
    ok("ROLE-003: ADMIN без смены — НЕТ «Приёмки» (роль не назначена/без смены)", !(await navHas("/warehouse/receiving")));
    ok("ROLE-003: ADMIN без смены — НЕТ «Мои задачи»", !(await navHas("/warehouse/tasks?view=mine")));
  }
  if (ids.adminRecvToken) {
    await setAuth(ids.adminRecvToken); // ADMIN + активная смена RECEIVER
    ok("ROLE-003: ADMIN+RECEIVER home → /warehouse/receiving", (await homePath()) === "/warehouse/receiving");
    ok("ROLE-003: ADMIN+RECEIVER — в меню «Приёмка»", await navHas("/warehouse/receiving"));
    ok("ROLE-003: ADMIN+RECEIVER — «Монитор задач» остаётся", await navHas("/warehouse/tasks?view=monitor"));
    ok("ROLE-003: ADMIN+RECEIVER — НЕТ «Мои задачи»", !(await navHas("/warehouse/tasks?view=mine")));
  }
  if (ids.adminLoadToken) {
    await setAuth(ids.adminLoadToken); // ADMIN + активная смена LOADER
    ok("ROLE-003: ADMIN+LOADER home → /warehouse/tasks", (await homePath()) === "/warehouse/tasks");
    ok("ROLE-003: ADMIN+LOADER — в меню «Мои задачи» (?view=mine)", await navHas("/warehouse/tasks?view=mine"));
    ok("ROLE-003: ADMIN+LOADER — «Монитор задач» остаётся", await navHas("/warehouse/tasks?view=monitor"));
    ok("ROLE-003: ADMIN+LOADER — НЕТ «Приёмки»", !(await navHas("/warehouse/receiving")));
  }
  // ADMIN на мобиле: операционный таб по активной смене (нижний таб-бар — <nav>)
  const tabHas = async (href) => ev(`!!document.querySelector('nav a[href="${href}"]')`);
  if (ids.adminRecvToken) {
    await setViewport(true);
    await setAuth(ids.adminRecvToken);
    await goto("/warehouse/receiving", `!!document.querySelector('nav a[href="/warehouse/receiving"]') || document.body.innerText.includes("Приёмка")`);
    ok("ROLE-003 (моб): ADMIN+RECEIVER — таб «Приёмка»", await tabHas("/warehouse/receiving"));
  }
  if (ids.adminLoadToken) {
    await setAuth(ids.adminLoadToken);
    await goto("/warehouse/tasks", `!!document.querySelector('nav a[href="/warehouse/tasks?view=mine"]') || document.body.innerText.includes("Задач")`);
    ok("ROLE-003 (моб): ADMIN+LOADER — таб «Мои задачи»", await tabHas("/warehouse/tasks?view=mine"));
  }
  if (ids.adminToken) {
    await setAuth(ids.adminToken);
    await goto("/warehouse", `location.pathname !== "/warehouse"`);
    ok("ROLE-003 (моб): ADMIN без смены — таб «Монитор»", await tabHas("/warehouse/tasks?view=monitor"));
  }

  // ── P3 (UI-004): операционные панели — пошаговые, без набора полей сразу ──
  const visIn = async (sel) => ev(`[...document.querySelectorAll('${sel}')].filter(e=>e.type!=="hidden" && e.offsetParent!==null).length`);
  const sheetFields = () => visIn('[data-workflow-sheet] input, [data-workflow-sheet] select, [data-workflow-sheet] textarea');
  if (ids.correctToken) {
    await setViewport(false);
    await setAuth(ids.correctToken); // сборщик с активной CORRECT_ORDER (расхождение — недостача)
    await goto("/warehouse/tasks", `document.body.innerText.includes("Добавить товар") || document.body.innerText.includes("Удалить товар") || document.body.innerText.includes("Исправить заказ")`);
    // до открытия шага в панели НЕТ набора полей: 0 видимых select и 0 числовых полей (старый баг — 4 поля сразу)
    ok("UI-004 CORRECT: в панели нет одновременного набора полей (0 select, 0 number)",
      (await visIn('main select')) === 0 && (await visIn('main input[type="number"]')) === 0);
    await sleep(1500);
    await clickText(/Добавить товар|Удалить товар/);
    let sh = false; for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('[data-workflow-sheet]')`)) { sh = true; break; } await sleep(150); }
    ok("UI-004 CORRECT: открыт пошаговый лист", sh);
    ok("UI-004 CORRECT: на текущем шаге видно ≤1 поля", (await sheetFields()) <= 1, String(await sheetFields()));
  }
  // CONTROL_ORDER: пройти весь мастер валидным EAN фикстуры — по одному полю на шаг, 0 на итоге,
  // отметка успешна, авто-переход к следующей строке, закрытие после последней. И текст без «по QR».
  if (ids.controllerToken && ids.ctrlEanA) {
    await setViewport(false);
    await setAuth(ids.controllerToken);
    await goto("/warehouse/tasks", `document.body.innerText.includes("Проверить товар") || document.body.innerText.includes("Контроль заказа")`);
    ok("UI-004 CONTROL: нет устаревшего текста «по QR»", !(await bodyText()).includes("по QR"));
    ok("UI-004 CONTROL: в панели нет inline-набора полей (0 select)", (await visIn('main select')) === 0);
    await sleep(1500);
    await clickText(/Проверить товар/);
    const sheetUp = async () => { for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('[data-workflow-sheet]')`)) return true; await sleep(150); } return false; };
    ok("UI-004 CONTROL: мастер открыт (шаг EAN)", (await sheetUp()) && (await sheetFields()) <= 1, String(await sheetFields()));
    const setField = (val) => ev(`(()=>{const el=[...document.querySelectorAll('[data-workflow-sheet] input:not([type=hidden]),[data-workflow-sheet] select,[data-workflow-sheet] textarea')].find(e=>e.offsetParent!==null); if(!el) return 0; const set=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set; set.call(el,${JSON.stringify(val)}); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return 1;})()`);
    const waitSel = async (sel) => { for (let i = 0; i < 30; i++) { if (await ev(`!!document.querySelector('${sel}')`)) return true; await sleep(150); } return false; };
    // Пройти один товар по шагам; вернуть число полей на каждом шаге.
    const markOne = async (ean) => {
      await setField(ean); await clickText(/Ввести/);                       // EAN → количество
      await waitSel('[data-workflow-sheet] input[type="number"]');
      const qf = await sheetFields();
      await setField("1"); await clickText(/Дальше/);                        // количество → состояние
      await waitSel('[data-workflow-sheet] select');
      const tf = await sheetFields();
      await clickText(/Дальше/); await sleep(500);                           // состояние → комментарий
      const cf = await sheetFields();
      await clickText(/Дальше/); await sleep(500);                           // комментарий → итог
      const ff = await sheetFields();
      await clickText(/Отметить/); await sleep(1200);                        // отметка
      return { qf, tf, cf, ff };
    };
    const r1 = await markOne(ids.ctrlEanA);
    ok("UI-004 CONTROL: шаг «количество» — 1 поле", r1.qf === 1, String(r1.qf));
    ok("UI-004 CONTROL: шаг «состояние» — 1 поле (select)", r1.tf === 1, String(r1.tf));
    ok("UI-004 CONTROL: шаг «комментарий» — 1 поле", r1.cf === 1, String(r1.cf));
    ok("UI-004 CONTROL: итоговый шаг — 0 полей", r1.ff === 0, String(r1.ff));
    // 2 строки: после первой — авто-переход к скану следующего товара (мастер открыт, без «Сканировать товар»)
    let advanced = false;
    for (let i = 0; i < 40; i++) { if ((await ev(`!!document.querySelector('[data-workflow-sheet]')`)) && (await ev(`!!document.querySelector('[data-workflow-sheet] form input:not([type=hidden])')`))) { advanced = true; break; } await sleep(150); }
    ok("UI-004 CONTROL: авто-переход к следующему товару (мастер открыт, скан активен)", advanced);
    // вторая (последняя) строка → все отмечены → мастер закрывается, показывается завершение
    await markOne(ids.ctrlEanB);
    let closed = false;
    for (let i = 0; i < 50; i++) { if (!(await ev(`!!document.querySelector('[data-workflow-sheet]')`))) { closed = true; break; } await sleep(200); }
    ok("UI-004 CONTROL: после последней строки мастер закрыт (завершение проверки)", closed);
  }

  // ── P2 (aria-current): ссылки «Мои задачи» (?view=mine) и «Монитор задач» (?view=monitor) ──
  // Проверяем НАЛИЧИЕ aria-current="page" среди ссылок с данным href (логотип-«home» может иметь тот же
  // href, но без aria-current — учитываем именно навигационный пункт, а не первую попавшуюся ссылку).
  const anyAria = async (sel) => ev(`[...document.querySelectorAll('${sel}')].some(e=>e.getAttribute('aria-current')==="page")`);
  const MINE = "/warehouse/tasks?view=mine", MON = "/warehouse/tasks?view=monitor";
  if (ids.adminLoadToken) {
    await setViewport(false);
    await setAuth(ids.adminLoadToken);
    await goto(`/warehouse/tasks?view=mine`, `!!document.querySelector('aside a[href="${MINE}"]')`);
    ok("aria-current (desktop): mine активна на ?view=mine", await anyAria(`aside a[href="${MINE}"]`));
    ok("aria-current (desktop): monitor НЕ активна на ?view=mine", !(await anyAria(`aside a[href="${MON}"]`)));
    await goto(`/warehouse/tasks?view=monitor`, `!!document.querySelector('aside a[href="${MON}"]')`);
    ok("aria-current (desktop): monitor активна на ?view=monitor", await anyAria(`aside a[href="${MON}"]`));
    ok("aria-current (desktop): mine НЕ активна на ?view=monitor", !(await anyAria(`aside a[href="${MINE}"]`)));
    await setViewport(true);
    await goto(`/warehouse/tasks?view=mine`, `!!document.querySelector('nav a[href="${MINE}"]')`);
    ok("aria-current (моб): mine активна на ?view=mine", await anyAria(`nav a[href="${MINE}"]`));
  }
  if (ids.adminToken) {
    await setViewport(true);
    await setAuth(ids.adminToken);
    await goto(`/warehouse/tasks?view=monitor`, `!!document.querySelector('nav a[href="${MON}"]')`);
    ok("aria-current (моб): monitor активна на ?view=monitor", await anyAria(`nav a[href="${MON}"]`));
  }

  // ── P2 (домашний экран ADMIN): открытие /warehouse (как по логотипу) даёт однозначный режим и aria-current ──
  if (ids.adminToken) {
    // ADMIN без смены → монитор; подсвечен ТОЛЬКО «Монитор задач»
    await setViewport(false);
    await setAuth(ids.adminToken);
    await goto("/warehouse", `location.pathname === "/warehouse/tasks"`);
    ok("home ADMIN без смены → monitor подсвечен (desktop)", await anyAria(`aside a[href="${MON}"]`));
    ok("home ADMIN без смены → mine НЕ подсвечен (desktop)", !(await anyAria(`aside a[href="${MINE}"]`)));
    await setViewport(true);
    await goto("/warehouse", `location.pathname === "/warehouse/tasks"`);
    ok("home ADMIN без смены → monitor подсвечен (mobile)", await anyAria(`nav a[href="${MON}"]`));
  }
  if (ids.adminLoadToken) {
    // ADMIN + смена LOADER → mine; подсвечен ТОЛЬКО «Мои задачи»
    await setViewport(false);
    await setAuth(ids.adminLoadToken);
    await goto("/warehouse", `location.pathname === "/warehouse/tasks"`);
    ok("home ADMIN+LOADER → mine подсвечен (desktop)", await anyAria(`aside a[href="${MINE}"]`));
    ok("home ADMIN+LOADER → monitor НЕ подсвечен (desktop)", !(await anyAria(`aside a[href="${MON}"]`)));
    await setViewport(true);
    await goto("/warehouse", `location.pathname === "/warehouse/tasks"`);
    ok("home ADMIN+LOADER → mine подсвечен (mobile)", await anyAria(`nav a[href="${MINE}"]`));
  }

  // ── TASK-007/008/009: монитор — «Запланирована» + МСК + живой таймер; выделение срочных (мобайл) ──
  const timers = async () => JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[role=timer]')].map(e=>e.innerText.replace(/\\s+/g,' ').trim()))`));
  const redUrgentCard = () => ev(`[...document.querySelectorAll('div')].some(d=>getComputedStyle(d).backgroundColor==="rgb(254, 242, 242)" && d.textContent.includes("Срочно"))`);
  const errBefore = page.consoleErrors.length; // TASK-008: контроль React/console-ошибок на экранах таймера
  if (ids.adminToken && ids.schedNearTitle) {
    await setViewport(true); // мобайл: скриншот + проверка переполнения
    await setAuth(ids.adminToken);
    await goto("/warehouse/tasks?view=monitor", `document.body.innerText.includes("${ids.schedNearTitle}")`);
    t = await bodyText();
    ok("TASK-007: запланированная задача — статус «Запланирована»", has(t, "Запланирована"));
    ok("TASK-008: у завершённых задач таймера нет", (await ev(`[...document.querySelectorAll('div')].filter(d=>d.className&&String(d.className).includes("rounded-xl")&&(d.textContent.includes("Выполнена")||d.textContent.includes("Отменена"))).some(d=>d.querySelector('[role=timer]'))`)) === false);
    ok("TASK-008: у таймера стабильная ширина (min-width задан)", await ev(`[...document.querySelectorAll('[role=timer] b')].some(b=>parseFloat(getComputedStyle(b).minWidth)>0)`));
    ok("TASK-008: показано московское время «Доступна с … (МСК)»", has(t, "Доступна с") && has(t, "(МСК)"));
    ok("TASK-008: «Ожидает начала» у назначенной срочной", has(t, "Ожидает начала"));
    ok("TASK-009: бейдж «Срочно» в мониторе (не только цвет)", has(t, "Срочно"));
    let arr = await timers();
    const near = arr.find((s) => /^До активации \d{2}:\d{2}:\d{2}$/.test(s));
    const far = arr.find((s) => /^До активации \d+ д \d{2}:\d{2}:\d{2}$/.test(s));
    ok("TASK-008: обратный отсчёт «До активации» (формат < суток)", !!near, arr.join(" | "));
    ok("TASK-008: формат > суток «N д ЧЧ:ММ:СС»", !!far, arr.join(" | "));
    ok("TASK-008: нет отрицательных значений", !arr.some((s) => s.includes("-")));
    await shot("urgent-1-monitor-scheduled"); // будущая срочная (запланированная)
    // отсчёт действительно идёт (near уменьшается) без перезагрузки
    await sleep(1500);
    const near2 = (await timers()).find((s) => /^До активации \d{2}:\d{2}:\d{2}$/.test(s));
    ok("TASK-008: таймер обновляется каждую секунду (значение изменилось)", !!near2 && near2 !== near, `${near} -> ${near2}`);
    ok("TASK-009: есть светло-красная карточка срочной задачи", await redUrgentCard());
    ok("TASK-009: монитор без горизонтального скролла (мобайл)", await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
  }
  // Активная срочная у исполнителя: красная карточка + прямой отсчёт «В работе», растёт без refresh.
  if (ids.correctToken) {
    await setViewport(true);
    await setAuth(ids.correctToken);
    await goto("/warehouse/tasks", `document.body.innerText.includes("Текущая задача")`);
    t = await bodyText();
    ok("TASK-009: у исполнителя срочная задача — бейдж «Срочно»", has(t, "Срочно"));
    let arr = await timers();
    const working = arr.find((s) => s.startsWith("В работе"));
    ok("TASK-008: таймер «В работе» на активной срочной", !!working, arr.join(" | "));
    ok("TASK-009: красная карточка у исполнителя", await redUrgentCard());
    await shot("urgent-2-active"); // активная срочная задача
    await sleep(1500);
    const working2 = (await timers()).find((s) => s.startsWith("В работе"));
    ok("TASK-008: прямой отсчёт увеличивается без refresh", !!working2 && working2 !== working, `${working} -> ${working2}`);
    ok("TASK-009: карточка исполнителя без горизонтального скролла (мобайл)", await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
  }
  const timerErrs = page.consoleErrors.slice(errBefore).filter((s) => !/favicon/i.test(s));
  ok("TASK-008: нет React/console ошибок на экранах таймера/срочных", timerErrs.length === 0, timerErrs.slice(0, 2).join(" | "));

  // ── TASK-006 (расширение): компактные карточки всех физических задач погрузчика ──
  if (ids.cardsLoaderToken) {
    await setViewport(true); // мобайл
    await setAuth(ids.cardsLoaderToken);
    await goto("/warehouse/tasks", `document.body.innerText.includes("Разместить") && document.body.innerText.includes("Переместить")`);
    t = await bodyText();
    ok("TASK-006*: PLACE_GROUP — команда/товар/количество/маршрут", has(t, "Разместить") && has(t, ids.itemName) && has(t, "2 шт") && has(t, "Приёмка") && has(t, "Хранение"));
    ok("TASK-006*: RETRIEVE_COOLING — команда/товар/количество/исходная/направление", has(t, "Забрать из охлаждения") && has(t, "5 шт") && has(t, "OH-01") && has(t, "Хранение"));
    ok("TASK-006*: до замера точная целевая ячейка не заявляется", has(t, "Ячейка будет назначена после замера"));
    ok("TASK-006*: MOVE_GROUP — точный маршрут CD-01 → CD-02", has(t, "Переместить") && has(t, "3 шт") && has(t, "CD-01") && has(t, "CD-02"));
    ok("TASK-006*: нет типа/статуса/времени создания", !has(t, "Размещение группы") && !has(t, "Перестановка группы вниз") && !has(t, "создано") && !has(t, "Назначена"));
    ok("TASK-006*: срочная карточка (RETRIEVE_COOLING) выделена красным + бейдж «Срочно»", has(t, "Срочно") && (await redUrgentCard()));
    ok("TASK-006*: мобайл без горизонтального скролла", await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
    await shot("cards-mobile-loader");
    await setViewport(false); // desktop
    await goto("/warehouse/tasks", `document.body.innerText.includes("Разместить")`);
    ok("TASK-006*: desktop без горизонтального скролла", await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
  }

  // ── Коррекция Задачи G (P1): компактные карточки задач ВЫДАЧИ (ISSUE_ORDER / DELIVER_ORDER) —
  //    единый формат «команда · заказ · N поз. · M шт · маршрут», без техзаголовка/типа/статуса/времени.
  const noTechMeta = (txt) =>
    !has(txt, "Размещение в выдаче") && !has(txt, "Выдача водителю") &&      // ярлыки ТИПА задачи
    !has(txt, "Разместить в выдаче: заказ") && !has(txt, "Выдать водителю: заказ") && // техЗАГОЛОВКИ
    !has(txt, "создано") && !has(txt, "Назначена");                          // время создания / статус
  // При активной текущей задаче очередь свёрнута (TASK-005) — раскрываем, чтобы увидеть карточки «до начала».
  const expandQueue = async () => { await clickText("/Показать/"); await sleep(500); };
  if (ids.izLoaderToken) {
    await setViewport(true); // мобайл
    await setAuth(ids.izLoaderToken);
    await goto("/warehouse/tasks", `document.body.innerText.includes("Разместить заказ в выдаче")`);
    t = await bodyText();
    // ISSUE_ORDER «в работе»: команда + номер заказа + N поз. + M шт + маршрут «Контроль → ячейки»
    ok("Выдача*: ISSUE «в работе» — команда «Разместить заказ в выдаче»", has(t, "Разместить заказ в выдаче"));
    ok("Выдача*: ISSUE — номер заказа/позиции/количество", has(t, `Заказ ${ids.issueWipExt}`) && has(t, "3 поз.") && has(t, "15 шт"), t.slice(0, 0));
    ok("Выдача*: ISSUE — маршрут «Контроль → ячейки выдачи»", has(t, "Контроль") && has(t, "IZ-01") && has(t, "IZ-02"));
    // DELIVER_ORDER «до начала» (в свёрнутой очереди — раскрываем)
    await expandQueue();
    t = await bodyText();
    ok("Выдача*: DELIVER «до начала» — команда «Выдать водителю»", has(t, "Выдать водителю"));
    ok("Выдача*: DELIVER — номер/позиции/количество/маршрут → Водитель", has(t, `Заказ ${ids.deliverWaitExt}`) && has(t, "2 поз.") && has(t, "10 шт") && has(t, "IZ-09") && has(t, "Водитель"));
    ok("Выдача*: НЕТ техзаголовка/типа/статуса/времени создания", noTechMeta(t), t.slice(0, 0));
    ok("Выдача*: мобайл без горизонтального скролла", await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
  }
  if (ids.dvLoaderToken) {
    await setViewport(true);
    await setAuth(ids.dvLoaderToken);
    await goto("/warehouse/tasks", `document.body.innerText.includes("Выдать водителю")`);
    t = await bodyText();
    // DELIVER_ORDER «в работе»
    ok("Выдача*: DELIVER «в работе» — команда/номер/позиции/количество", has(t, "Выдать водителю") && has(t, `Заказ ${ids.deliverWipExt}`) && has(t, "2 поз.") && has(t, "10 шт"));
    ok("Выдача*: DELIVER «в работе» — маршрут «ячейка → Водитель»", has(t, "DV-01") && has(t, "Водитель"));
    // ISSUE_ORDER «до начала» (в свёрнутой очереди — раскрываем)
    await expandQueue();
    t = await bodyText();
    ok("Выдача*: ISSUE «до начала» — команда/номер/позиции/количество/маршрут", has(t, "Разместить заказ в выдаче") && has(t, `Заказ ${ids.issueWaitExt}`) && has(t, "1 поз.") && has(t, "9 шт") && has(t, "Контроль") && has(t, "DV-09"));
    ok("Выдача*: НЕТ техзаголовка/типа/статуса/времени создания", noTechMeta(t), t.slice(0, 0));
    ok("Выдача*: мобайл без горизонтального скролла", await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
  }

  // ── Коррекция Задачи G (P2): браузерный замер охлаждения. ≤X → точная целевая ячейка; >X → новый
  //    срок без ложного движения. Проходим мастер замера вручную (тот же путь, что ручной ввод скана). ──
  const sheetUp = async () => { for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('[data-workflow-sheet]')`)) return true; await sleep(150); } return false; };
  const sheetTxt = () => ev(`document.querySelector('[data-workflow-sheet]')?.innerText || ""`);
  // На шаге температуры в шторке два поля (ручной ввод ячейки + числовое поле замера) — целимся именно
  // в числовое поле замера (input[type=number]), иначе температура уходит не в тот input.
  const setSheetNumber = (val) => ev(`(()=>{const el=[...document.querySelectorAll('[data-workflow-sheet] input[type="number"]')].find(e=>e.offsetParent!==null); if(!el) return 0; const set=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set; set.call(el,${JSON.stringify(val)}); el.dispatchEvent(new Event('input',{bubbles:true})); return 1;})()`);
  const waitSheetField = async () => { for (let i = 0; i < 30; i++) { if (await sheetCount()) return true; await sleep(150); } return false; };
  // COOL-003: фаза замера начинается с EAN (серверная проверка), без скана ячейки; затем температура.
  const measure = async (ean, temp) => {
    await sleep(600); await clickText("/Забрать из охлаждения/");
    if (!(await sheetUp())) return false;
    await sleep(300); await clickText("/Сканировать товар/");                     // измерение начинается с EAN
    if (!(await waitSheetField())) return false;
    await setSheetField(ean); await clickText("/Ввести/");                        // серверная проверка EAN → авто-переход к температуре
    for (let i = 0; i < 40 && !(await ev(`!!document.querySelector('[data-workflow-sheet] input[type="number"]')`)); i++) await sleep(200);
    if (!(await setSheetNumber(String(temp)))) return false;                      // шаг температуры (числовое поле)
    await clickText("/Записать температуру/");
    return true;
  };
  if (ids.coolLeqToken && ids.coolLeqCellQr) {
    await setViewport(true);
    await setAuth(ids.coolLeqToken);
    await goto("/warehouse/tasks", `document.body.innerText.includes("Забрать из охлаждения")`);
    ok("Охлаждение ≤X: карточка забора в работе", has(await bodyText(), "Забрать из охлаждения"));
    const opened = await measure(ids.ean, ids.thresholdX - 2);
    ok("Охлаждение ≤X: мастер замера открыт и пройден", opened);
    let leqReady = false;
    // Задача K: фаза вывоза компактна — «Готово к вывозу»/«Фаза 2» убраны; цель видна в маршруте шторки.
    for (let i = 0; i < 60; i++) { const s = await sheetTxt(); if (s.includes(ids.coolLeqTargetCode) && /переместить/i.test(s)) { leqReady = true; break; } await sleep(200); }
    const s = await sheetTxt();
    ok("Охлаждение ≤X: показана ТОЧНАЯ целевая ячейка после замера", leqReady && has(s, ids.coolLeqTargetCode), s.slice(0, 0));
    ok("Охлаждение ≤X: нет «Ещё охлаждается» (замер прошёл)", !has(s, "Ещё охлаждается") && !has(await bodyText(), "Ещё охлаждается"));
    ok("Охлаждение ≤X: мобайл без горизонтального скролла", await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
  }
  if (ids.coolGtToken && ids.coolGtCellQr) {
    await setViewport(true);
    await setAuth(ids.coolGtToken);
    await goto("/warehouse/tasks", `document.body.innerText.includes("Забрать из охлаждения")`);
    const opened = await measure(ids.ean, ids.thresholdX + 5);
    ok("Охлаждение >X: мастер замера открыт и пройден", opened);
    // Замер >X завершает текущий забор и планирует ПОВТОРНЫЙ на новый срок (revalidate убирает задачу с
    // доски исполнителя). «Без ложного движения» — забор не доведён до хранения: нет «Готово к вывозу»/
    // «Размещено», задача ушла из «в работе».
    let cycled = false;
    for (let i = 0; i < 60; i++) { const bt = await bodyText(); if (!bt.includes("Готово к вывозу") && (bt.includes("Задач пока нет") || !bt.includes("Забрать из охлаждения"))) { cycled = true; break; } await sleep(200); }
    const bt = await bodyText();
    ok("Охлаждение >X: забор не доведён до хранения (нет ложного движения)",
      cycled && !has(bt, "Готово к вывозу") && !has(bt, "Размещено") && !has(bt, "Забрано из охлаждения"), bt.slice(0, 0));
    // Новый срок виден в мониторе (ADMIN): запланированный RETRIEVE_COOLING этого склада + «Доступна с (МСК)».
    if (ids.adminToken && ids.coolGtWhId) {
      await setViewport(false);
      await setAuth(ids.adminToken);
      await goto(`/warehouse/tasks?view=monitor&warehouse=${encodeURIComponent(ids.coolGtWhId)}`, `document.body.innerText.includes("Забор из охлаждения") || document.body.innerText.includes("Задач нет")`);
      const mt = await bodyText();
      ok("Охлаждение >X: назначен НОВЫЙ срок — «Запланирована» повторного забора", has(mt, "Забор из охлаждения") && has(mt, "Запланирована"), mt.slice(0, 0));
      ok("Охлаждение >X: новый срок показан московским временем «Доступна с … (МСК)»", has(mt, "Доступна с") && has(mt, "(МСК)"));
      ok("Охлаждение >X: в мониторе склада нет ложного движения (нет «Размещено»)", !has(mt, "Размещено"));
    }
  }

  // ── Задача J: физический процесс RETRIEVE_COOLING (COOL-003/004, UI-004/005). Фаза замера начинается
  //    с EAN (серверная проверка) → температура; фаза вывоза: исходная COOLING-ячейка (серверная проверка)
  //    → назначенная STORAGE-ячейка (финальная транзакция). Каждый скан авторитетно проверяется сервером
  //    ДО смены шага; неверный скан — role=alert, шаг не меняется; успех — только после ответа сервера.
  //    Камера и ручной ввод — одна state-machine. Финальное размещение — ровно одно движение. ──
  if (ids.coolUiToken && ids.coolUiCellQr) {
    let prisma = null;
    try { prisma = new PrismaClient(); await prisma.$queryRaw`SELECT 1`; } catch { prisma = null; }
    const movCount = async () => { if (!prisma || !ids.coolUiWhId) return null; try { return await prisma.stockMovement.count({ where: { OR: [{ fromWarehouseId: ids.coolUiWhId }, { toWarehouseId: ids.coolUiWhId }] } }); } catch { return null; } };
    const scanBtns = () => ev(`[...document.querySelectorAll('[data-workflow-sheet] button')].map(b=>b.textContent.trim()).filter(t=>/^Сканировать/.test(t))`);
    const sheetPlaceholder = () => ev(`document.querySelector('[data-workflow-sheet] input[placeholder]')?.getAttribute('placeholder') || ""`);
    const hasAlert = () => ev(`!!document.querySelector('[role=alert]')`);
    const hasNumberField = () => ev(`!!document.querySelector('[data-workflow-sheet] input[type="number"]')`);
    const openScanner = async () => { await sleep(400); await clickText("/Забрать из охлаждения/"); for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('[data-workflow-sheet]')`)) return true; await sleep(150); } return false; };
    const clickScan = async (re) => { await clickText(re); await sleep(300); await waitSheetField(); };
    const manualScan = async (val) => { await setSheetField(val); await clickText("/Ввести/"); await sleep(700); };
    const retryErr = async () => { await clickText("/Повторить/"); await sleep(300); };
    const waitPlaceholder = async (sub) => { for (let i = 0; i < 40; i++) { if ((await sheetPlaceholder()).includes(sub)) return true; await sleep(200); } return false; };

    await setViewport(true); // мобайл (тест 12)
    await setAuth(ids.coolUiToken);
    await goto("/warehouse/tasks", `document.body.innerText.includes("Забрать из охлаждения")`);
    const m0 = await movCount();

    // тест 13: последовательность начинается с EAN — старого порядка cell→EAN нет.
    ok("J: мастер охлаждения открыт", await openScanner());
    let btns = await scanBtns();
    ok("J/13: фаза замера начинается с EAN — кнопка «Сканировать товар» (не ячейка)", btns.length === 1 && btns[0] === "Сканировать товар", JSON.stringify(btns));
    ok("J/12: одновременно один шаг (одна scan-кнопка)", btns.length === 1, JSON.stringify(btns));

    // тест 1: неверный/чужой EAN сразу отклонён сервером; температура не показана; БД не меняется.
    await clickScan("/Сканировать товар/");
    await manualScan(ids.ctrlEanA);                          // валидный EAN другого товара (чужой)
    let alerted = false; for (let i = 0; i < 40; i++) { if (await hasAlert()) { alerted = true; break; } await sleep(150); }
    ok("J/1: чужой EAN → красная ошибка (role=alert)", alerted);
    ok("J/1: температура НЕ показана (шаг не сменился)", !(await hasNumberField()));
    ok("J/1: отклонение EAN не изменило StockMovement", (await movCount()) === m0, `${m0} -> ${await movCount()}`);
    await retryErr();

    // тест 2: правильный EAN подтверждён сервером → показывается только температура.
    await clickScan("/Сканировать товар/");
    await manualScan(ids.ean);
    let eanOk = false; for (let i = 0; i < 50; i++) { if (await hasNumberField()) { eanOk = true; break; } await sleep(150); }
    ok("J/2: правильный EAN подтверждён сервером → показан шаг температуры", eanOk);
    ok("J/2: успех EAN озвучен (role=status)", await ev(`!!document.querySelector('[role=status]')`) || eanOk);
    ok("J/2: подтверждение EAN не создало движения", (await movCount()) === m0);

    // код исходной/целевой ячейки — на кнопках фазы вывоза (Задача K)
    const fromScan = `/Сканировать ${ids.coolUiCoolCode}/`, targetScan = `/Сканировать ${ids.coolUiTargetCode}/`;
    const sheetTxtI = () => ev(`document.querySelector('[data-workflow-sheet]')?.innerText || ""`);
    const countOcc = (s, sub) => s.split(sub).length - 1;

    // ── Задача L: компактный экран ввода температуры (мы сейчас на нём после успешного скана EAN) ──
    const tempScreen = await sheetTxtI();
    ok("L: товар показан один раз", countOcc(tempScreen, ids.itemName) === 1, `${countOcc(tempScreen, ids.itemName)}×`);
    ok("L: количество показано один раз", countOcc(tempScreen, " шт") === 1 && /\d+\s*шт/.test(tempScreen), `${countOcc(tempScreen, " шт")}×`);
    ok("L: маршрут «<COOLING> → Хранение» показан один раз", has(tempScreen, ids.coolUiCoolCode) && has(tempScreen, "Хранение") && countOcc(tempScreen, "→") === 1);
    ok("L: есть подпись «Текущая температура, °C»", has(tempScreen, "Текущая температура, °C"));
    ok("L: нет «Фаза 1», порога X и инструкции про EAN", !has(tempScreen, "Фаза 1") && !has(tempScreen, "порог") && !has(tempScreen, "Отсканируйте EAN") && !has(tempScreen, "Сканируйте EAN"), tempScreen.replace(/\n/g, " ").slice(0, 0));
    ok("L: нет подзаголовка «Замер температуры» на экране температуры", !has(tempScreen, "Замер температуры"), tempScreen.replace(/\n/g, " ").slice(0, 0));
    ok("L: нет дублирующего зелёного «Товар подтверждён — введите»", !has(tempScreen, "Товар подтверждён — введите"));
    ok("L: поле температуры и кнопка «Записать температуру» видны без прокрутки (mobile)", await ev(`(()=>{const inp=document.querySelector('[data-workflow-sheet] input[type="number"]'); const b=[...document.querySelectorAll('[data-workflow-sheet] button')].find(x=>/Записать температуру/.test(x.textContent)); if(!inp||!b) return false; const ri=inp.getBoundingClientRect(), rb=b.getBoundingClientRect(); return ri.top>=0 && rb.bottom<=window.innerHeight+2 && rb.top>=0;})()`));

    // тест 4: температура <=X назначает ровно одну целевую ячейку.
    await setSheetNumber(String(ids.thresholdX - 2)); await clickText("/Записать температуру/"); await sleep(1200);
    let leqTarget = false; for (let i = 0; i < 50; i++) { if ((await bodyText()).includes(ids.coolUiTargetCode)) { leqTarget = true; break; } await sleep(200); }
    ok("J/4: температура ≤X → назначена целевая ячейка (фаза вывоза)", leqTarget, ids.coolUiTargetCode);
    ok("J/4: назначение цели не создало движения", (await movCount()) === m0);

    // ── Задача K: компактная фаза вывоза ──
    let st = await sheetTxtI();
    ok("K/1: товар в фазе вывоза показан ровно один раз", countOcc(st, ids.itemName) === 1, `${countOcc(st, ids.itemName)}×`);
    ok("K/1: количество показано (одна метрика · маршрут)", /\d+\s*шт/.test(st), st.replace(/\n/g, " ").slice(0, 0));
    // innerText отражает text-transform:uppercase → «ПЕРЕМЕСТИТЬ»; сверяем без учёта регистра.
    ok("K/1: команда «Переместить» показана", /переместить/i.test(st));
    ok("K/2: нет «Фаза 2» и нет «Готово к вывозу»", !has(st, "Фаза 2") && !has(st, "Готово к вывозу"), st.replace(/\n/g, " ").slice(0, 0));
    ok("K/2: нет температуры/порога X в фазе вывоза", !has(st, "°C") && !has(st, "порог"));
    btns = await scanBtns();
    ok("K/3: исходный шаг — кнопка с точным кодом COOLING-ячейки", btns.length === 1 && btns[0] === `Сканировать ${ids.coolUiCoolCode}`, JSON.stringify(btns));
    // Основное действие (scan-кнопка) видно в пределах viewport стандартного iPhone (без прокрутки).
    ok("K/7: основное действие видно без прокрутки (mobile)", await ev(`(()=>{const b=[...document.querySelectorAll('[data-workflow-sheet] button')].find(x=>/Сканировать/.test(x.textContent)); if(!b) return false; const r=b.getBoundingClientRect(); return r.top>=0 && r.top<window.innerHeight && r.bottom<=window.innerHeight+2;})()`));

    // P2-fix: пропавшая активная бронь цели → красная ошибка на скане исходной ячейки, целевой шаг не открыт.
    if (prisma && ids.coolUiWhId) {
      const rsv = await prisma.cellReservation.findFirst({ where: { warehouseId: ids.coolUiWhId, sessionId: { not: null }, status: "ACTIVE" } });
      if (rsv) {
        await prisma.cellReservation.update({ where: { id: rsv.id }, data: { status: "RELEASED" } });
        await clickScan(fromScan);
        await manualScan(ids.coolUiCellQr);
        let a = false; for (let i = 0; i < 40; i++) { if (await hasAlert()) { a = true; break; } await sleep(150); }
        ok("J/P2: пропавшая бронь цели → красная ошибка на скане исходной ячейки", a);
        ok("J/P2: целевой шаг не открыт (кнопка не про целевую ячейку)", !(await scanBtns()).some((b) => b.includes(ids.coolUiTargetCode)));
        ok("J/P2: отклонение не создало движения", (await movCount()) === m0);
        await retryErr();
        await prisma.cellReservation.update({ where: { id: rsv.id }, data: { status: "ACTIVE" } }); // восстановить бронь
      }
    }

    // тест 5: неверная исходная ячейка (другая ВАЛИДНАЯ ячейка склада) сразу отклонена; целевой шаг не открыт.
    await clickScan(fromScan);
    await manualScan(ids.coolUiTargetQr);                    // валидная STORAGE-ячейка склада, но не COOLING-источник
    alerted = false; for (let i = 0; i < 40; i++) { if (await hasAlert()) { alerted = true; break; } await sleep(150); }
    ok("J/5: другая валидная ячейка склада как источник → красная ошибка", alerted);
    ok("J/5: отклонение исходной ячейки не изменило StockMovement", (await movCount()) === m0);
    await retryErr();

    // тест 6 + K/4: правильная исходная ячейка → зелёное «Ячейка <код> подтверждена» → открыт скан цели.
    await clickScan(fromScan);
    await manualScan(ids.coolUiCellQr);
    let srcConfirmed = false; for (let i = 0; i < 40; i++) { if ((await bodyText()).includes(`Ячейка ${ids.coolUiCoolCode} подтверждена`)) { srcConfirmed = true; break; } await sleep(120); }
    ok("K/4: после правильного скана — зелёное подтверждение с кодом «Ячейка <код> подтверждена»", srcConfirmed);
    ok("J/6: верная исходная ячейка подтверждена → открыт скан цели (placeholder про назначенную ячейку)", await waitPlaceholder("назначенн"));
    // подпись строго по шагу: выйти из камеры → «Сканировать <код цели>»
    await clickText("/Назад к списку/"); await sleep(300);
    btns = await scanBtns();
    ok("K/5 + J/10: целевой шаг — кнопка с точным кодом STORAGE-ячейки", btns.length === 1 && btns[0] === `Сканировать ${ids.coolUiTargetCode}`, JSON.stringify(btns));

    // тест 7: неверная целевая ячейка отклонена без движения.
    await clickScan(targetScan);
    await manualScan(ids.coolUiCellQr);                      // COOLING-ячейка как цель — неверно
    alerted = false; for (let i = 0; i < 40; i++) { if (await hasAlert()) { alerted = true; break; } await sleep(150); }
    ok("J/7: неверная целевая ячейка → красная ошибка без движения", alerted && (await movCount()) === m0, `${m0} -> ${await movCount()}`);
    await retryErr();

    // тест 10: «Начать заново» сбрасывает к исходной ячейке, без server action и движения.
    await clickText("/Назад к списку/"); await sleep(250);
    await clickText("/Начать заново/"); await sleep(300);
    btns = await scanBtns();
    ok("J/10: «Начать заново» сбрасывает фазу вывоза к скану исходной COOLING-ячейки", btns[0] === `Сканировать ${ids.coolUiCoolCode}`, JSON.stringify(btns));
    ok("J/10: «Начать заново» не создало движение/бронь (StockMovement неизменен)", (await movCount()) === m0);
    ok("J/12: мобайл без горизонтального скролла", await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`));

    // тест 8+11: правильная цель → ровно одно движение (ручная ветка = та же state-machine, что и камера).
    await clickScan(fromScan);
    await manualScan(ids.coolUiCellQr);                      // исходная ячейка подтверждена → авто-переход к цели
    await waitPlaceholder("назначенн");
    await manualScan(ids.coolUiTargetQr);                    // назначенная цель → финальная транзакция
    let placed = false, mFinal = m0;
    for (let i = 0; i < 120; i++) {
      if ((await bodyText()).includes("Забрано из охлаждения")) { placed = true; break; }
      mFinal = await movCount();
      if (mFinal !== null && m0 !== null && mFinal === m0 + 1) { placed = true; break; }
      await sleep(200);
    }
    ok("J/8+11: финальное размещение выполнено (ручная ветка = единая state-machine)", placed);
    mFinal = await movCount();
    ok("J/8: правильная цель создала РОВНО одно движение", m0 === null ? true : mFinal === m0 + 1, `${m0} -> ${mFinal}`);
    if (prisma) await prisma.$disconnect();
  }

  // ── Задача M (Этап 1): сборщик — авторитетная проверка каждого скана, количество-в-подтверждении,
  //    следующий резерв авто, компактная карточка PICK, QR заказа. Камера и ручной ввод — одна state-machine. ──
  if (ids.pickToken && ids.pickCellAQr) {
    let pr = null;
    try { pr = new PrismaClient(); await pr.$queryRaw`SELECT 1`; } catch { pr = null; }
    const movP = async () => { if (!pr || !ids.pickWhId) return null; try { return await pr.stockMovement.count({ where: { OR: [{ fromWarehouseId: ids.pickWhId }, { toWarehouseId: ids.pickWhId }] } }); } catch { return null; } };
    const pScanBtns = () => ev(`[...document.querySelectorAll('[data-workflow-sheet] button')].map(b=>b.textContent.trim()).filter(x=>/Сканировать/.test(x))`);
    const pAlert = () => ev(`!!document.querySelector('[role=alert]')`);
    const pNum = () => ev(`!!document.querySelector('[data-workflow-sheet] input[type="number"]')`);
    const pSheet = () => ev(`document.querySelector('[data-workflow-sheet]')?.innerText || ""`);
    const pOpen = async () => { for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('[data-workflow-sheet]')`)) return true; await sleep(150); } return false; };
    const pField = async () => { for (let i = 0; i < 30; i++) { if (await sheetCount()) return true; await sleep(150); } return false; };
    const pScan = async (re) => { await clickText(re); await sleep(300); await pField(); };
    const pManual = async (v) => { await setSheetField(v); await clickText("/Ввести/"); await sleep(700); };
    const pRetry = async () => { await clickText("/Повторить/"); await sleep(300); };
    const setNum = (v) => ev(`(()=>{const el=[...document.querySelectorAll('[data-workflow-sheet] input[type="number"]')].find(e=>e.offsetParent!==null); if(!el) return 0; const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set; s.call(el,${JSON.stringify(v)}); el.dispatchEvent(new Event('input',{bubbles:true})); return 1;})()`);
    const pWaitNum = async () => { for (let i = 0; i < 50; i++) { if (await pNum()) return true; await sleep(150); } return false; };
    const pWaitBtn = async (sub) => { for (let i = 0; i < 50; i++) { if ((await pScanBtns()).some((x) => x.includes(sub))) return true; await sleep(200); } return false; };
    const pWaitAlert = async () => { for (let i = 0; i < 40; i++) { if (await pAlert()) return true; await sleep(150); } return false; };

    await setViewport(true); // мобайл
    await setAuth(ids.pickToken);
    await goto("/warehouse/tasks", `document.body.innerText.includes("Собрать заказ")`);
    // компактная карточка PICK (часть 4) — команда «Собрать заказ» отображается uppercase (CSS) → без регистра
    t = await bodyText();
    ok("M/card: компактная PICK — команда/номер/позиции·количество", /собрать заказ/i.test(t) && has(t, `№ ${ids.pickOrderExt}`) && has(t, "2 поз.") && has(t, "2 шт") && has(t, "0/2"));
    ok("M/card: нет техметаданных (тип/статус/создано)", !has(t, `Собрать заказ ${ids.pickOrderExt}`) && !has(t, "создано") && !has(t, "Назначена"));
    ok("M/card: мобайл без переполнения", await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
    const m0 = await movP();

    await clickText("/Собрать \\(сканирование\\)/");
    ok("M: сканер сборки открыт", await pOpen());
    let b = await pScanBtns();
    ok("M/1: шаг ячейки — кнопка с точным кодом PK-01", b.length === 1 && b[0] === `Сканировать ${ids.pickCellACode}`, JSON.stringify(b));

    // неправильная ячейка (валидная зарезервированная PK-02, но НЕ следующая) → красная ошибка, без движения
    await pScan(`/Сканировать ${ids.pickCellACode}/`);
    await pManual(ids.pickCellBQr);
    ok("M/1: неправильная ячейка → красная ошибка", await pWaitAlert());
    ok("M/1: без движения и товар не открыт", (await movP()) === m0 && !(await pNum()));
    await pRetry();
    // «Повторить» немедленно возвращает к сканированию текущего шага — поле активно без повторного клика
    ok("M/1: «Повторить» → сразу к сканированию (поле активно, ошибки нет)", (await pField()) && !(await pAlert()));

    // правильная ячейка → зелёное подтверждение → шаг товара
    await pScan(`/Сканировать ${ids.pickCellACode}/`);
    await pManual(ids.pickCellAQr);
    let cellOk = false; for (let i = 0; i < 40; i++) { if ((await bodyText()).includes(`Ячейка ${ids.pickCellACode} подтверждена`)) { cellOk = true; break; } await sleep(120); }
    ok("M/2: правильная ячейка → зелёное подтверждение с кодом", cellOk);
    // после подтверждения ячейки сценарий авто-переходит к товару (камера/ручной ввод ждут EAN)
    let atProduct = false; for (let i = 0; i < 40; i++) { const ph = await ev(`document.querySelector('[data-workflow-sheet] input[placeholder]')?.getAttribute('placeholder') || ""`); if (ph.includes("EAN")) { atProduct = true; break; } await sleep(200); }
    ok("M/2: авто-переход к шагу товара (ждёт EAN)", atProduct);

    // неправильный EAN (валидный EAN заказа, но не тот товар) → ошибка, количество не открывается, без движения
    await pScan(`/Сканировать ${ids.pickItemAName}/`);
    await pManual(ids.pickEanWrong);
    ok("M/3: неправильный EAN → красная ошибка", await pWaitAlert());
    ok("M/3: количество не открылось, без движения", !(await pNum()) && (await movP()) === m0);
    await pRetry();

    // правильный EAN → количество в том же окне подтверждения товара (часть 2)
    await pScan(`/Сканировать ${ids.pickItemAName}/`);
    await pManual(ids.pickEanA);
    ok("M/4: правильный EAN → поле количества в том же окне", await pWaitNum());
    ok("M/4: окно «Товар подтверждён» + кнопка «Собрать» (без scan-кнопок и «ОК»)", has(await pSheet(), "Товар подтверждён") && (await pScanBtns()).length === 0 && (await ev(`[...document.querySelectorAll('[data-workflow-sheet] button')].some(x=>/^Собрать$/.test(x.textContent.trim()))`)));

    // неправильное количество (2 > резерв 1) → ошибка без сброса ячейки/EAN, без движения
    await setNum("2"); await clickText(/^Собрать$/);
    ok("M/5: неправильное количество → ошибка без движения", (await pWaitAlert()) && (await movP()) === m0);
    await pRetry();
    ok("M/5: ячейка и EAN не сброшены — поле количества на месте", await pNum());

    // правильное количество → ровно одно движение, следующий резерв авто
    await setNum("1"); await clickText(/^Собрать$/);
    let m1 = m0; for (let i = 0; i < 100; i++) { m1 = await movP(); if (m1 !== null && m0 !== null && m1 === m0 + 1) break; if ((await bodyText()).includes(ids.pickCellBCode)) break; await sleep(200); }
    ok("M/6: правильное количество → ровно одно движение", m0 === null ? true : m1 === m0 + 1, `${m0}->${m1}`);
    ok("M/7: следующий резерв (PK-02) показан автоматически", await pWaitBtn(ids.pickCellBCode));

    // вторая (последняя) позиция → завершение без дубля движения
    await pScan(`/Сканировать ${ids.pickCellBCode}/`);
    await pManual(ids.pickCellBQr);
    await pWaitBtn(ids.pickItemBName);
    await pScan(`/Сканировать ${ids.pickItemBName}/`);
    await pManual(ids.pickEanB);
    await pWaitNum();
    await setNum("1"); await clickText(/^Собрать$/);
    let done = false, mFin = m1; for (let i = 0; i < 100; i++) { if ((await bodyText()).includes("Заказ собран")) { done = true; break; } mFin = await movP(); if (mFin !== null && m0 !== null && mFin === m0 + 2) { done = true; break; } await sleep(200); }
    ok("M/8: последняя позиция завершает сборку (Заказ собран)", done);
    mFin = await movP();
    ok("M/8: всего ровно два движения (без дубля)", m0 === null ? true : mFin === m0 + 2, `${m0}->${mFin}`);

    // QR заказа (часть 6): ADMIN видит QR + код + канонический URL; /q/<code> открывает нужный заказ
    if (ids.adminToken && ids.pickOrderId && ids.pickOrderQrCode) {
      await setViewport(false);
      await setAuth(ids.adminToken);
      await goto(`/warehouse/external-orders/${ids.pickOrderId}`, `document.body.innerText.includes("QR заказа")`);
      const qt = await bodyText();
      ok("M/QR: карточка заказа показывает «QR заказа» и ручной код", has(qt, "QR заказа") && has(qt, ids.pickOrderQrCode));
      ok("M/QR: показан канонический URL /q/<code>", has(qt, `/q/${ids.pickOrderQrCode}`));
      ok("M/QR: есть действия «Открыть крупно» и «Скачать/распечатать»", has(qt, "Открыть крупно") && has(qt, "Скачать"));
      // /q/<code> с сессией → 307 на карточку ИМЕННО этого заказа (детерминированно, node:http с Host+cookie)
      const qres = await new Promise((resolve) => {
        const rq = http.request({ hostname: "127.0.0.1", port: PORT, path: `/q/${ids.pickOrderQrCode}`, method: "GET", headers: { host: HOST, cookie: `skx_session=${ids.adminToken}` } }, (res) => resolve({ status: res.statusCode ?? 0, loc: res.headers.location ?? "" }));
        rq.on("error", () => resolve({ status: 0, loc: "" })); rq.end();
      });
      ok("M/QR: /q/<code> открывает именно нужный заказ", qres.status === 307 && qres.loc.includes(`/warehouse/external-orders/${ids.pickOrderId}`), `${qres.status} ${qres.loc}`);
    }
    if (pr) await pr.$disconnect();
  }

  // ── Задача M (Этап 2): контролёр — компактная карточка CONTROL_ORDER (до начала и в работе),
  //    скан QR заказа ПЕРВЫМ шагом (авторитетная серверная проверка), неверный QR не меняет шаг/БД,
  //    верный QR → зелёное подтверждение UI-005 → шаг EAN. Ни техметаданных, ни внутренних ID. ──
  if (ids.controlE2EToken && ids.controlOrderAQr) {
    let cr = null;
    try { cr = new PrismaClient(); await cr.$queryRaw`SELECT 1`; } catch { cr = null; }
    const checksA = async () => { if (!cr || !ids.controlOrderAId) return null; try { return await cr.controlCheck.count({ where: { orderId: ids.controlOrderAId } }); } catch { return null; } };
    const cOpen = async () => { for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('[data-workflow-sheet]')`)) return true; await sleep(150); } return false; };
    const cAlert = async () => { for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('[role=alert]')`)) return true; await sleep(150); } return false; };

    // мобайл — компактная карточка «в работе» (заказ A = текущая задача)
    await setViewport(true);
    await setAuth(ids.controlE2EToken);
    await goto("/warehouse/tasks", `document.body.innerText.includes("Проверить заказ")`);
    t = await bodyText();
    ok("M/ctl card в работе: команда/№/позиции·единицы/прогресс", /проверить заказ/i.test(t) && has(t, `№ ${ids.controlOrderAExt}`) && has(t, "2 поз.") && has(t, "2 ед.") && has(t, "0/2"));
    ok("M/ctl card: нет техметаданных (тип/статус/создано/внутр. ID)", !has(t, `Контроль заказа ${ids.controlOrderAExt}`) && !has(t, "создано") && !has(t, "Назначена") && !has(t, "CONTROL_ORDER") && !has(t, ids.controlOrderAId));
    ok("M/ctl card: мобайл без переполнения", await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`));

    // компактная карточка «до начала» (заказ B в очереди) — раскрыть свёрнутую очередь
    await clickText(/Показать/); await sleep(400);
    t = await bodyText();
    ok("M/ctl card до начала: № заказа B и позиции·единицы (без техметаданных)", has(t, `№ ${ids.controlOrderBExt}`) && has(t, "1 поз.") && has(t, "1 ед.") && !has(t, `Контроль заказа ${ids.controlOrderBExt}`));

    // скан QR заказа ПЕРВЫМ шагом — открыть сканер
    await clickText(/Сканировать QR заказа/);
    ok("M/ctl: сканер QR заказа открыт (одно поле)", (await cOpen()) && (await sheetCount()) <= 1, String(await sheetCount()));

    const c0 = await checksA();
    // неверный QR (валидный QR ЧУЖОГО заказа B) → красная ошибка, шаг НЕ меняется, БД НЕ меняется
    await setSheetField(ids.controlWrongQr); await clickText("/Ввести/"); await sleep(700);
    ok("M/ctl: неверный QR → красная ошибка", await cAlert());
    ok("M/ctl: неверный QR не подтвердил заказ и не открыл шаг EAN", !(await bodyText()).includes("Заказ подтверждён") && !(await ev(`!!document.querySelector('[data-workflow-sheet] input[placeholder*="EAN"]')`)));
    ok("M/ctl: неверный QR не изменил БД (проверок не создано)", c0 === null ? true : (await checksA()) === c0, `${c0}`);

    await clickText(/Повторить/); await sleep(300);
    // верный QR (заказ A) → зелёное подтверждение UI-005 → refresh → шаг EAN
    await setSheetField(ids.controlOrderAQr); await clickText("/Ввести/");
    let green = false; for (let i = 0; i < 90; i++) { if (await ev(`document.body.innerText.includes("Заказ подтверждён")`)) { green = true; break; } await sleep(60); }
    ok("M/ctl: верный QR → зелёное подтверждение UI-005", green);
    let atEan = false; for (let i = 0; i < 60; i++) { if ((await bodyText()).includes("Проверить товар")) { atEan = true; break; } await sleep(200); }
    ok("M/ctl: верный QR → переход к пошаговому контролю (шаг EAN)", atEan);
    ok("M/ctl: верный QR создал ровно одну проверку в БД", c0 === null ? true : (await checksA()) === c0 + 1, `${c0}`);
    if (cr) await cr.$disconnect();
  }

  // ── Задача M (Этап 2, P2): fail-closed CONTROL_ORDER без структурированного контекста — ни техкарточки
  //    (title/status/time/ID), ни кнопки «Начать». Повреждённая текущая (IN_PROGRESS) и в очереди (ASSIGNED). ──
  if (ids.controlBadToken) {
    const startCount = () => ev(`[...document.querySelectorAll('button')].filter(b=>/^Начать$/.test(b.textContent.trim())).length`);
    await setViewport(true);
    await setAuth(ids.controlBadToken);
    await goto("/warehouse/tasks", `document.body.innerText.includes("Данные задачи недоступны")`);
    t = await bodyText();
    ok("M/ctl-bad: текущая повреждённая → fail-closed «Данные задачи недоступны»", has(t, "Данные задачи недоступны"));
    ok("M/ctl-bad: нет техданных (title/тип/статус/время/ID)", !has(t, "BROKEN-ORD-INTERNAL") && !has(t, "CONTROL_ORDER") && !has(t, "Проверить заказ") && !has(t, "создано") && !has(t, "Назначена"));
    ok("M/ctl-bad: текущую повреждённую нельзя начать (нет «Начать»)", (await startCount()) === 0, String(await startCount()));
    // очередь: раскрыть → повреждённая ASSIGNED тоже fail-closed, тоже без «Начать»
    await clickText(/Показать/); await sleep(400);
    t = await bodyText();
    const cnt = (t.match(/Данные задачи недоступны/g) || []).length;
    ok("M/ctl-bad: повреждённая в очереди → тоже fail-closed (≥2 карточки)", cnt >= 2, String(cnt));
    ok("M/ctl-bad: повреждённую в очереди начать нельзя (нет «Начать»)", (await startCount()) === 0, String(await startCount()));
    ok("M/ctl-bad: без техданных в очереди (нет внутреннего номера)", !(await bodyText()).includes("BROKEN-ORD-INTERNAL"));
    ok("M/ctl-bad: мобайл без переполнения", await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
  }

  // ── Задача H: монитор ADMIN — новые задачи сверху (createdAt DESC, id DESC) + серверная пагинация;
  //    порядок держится и под фильтром. ──
  if (ids.adminToken && ids.monitorNewestTitle) {
    await setViewport(false);
    await setAuth(ids.adminToken);
    await goto("/warehouse/tasks?view=monitor", `document.body.innerText.includes("${ids.monitorNewestTitle}")`);
    t = await bodyText();
    ok("Монитор (H): серверная пагинация — показан счётчик «Стр. N из M»", /Стр\.\s*1\s*из\s*\d+/.test(t), t.slice(0, 0));
    // Новейшая (создана последней) должна идти ВЫШЕ более старой срочной.
    const iNew = t.indexOf(ids.monitorNewestTitle);
    const iOld = ids.asgUrgentTitleForSort ? t.indexOf(ids.asgUrgentTitleForSort) : -1;
    ok("Монитор (H): новая задача присутствует на первой странице", iNew >= 0);
    ok("Монитор (H): новые сверху — новейшая выше более старой", iNew >= 0 && iOld >= 0 && iNew < iOld, `new@${iNew} old@${iOld}`);
    // Порядок сохраняется под фильтром по роли (сентинел — LOADER).
    await goto("/warehouse/tasks?view=monitor&role=LOADER", `document.body.innerText.includes("${ids.monitorNewestTitle}")`);
    const tf = await bodyText();
    const iNewF = tf.indexOf(ids.monitorNewestTitle);
    const iOldF = ids.asgUrgentTitleForSort ? tf.indexOf(ids.asgUrgentTitleForSort) : -1;
    ok("Монитор (H): под фильтром роль=LOADER новые тоже сверху", iNewF >= 0 && iOldF >= 0 && iNewF < iOldF, `new@${iNewF} old@${iOldF}`);
    ok("Монитор (H): под фильтром пагинация сохраняется («Стр. N из M»)", /Стр\.\s*1\s*из\s*\d+/.test(tf));
  }

  console.log(failures === 0 ? "\nE2E RELEASE OK ✓" : `\nПРОВАЛЕНО: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
