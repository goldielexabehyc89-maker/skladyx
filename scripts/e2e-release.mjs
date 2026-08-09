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
    ok("TASK-006: карточка показывает источник маршрута «Приёмка» (стрелка — иконка ArrowRight)", has(t, "Приёмка"));
    ok("TASK-006: до назначения цель — зона «Хранение»", has(t, "Хранение"));
    ok("TASK-006: НЕТ типа задачи «Размещение группы»", !has(t, "Размещение группы"));
    ok("TASK-006: НЕТ статуса «В работе» и времени «создано»", !has(t, "В работе") && !has(t, "создано"));
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
    ok("Размещение: после «Начать размещение» в карточке маршрут «Приёмка → <ячейка>»", assigned && has(await bodyText(), "Приёмка"), ids.placeCellCode);

    if (ids.ean && ids.placeCellQr && ids.placeWrongCellQr) {
      // открыть скан-мастер
      await sleep(500); await clickText("/Сканировать/");
      const sheetUp = async () => { for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('[data-workflow-sheet]')`)) return true; await sleep(150); } return false; };
      ok("Размещение: скан-мастер открыт (шаг EAN)", await sheetUp());
      await shot("place-1-wait-ean"); // (1) ожидание EAN
      ok("UI-005: на шаге EAN не более одного поля", (await sheetCount()) <= 1, String(await sheetCount()));

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

  console.log(failures === 0 ? "\nE2E RELEASE OK ✓" : `\nПРОВАЛЕНО: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
