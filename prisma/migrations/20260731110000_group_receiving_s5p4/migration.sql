-- Этап 5/Пакет 4 · additive, forward-only: HandlingGroup (групповая приёмка) + виртуальная
-- зона в ядре остатков (locKey Z:<zoneId>). Legacy-модели/поля не трогаем.
-- BEGIN/COMMIT не добавляем (Prisma сама оборачивает миграцию).

-- CreateEnum
CREATE TYPE "HandlingGroupStatus" AS ENUM ('IN_RECEIVING', 'AWAITING_STORAGE', 'AWAITING_COOLING', 'IN_STORAGE', 'IN_COOLING');

-- AlterEnum: QR группы через существующую систему QR (значение не используется в этой же tx)
ALTER TYPE "QrType" ADD VALUE IF NOT EXISTS 'GROUP';

-- AlterTable: виртуальная зона в ядре остатков (обратная совместимость; C:/W:/E:/EP: не затронуты)
ALTER TABLE "StockBalance" ADD COLUMN "zoneId" TEXT;
ALTER TABLE "StockMovement" ADD COLUMN "fromZoneId" TEXT,
ADD COLUMN "toZoneId" TEXT;

-- CreateTable
CREATE TABLE "HandlingGroup" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "temperature" DECIMAL(6,2) NOT NULL,
    "thresholdX" DECIMAL(6,2) NOT NULL,
    "status" "HandlingGroupStatus" NOT NULL DEFAULT 'IN_RECEIVING',
    "dedupeKey" TEXT NOT NULL,
    "acceptedById" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HandlingGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockBalance_companyId_zoneId_idx" ON "StockBalance"("companyId", "zoneId");
CREATE UNIQUE INDEX "HandlingGroup_companyId_dedupeKey_key" ON "HandlingGroup"("companyId", "dedupeKey");
CREATE INDEX "HandlingGroup_companyId_status_idx" ON "HandlingGroup"("companyId", "status");
CREATE INDEX "HandlingGroup_warehouseId_idx" ON "HandlingGroup"("warehouseId");
CREATE INDEX "HandlingGroup_lotId_idx" ON "HandlingGroup"("lotId");

-- AddForeignKey
ALTER TABLE "HandlingGroup" ADD CONSTRAINT "HandlingGroup_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HandlingGroup" ADD CONSTRAINT "HandlingGroup_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
