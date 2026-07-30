-- CreateEnum
CREATE TYPE "ZoneKind" AS ENUM ('RECEIVING', 'STORAGE', 'COOLING', 'CONTROL', 'ISSUE', 'DISCREPANCY', 'BUFFER');

-- AlterTable
ALTER TABLE "Cell" ADD COLUMN     "level" INTEGER,
ADD COLUMN     "zoneId" TEXT;

-- CreateTable
CREATE TABLE "WarehouseZone" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ZoneKind" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WarehouseZone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WarehouseZone_companyId_idx" ON "WarehouseZone"("companyId");

-- CreateIndex
CREATE INDEX "WarehouseZone_warehouseId_idx" ON "WarehouseZone"("warehouseId");

-- CreateIndex
CREATE INDEX "WarehouseZone_kind_idx" ON "WarehouseZone"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "WarehouseZone_warehouseId_code_key" ON "WarehouseZone"("warehouseId", "code");

-- CreateIndex
CREATE INDEX "Cell_zoneId_idx" ON "Cell"("zoneId");

-- AddForeignKey
ALTER TABLE "WarehouseZone" ADD CONSTRAINT "WarehouseZone_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseZone" ADD CONSTRAINT "WarehouseZone_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cell" ADD CONSTRAINT "Cell_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "WarehouseZone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Backfill (Этап 5/Пакет 3, additive, идемпотентно; BEGIN/COMMIT не добавляем — Prisma сама оборачивает) ──
-- Стандартные зоны для каждого существующего склада (виртуальные RECEIVING/CONTROL/DISCREPANCY
-- + физические STORAGE/COOLING/ISSUE/BUFFER). code == kind у стандартных зон; названия настраиваемы.
INSERT INTO "WarehouseZone" ("id", "companyId", "warehouseId", "code", "name", "kind", "isActive", "sortOrder", "createdAt")
SELECT gen_random_uuid()::text, w."companyId", w."id", z.code, z.name, z.code::"ZoneKind", true, z."sortOrder", CURRENT_TIMESTAMP
FROM "Warehouse" w
CROSS JOIN (VALUES
  ('RECEIVING',   'Зона приёмки',     10),
  ('STORAGE',     'Хранение',         20),
  ('COOLING',     'Охлаждение',       30),
  ('CONTROL',     'Зона контроля',    40),
  ('ISSUE',       'Зона выдачи',      50),
  ('DISCREPANCY', 'Зона расхождений', 60),
  ('BUFFER',      'Буфер',            70)
) AS z(code, name, "sortOrder")
ON CONFLICT ("warehouseId", "code") DO NOTHING;

-- Существующие ячейки: isStaging=true → зона ISSUE, isStaging=false → зона STORAGE (того же склада).
UPDATE "Cell" c SET "zoneId" = z."id"
FROM "WarehouseZone" z
WHERE z."warehouseId" = c."warehouseId" AND z."kind" = 'ISSUE'
  AND c."isStaging" = true AND c."zoneId" IS NULL;

UPDATE "Cell" c SET "zoneId" = z."id"
FROM "WarehouseZone" z
WHERE z."warehouseId" = c."warehouseId" AND z."kind" = 'STORAGE'
  AND c."isStaging" = false AND c."zoneId" IS NULL;

-- Уровень существующих ячеек НЕ угадываем из кода — остаётся NULL до настройки.

-- CHECK: если уровень задан — он >= 1 (обязательность уровня для STORAGE проверяется в actions,
-- т.к. зависит от kind соседней таблицы и в CHECK невыразима).
ALTER TABLE "Cell" ADD CONSTRAINT "Cell_level_check" CHECK ("level" IS NULL OR "level" >= 1);
