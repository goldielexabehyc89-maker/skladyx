// Проверка Этапа 4B/S2 (dual-read ролей). Не содержит паролей/секретов.
// Требует dev-сервер (обычный или после verify-http) и dev-БД.
// Запуск (flag=false):  EXPECT_DUAL_READ=false VERIFY_BASE=http://localhost:3001 \
//   npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-roles-s2.ts
// Запуск (flag=true):   ROLES_DUAL_READ на СЕРВЕРЕ=true, затем EXPECT_DUAL_READ=true ... тот же скрипт.
// EXPECT_DUAL_READ описывает ОЖИДАЕМОЕ поведение сервера (должно совпадать с флагом сервера).
/* eslint-disable no-console */
import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { sanitizeRoles } from "@/lib/jwt";

const BASE = process.env.VERIFY_BASE || "http://localhost:3000";
const EXPECT = process.env.EXPECT_DUAL_READ === "true";
const PASS = "s2-verify-pass-01"; // тестовый пароль только для dev-провижна, не секрет
const prisma = new PrismaClient();
let failures = 0;
const ok = (name: string, cond: boolean, extra = "") =>
  cond ? console.log(`  ✓ ${name}`) : (failures++, console.error(`  ✗ ${name} ${extra}`));

// ── тест-пользователи: (ключ, телефон, legacy User.role, набор UserRole) ──
const USERS = [
  { key: "tadmin", phone: "+79990000001", role: "ADMIN" as Role, roles: ["ADMIN"] as Role[] },
  { key: "tkeeper", phone: "+79990000002", role: "STOREKEEPER" as Role, roles: ["STOREKEEPER"] as Role[] },
  { key: "tkeadm", phone: "+79990000003", role: "STOREKEEPER" as Role, roles: ["STOREKEEPER", "ADMIN"] as Role[] },
  { key: "temp", phone: "+79990000004", role: "EMPLOYEE" as Role, roles: ["EMPLOYEE"] as Role[] },
  { key: "tkeemp", phone: "+79990000005", role: "STOREKEEPER" as Role, roles: ["STOREKEEPER", "EMPLOYEE"] as Role[] },
  { key: "tnourole", phone: "+79990000006", role: "STOREKEEPER" as Role, roles: [] as Role[] }, // fallback: строк UserRole нет
];
const PHONES = USERS.map((u) => u.phone);

// эффективный набор ролей с учётом ожидаемого флага (зеркало @/lib/roles)
function effective(u: (typeof USERS)[number]): Role[] {
  if (!EXPECT) return [u.role];
  return u.roles.length > 0 ? u.roles : [u.role];
}
const expectAdmin = (u: (typeof USERS)[number]) => effective(u).includes("ADMIN");
const expectStaff = (u: (typeof USERS)[number]) =>
  effective(u).some((r) => r === "ADMIN" || r === "STOREKEEPER");

// ── HTTP helpers ──
function parseForm(html: string): Record<string, string> {
  const m = html.match(/<form[\s\S]*?<\/form>/g)?.find((f) => f.includes('name="login"')) ?? "";
  const fields: Record<string, string> = {};
  for (const inp of m.match(/<input[^>]*>/g) ?? []) {
    const n = /name="([^"]*)"/.exec(inp)?.[1];
    if (n) fields[n] = (/value="([^"]*)"/.exec(inp)?.[1] ?? "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  }
  return fields;
}
async function loginCookie(phone: string): Promise<string> {
  const html = await (await fetch(`${BASE}/login`, { redirect: "manual" })).text();
  const fields = parseForm(html);
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (k.startsWith("$ACTION")) fd.set(k, v);
  fd.set("login", phone);
  fd.set("password", PASS);
  const res = await fetch(`${BASE}/login`, { method: "POST", body: fd, redirect: "manual" });
  let cookie = "";
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    if (pair.startsWith("skx_session=")) cookie = pair;
  }
  return cookie;
}
// 200 = доступ разрешён; 307/302 (редирект на /warehouse|/login) = запрещён
async function allowed(cookie: string, path: string): Promise<boolean> {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
  return res.status === 200;
}

async function provision() {
  const company = await prisma.company.findFirstOrThrow();
  const passwordHash = await bcrypt.hash(PASS, 10);
  for (const u of USERS) {
    // пересоздаём чисто, чтобы набор UserRole был детерминированным
    await prisma.user.deleteMany({ where: { phone: u.phone } });
    await prisma.user.create({
      data: {
        companyId: company.id,
        phone: u.phone,
        name: `S2 ${u.key}`,
        role: u.role,
        passwordHash,
        isActive: true,
        allWarehouses: true,
        userRoles: u.roles.length ? { create: u.roles.map((role) => ({ role })) } : undefined,
      },
    });
  }
}

async function main() {
  console.log(`S2 verify — EXPECT_DUAL_READ=${EXPECT} — ${BASE}`);

  console.log("0) юнит sanitizeRoles");
  ok("нет roles → [role] (старый JWT)", JSON.stringify(sanitizeRoles(undefined, "ADMIN")) === '["ADMIN"]');
  ok("дедуп + отброс невалидных", JSON.stringify(sanitizeRoles(["ADMIN", "ADMIN", "X"], "EMPLOYEE")) === '["ADMIN"]');
  ok("все невалидные → [fallback]", JSON.stringify(sanitizeRoles(["BOGUS"], "STOREKEEPER")) === '["STOREKEEPER"]');
  ok("пустой массив → [fallback]", JSON.stringify(sanitizeRoles([], "ADMIN")) === '["ADMIN"]');

  console.log("1) провижн тест-пользователей (dev-БД)");
  await provision();
  console.log("   создано:", USERS.length);

  console.log("2) матрица доступа (admin=/warehouse/orders, staff=/warehouse/active)");
  for (const u of USERS) {
    const cookie = await loginCookie(u.phone);
    if (!cookie.includes("skx_session=")) {
      ok(`${u.key}: вход`, false, "нет cookie");
      continue;
    }
    const gotAdmin = await allowed(cookie, "/warehouse/orders");
    const gotStaff = await allowed(cookie, "/warehouse/active");
    const eAdmin = expectAdmin(u);
    const eStaff = expectStaff(u);
    ok(`${u.key}: admin-доступ = ${eAdmin}`, gotAdmin === eAdmin, `получено ${gotAdmin} (роли=${u.role}/[${u.roles}])`);
    ok(`${u.key}: staff-доступ = ${eStaff}`, gotStaff === eStaff, `получено ${gotStaff}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(async () => {
    // восстановление dev-БД: удаляем тест-пользователей (UserRole уходит по каскаду)
    await prisma.user.deleteMany({ where: { phone: { in: PHONES } } });
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ S2 ПРОЙДЕНЫ ✓" : `\nПРОВАЛЕНО: ${failures}`);
    process.exit(failures === 0 ? 0 : 1);
  });
