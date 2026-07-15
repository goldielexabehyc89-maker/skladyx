ALTER TABLE "PickList" ALTER COLUMN "targetEmployeeId" DROP NOT NULL;
ALTER TABLE "PickList" ADD COLUMN "targetWarehouseId" TEXT;
