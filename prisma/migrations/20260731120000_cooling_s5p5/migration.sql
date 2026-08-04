-- Этап 5/Пакет 5 · additive, forward-only: охлаждение (CoolingSession + TemperatureMeasurement
-- + CellReservation), R на складе (Warehouse.coolingRate), отложенные задачи (WorkflowTask.availableAt).
-- Legacy-модели/поля не трогаем. BEGIN/COMMIT не добавляем (Prisma оборачивает миграцию).

-- CreateEnum
CREATE TYPE "CoolingStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');
CREATE TYPE "CellReservationStatus" AS ENUM ('ACTIVE', 'RELEASED');

-- AlterTable: R на складе + время доступности отложенной задачи
ALTER TABLE "Warehouse" ADD COLUMN "coolingRate" DECIMAL(6,2);
ALTER TABLE "WorkflowTask" ADD COLUMN "availableAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CoolingSession" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "handlingGroupId" TEXT NOT NULL,
    "coolingCellId" TEXT NOT NULL,
    "startTemp" DECIMAL(6,2) NOT NULL,
    "thresholdX" DECIMAL(6,2) NOT NULL,
    "coolingRate" DECIMAL(6,2) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "estimatedReadyAt" TIMESTAMP(3) NOT NULL,
    "status" "CoolingStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoolingSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TemperatureMeasurement" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "temperature" DECIMAL(6,2) NOT NULL,
    "measuredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "byUserId" TEXT NOT NULL,

    CONSTRAINT "TemperatureMeasurement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CellReservation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "cellId" TEXT NOT NULL,
    "sessionId" TEXT,
    "status" "CellReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "CellReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowTask_status_availableAt_idx" ON "WorkflowTask"("status", "availableAt");
CREATE UNIQUE INDEX "CoolingSession_handlingGroupId_key" ON "CoolingSession"("handlingGroupId");
CREATE INDEX "CoolingSession_companyId_status_idx" ON "CoolingSession"("companyId", "status");
CREATE INDEX "CoolingSession_warehouseId_idx" ON "CoolingSession"("warehouseId");
CREATE INDEX "TemperatureMeasurement_sessionId_idx" ON "TemperatureMeasurement"("sessionId");
CREATE INDEX "CellReservation_companyId_status_idx" ON "CellReservation"("companyId", "status");
CREATE INDEX "CellReservation_cellId_idx" ON "CellReservation"("cellId");
CREATE INDEX "CellReservation_sessionId_idx" ON "CellReservation"("sessionId");
-- одна активная бронь на ячейку (partial unique — Prisma не выражает, ставим руками)
CREATE UNIQUE INDEX "CellReservation_cell_active_key" ON "CellReservation"("cellId") WHERE "status" = 'ACTIVE';

-- AddForeignKey
ALTER TABLE "CoolingSession" ADD CONSTRAINT "CoolingSession_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CoolingSession" ADD CONSTRAINT "CoolingSession_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CoolingSession" ADD CONSTRAINT "CoolingSession_handlingGroupId_fkey" FOREIGN KEY ("handlingGroupId") REFERENCES "HandlingGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TemperatureMeasurement" ADD CONSTRAINT "TemperatureMeasurement_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CoolingSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CellReservation" ADD CONSTRAINT "CellReservation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CoolingSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
