CREATE TYPE "PickListKind" AS ENUM ('PICK', 'TRANSFER');
ALTER TABLE "PickList" ADD COLUMN "kind" "PickListKind" NOT NULL DEFAULT 'PICK';
UPDATE "PickList" SET "kind" = 'TRANSFER' WHERE "targetWarehouseId" IS NOT NULL;
DROP INDEX "PickList_companyId_number_key";
CREATE UNIQUE INDEX "PickList_companyId_kind_number_key" ON "PickList"("companyId", "kind", "number");
