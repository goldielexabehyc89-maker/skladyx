-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "TrackingType" AS ENUM ('LOT', 'UNIT');

-- CreateEnum
CREATE TYPE "QrType" AS ENUM ('LOT', 'UNIT', 'CELL', 'EMPLOYEE', 'PICKLIST');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('DRAFT', 'POSTED');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('DRAFT', 'POSTED');

-- CreateEnum
CREATE TYPE "WriteOffStatus" AS ENUM ('DRAFT', 'POSTED');

-- CreateEnum
CREATE TYPE "PickListStatus" AS ENUM ('NEW', 'PICKING', 'PICKED', 'STAGED', 'ISSUED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('PENDING', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "IssueSource" AS ENUM ('DIRECT', 'PICKLIST');

-- CreateEnum
CREATE TYPE "InventoryStatus" AS ENUM ('IN_PROGRESS', 'REVIEW', 'POSTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "UnitStatus" AS ENUM ('IN_STOCK', 'PICKED', 'ISSUE_PENDING', 'ISSUED', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "MovementDocType" AS ENUM ('RECEIPT', 'CELL_ASSIGN', 'TRANSFER', 'WRITEOFF', 'PICKLIST', 'ISSUE', 'ISSUE_CONFIRM', 'INVENTORY');

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'EMPLOYEE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "key" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "url" TEXT,
    "actorId" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QrCode" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "QrType" NOT NULL,
    "refId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QrCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Warehouse" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cell" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "isStaging" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Cell_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Uom" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "allowFraction" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Uom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Item" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "uomId" TEXT NOT NULL,
    "tracking" "TrackingType" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Counter" (
    "companyId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Counter_pkey" PRIMARY KEY ("companyId","docType")
);

-- CreateTable
CREATE TABLE "Receipt" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'DRAFT',
    "postedAt" TIMESTAMP(3),
    "supplier" TEXT,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "price" DECIMAL(14,2),
    "cellId" TEXT,

    CONSTRAINT "ReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lot" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "receiptLineId" TEXT NOT NULL,
    "qtyReceived" DECIMAL(14,3) NOT NULL,
    "price" DECIMAL(14,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemUnit" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "receiptLineId" TEXT NOT NULL,
    "serial" INTEGER NOT NULL,
    "price" DECIMAL(14,2),
    "status" "UnitStatus" NOT NULL DEFAULT 'IN_STOCK',
    "warehouseId" TEXT,
    "cellId" TEXT,
    "employeeId" TEXT,
    "pickListId" TEXT,
    "issueId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBalance" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "locKey" TEXT NOT NULL,
    "warehouseId" TEXT,
    "cellId" TEXT,
    "employeeId" TEXT,
    "qty" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "StockBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "docType" "MovementDocType" NOT NULL,
    "docId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotId" TEXT,
    "unitId" TEXT,
    "qty" DECIMAL(14,3) NOT NULL,
    "fromWarehouseId" TEXT,
    "fromCellId" TEXT,
    "fromEmployeeId" TEXT,
    "fromPending" BOOLEAN NOT NULL DEFAULT false,
    "toWarehouseId" TEXT,
    "toCellId" TEXT,
    "toEmployeeId" TEXT,
    "toPending" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storedPath" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transfer" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "fromWarehouseId" TEXT NOT NULL,
    "toWarehouseId" TEXT NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'DRAFT',
    "postedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransferLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotId" TEXT,
    "unitId" TEXT,
    "qty" DECIMAL(14,3) NOT NULL,
    "toCellId" TEXT,

    CONSTRAINT "TransferLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WriteOff" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "warehouseId" TEXT,
    "employeeId" TEXT,
    "reason" TEXT NOT NULL,
    "status" "WriteOffStatus" NOT NULL DEFAULT 'DRAFT',
    "postedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WriteOff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WriteOffLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "writeOffId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotId" TEXT,
    "unitId" TEXT,
    "qty" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "WriteOffLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PickList" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "targetEmployeeId" TEXT NOT NULL,
    "status" "PickListStatus" NOT NULL DEFAULT 'NEW',
    "stagingCellId" TEXT,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "pickedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pickedAt" TIMESTAMP(3),
    "stagedAt" TIMESTAMP(3),
    "issuedAt" TIMESTAMP(3),

    CONSTRAINT "PickList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PickLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "pickListId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "qtyRequested" DECIMAL(14,3) NOT NULL,
    "qtyPicked" DECIMAL(14,3) NOT NULL DEFAULT 0,

    CONSTRAINT "PickLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PickFulfillment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "pickLineId" TEXT NOT NULL,
    "lotId" TEXT,
    "unitId" TEXT,
    "qty" DECIMAL(14,3) NOT NULL,
    "fromWarehouseId" TEXT NOT NULL,
    "fromCellId" TEXT,
    "scannedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PickFulfillment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Issue" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "employeeId" TEXT NOT NULL,
    "source" "IssueSource" NOT NULL,
    "pickListId" TEXT,
    "status" "IssueStatus" NOT NULL,
    "issuedById" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "Issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssueLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotId" TEXT,
    "unitId" TEXT,
    "qty" DECIMAL(14,3) NOT NULL,
    "price" DECIMAL(14,2),

    CONSTRAINT "IssueLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inventory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "status" "InventoryStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "postedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Inventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "inventoryId" TEXT NOT NULL,
    "cellId" TEXT,
    "itemId" TEXT NOT NULL,
    "lotId" TEXT,
    "unitId" TEXT,
    "expectedQty" DECIMAL(14,3) NOT NULL,
    "countedQty" DECIMAL(14,3),

    CONSTRAINT "InventoryLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_slug_key" ON "Company"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_companyId_idx" ON "User"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthToken_token_key" ON "AuthToken"("token");

-- CreateIndex
CREATE INDEX "AuthToken_userId_idx" ON "AuthToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_companyId_idx" ON "PushSubscription"("companyId");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- CreateIndex
CREATE INDEX "Event_companyId_createdAt_idx" ON "Event"("companyId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Event_companyId_type_createdAt_idx" ON "Event"("companyId", "type", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Event_companyId_key_key" ON "Event"("companyId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "QrCode_code_key" ON "QrCode"("code");

-- CreateIndex
CREATE INDEX "QrCode_companyId_idx" ON "QrCode"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "QrCode_type_refId_key" ON "QrCode"("type", "refId");

-- CreateIndex
CREATE INDEX "Warehouse_companyId_idx" ON "Warehouse"("companyId");

-- CreateIndex
CREATE INDEX "Cell_companyId_idx" ON "Cell"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Cell_warehouseId_code_key" ON "Cell"("warehouseId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Uom_companyId_name_key" ON "Uom"("companyId", "name");

-- CreateIndex
CREATE INDEX "Item_companyId_name_idx" ON "Item"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Item_companyId_sku_key" ON "Item"("companyId", "sku");

-- CreateIndex
CREATE INDEX "Receipt_companyId_status_createdAt_idx" ON "Receipt"("companyId", "status", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_companyId_number_key" ON "Receipt"("companyId", "number");

-- CreateIndex
CREATE INDEX "ReceiptLine_receiptId_idx" ON "ReceiptLine"("receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "Lot_receiptLineId_key" ON "Lot"("receiptLineId");

-- CreateIndex
CREATE INDEX "Lot_companyId_itemId_idx" ON "Lot"("companyId", "itemId");

-- CreateIndex
CREATE INDEX "ItemUnit_companyId_itemId_status_idx" ON "ItemUnit"("companyId", "itemId", "status");

-- CreateIndex
CREATE INDEX "ItemUnit_companyId_employeeId_idx" ON "ItemUnit"("companyId", "employeeId");

-- CreateIndex
CREATE INDEX "ItemUnit_companyId_cellId_idx" ON "ItemUnit"("companyId", "cellId");

-- CreateIndex
CREATE INDEX "ItemUnit_pickListId_idx" ON "ItemUnit"("pickListId");

-- CreateIndex
CREATE INDEX "ItemUnit_receiptLineId_idx" ON "ItemUnit"("receiptLineId");

-- CreateIndex
CREATE INDEX "StockBalance_companyId_itemId_idx" ON "StockBalance"("companyId", "itemId");

-- CreateIndex
CREATE INDEX "StockBalance_companyId_warehouseId_cellId_idx" ON "StockBalance"("companyId", "warehouseId", "cellId");

-- CreateIndex
CREATE INDEX "StockBalance_companyId_employeeId_idx" ON "StockBalance"("companyId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "StockBalance_lotId_locKey_key" ON "StockBalance"("lotId", "locKey");

-- CreateIndex
CREATE INDEX "StockMovement_companyId_createdAt_idx" ON "StockMovement"("companyId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "StockMovement_companyId_itemId_idx" ON "StockMovement"("companyId", "itemId");

-- CreateIndex
CREATE INDEX "StockMovement_lotId_idx" ON "StockMovement"("lotId");

-- CreateIndex
CREATE INDEX "StockMovement_unitId_idx" ON "StockMovement"("unitId");

-- CreateIndex
CREATE INDEX "StockMovement_docType_docId_idx" ON "StockMovement"("docType", "docId");

-- CreateIndex
CREATE INDEX "Attachment_ownerType_ownerId_idx" ON "Attachment"("ownerType", "ownerId");

-- CreateIndex
CREATE INDEX "Attachment_companyId_idx" ON "Attachment"("companyId");

-- CreateIndex
CREATE INDEX "Transfer_companyId_status_idx" ON "Transfer"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Transfer_companyId_number_key" ON "Transfer"("companyId", "number");

-- CreateIndex
CREATE INDEX "TransferLine_transferId_idx" ON "TransferLine"("transferId");

-- CreateIndex
CREATE INDEX "WriteOff_companyId_status_idx" ON "WriteOff"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WriteOff_companyId_number_key" ON "WriteOff"("companyId", "number");

-- CreateIndex
CREATE INDEX "WriteOffLine_writeOffId_idx" ON "WriteOffLine"("writeOffId");

-- CreateIndex
CREATE INDEX "PickList_companyId_status_idx" ON "PickList"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PickList_companyId_number_key" ON "PickList"("companyId", "number");

-- CreateIndex
CREATE INDEX "PickLine_pickListId_idx" ON "PickLine"("pickListId");

-- CreateIndex
CREATE INDEX "PickFulfillment_pickLineId_idx" ON "PickFulfillment"("pickLineId");

-- CreateIndex
CREATE UNIQUE INDEX "Issue_pickListId_key" ON "Issue"("pickListId");

-- CreateIndex
CREATE INDEX "Issue_companyId_employeeId_idx" ON "Issue"("companyId", "employeeId");

-- CreateIndex
CREATE INDEX "Issue_companyId_status_idx" ON "Issue"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Issue_companyId_number_key" ON "Issue"("companyId", "number");

-- CreateIndex
CREATE INDEX "IssueLine_issueId_idx" ON "IssueLine"("issueId");

-- CreateIndex
CREATE INDEX "Inventory_companyId_status_idx" ON "Inventory"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Inventory_companyId_number_key" ON "Inventory"("companyId", "number");

-- CreateIndex
CREATE INDEX "InventoryLine_inventoryId_idx" ON "InventoryLine"("inventoryId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QrCode" ADD CONSTRAINT "QrCode_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Warehouse" ADD CONSTRAINT "Warehouse_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cell" ADD CONSTRAINT "Cell_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Uom" ADD CONSTRAINT "Uom_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_uomId_fkey" FOREIGN KEY ("uomId") REFERENCES "Uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptLine" ADD CONSTRAINT "ReceiptLine_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferLine" ADD CONSTRAINT "TransferLine_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WriteOff" ADD CONSTRAINT "WriteOff_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WriteOffLine" ADD CONSTRAINT "WriteOffLine_writeOffId_fkey" FOREIGN KEY ("writeOffId") REFERENCES "WriteOff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickList" ADD CONSTRAINT "PickList_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickLine" ADD CONSTRAINT "PickLine_pickListId_fkey" FOREIGN KEY ("pickListId") REFERENCES "PickList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickFulfillment" ADD CONSTRAINT "PickFulfillment_pickLineId_fkey" FOREIGN KEY ("pickLineId") REFERENCES "PickLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueLine" ADD CONSTRAINT "IssueLine_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inventory" ADD CONSTRAINT "Inventory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLine" ADD CONSTRAINT "InventoryLine_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES "Inventory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
