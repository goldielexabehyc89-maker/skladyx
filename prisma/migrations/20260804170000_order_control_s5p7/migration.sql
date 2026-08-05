-- Этап 5/Пакет 7 · additive, forward-only: контроль заказа.
-- ControlCheck + ControlCheckLine (результат/строки проверки), статусы проверки и типы расхождений,
-- новые статусы внешнего заказа CORRECTION_REQUIRED/CONTROL_PASSED. ExternalOrder остаётся
-- единственным владельцем жизненного цикла заказа. Legacy не трогаем. BEGIN/COMMIT не добавляем
-- (Prisma оборачивает миграцию). Новые значения ExternalOrderStatus в этой миграции как ДАННЫЕ
-- не используются — только объявляются (PG16 это допускает; ср. Пакет 6, QrType ADD VALUE 'ORDER').

-- AlterEnum: новые статусы внешнего заказа
ALTER TYPE "ExternalOrderStatus" ADD VALUE 'CORRECTION_REQUIRED';
ALTER TYPE "ExternalOrderStatus" ADD VALUE 'CONTROL_PASSED';

-- CreateEnum
CREATE TYPE "ControlCheckStatus" AS ENUM ('IN_PROGRESS', 'PASSED', 'FAILED');
CREATE TYPE "ControlDiscrepancyType" AS ENUM ('SHORTAGE', 'EXCESS', 'WRONG_ITEM', 'DAMAGED', 'OTHER');

-- CreateTable
CREATE TABLE "ControlCheck" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" "ControlCheckStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "controllerId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ControlCheck_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ControlCheckLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "lineId" TEXT,
    "itemId" TEXT NOT NULL,
    "expectedQty" DECIMAL(14,3) NOT NULL,
    "countedQty" DECIMAL(14,3),
    "discrepancyType" "ControlDiscrepancyType",
    "comment" TEXT,
    "byUserId" TEXT,
    "checkedAt" TIMESTAMP(3),

    CONSTRAINT "ControlCheckLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ControlCheck_taskId_key" ON "ControlCheck"("taskId");
CREATE UNIQUE INDEX "ControlCheck_orderId_attempt_key" ON "ControlCheck"("orderId", "attempt");
CREATE INDEX "ControlCheck_companyId_status_idx" ON "ControlCheck"("companyId", "status");
CREATE INDEX "ControlCheck_orderId_idx" ON "ControlCheck"("orderId");
CREATE UNIQUE INDEX "ControlCheckLine_checkId_lineId_key" ON "ControlCheckLine"("checkId", "lineId");
CREATE INDEX "ControlCheckLine_checkId_idx" ON "ControlCheckLine"("checkId");

-- AddForeignKey
ALTER TABLE "ControlCheck" ADD CONSTRAINT "ControlCheck_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ExternalOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ControlCheckLine" ADD CONSTRAINT "ControlCheckLine_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "ControlCheck"("id") ON DELETE CASCADE ON UPDATE CASCADE;
