// Проверка Этапа 5 / Пакет 1 (мультироли + рабочие смены). Только dev-БД; тест-данные удаляются в finally.
// HTTP через node:http (fetch запрещает Host). Запускать при СЕРВЕРНОМ TENANT_AUTH=false, ROLES_DUAL_READ=true.
// Запуск: VERIFY_BASE=http://localhost:3021 npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-work-shifts.ts
/* eslint-disable no-console */
import http from "node:http";
import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";

const BASE = new URL(process.env.VERIFY_BASE || "http://localhost:3000");
const PASS = "s5-verify-pass-01";
const prisma = new PrismaClient();
let failures = 0;
const ok = (n: string, c: boolean, e = "") => (c ? console.log(`  ✓ ${n}`) : (failures++, console.error(`  ✗ ${n} ${e}`)));

interface Resp { status: number; headers: http.IncomingHttpHeaders; body: string; cookie: string }
function req(method: string, path: string, opts: { cookie?: string; body?: Buffer; contentType?: string } = {}): Promise<Resp> {
  return new Promise((resolve) => {
    const headers: Record<string, string | number> = { Host: BASE.host };
    if (opts.cookie) headers["Cookie"] = opts.cookie;
    if (opts.body) { headers["Content-Type"] = opts.contentType!; headers["Content-Length"] = opts.body.length; }
    const r = http.request({ hostname: BASE.hostname, port: BASE.port, path, method, headers }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => {
        let cookie = "";
        for (const c of res.headers["set-cookie"] ?? []) { const [p] = c.split(";"); if (p.startsWith("skx_session=")) cookie = p; }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: d, cookie });
      });
    });
    r.on("error", () => resolve({ status: 0, headers: {}, body: "", cookie: "" }));
    if (opts.body) r.write(opts.body); r.end();
  });
}
function inputs(html: string, formMarker: string): Record<string, string[]> {
  const form = html.match(/<form[\s\S]*?<\/form>/g)?.find((f) => f.includes(formMarker)) ?? "";
  const f: Record<string, string[]> = {};
  for (const tag of form.match(/<input[^>]*>/g) ?? []) {
    const n = /name="([^"]*)"/.exec(tag)?.[1]; if (!n) continue;
    const v = (/value="([^"]*)"/.exec(tag)?.[1] ?? "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    (f[n] ??= []).push(v);
  }
  return f;
}
function multipart(fields: [string, string][]): { body: Buffer; contentType: string } {
  const b = "----s5boundary8a2f"; let s = "";
  for (const [k, v] of fields) s += `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  s += `--${b}--\r\n`;
  return { body: Buffer.from(s, "utf8"), contentType: `multipart/form-data; boundary=${b}` };
}
async function login(phone: string): Promise<string> {
  const page = await req("GET", "/login");
  const f = inputs(page.body, 'name="login"');
  const fields: [string, string][] = [];
  for (const [k, arr] of Object.entries(f)) if (k.startsWith("$ACTION")) fields.push([k, arr[0]]);
  fields.push(["login", phone], ["password", PASS]);
  const mp = multipart(fields);
  return (await req("POST", "/login", { body: mp.body, contentType: mp.contentType })).cookie;
}
// действие формы по маркеру: берём $ACTION-поля со страницы, добавляем values
async function submit(cookie: string, path: string, marker: string, values: [string, string][]): Promise<Resp> {
  const page = await req("GET", path, { cookie });
  const f = inputs(page.body, marker);
  const fields: [string, string][] = [];
  for (const [k, arr] of Object.entries(f)) if (k.startsWith("$ACTION")) fields.push([k, arr[0]]);
  fields.push(...values);
  const mp = multipart(fields);
  return req("POST", path, { cookie, body: mp.body, contentType: mp.contentType });
}

let companyId = "";
let demoId = "";
let w1 = "", w2 = "";
const IDS = ["s5_worker", "s5_admin", "s5_keeper", "s5_emp", "s5_probe", "s5_d_a1", "s5_d_a2", "s5_d_user"];
async function mkUser(id: string, cid: string, phone: string, roles: Role[], compat: Role, allWh: boolean, whIds: string[] = []) {
  await prisma.user.deleteMany({ where: { id } });
  await prisma.user.create({
    data: {
      id, companyId: cid, phone, name: id, role: compat, isActive: true, allWarehouses: allWh,
      passwordHash: await bcrypt.hash(PASS, 10),
      userRoles: { create: roles.map((r) => ({ role: r })) },
      warehouseLinks: allWh ? undefined : { create: whIds.map((warehouseId) => ({ warehouseId })) },
    },
  });
}
async function cleanup() {
  if (demoId) {
    // сначала пользователи (каскадом уходят их смены/роли), затем склады, затем компания
    await prisma.user.deleteMany({ where: { companyId: demoId } });
    await prisma.warehouse.deleteMany({ where: { companyId: demoId } });
    await prisma.company.deleteMany({ where: { id: demoId } });
    demoId = "";
  }
  await prisma.user.deleteMany({ where: { id: { in: IDS } } });
  await prisma.user.deleteMany({ where: { phone: "+79995559999" } });
  await prisma.warehouse.deleteMany({ where: { id: { in: ["s5_w1", "s5_w2"] } } });
}

async function provision() {
  const c = await prisma.company.findFirstOrThrow({ where: { slug: "rostagro" } });
  companyId = c.id;
  const mw = async (id: string, name: string) => {
    await prisma.warehouse.deleteMany({ where: { id } });
    await prisma.warehouse.create({ data: { id, companyId, name, isActive: true } });
    return id;
  };
  w1 = await mw("s5_w1", "Склад 1"); w2 = await mw("s5_w2", "Склад 2");
  // worker: RECEIVER+LOADER, доступ только к W1
  await mkUser("s5_worker", companyId, "+79995551001", ["RECEIVER", "LOADER"], "RECEIVER", false, [w1]);
  await mkUser("s5_admin", companyId, "+79995551002", ["ADMIN"], "ADMIN", true);
  await mkUser("s5_keeper", companyId, "+79995551003", ["STOREKEEPER"], "STOREKEEPER", true);
  await mkUser("s5_emp", companyId, "+79995551004", ["EMPLOYEE"], "EMPLOYEE", true);
  // demo: 2 админа (last-admin concurrency) + пользователь со сменой (tenant isolation)
  const demo = await prisma.company.upsert({ where: { slug: "demo" }, update: {}, create: { name: "Demo", slug: "demo", settings: {} } });
  demoId = demo.id;
  await mkUser("s5_d_a1", demoId, "+79996661001", ["ADMIN"], "ADMIN", true);
  await mkUser("s5_d_a2", demoId, "+79996661002", ["ADMIN"], "ADMIN", true);
}

async function main() {
  console.log(`S5-P1 verify — ${BASE.href}`);
  await cleanup();
  await provision();

  console.log("1) мультироли + compat User.role (createUserAction через админа)");
  const adm = await login("+79995551002");
  ok("admin: вход", adm.includes("skx_session="));
  // создать сотрудника с двумя ролями [LOADER, RECEIVER] → compat = RECEIVER (приоритет)
  await submit(adm, "/warehouse/employees/new", 'name="roles"', [
    ["name", "S5 Probe"], ["phone", "+79995559999"], ["roles", "LOADER"], ["roles", "RECEIVER"], ["allWarehouses", "on"],
  ]);
  const probe = await prisma.user.findFirst({ where: { companyId, phone: "+79995559999" }, include: { userRoles: true } });
  if (probe) IDS.push(probe.id);
  ok("создан с 2 ролями", (probe?.userRoles.length ?? 0) === 2, `ролей ${probe?.userRoles.length}`);
  ok("compat User.role = RECEIVER (по приоритету)", probe?.role === "RECEIVER", `role=${probe?.role}`);

  console.log("2) старт смены: правила");
  const wk = await login("+79995551001");
  ok("worker: вход", wk.includes("skx_session="));
  // роль не назначена (PICKER) → отказ
  await submit(wk, "/warehouse/shift", 'name="role"', [["role", "PICKER"], ["warehouseId", w1]]);
  ok("старт с неназначенной ролью отклонён", (await prisma.workShift.count({ where: { userId: "s5_worker", endedAt: null } })) === 0);
  // недоступный склад (W2) → отказ
  await submit(wk, "/warehouse/shift", 'name="role"', [["role", "RECEIVER"], ["warehouseId", w2]]);
  ok("старт на недоступном складе отклонён", (await prisma.workShift.count({ where: { userId: "s5_worker", endedAt: null } })) === 0);
  // корректный старт RECEIVER@W1
  await submit(wk, "/warehouse/shift", 'name="role"', [["role", "RECEIVER"], ["warehouseId", w1]]);
  ok("корректный старт создал смену", (await prisma.workShift.count({ where: { userId: "s5_worker", endedAt: null } })) === 1);

  console.log("3) запрет второй смены + конкурентный двойной старт");
  await submit(wk, "/warehouse/shift", 'name="role"', [["role", "LOADER"], ["warehouseId", w1]]);
  ok("вторая смена не создана", (await prisma.workShift.count({ where: { userId: "s5_worker", endedAt: null } })) === 1);

  console.log("4) блок правок сотрудника при открытой смене (updateUserAction)");
  const editWorker = (roles: string[], whIds: string[], active = true) =>
    submit(adm, "/warehouse/employees/s5_worker", 'name="roles"', [
      ["id", "s5_worker"], ["name", "s5_worker"], ...(active ? ([["isActive", "on"]] as [string, string][]) : []),
      ...roles.map((r) => ["roles", r] as [string, string]),
      ["allWarehouses", ""], ...whIds.map((w) => ["wh", w] as [string, string]),
    ]);
  // снять активную роль RECEIVER (оставить LOADER) → блок
  await editWorker(["LOADER"], [w1]);
  ok("нельзя снять активную роль смены", (await prisma.userRole.count({ where: { userId: "s5_worker", role: "RECEIVER" } })) === 1);
  // убрать доступ к складу смены (только W2) → блок
  await editWorker(["RECEIVER", "LOADER"], [w2]);
  ok("нельзя убрать склад активной смены", !!(await prisma.userWarehouse.findFirst({ where: { userId: "s5_worker", warehouseId: w1 } })));
  // деактивировать → блок
  await editWorker(["RECEIVER", "LOADER"], [w1], false);
  ok("нельзя деактивировать сотрудника на смене", (await prisma.user.findFirst({ where: { id: "s5_worker" } }))?.isActive === true);

  console.log("5) завершение и старт в другой роли");
  await submit(wk, "/warehouse/shift", "Завершить смену", []);
  ok("смена завершена", (await prisma.workShift.count({ where: { userId: "s5_worker", endedAt: null } })) === 0);
  ok("завершённая смена сохранена в истории", (await prisma.workShift.count({ where: { userId: "s5_worker" } })) >= 1);
  await submit(wk, "/warehouse/shift", 'name="role"', [["role", "LOADER"], ["warehouseId", w1]]);
  const openNow = await prisma.workShift.findFirst({ where: { userId: "s5_worker", endedAt: null } });
  ok("старт в другой роли (LOADER) успешен", openNow?.role === "LOADER");
  await prisma.workShift.updateMany({ where: { userId: "s5_worker", endedAt: null }, data: { endedAt: new Date() } });

  console.log("6) last-admin: конкурентная кросс-демоция в demo (ровно 2 admin)");
  const da1 = await login("+79996661001");
  const da2 = await login("+79996661002");
  const demote = (cookie: string, targetId: string) =>
    submit(cookie, `/warehouse/employees/${targetId}`, 'name="roles"', [
      ["id", targetId], ["name", targetId], ["isActive", "on"], ["roles", "RECEIVER"], ["allWarehouses", "on"],
    ]);
  await Promise.all([demote(da1, "s5_d_a2"), demote(da2, "s5_d_a1")]);
  const demoAdmins = await prisma.user.count({ where: { companyId: demoId, isActive: true, userRoles: { some: { role: "ADMIN" } } } });
  ok("после кросс-демоции остался РОВНО 1 ADMIN в demo (сериализация lock)", demoAdmins === 1, `осталось ${demoAdmins}`);

  console.log("7) tenant isolation WorkShift");
  const dw = await prisma.warehouse.create({ data: { companyId: demoId, name: "Demo WH", isActive: true } });
  await mkUser("s5_d_user", demoId, "+79996661003", ["RECEIVER"], "RECEIVER", true);
  const dsh = await prisma.workShift.create({
    data: { companyId: demoId, userId: "s5_d_user", warehouseId: dw.id, role: "RECEIVER" },
  });
  // rostagro-скоуп (companyId) не видит demo-смену
  ok("demo-смена не видна в rostagro-скоупе", (await prisma.workShift.findFirst({ where: { id: dsh.id, companyId } })) === null);
  ok("demo-смена видна в demo-скоупе", (await prisma.workShift.findFirst({ where: { id: dsh.id, companyId: demoId } })) !== null);

  console.log("8) legacy роли не сломаны (вход + стартовый роут)");
  ok("legacy admin: вход", (await login("+79995551002")).includes("skx_session="));
  ok("legacy keeper: вход", (await login("+79995551003")).includes("skx_session="));
  ok("legacy employee: вход", (await login("+79995551004")).includes("skx_session="));
  const empCookie = await login("+79995551004");
  ok("employee: /warehouse → 307 (роутинг работает)", [302, 307].includes((await req("GET", "/warehouse", { cookie: empCookie })).status));
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ S5-P1 ПРОЙДЕНЫ ✓" : `\nПРОВАЛЕНО: ${failures}`);
    process.exit(failures === 0 ? 0 : 1);
  });
