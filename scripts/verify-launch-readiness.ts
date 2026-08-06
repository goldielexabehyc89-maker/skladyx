// Проверка Этапа 5/Пакет 10 (коррекция) — чек-лист готовности считается строго по единственному
// активному складу; ячейки неактивных/других складов не учитываются. Только dev/CI-БД; тест-данные
// удаляются в finally. Запуск: npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-launch-readiness.ts
/* eslint-disable no-console */
import { PrismaClient } from "@prisma/client";
import { getLaunchReadiness } from "@/lib/launch-readiness";
import { ensureStandardZones, createCellsInZone } from "@/lib/cells";

const prisma = new PrismaClient();
let failures = 0;
const ok = (n: string, c: boolean, e = "") => (c ? console.log(`  ✓ ${n}`) : (failures++, console.error(`  ✗ ${n} ${e}`)));

const SLUG = process.env.SEED_COMPANY_SLUG || "rostagro";
const P = "LR10-";
let companyId = "";
let A = "", B = "";
let deactivated: string[] = [];

const check = (r: Awaited<ReturnType<typeof getLaunchReadiness>>, label: string) => r.checks.find((c) => c.label.startsWith(label));

async function zone(wh: string, kind: string) {
  return (await prisma.warehouseZone.findFirstOrThrow({ where: { warehouseId: wh, kind: kind as never } })).id;
}

async function setup() {
  companyId = (await prisma.company.findFirstOrThrow({ where: { slug: SLUG } })).id;
  const act = await prisma.warehouse.findMany({ where: { companyId, isActive: true }, select: { id: true } });
  deactivated = act.map((w) => w.id);
  if (deactivated.length) await prisma.warehouse.updateMany({ where: { id: { in: deactivated } }, data: { isActive: false } });

  // A — активный, но ПУСТОЙ (зоны есть, ячеек нет)
  A = (await prisma.warehouse.create({ data: { companyId, name: `${P}A`, isActive: true } })).id;
  await ensureStandardZones(companyId, A);

  // B — НЕАКТИВНЫЙ, но с полным набором ячеек
  B = (await prisma.warehouse.create({ data: { companyId, name: `${P}B`, isActive: true } })).id;
  await ensureStandardZones(companyId, B);
  await createCellsInZone({ companyId, warehouseId: B, zoneId: await zone(B, "STORAGE"), codes: [`${P}B-S1`], level: 1 });
  await createCellsInZone({ companyId, warehouseId: B, zoneId: await zone(B, "STORAGE"), codes: [`${P}B-S2`], level: 2 });
  await createCellsInZone({ companyId, warehouseId: B, zoneId: await zone(B, "STORAGE"), codes: [`${P}B-S3`], level: 3 });
  await createCellsInZone({ companyId, warehouseId: B, zoneId: await zone(B, "COOLING"), codes: [`${P}B-C1`], level: null });
  await createCellsInZone({ companyId, warehouseId: B, zoneId: await zone(B, "ISSUE"), codes: [`${P}B-I1`], level: null });
  await createCellsInZone({ companyId, warehouseId: B, zoneId: await zone(B, "BUFFER"), codes: [`${P}B-BF1`], level: null });
  await prisma.warehouse.update({ where: { id: B }, data: { isActive: false } });
}

async function cleanup() {
  for (const wh of [A, B].filter(Boolean)) {
    await prisma.cell.deleteMany({ where: { warehouseId: wh } });
    await prisma.warehouseZone.deleteMany({ where: { warehouseId: wh } });
  }
  await prisma.warehouse.deleteMany({ where: { companyId, name: { startsWith: P } } });
  if (deactivated.length) await prisma.warehouse.updateMany({ where: { id: { in: deactivated } }, data: { isActive: true } });
}

async function main() {
  await setup();

  console.log("1) единственный активный склад пуст, полный набор ячеек — у НЕАКТИВНОГО B");
  {
    const r = await getLaunchReadiness(companyId, 5);
    ok("ровно один активный склад (A)", check(r, "Ровно один активный склад")?.ok === true, JSON.stringify(check(r, "Ровно один")));
    ok("STORAGE 1/2/3+ КРАСНЫЙ (ячейки B не в счёт)", check(r, "STORAGE")?.ok === false, JSON.stringify(check(r, "STORAGE")));
    ok("COOLING/ISSUE/BUFFER КРАСНЫЙ (ячейки B не в счёт)", check(r, "Физические")?.ok === false, JSON.stringify(check(r, "Физические")));
  }

  console.log("2) два активных склада → все склад-зависимые проверки красные");
  {
    await prisma.warehouse.update({ where: { id: B }, data: { isActive: true } }); // теперь 2 активных
    const r = await getLaunchReadiness(companyId, 5);
    ok("«ровно один активный склад» КРАСНЫЙ", check(r, "Ровно один активный склад")?.ok === false);
    ok("STORAGE КРАСНЫЙ при 2 активных", check(r, "STORAGE")?.ok === false);
    ok("COOLING/ISSUE/BUFFER КРАСНЫЙ при 2 активных", check(r, "Физические")?.ok === false);
    await prisma.warehouse.update({ where: { id: B }, data: { isActive: false } });
  }

  console.log("3) контроль: если ячейки перенести в активный A — станет зелёным");
  {
    // переносим ячейки B в зоны A того же kind (проверяем, что по активному складу считается верно)
    for (const [kind, code] of [["STORAGE", `${P}B-S1`], ["STORAGE", `${P}B-S2`], ["STORAGE", `${P}B-S3`], ["COOLING", `${P}B-C1`], ["ISSUE", `${P}B-I1`], ["BUFFER", `${P}B-BF1`]] as const) {
      const c = await prisma.cell.findFirstOrThrow({ where: { warehouseId: B, code } });
      await prisma.cell.update({ where: { id: c.id }, data: { warehouseId: A, zoneId: await zone(A, kind) } });
    }
    const r = await getLaunchReadiness(companyId, 5);
    ok("STORAGE 1/2/3+ ЗЕЛЁНЫЙ по активному A", check(r, "STORAGE")?.ok === true, JSON.stringify(check(r, "STORAGE")));
    ok("COOLING/ISSUE/BUFFER ЗЕЛЁНЫЙ по активному A", check(r, "Физические")?.ok === true, JSON.stringify(check(r, "Физические")));
  }
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ P10 (готовность) ПРОЙДЕНЫ ✓" : `\nПРОВАЛЕНО: ${failures}`);
    process.exit(failures === 0 ? 0 : 1);
  });
