// Проверка Этапа 4B/S3 (tenant-auth). Запускать при СЕРВЕРНОМ TENANT_AUTH=true.
// Провижн — только dev-БД; временная организация demo и тест-пользователи удаляются в finally.
// Секретов в репозитории нет (тестовый пароль — не секрет).
// HTTP через node:http (не fetch): fetch/undici ЗАПРЕЩАЕТ задавать заголовок Host, а он тут ключевой.
// Запуск: VERIFY_BASE=http://localhost:3021 npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-tenant-s3.ts
/* eslint-disable no-console */
import http from "node:http";
import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { resolveOrgSlug } from "@/lib/tenant-host";

const BASE = new URL(process.env.VERIFY_BASE || "http://localhost:3000");
const PASS = "s3-verify-pass-01";
const H_ROSTAGRO = "rostagro.skladyx.ru";
const H_DEMO = "demo.skladyx.ru";
const H_UNKNOWN = "nope.skladyx.ru";
const prisma = new PrismaClient();
let failures = 0;
const ok = (n: string, c: boolean, e = "") =>
  c ? console.log(`  ✓ ${n}`) : (failures++, console.error(`  ✗ ${n} ${e}`));

interface Resp { status: number; headers: http.IncomingHttpHeaders; body: string; cookie: string }

// Запрос с ЯВНЫМ Host (node:http позволяет то, что запрещает fetch).
function req(
  method: string,
  host: string,
  path: string,
  opts: { cookie?: string; body?: Buffer; contentType?: string } = {},
): Promise<Resp> {
  return new Promise((resolve) => {
    const headers: Record<string, string | number> = { Host: host };
    if (opts.cookie) headers["Cookie"] = opts.cookie;
    if (opts.body) {
      headers["Content-Type"] = opts.contentType!;
      headers["Content-Length"] = opts.body.length;
    }
    const r = http.request(
      { hostname: BASE.hostname, port: BASE.port, path, method, headers },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          let cookie = "";
          for (const c of res.headers["set-cookie"] ?? []) {
            const [p] = c.split(";");
            if (p.startsWith("skx_session=")) cookie = p;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: d, cookie });
        });
      },
    );
    r.on("error", () => resolve({ status: 0, headers: {}, body: "", cookie: "" }));
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

function actionFields(html: string, marker: string): Record<string, string> {
  const form = html.match(/<form[\s\S]*?<\/form>/g)?.find((f) => f.includes(marker)) ?? "";
  const f: Record<string, string> = {};
  for (const inp of form.match(/<input[^>]*>/g) ?? []) {
    const n = /name="([^"]*)"/.exec(inp)?.[1];
    if (n) f[n] = (/value="([^"]*)"/.exec(inp)?.[1] ?? "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  }
  return f;
}
function multipart(fields: Record<string, string>): { body: Buffer; contentType: string } {
  const boundary = "----s3verifyboundary7f3a";
  let s = "";
  for (const [k, v] of Object.entries(fields)) {
    s += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  }
  s += `--${boundary}--\r\n`;
  return { body: Buffer.from(s, "utf8"), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function loginVia(host: string, phone: string): Promise<string> {
  const page = await req("GET", host, "/login");
  const fields = actionFields(page.body, 'name="login"');
  const send: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) if (k.startsWith("$ACTION")) send[k] = v;
  send.login = phone;
  send.password = PASS;
  const mp = multipart(send);
  const res = await req("POST", host, "/login", { body: mp.body, contentType: mp.contentType });
  return res.cookie;
}
const allowed = async (host: string, cookie: string, path: string) =>
  (await req("GET", host, path, { cookie })).status === 200;

let demoId = "";
let rostagroId = "";
async function upsertUser(companyId: string, id: string, phone: string, role: Role, roles: Role[], name: string, isActive = true) {
  await prisma.user.deleteMany({ where: { id } });
  await prisma.user.create({
    data: {
      id, companyId, phone, name, role, isActive, allWarehouses: true,
      passwordHash: await bcrypt.hash(PASS, 10),
      userRoles: roles.length ? { create: roles.map((r) => ({ role: r })) } : undefined,
    },
  });
}
const ALL_IDS = [
  "s3_r_admin", "s3_r_keeper", "s3_r_keadm", "s3_r_nourole", "s3_r_emp", "s3_r_shared",
  "s3_d_shared", "s3_d_adminA", "s3_d_adminB",
];
async function cleanup() {
  await prisma.user.deleteMany({ where: { id: { in: ALL_IDS } } });
  if (demoId) await prisma.company.deleteMany({ where: { id: demoId, slug: "demo" } });
}
async function provision() {
  const rostagro = await prisma.company.findFirstOrThrow({ where: { slug: "rostagro" } });
  rostagroId = rostagro.id;
  const demo = await prisma.company.upsert({
    where: { slug: "demo" }, update: {}, create: { name: "Demo Org", slug: "demo", settings: {} },
  });
  demoId = demo.id;
  await upsertUser(rostagroId, "s3_r_admin", "+79991110001", "ADMIN", ["ADMIN"], "R Admin");
  await upsertUser(rostagroId, "s3_r_keeper", "+79991110002", "STOREKEEPER", ["STOREKEEPER"], "R Keeper");
  await upsertUser(rostagroId, "s3_r_keadm", "+79991110003", "STOREKEEPER", ["STOREKEEPER", "ADMIN"], "R KeAdm");
  await upsertUser(rostagroId, "s3_r_nourole", "+79991110004", "STOREKEEPER", [], "R NoRole");
  await upsertUser(rostagroId, "s3_r_emp", "+79991110005", "EMPLOYEE", ["EMPLOYEE"], "R Emp");
  await upsertUser(rostagroId, "s3_r_shared", "+79990009999", "ADMIN", ["ADMIN"], "R Shared");
  await upsertUser(demoId, "s3_d_shared", "+79990009999", "EMPLOYEE", ["EMPLOYEE"], "D Shared");
  await upsertUser(demoId, "s3_d_adminA", "+79992220001", "ADMIN", ["ADMIN"], "D AdminA");
  await upsertUser(demoId, "s3_d_adminB", "+79992220002", "ADMIN", ["ADMIN"], "D AdminB");
}

async function demote(actorCookie: string, targetId: string) {
  const page = await req("GET", H_DEMO, `/warehouse/employees/${targetId}`, { cookie: actorCookie });
  const fields = actionFields(page.body, 'name="role"');
  if (!Object.keys(fields).includes("id")) return;
  const send: Record<string, string> = { ...fields };
  send.id = targetId; send.name = "demoted"; send.role = "EMPLOYEE"; send.allWarehouses = "on"; send.isActive = "on";
  const mp = multipart(send);
  await req("POST", H_DEMO, `/warehouse/employees/${targetId}`, { cookie: actorCookie, body: mp.body, contentType: mp.contentType });
}

async function main() {
  console.log(`S3 verify — ${BASE.href} (сервер должен быть с TENANT_AUTH=true)`);

  console.log("0) юнит resolveOrgSlug");
  const p = { baseDomain: "skladyx.ru", prefix: "", defaultSlug: "rostagro", isProd: true };
  const st = { baseDomain: "skladyx.ru", prefix: "staging-", defaultSlug: "rostagro", isProd: true };
  const slug = (h: string, o = p) => (resolveOrgSlug(h, o) as { slug: string | null }).slug;
  ok("rostagro.skladyx.ru → rostagro", slug("rostagro.skladyx.ru") === "rostagro");
  ok("demo.skladyx.ru → demo", slug("demo.skladyx.ru") === "demo");
  ok("staging-rostagro (prefix) → rostagro", slug("staging-rostagro.skladyx.ru", st) === "rostagro");
  ok("apex skladyx.ru → отказ (prod)", slug("skladyx.ru") === null);
  ok("www → отказ (prod)", slug("www.skladyx.ru") === null);
  ok("чужой домен → отказ (prod)", slug("evil.com") === null);
  ok("прямой IP → отказ (prod)", slug("104.171.136.35") === null);
  ok("localhost → default (dev)", slug("localhost", { ...p, isProd: false }) === "rostagro");

  console.log("1) провижн (rostagro + временная demo)");
  await provision();
  console.log("   demo:", demoId.slice(0, 8), "rostagro:", rostagroId.slice(0, 8));

  console.log("2) вход через правильный поддомен");
  const rAdmin = await loginVia(H_ROSTAGRO, "+79991110001");
  ok("rostagro admin: вход", rAdmin.includes("skx_session="));
  ok("rostagro admin: admin-доступ", await allowed(H_ROSTAGRO, rAdmin, "/warehouse/orders"));

  console.log("3) неизвестный поддомен — вход запрещён, формы нет");
  const unknownPage = await req("GET", H_UNKNOWN, "/login");
  ok("unknown host: нет формы логина", !unknownPage.body.includes('name="login"'));
  ok("unknown host: сессия не создана", !(await loginVia(H_UNKNOWN, "+79991110001")).includes("skx_session="));

  console.log("4) одинаковый телефон в разных организациях — разные User");
  const rShared = await loginVia(H_ROSTAGRO, "+79990009999"); // R Shared = ADMIN
  const dShared = await loginVia(H_DEMO, "+79990009999"); // D Shared = EMPLOYEE
  ok("rostagro shared: вход", rShared.includes("skx_session="));
  ok("demo shared: вход", dShared.includes("skx_session="));
  ok("rostagro shared → admin (ADMIN)", await allowed(H_ROSTAGRO, rShared, "/warehouse/orders"));
  ok("demo shared → НЕ admin (EMPLOYEE)", !(await allowed(H_DEMO, dShared, "/warehouse/orders")));

  console.log("5) одинаковый телефон внутри одной компании — запрещён (composite unique)");
  let dupThrew = false;
  try {
    await prisma.user.create({
      data: { id: "s3_dup_tmp", companyId: rostagroId, phone: "+79991110001", name: "dup", role: "EMPLOYEE", passwordHash: "x" },
    });
  } catch { dupThrew = true; }
  await prisma.user.deleteMany({ where: { id: "s3_dup_tmp" } });
  ok("дубль (companyId, phone) отклонён БД", dupThrew);

  console.log("6) cookie одной организации на host другой — отказ");
  const crossW = await req("GET", H_DEMO, "/warehouse/orders", { cookie: rAdmin });
  ok("rostagro cookie на demo host: /warehouse не 200", crossW.status !== 200);
  const crossQr = await req("GET", H_DEMO, "/q/ZZZZZZZZZZ", { cookie: rAdmin });
  ok("rostagro cookie на demo host: /q → login (не раскрывает)", /\/login/.test((crossQr.headers["location"] as string) || ""));

  console.log("7) блокировка действует со следующего запроса");
  const kCookie = await loginVia(H_ROSTAGRO, "+79991110002"); // keeper
  ok("keeper: staff до блокировки", await allowed(H_ROSTAGRO, kCookie, "/warehouse/active"));
  await prisma.user.update({ where: { id: "s3_r_keeper" }, data: { isActive: false } });
  ok("keeper: после блокировки закрыт", !(await allowed(H_ROSTAGRO, kCookie, "/warehouse/active")));
  await prisma.user.update({ where: { id: "s3_r_keeper" }, data: { isActive: true } });

  console.log("8) смена ролей действует без нового входа");
  ok("keeper: admin закрыт (STOREKEEPER)", !(await allowed(H_ROSTAGRO, kCookie, "/warehouse/orders")));
  await prisma.userRole.create({ data: { userId: "s3_r_keeper", role: "ADMIN" } });
  ok("keeper: +ADMIN → admin открыт (без релогина)", await allowed(H_ROSTAGRO, kCookie, "/warehouse/orders"));
  await prisma.userRole.deleteMany({ where: { userId: "s3_r_keeper", role: "ADMIN" } });
  ok("keeper: −ADMIN → admin закрыт (без релогина)", !(await allowed(H_ROSTAGRO, kCookie, "/warehouse/orders")));

  console.log("9) fallback на User.role (нет строк UserRole)");
  const nrCookie = await loginVia(H_ROSTAGRO, "+79991110004");
  ok("nourole: staff через User.role", await allowed(H_ROSTAGRO, nrCookie, "/warehouse/active"));
  ok("nourole: admin закрыт", !(await allowed(H_ROSTAGRO, nrCookie, "/warehouse/orders")));

  console.log("10) EMPLOYEE без прав");
  const eCookie = await loginVia(H_ROSTAGRO, "+79991110005");
  ok("emp: admin закрыт", !(await allowed(H_ROSTAGRO, eCookie, "/warehouse/orders")));
  ok("emp: staff закрыт", !(await allowed(H_ROSTAGRO, eCookie, "/warehouse/active")));

  console.log("11) последний ADMIN: конкурентная кросс-демоция в demo (ровно 2 admin)");
  const aA = await loginVia(H_DEMO, "+79992220001");
  const aB = await loginVia(H_DEMO, "+79992220002");
  ok("demo adminA: вход", aA.includes("skx_session="));
  ok("demo adminB: вход", aB.includes("skx_session="));
  await Promise.all([demote(aA, "s3_d_adminB"), demote(aB, "s3_d_adminA")]);
  const demoAdmins = await prisma.user.count({
    where: { companyId: demoId, isActive: true, userRoles: { some: { role: "ADMIN" } } },
  });
  ok("после кросс-демоции остался ≥1 активный ADMIN", demoAdmins >= 1, `осталось ${demoAdmins}`);
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ S3 ПРОЙДЕНЫ ✓" : `\nПРОВАЛЕНО: ${failures}`);
    process.exit(failures === 0 ? 0 : 1);
  });
