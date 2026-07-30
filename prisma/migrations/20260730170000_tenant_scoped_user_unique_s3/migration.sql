-- Этап 4B/S3 · per-tenant уникальность User.phone/email.
-- Глобальные @unique(phone/email) → composite @@unique([companyId, phone]) / ([companyId, email]).
-- BEGIN/COMMIT НЕ добавляем: Prisma 6.19.3 сама оборачивает миграцию в транзакцию (RAISE откатит всё).
-- Guard — только счётчики, БЕЗ вывода телефонов/email (никаких ПДн в ошибках).

-- ---------- Preflight guard (останавливает миграцию при коллизиях) ----------
DO $$
DECLARE
  bad_phone  int;
  dup_phone  int;
  dup_email  int;
BEGIN
  -- 1) неканоничные телефоны: нормализацию делает единый normalizePhone в приложении, НЕ SQL.
  --    Канон: +7XXXXXXXXXX. Если есть иные — остановиться (сначала нормализовать через приложение).
  SELECT count(*) INTO bad_phone
  FROM "User"
  WHERE phone IS NOT NULL AND phone !~ '^\+7[0-9]{10}$';
  IF bad_phone > 0 THEN
    RAISE EXCEPTION 'S3 preflight: % неканоничных телефонов — нормализуйте через normalizePhone до миграции', bad_phone;
  END IF;

  -- 2) дубли (companyId, phone)
  SELECT count(*) INTO dup_phone FROM (
    SELECT "companyId", phone FROM "User"
    WHERE phone IS NOT NULL
    GROUP BY "companyId", phone HAVING count(*) > 1
  ) d;
  IF dup_phone > 0 THEN
    RAISE EXCEPTION 'S3 preflight: % дублей (companyId, phone)', dup_phone;
  END IF;

  -- 3) коллизии (companyId, нормализованный email = lower(trim), пустое → NULL)
  SELECT count(*) INTO dup_email FROM (
    SELECT "companyId", lower(trim(email)) AS e FROM "User"
    WHERE email IS NOT NULL AND trim(email) <> ''
    GROUP BY "companyId", lower(trim(email)) HAVING count(*) > 1
  ) d;
  IF dup_email > 0 THEN
    RAISE EXCEPTION 'S3 preflight: % коллизий (companyId, lower(trim(email)))', dup_email;
  END IF;
END $$;

-- ---------- Нормализация email (lower(trim); пустое → NULL) ----------
UPDATE "User" SET email = NULLIF(lower(trim(email)), '') WHERE email IS NOT NULL;

-- ---------- Смена уникальности: глобальные unique → composite ----------
-- DropIndex
DROP INDEX "User_email_key";

-- DropIndex
DROP INDEX "User_phone_key";

-- CreateIndex
CREATE UNIQUE INDEX "User_companyId_phone_key" ON "User"("companyId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "User_companyId_email_key" ON "User"("companyId", "email");
