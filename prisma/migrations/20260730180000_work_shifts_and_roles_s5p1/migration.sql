-- Этап 5 / Пакет 1 · additive: рабочие роли РостАгро + рабочие смены (WorkShift).
-- Только добавление: enum Role расширяется, WorkShift создаётся. User.role и старые значения
-- Role НЕ удаляются. BEGIN/COMMIT НЕ добавляем (Prisma сама оборачивает миграцию в транзакцию).
-- PG16 допускает ALTER TYPE ... ADD VALUE в транзакции; новые значения в этой же миграции
-- НЕ используются (строк с ними не вставляем), поэтому это безопасно.

-- AlterEnum: новые рабочие роли
ALTER TYPE "Role" ADD VALUE 'RECEIVER';
ALTER TYPE "Role" ADD VALUE 'LOADER';
ALTER TYPE "Role" ADD VALUE 'PICKER';
ALTER TYPE "Role" ADD VALUE 'CONTROLLER';
ALTER TYPE "Role" ADD VALUE 'OBSERVER';

-- CreateTable: рабочая смена (история; завершённые не удаляем)
CREATE TABLE "WorkShift" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkShift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkShift_companyId_idx" ON "WorkShift"("companyId");
CREATE INDEX "WorkShift_userId_idx" ON "WorkShift"("userId");
CREATE INDEX "WorkShift_warehouseId_idx" ON "WorkShift"("warehouseId");
CREATE INDEX "WorkShift_role_idx" ON "WorkShift"("role");
CREATE INDEX "WorkShift_endedAt_idx" ON "WorkShift"("endedAt");

-- Не более одной НЕзавершённой смены на пользователя (partial unique — Prisma не описывает WHERE).
CREATE UNIQUE INDEX "WorkShift_userId_open_key" ON "WorkShift"("userId") WHERE "endedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "WorkShift" ADD CONSTRAINT "WorkShift_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkShift" ADD CONSTRAINT "WorkShift_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkShift" ADD CONSTRAINT "WorkShift_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
