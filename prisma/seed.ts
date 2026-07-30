import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";

// Первичный seed: компания, администратор, единицы измерения.
// Никаких демо-данных — только то, без чего система не стартует.

const prisma = new PrismaClient();

const UOMS: { name: string; allowFraction: boolean }[] = [
  { name: "шт", allowFraction: false },
  { name: "кг", allowFraction: true },
  { name: "м", allowFraction: true },
];

async function main() {
  const companyName = process.env.SEED_COMPANY_NAME || "РостАгро";
  const companySlug = process.env.SEED_COMPANY_SLUG || "rostagro";
  const adminEmail = (process.env.SEED_ADMIN_EMAIL || "admin@skladyx.ru")
    .toLowerCase()
    .trim();
  // логин — телефон; email оставлен как legacy-вход
  const adminPhone = process.env.SEED_ADMIN_PHONE?.trim() || null;
  const adminName = process.env.SEED_ADMIN_NAME || "Администратор";
  let adminPassword = process.env.SEED_ADMIN_PASSWORD || "";
  const generated = !adminPassword;
  if (generated) adminPassword = crypto.randomBytes(9).toString("base64url");

  const company = await prisma.company.upsert({
    where: { slug: companySlug },
    update: {},
    create: { name: companyName, slug: companySlug, settings: {} },
  });

  // S3: поиск в пределах организации (phone/email больше не глобально-уникальны)
  const existingAdmin = await prisma.user.findFirst({
    where: { companyId: company.id, email: adminEmail },
  });
  if (!existingAdmin) {
    await prisma.user.create({
      data: {
        companyId: company.id,
        email: adminEmail,
        phone: adminPhone,
        name: adminName,
        role: "ADMIN",
        passwordHash: await bcrypt.hash(adminPassword, 10),
        // S1 shadow dual-write: роль в UserRole
        userRoles: { create: { role: "ADMIN" } },
      },
    });
    console.log(`Админ создан: ${adminPhone ?? adminEmail} / ${adminPassword}${generated ? " (пароль сгенерирован — смените после входа)" : ""}`);
  } else {
    if (adminPhone && !existingAdmin.phone) {
      await prisma.user.update({ where: { id: existingAdmin.id }, data: { phone: adminPhone } });
      console.log(`Админу добавлен телефон для входа: ${adminPhone}`);
    }
    console.log(`Админ уже существует: ${adminEmail} — пароль не менялся`);
  }

  for (const uom of UOMS) {
    await prisma.uom.upsert({
      where: { companyId_name: { companyId: company.id, name: uom.name } },
      update: {},
      create: { companyId: company.id, ...uom },
    });
  }

  console.log(`Seed выполнен: компания «${company.name}», единицы измерения (${UOMS.length}).`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
