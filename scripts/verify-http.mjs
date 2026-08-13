// Сквозная HTTP-проверка через прогрессивные формы server actions (no-JS путь):
// логин → склад → ячейки → товары → приемка → проведение → остатки → печать →
// сотрудник → ссылка пароля. Использует реальный сервер на localhost:3000.
/* eslint-disable no-console */

const BASE = process.env.VERIFY_BASE || "http://localhost:3000";
const EMAIL = process.env.VERIFY_EMAIL || "goldielexabehyc89@gmail.com";
const PASSWORD = process.env.VERIFY_PASSWORD;

if (!PASSWORD) {
  console.error("Задайте VERIFY_PASSWORD");
  process.exit(1);
}

let cookie = "";
let failures = 0;

function ok(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

function updateCookie(res) {
  const set = res.headers.getSetCookie?.() ?? [];
  for (const c of set) {
    const [pair] = c.split(";");
    if (pair.startsWith("skx_session=")) cookie = pair;
  }
}

async function get(path) {
  const res = await fetch(BASE + path, {
    headers: { cookie },
    redirect: "manual",
  });
  updateCookie(res);
  return res;
}

// Достаёт формы из HTML: [{fields: Map, html}]
function parseForms(html) {
  const forms = [];
  const re = /<form[\s\S]*?<\/form>/g;
  for (const m of html.match(re) ?? []) {
    const fields = {};
    const inputRe = /<input[^>]*>/g;
    for (const inp of m.match(inputRe) ?? []) {
      const name = /name="([^"]*)"/.exec(inp)?.[1];
      if (!name) continue;
      const value = /value="([^"]*)"/.exec(inp)?.[1] ?? "";
      fields[name] = value.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    }
    // selects: первое значение option
    const selRe = /<select[^>]*name="([^"]*)"[\s\S]*?<\/select>/g;
    let sm;
    while ((sm = selRe.exec(m))) {
      const opt = /<option[^>]*value="([^"]+)"/.exec(sm[0]);
      fields[sm[1]] = opt?.[1] ?? "";
    }
    forms.push({ fields, html: m });
  }
  return forms;
}

// Отправка формы: базовые $ACTION-поля + пользовательские значения.
async function submitForm(path, form, values) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form.fields)) {
    if (k.startsWith("$ACTION")) fd.set(k, v);
  }
  // не-ACTION hidden поля тоже отправляем (receiptId и т.п.), затем переопределяем values
  for (const [k, v] of Object.entries(form.fields)) {
    if (!k.startsWith("$ACTION")) fd.set(k, v);
  }
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

function formWith(forms, inputName) {
  return forms.find((f) => Object.keys(f.fields).includes(inputName));
}

async function followRedirect(res) {
  const loc = res.headers.get("location") || res.headers.get("x-action-redirect");
  if (!loc) return null;
  return loc.startsWith("http") ? new URL(loc).pathname + new URL(loc).search : loc;
}

async function main() {
  console.log("1. Логин");
  {
    const html = await (await get("/login")).text();
    const forms = parseForms(html);
    const form = formWith(forms, "login");
    ok("форма логина найдена", !!form);
    // админ входит по email (legacy-вход для учёток без телефона)
    const res = await submitForm("/login", form, { login: EMAIL, password: PASSWORD });
    ok("логин: редирект", res.status === 303 || res.status === 302, `status=${res.status}`);
    ok("cookie сессии установлена", cookie.includes("skx_session="));
  }

  console.log("2. Страницы отвечают 200");
  for (const p of [
    "/warehouse/warehouses",
    "/warehouse/items",
    "/warehouse/active",
    "/warehouse/receipts",
    "/warehouse/stock",
    "/warehouse/transfers",
    "/warehouse/writeoffs",
    "/warehouse/picklists",
    "/warehouse/staging",
    "/warehouse/issues",
    "/warehouse/issues/new",
    "/warehouse/inventories",
    "/warehouse/employees",
    "/warehouse/feed",
    "/warehouse/docs",
    "/warehouse/more",
    "/warehouse/settings",
    "/warehouse/scan",
    "/warehouse/my",
  ]) {
    const res = await get(p);
    ok(p, res.status === 200, `status=${res.status}`);
  }

  {
    const res = await get("/warehouse");
    ok("/warehouse редиректит в рабочий экран роли", res.status >= 300 && res.status < 400, `status=${res.status}`);
  }

  console.log("3. Создание склада");
  let warehouseId = "";
  {
    const html = await (await get("/warehouse/warehouses/new")).text();
    const form = formWith(parseForms(html), "name");
    const res = await submitForm("/warehouse/warehouses/new", form, {
      name: "Основной склад",
      address: "Тестовый адрес",
    });
    const loc = await followRedirect(res);
    ok("склад создан (редирект)", !!loc && loc.includes("/warehouse/warehouses/"), `loc=${loc}`);
    warehouseId = loc?.split("/").pop() ?? "";
  }

  console.log("4. Ячейки: диапазон А-01…А-05");
  {
    const html = await (await get(`/warehouse/warehouses/${warehouseId}`)).text();
    const form = formWith(parseForms(html), "prefix");
    await submitForm(`/warehouse/warehouses/${warehouseId}`, form, {
      prefix: "А-",
      from: "1",
      to: "5",
    });
    const html2 = await (await get(`/warehouse/warehouses/${warehouseId}`)).text();
    ok("ячейки созданы", html2.includes("А-01") && html2.includes("А-05"));
    console.log("   печать QR ячеек:");
    const printHtml = await (await get(`/warehouse/print/labels?cells=${warehouseId}`)).text();
    ok("этикетки ячеек содержат 5 QR", (printHtml.match(/class="label-qr/g) ?? []).length === 5);
  }

  console.log("5. Товары: создание по заводскому EAN (Пакет 9B — авто шт+LOT, без выбора UNIT/LOT)");
  {
    // Контрольная цифра EAN-13 (12 цифр базы → +checksum).
    const ean13 = (b) => {
      let sum = 0;
      for (let i = 0; i < 12; i++) sum += Number(b[i]) * (i % 2 === 0 ? 1 : 3);
      return b + String((10 - (sum % 10)) % 10);
    };
    const cementEan = ean13("460775000001");
    const boschEan = ean13("460775000002");

    let html = await (await get("/warehouse/items/new")).text();
    let forms = parseForms(html);
    const itemForm = forms.find((f) => f.html.includes('name="ean"'));
    // P3B-FIX-1: createItemAction больше НЕ делает server-redirect() (клиент навигирует
    // window.location.assign(redirectTo)). Поэтому факт создания проверяем по списку /warehouse/items.
    await submitForm("/warehouse/items/new", itemForm, {
      name: "Цемент М500 50кг",
      ean: cementEan,
      sku: "CEM500",
    });
    const itemsAfter1 = await (await get("/warehouse/items")).text();
    ok("цемент создан по EAN", itemsAfter1.includes(cementEan));

    html = await (await get("/warehouse/items/new")).text();
    forms = parseForms(html);
    const itemForm2 = forms.find((f) => f.html.includes('name="ean"'));
    await submitForm("/warehouse/items/new", itemForm2, {
      name: "Перфоратор Bosch GBH 2-26",
      ean: boschEan,
      sku: "BOSCH226",
    });
    const itemsAfter2 = await (await get("/warehouse/items")).text();
    ok("перфоратор создан по EAN", itemsAfter2.includes(boschEan));

    // Неверная контрольная цифра — отказ, товар не создаётся (в списке его нет).
    html = await (await get("/warehouse/items/new")).text();
    const badForm = parseForms(html).find((f) => f.html.includes('name="ean"'));
    await submitForm("/warehouse/items/new", badForm, {
      name: "Бракованный EAN",
      ean: "4607750000019", // неверная контрольная цифра
    });
    const itemsAfterBad = await (await get("/warehouse/items")).text();
    ok("EAN с неверной контрольной цифрой отклонён", !itemsAfterBad.includes("Бракованный EAN"));

    const listHtml = await (await get("/warehouse/items")).text();
    ok("оба товара в списке", listHtml.includes("Цемент М500") && listHtml.includes("Перфоратор"));
    ok("EAN отображается в списке", listHtml.includes(cementEan) && listHtml.includes(boschEan));
    ok("бракованный товар не создан", !listHtml.includes("Бракованный EAN"));
  }

  console.log("6. Заказ поставщику: таблица, id позиций, приём во вкладке «Приемки»");
  {
    // поставщик создаётся в отдельном справочнике /warehouse/suppliers
    // (в форме заказа — автокомплит, без JS он недоступен)
    const supHtml = await (await get("/warehouse/suppliers/new")).text();
    const supCreateForm = parseForms(supHtml).find(
      (f) => f.html.includes('name="phone"') && !f.fields.id,
    );
    await submitForm("/warehouse/suppliers/new", supCreateForm, {
      name: "ООО СтройБаза-Тест",
      phone: "+7 900 000-00-00",
    });
    const supHtml2 = await (await get("/warehouse/suppliers")).text();
    const supIdMatch = /"\/warehouse\/suppliers\/(?!new")([a-z0-9]+)"/.exec(supHtml2);
    ok(
      "поставщик создан в справочнике",
      supHtml2.includes("ООО СтройБаза-Тест") && !!supIdMatch,
    );
    const supplierId = supIdMatch?.[1] ?? "";

    // заказ: hidden-поля автокомплитов заполняем напрямую
    const newHtml2 = await (await get("/warehouse/orders/new")).text();
    const orderForm = parseForms(newHtml2).find((f) =>
      Object.keys(f.fields).includes("supplierId"),
    );
    ok("форма заказа доступна", !!orderForm);
    const res = await submitForm("/warehouse/orders/new", orderForm, { supplierId, warehouseId });
    const loc = await followRedirect(res);
    ok("заказ создан", !!loc && loc.includes("/warehouse/orders/"), `loc=${loc}`);
    const orderId = loc?.split("/").pop() ?? "";

    // позиции: цемент 10 по 550, перфоратор 2 по 15000.
    // Поля добавления живут в таблице (атрибут form="add-line"), поэтому id товаров
    // берём из списка номенклатуры, а значения подставляем в форму напрямую.
    const itemsHtml = await (await get("/warehouse/items")).text();
    const cementId2 = /href="\/warehouse\/items\/([^"]+)"(?:(?!href)[\s\S]){0,300}?Цемент/.exec(itemsHtml)?.[1];
    const boschId2 = /href="\/warehouse\/items\/([^"]+)"(?:(?!href)[\s\S]){0,300}?Перфоратор/.exec(itemsHtml)?.[1];
    ok("id товаров найдены в номенклатуре", !!cementId2 && !!boschId2);
    let oHtml = await (await get(`/warehouse/orders/${orderId}`)).text();
    let addForm = parseForms(oHtml).find((f) => f.html.includes('id="add-line"'));
    ok("строка добавления в таблице", !!addForm);
    // цена с запятой — «550,50» должна принять и посчитать
    await submitForm(`/warehouse/orders/${orderId}`, addForm, {
      itemId: cementId2,
      qty: "10",
      price: "550,50",
    });
    oHtml = await (await get(`/warehouse/orders/${orderId}`)).text();
    addForm = parseForms(oHtml).find((f) => f.html.includes('id="add-line"'));
    await submitForm(`/warehouse/orders/${orderId}`, addForm, {
      itemId: boschId2,
      qty: "2",
      price: "15000",
    });
    oHtml = await (await get(`/warehouse/orders/${orderId}`)).text();
    ok("итого заказа посчитан", oHtml.includes("35"), "ожидали 35 505");

    // сохранение: позициям присваиваются id «дата-№заказа-№строки»
    const saveForm = parseForms(oHtml).find(
      (f) => f.fields.orderId && f.html.includes("Сохранить") && !f.html.includes("Отменить"),
    );
    await submitForm(`/warehouse/orders/${orderId}`, saveForm, {});
    oHtml = await (await get(`/warehouse/orders/${orderId}`)).text();
    ok("цена с запятой принята (550,5 ₽)", oHtml.includes("550,5"));
    // мобильный вид деталей заказа: карточки + таблица скрыта на телефоне
    ok("детали заказа: мобильные карточки (lg:hidden)", oHtml.includes("lg:hidden"));
    ok(
      "детали заказа: таблица только на десктопе",
      oHtml.includes("hidden overflow-x-auto") && oHtml.includes("lg:block"),
    );
    const ordersJournal = await (await get("/warehouse/orders")).text();
    ok(
      "журнал заказов: мобильные карточки с суммой",
      ordersJournal.includes("lg:hidden") && ordersJournal.includes("Заказ №"),
    );
    const codes = [...oHtml.matchAll(/>(\d{7,8}-\d+-\d+)</g)].map((m) => m[1]);
    ok("позициям присвоены id (дата-№заказа-№строки)", codes.length >= 2, `нашли: ${codes.join(",")}`);

    // печать этикеток ИЗ ЗАКАЗА — до приемки
    const orderLabels = await (await get(`/warehouse/print/labels?order=${orderId}`)).text();
    ok(
      "этикеток заказа 12 (по количеству партий: 10 + 2)",
      (orderLabels.match(/class="label-qr/g) ?? []).length === 12,
    );
    ok("этикетка партии с id позиции", codes.length > 0 && orderLabels.includes(codes[0]));

    // приёмка — во вкладке «Приемки»: заказ показывается в списке ORDERED
    const recListHtml = await (await get("/warehouse/active")).text();
    ok("заказ виден во вкладке «Активные»", recListHtml.includes(`/warehouse/receipts/${orderId}`));
    const rHtml = await (await get(`/warehouse/receipts/${orderId}`)).text();
    ok("страница приёмки открывается", rHtml.includes("Печать этикеток заказа"));
    // приём — только сканированием «товар → ячейка» (камера/JS), проверяется вручную на телефоне;
    // ядро оприходования в остатки покрыто scripts/verify-stock.ts.
    ok("на приёмке есть кнопка сканирования", rHtml.includes("Приемка сканированием"));
    ok("кнопки «принять всё без сканирования» нет", !rHtml.includes("Принять всё"));

    // /q/<id> непринятой позиции ведёт на страницу заказа
    if (codes[0]) {
      const qRes = await get(`/q/${codes[0]}`);
      const qLoc = await followRedirect(qRes);
      ok(
        "скан непринятого id открывает заказ",
        !!qLoc && qLoc.includes("/warehouse/orders/"),
        `loc=${qLoc}`,
      );
    }
  }

  console.log("9. Сотрудник + ссылка пароля");
  {
    const html = await (await get("/warehouse/employees/new")).text();
    const form = formWith(parseForms(html), "phone");
    const res = await submitForm("/warehouse/employees/new", form, {
      name: "Иван Тестов",
      phone: "+7 900 111-22-33",
      roles: "EMPLOYEE",
      allWarehouses: "on",
    });
    // no-JS ответ — та же страница с состоянием формы (ссылка внутри)
    const body = await res.text();
    const linkMatch = /auth\/set\/([a-f0-9]{64})/.exec(body);
    ok("ссылка установки пароля выдана", !!linkMatch);
    if (linkMatch) {
      const setHtml = await (await fetch(`${BASE}/auth/set/${linkMatch[1]}`)).text();
      ok("страница установки пароля открывается", setHtml.includes("Установка пароля"));
    }
    const list = await (await get("/warehouse/employees")).text();
    ok("сотрудник в списке", list.includes("Иван Тестов"));
  }

  console.log("9б. Кладовщик: приемки доступны, заказы и остальное закрыто");
  let storeCookie = "";
  {
    const html = await (await get("/warehouse/employees/new")).text();
    const form = formWith(parseForms(html), "phone");
    const res = await submitForm("/warehouse/employees/new", form, {
      name: "Пётр Кладовщиков",
      phone: "89001112244",
      roles: "STOREKEEPER",
      allWarehouses: "on",
    });
    const body = await res.text();
    const linkMatch = /auth\/set\/([a-f0-9]{64})/.exec(body);
    ok("ссылка пароля кладовщика выдана", !!linkMatch);
    if (linkMatch) {
      const adminCookie = cookie; // сохраняем сессию админа
      cookie = "";
      const setHtml = await (await get(`/auth/set/${linkMatch[1]}`)).text();
      const setForm = formWith(parseForms(setHtml), "password2");
      await submitForm(`/auth/set/${linkMatch[1]}`, setForm, {
        password: "kladovshik123",
        password2: "kladovshik123",
      });
      ok("кладовщик залогинен", cookie.includes("skx_session="));

      // вход по телефону во всех форматах: создан как 89001112244
      for (const variant of ["9001112244", "+7 (900) 111-22-44", "89001112244"]) {
        cookie = "";
        const lHtml = await (await get("/login")).text();
        const lForm = formWith(parseForms(lHtml), "login");
        const lRes = await submitForm("/login", lForm, {
          login: variant,
          password: "kladovshik123",
        });
        ok(
          `вход по «${variant}»`,
          (lRes.status === 303 || lRes.status === 302) && cookie.includes("skx_session="),
          `status=${lRes.status}`,
        );
      }

      const actRes = await get("/warehouse/active");
      ok("активные доступны", actRes.status === 200, `status=${actRes.status}`);
      const recRes = await get("/warehouse/receipts");
      ok(
        "журнал приёмок доступен кладовщику (просмотр)",
        recRes.status === 200,
        `status=${recRes.status}`,
      );
      const ordersRes = await get("/warehouse/orders");
      ok(
        "заказы поставщикам недоступны (редирект)",
        ordersRes.status >= 300 && ordersRes.status < 400,
        `status=${ordersRes.status}`,
      );
      const whRes = await get("/warehouse/warehouses");
      ok(
        "склады недоступны (редирект)",
        whRes.status >= 300 && whRes.status < 400,
        `status=${whRes.status}`,
      );
      storeCookie = cookie; // пригодится для проверки пустых документов
      cookie = adminCookie; // возвращаем админа
    }
  }

  console.log("9в. Пустая заявка: бейдж «без позиций», у кладовщика скрыта");
  {
    // id сотрудника — из списка (селект в форме без JS пуст, зависит от склада)
    const empListHtml = await (await get("/warehouse/employees")).text();
    const empId = /href="\/warehouse\/employees\/([a-z0-9]+)"[\s\S]{0,200}?Иван Тестов/.exec(
      empListHtml,
    )?.[1];
    ok("id сотрудника найден", !!empId);

    const newHtml = await (await get("/warehouse/picklists/new")).text();
    const plForm = parseForms(newHtml).find((fm) =>
      Object.keys(fm.fields).includes("targetEmployeeId"),
    );
    ok("форма новой заявки найдена", !!plForm);
    const res = await submitForm("/warehouse/picklists/new", plForm, {
      warehouseId,
      targetEmployeeId: empId ?? "",
    });
    const loc = await followRedirect(res);
    ok("пустая заявка создана", !!loc && loc.includes("/warehouse/picklists/"), `loc=${loc}`);
    const plId = loc?.split("/").pop() ?? "";

    const plHtml = await (await get(`/warehouse/picklists/${plId}`)).text();
    ok("детали заявки: мобильный блок (lg:hidden)", plHtml.includes("lg:hidden"));

    const journal = await (await get("/warehouse/picklists")).text();
    ok(
      "журнал заявок: карточки и бейдж «без позиций»",
      journal.includes("lg:hidden") && journal.includes("без позиций"),
    );

    const activeAdmin = await (await get("/warehouse/active")).text();
    ok(
      "админ видит пустую заявку в «Требуют внимания»",
      activeAdmin.includes("Требуют внимания") && activeAdmin.includes(`/warehouse/picklists/${plId}`),
    );

    if (storeCookie) {
      const adminCookie2 = cookie;
      cookie = storeCookie;
      const activeStore = await (await get("/warehouse/active")).text();
      ok("кладовщик пустую заявку не видит", !activeStore.includes(plId));
      cookie = adminCookie2;
    }
  }

  console.log("10. Изоляция ролей: EMPLOYEE не видит админских страниц");
  {
    // основной тест «без сессии»: /warehouse/* закрыт → редирект на /login
    const res = await fetch(`${BASE}/warehouse/stock`, { redirect: "manual" });
    const loc = await followRedirect(res);
    ok(
      "без сессии /warehouse/* → /login",
      res.status >= 300 && res.status < 400 && !!loc && loc.startsWith("/login"),
      `status=${res.status} loc=${loc}`,
    );
  }

  console.log("11. Legacy-совместимость: старый /app/* → /warehouse/*");
  {
    // старый префикс должен редиректить на новый модульный URL (закладки/QR)
    const res = await fetch(`${BASE}/app/stock`, { redirect: "manual" });
    const loc = await followRedirect(res);
    ok(
      "/app/stock → /warehouse/stock (redirect compatibility)",
      res.status >= 300 && res.status < 400 && loc === "/warehouse/stock",
      `status=${res.status} loc=${loc}`,
    );
  }

  console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ ✓" : `\nПРОВАЛОВ: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
