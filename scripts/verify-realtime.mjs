// Проверка онлайн-обновлений (SSE /api/realtime) на живом dev-сервере:
// авторизация, формат потока, доставка события при изменении документа,
// фильтрация по ролям (EMPLOYEE не получает чужие документные события).
//
// Требует dev-сервер с заполненной базой (после verify-http.mjs).
// Запуск: VERIFY_PASSWORD=<пароль> node scripts/verify-realtime.mjs
/* eslint-disable no-console */

const BASE = process.env.VERIFY_BASE || "http://localhost:3000";
const EMAIL = process.env.VERIFY_EMAIL || "goldielexabehyc89@gmail.com";
const PASSWORD = process.env.VERIFY_PASSWORD;

if (!PASSWORD) {
  console.error("Задайте VERIFY_PASSWORD");
  process.exit(1);
}

let failures = 0;
function ok(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name} ${extra}`);
  }
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

function cookieFrom(res, current = "") {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    if (pair.startsWith("skx_session=")) return pair;
  }
  return current;
}

async function login(loginValue, password) {
  let cookie = "";
  const res0 = await fetch(`${BASE}/login`);
  cookie = cookieFrom(res0, cookie);
  const form = parseForms(await res0.text()).find((f) => "login" in f.fields);
  const fd = new FormData();
  for (const [k, v] of Object.entries(form.fields)) fd.set(k, v);
  fd.set("login", loginValue);
  fd.set("password", password);
  const res = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { cookie },
    body: fd,
    redirect: "manual",
  });
  cookie = cookieFrom(res, cookie);
  if (!cookie) throw new Error(`логин не удался: ${loginValue}`);
  return cookie;
}

// Открывает SSE-поток и копит события; вернуть { events, headers, close, waitFor }.
async function openStream(cookie) {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/realtime`, {
    headers: { cookie, accept: "text/event-stream" },
    signal: ctrl.signal,
  });
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (dataLine) {
            try {
              events.push(JSON.parse(dataLine.slice(6)));
            } catch {}
          }
        }
      }
    } catch {}
  })();
  const waitFor = (pred, timeoutMs = 6000) =>
    new Promise((resolve) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        const found = events.find(pred);
        if (found) {
          clearInterval(timer);
          resolve(found);
        } else if (Date.now() - t0 > timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, 100);
    });
  return { res, events, waitFor, close: () => ctrl.abort() };
}

async function main() {
  console.log("1. Авторизация endpoint");
  {
    const res = await fetch(`${BASE}/api/realtime`);
    ok("без сессии — 401", res.status === 401, `status=${res.status}`);
  }

  const adminCookie = await login(EMAIL, PASSWORD);

  console.log("2. SSE-поток открывается");
  const admin = await openStream(adminCookie);
  ok(
    "content-type: text/event-stream",
    (admin.res.headers.get("content-type") ?? "").includes("text/event-stream"),
    admin.res.headers.get("content-type") ?? "",
  );
  const hello = await admin.waitFor((e) => e.type === "hello", 4000);
  ok("приветственное событие получено", !!hello);

  console.log("3. Событие доходит при изменении документа");
  // создаём заявку на сбор (см. verify-http 9в): админ должен получить document.created
  const get = async (path) =>
    (await fetch(BASE + path, { headers: { cookie: adminCookie } })).text();
  const empListHtml = await get("/warehouse/employees");
  const empId = /href="\/warehouse\/employees\/([a-z0-9]+)"[\s\S]{0,200}?Иван Тестов/.exec(
    empListHtml,
  )?.[1];
  const whHtml = await get("/warehouse/warehouses");
  const warehouseId = /"\/warehouse\/warehouses\/(?!new")([a-z0-9]+)"/.exec(whHtml)?.[1];
  ok("сотрудник и склад найдены", !!empId && !!warehouseId);

  // кладовщик слушает параллельно (у него allWarehouses — событие должно дойти)
  const storeCookie = await login("89001112244", "kladovshik123");
  const store = await openStream(storeCookie);
  await store.waitFor((e) => e.type === "hello", 4000);

  const newHtml = await get("/warehouse/picklists/new");
  const plForm = parseForms(newHtml).find((f) => f.html.includes('name="targetEmployeeId"'));
  const fd = new FormData();
  for (const [k, v] of Object.entries(plForm.fields)) fd.set(k, v);
  fd.set("warehouseId", warehouseId);
  fd.set("targetEmployeeId", empId);
  await fetch(`${BASE}/warehouse/picklists/new`, {
    method: "POST",
    headers: { cookie: adminCookie },
    body: fd,
    redirect: "manual",
  });

  const created = await admin.waitFor(
    (e) => e.type === "document.created" && e.entity === "picklist",
  );
  ok("админ получил document.created (picklist)", !!created, JSON.stringify(admin.events));
  ok(
    "в событии есть warehouseIds и createdAt",
    !!created && Array.isArray(created.warehouseIds) && !!created.createdAt,
    created ? JSON.stringify(created) : "",
  );
  const storeGot = await store.waitFor(
    (e) => e.type === "document.created" && e.entity === "picklist",
  );
  ok("кладовщик (доступ ко всем складам) получил событие", !!storeGot);

  console.log("4. Фильтрация по роли: EMPLOYEE не получает чужие документы");
  {
    // создаём сотрудника EMPLOYEE с паролем (ссылка установки пароля — в ответе формы)
    const empNewHtml = await get("/warehouse/employees/new");
    const empForm = parseForms(empNewHtml).find((f) => "phone" in f.fields);
    const fdE = new FormData();
    for (const [k, v] of Object.entries(empForm.fields)) fdE.set(k, v);
    fdE.set("name", "Реалтайм Сотрудник");
    fdE.set("phone", "89001113355");
    fdE.set("role", "EMPLOYEE");
    fdE.set("allWarehouses", "on");
    const resE = await fetch(`${BASE}/warehouse/employees/new`, {
      method: "POST",
      headers: { cookie: adminCookie },
      body: fdE,
      redirect: "manual",
    });
    const linkMatch = /auth\/set\/([a-f0-9]{64})/.exec(await resE.text());
    ok("ссылка пароля сотрудника выдана", !!linkMatch);
    let empOk = false;
    if (linkMatch) {
      const setRes = await fetch(`${BASE}/auth/set/${linkMatch[1]}`);
      const setCookie = cookieFrom(setRes);
      const setForm = parseForms(await setRes.text()).find((f) => "password2" in f.fields);
      const fdP = new FormData();
      for (const [k, v] of Object.entries(setForm.fields)) fdP.set(k, v);
      fdP.set("password", "employee-rt-2026");
      fdP.set("password2", "employee-rt-2026");
      await fetch(`${BASE}/auth/set/${linkMatch[1]}`, {
        method: "POST",
        headers: { cookie: setCookie },
        body: fdP,
        redirect: "manual",
      });
      const empCookie = await login("89001113355", "employee-rt-2026");
      const emp = await openStream(empCookie);
      await emp.waitFor((e) => e.type === "hello", 4000);
      // новая заявка адресована Ивану — постороннему EMPLOYEE события быть не должно
      const newHtml2 = await get("/warehouse/picklists/new");
      const plForm2 = parseForms(newHtml2).find((f) => f.html.includes('name="targetEmployeeId"'));
      const fd2 = new FormData();
      for (const [k, v] of Object.entries(plForm2.fields)) fd2.set(k, v);
      fd2.set("warehouseId", warehouseId);
      fd2.set("targetEmployeeId", empId);
      await fetch(`${BASE}/warehouse/picklists/new`, {
        method: "POST",
        headers: { cookie: adminCookie },
        body: fd2,
        redirect: "manual",
      });
      // а кладовщик это же событие получить должен (контроль, что событие вообще было)
      const storeGot2 = await store.waitFor(
        (e, i) => e.type === "document.created" && e.entity === "picklist" && store.events.indexOf(e) > store.events.indexOf(storeGot ?? {}),
        6000,
      );
      const leaked = await emp.waitFor(
        (e) => e.type === "document.created" && e.entity === "picklist",
        2500,
      );
      ok("кладовщик получил второе событие (контроль)", !!storeGot2);
      ok("постороннему EMPLOYEE событие не пришло", !leaked);
      emp.close();
      empOk = true;
    }
    if (!empOk) ok("EMPLOYEE-проверка выполнена", false, "не удалось создать сотрудника");
  }

  console.log("5. Reconnect (повторное подключение тем же пользователем)");
  {
    admin.close();
    const again = await openStream(adminCookie);
    const hi = await again.waitFor((e) => e.type === "hello", 4000);
    ok("повторное подключение работает", !!hi);
    again.close();
  }

  store.close();
  console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ ✓" : `\nПРОВАЛОВ: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
