-- Этап 5/Пакет 9A: настройки, фиксация 7 системных зон, основа EAN. Аддитивно, forward-only.

-- CreateEnum
CREATE TYPE "BarcodeSymbology" AS ENUM ('EAN8', 'EAN13');
CREATE TYPE "BarcodeSource" AS ENUM ('MANUAL', 'API');

-- AlterTable: Item — источник и внешний идентификатор (API-ready, аддитивно)
ALTER TABLE "Item" ADD COLUMN "source" "BarcodeSource" NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "Item" ADD COLUMN "externalId" TEXT;

-- CreateTable: ItemBarcode
CREATE TABLE "ItemBarcode" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "symbology" "BarcodeSymbology" NOT NULL,
    "source" "BarcodeSource" NOT NULL DEFAULT 'MANUAL',
    "externalId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ItemBarcode_pkey" PRIMARY KEY ("id")
);

-- Один EAN в пределах компании относится только к одному Item.
CREATE UNIQUE INDEX "ItemBarcode_companyId_code_key" ON "ItemBarcode"("companyId", "code");
CREATE INDEX "ItemBarcode_companyId_idx" ON "ItemBarcode"("companyId");
CREATE INDEX "ItemBarcode_itemId_idx" ON "ItemBarcode"("itemId");

ALTER TABLE "ItemBarcode" ADD CONSTRAINT "ItemBarcode_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Ровно одна системная зона каждого kind на складе (7 фиксированных зон).
CREATE UNIQUE INDEX "WarehouseZone_warehouseId_kind_key" ON "WarehouseZone"("warehouseId", "kind");
