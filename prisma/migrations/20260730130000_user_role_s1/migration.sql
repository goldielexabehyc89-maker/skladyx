-- Этап 4B/S1 · additive: таблица UserRole + backfill из User.role.
-- Область S1: только UserRole (авторизация ещё по User.role; UserRole — теневая копия).
-- Уникальность User.phone/email НЕ трогаем (это S3). BEGIN/COMMIT НЕ добавляем: Prisma 6.19.3
-- сама оборачивает миграцию в транзакцию (проверено эмпирически). Для сырого psql — --single-transaction.

-- CreateTable
CREATE TABLE "UserRole" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserRole_userId_role_key" ON "UserRole"("userId", "role");

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------- Backfill из User.role (детерминированный id, идемпотентно) ----------
-- Prisma cuid() НЕ является DEFAULT PostgreSQL, поэтому id задаём явно в SQL.
INSERT INTO "UserRole" ("id", "userId", "role")
SELECT
  'backfill_' || md5(u."id" || ':' || u."role"::text),
  u."id",
  u."role"
FROM "User" u
ON CONFLICT ("userId", "role") DO NOTHING;
