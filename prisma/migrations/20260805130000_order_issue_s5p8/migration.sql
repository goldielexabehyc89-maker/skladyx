-- Этап 5/Пакет 8 · additive, forward-only: размещение проверенного заказа в ячейки выдачи (ISSUE)
-- и выдача водителю. ExternalOrder остаётся единственным владельцем состояния заказа. Прежние
-- миграции не редактируем, legacy не трогаем. Новые значения enum как ДАННЫЕ в этой миграции не
-- используются (PG16 допускает добавление значений в транзакции).

-- AlterEnum: новые статусы заказа (выдача)
ALTER TYPE "ExternalOrderStatus" ADD VALUE 'AWAITING_ISSUE_CELL';
ALTER TYPE "ExternalOrderStatus" ADD VALUE 'MOVING_TO_ISSUE';
ALTER TYPE "ExternalOrderStatus" ADD VALUE 'READY_FOR_DRIVER';
ALTER TYPE "ExternalOrderStatus" ADD VALUE 'ISSUED';

-- CreateEnum
CREATE TYPE "OrderIssueCellStatus" AS ENUM ('RESERVED', 'PLACED', 'RELEASED');

-- CreateTable
CREATE TABLE "OrderIssueCell" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "cellId" TEXT NOT NULL,
    "status" "OrderIssueCellStatus" NOT NULL DEFAULT 'RESERVED',
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "placedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "OrderIssueCell_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderIssuePlacement" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "issueCellId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderIssuePlacement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderShipment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "issuedById" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderShipment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderIssueCell_companyId_status_idx" ON "OrderIssueCell"("companyId", "status");
CREATE INDEX "OrderIssueCell_orderId_idx" ON "OrderIssueCell"("orderId");
CREATE INDEX "OrderIssueCell_cellId_idx" ON "OrderIssueCell"("cellId");
-- partial unique: одна активная (не RELEASED) ячейка выдачи — только под один заказ
CREATE UNIQUE INDEX "OrderIssueCell_active_key" ON "OrderIssueCell"("cellId") WHERE "status" <> 'RELEASED';
CREATE UNIQUE INDEX "OrderIssuePlacement_orderId_lotId_key" ON "OrderIssuePlacement"("orderId", "lotId");
CREATE INDEX "OrderIssuePlacement_issueCellId_idx" ON "OrderIssuePlacement"("issueCellId");
CREATE UNIQUE INDEX "OrderShipment_orderId_key" ON "OrderShipment"("orderId");
CREATE INDEX "OrderShipment_companyId_idx" ON "OrderShipment"("companyId");

-- AddForeignKey
ALTER TABLE "OrderIssueCell" ADD CONSTRAINT "OrderIssueCell_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ExternalOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderIssuePlacement" ADD CONSTRAINT "OrderIssuePlacement_issueCellId_fkey" FOREIGN KEY ("issueCellId") REFERENCES "OrderIssueCell"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderShipment" ADD CONSTRAINT "OrderShipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ExternalOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
