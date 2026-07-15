-- AlterTable
ALTER TABLE "ReceiptLine" ADD COLUMN     "orderLineId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptLine_orderLineId_key" ON "ReceiptLine"("orderLineId");
