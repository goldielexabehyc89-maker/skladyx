-- AlterTable
ALTER TABLE "PickLine" ADD COLUMN     "cellId" TEXT,
ADD COLUMN     "lotId" TEXT,
ADD COLUMN     "unitId" TEXT;

-- AlterTable
ALTER TABLE "PickList" ADD COLUMN     "warehouseId" TEXT;
