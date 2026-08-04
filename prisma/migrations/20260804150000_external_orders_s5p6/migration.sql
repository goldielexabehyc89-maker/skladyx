-- Этап 5/Пакет 6 · additive, forward-only: внешние заказы (ExternalOrder + ExternalOrderLine),
-- резерв товара (StockReservation), срок задачи (WorkflowTask.dueAt), бронь ячейки под
-- перестановку (CellReservation.handlingGroupId), тип QR ORDER. Legacy не трогаем.
-- BEGIN/COMMIT не добавляем (Prisma оборачивает миграцию). ALTER TYPE ADD VALUE новое значение
-- в этой же транзакции НЕ используется (PG16 это допускает).

-- CreateEnum
CREATE TYPE "ExternalOrderStatus" AS ENUM ('IMPORTED', 'PARTIALLY_RESERVED', 'READY_TO_PICK', 'PICKING', 'IN_CONTROL', 'BLOCKED');
CREATE TYPE "StockReservationStatus" AS ENUM ('ACTIVE', 'FULFILLED', 'RELEASED');

-- AlterEnum: QR внешнего заказа
ALTER TYPE "QrType" ADD VALUE 'ORDER';

-- AlterTable: срок задачи (сортировка очереди) + бронь ячейки под перестановку группы
ALTER TABLE "WorkflowTask" ADD COLUMN "dueAt" TIMESTAMP(3);
ALTER TABLE "CellReservation" ADD COLUMN "handlingGroupId" TEXT;

-- CreateTable
CREATE TABLE "ExternalOrder" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "status" "ExternalOrderStatus" NOT NULL DEFAULT 'IMPORTED',
    "arrivalAt" TIMESTAMP(3),
    "payloadHash" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExternalOrderLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "externalLineId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "requiredQty" DECIMAL(14,3) NOT NULL,
    "reservedQty" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "pickedQty" DECIMAL(14,3) NOT NULL DEFAULT 0,

    CONSTRAINT "ExternalOrderLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StockReservation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "taskId" TEXT,
    "handlingGroupId" TEXT,
    "lotId" TEXT,
    "sourceLocKey" TEXT,
    "cellId" TEXT,
    "unitId" TEXT,
    "qty" DECIMAL(14,3) NOT NULL,
    "status" "StockReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),

    CONSTRAINT "StockReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowTask_status_dueAt_idx" ON "WorkflowTask"("status", "dueAt");
CREATE INDEX "CellReservation_handlingGroupId_idx" ON "CellReservation"("handlingGroupId");
CREATE UNIQUE INDEX "ExternalOrder_companyId_externalId_key" ON "ExternalOrder"("companyId", "externalId");
CREATE INDEX "ExternalOrder_companyId_status_idx" ON "ExternalOrder"("companyId", "status");
CREATE INDEX "ExternalOrder_warehouseId_idx" ON "ExternalOrder"("warehouseId");
CREATE UNIQUE INDEX "ExternalOrderLine_orderId_externalLineId_key" ON "ExternalOrderLine"("orderId", "externalLineId");
CREATE INDEX "ExternalOrderLine_companyId_idx" ON "ExternalOrderLine"("companyId");
CREATE INDEX "ExternalOrderLine_orderId_idx" ON "ExternalOrderLine"("orderId");
CREATE INDEX "ExternalOrderLine_itemId_idx" ON "ExternalOrderLine"("itemId");
CREATE UNIQUE INDEX "StockReservation_companyId_dedupeKey_key" ON "StockReservation"("companyId", "dedupeKey");
CREATE INDEX "StockReservation_companyId_status_idx" ON "StockReservation"("companyId", "status");
CREATE INDEX "StockReservation_lotId_sourceLocKey_idx" ON "StockReservation"("lotId", "sourceLocKey");
CREATE INDEX "StockReservation_orderId_idx" ON "StockReservation"("orderId");
CREATE INDEX "StockReservation_lineId_idx" ON "StockReservation"("lineId");
CREATE INDEX "StockReservation_handlingGroupId_idx" ON "StockReservation"("handlingGroupId");

-- AddForeignKey
ALTER TABLE "ExternalOrderLine" ADD CONSTRAINT "ExternalOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ExternalOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ExternalOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "ExternalOrderLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
