-- Этап 5 / Пакет 2 · additive: WorkflowTask + TaskDependency + TaskHandoff (очередь задач).
-- Остатки/stock.ts НЕ трогаем. BEGIN/COMMIT НЕ добавляем (Prisma сама оборачивает миграцию).

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('NORMAL', 'URGENT');
CREATE TYPE "TaskStatus" AS ENUM ('BLOCKED', 'QUEUED', 'ASSIGNED', 'IN_PROGRESS', 'HANDOFF_PENDING', 'NEEDS_ATTENTION', 'COMPLETED', 'CANCELLED');
CREATE TYPE "HandoffStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "WorkflowTask" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "requiredRole" "Role" NOT NULL,
    "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "TaskStatus" NOT NULL DEFAULT 'QUEUED',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "actionUrl" TEXT,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "loadUnits" INTEGER NOT NULL DEFAULT 1,
    "assignedUserId" TEXT,
    "assignedShiftId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkflowTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TaskDependency" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "dependsOnTaskId" TEXT NOT NULL,
    CONSTRAINT "TaskDependency_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TaskHandoff" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "fromShiftId" TEXT NOT NULL,
    "toShiftId" TEXT NOT NULL,
    "status" "HandoffStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    CONSTRAINT "TaskHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowTask_companyId_idx" ON "WorkflowTask"("companyId");
CREATE INDEX "WorkflowTask_warehouseId_idx" ON "WorkflowTask"("warehouseId");
CREATE INDEX "WorkflowTask_status_idx" ON "WorkflowTask"("status");
CREATE INDEX "WorkflowTask_requiredRole_idx" ON "WorkflowTask"("requiredRole");
CREATE INDEX "WorkflowTask_assignedUserId_idx" ON "WorkflowTask"("assignedUserId");
CREATE INDEX "WorkflowTask_assignedShiftId_idx" ON "WorkflowTask"("assignedShiftId");
CREATE UNIQUE INDEX "WorkflowTask_companyId_dedupeKey_key" ON "WorkflowTask"("companyId", "dedupeKey");
CREATE INDEX "TaskDependency_dependsOnTaskId_idx" ON "TaskDependency"("dependsOnTaskId");
CREATE UNIQUE INDEX "TaskDependency_taskId_dependsOnTaskId_key" ON "TaskDependency"("taskId", "dependsOnTaskId");
CREATE INDEX "TaskHandoff_taskId_idx" ON "TaskHandoff"("taskId");
CREATE INDEX "TaskHandoff_toShiftId_idx" ON "TaskHandoff"("toShiftId");
CREATE INDEX "TaskHandoff_status_idx" ON "TaskHandoff"("status");

-- Не более одной IN_PROGRESS задачи на пользователя (partial unique — Prisma не описывает WHERE).
CREATE UNIQUE INDEX "WorkflowTask_assignedUser_inprogress_key" ON "WorkflowTask"("assignedUserId") WHERE "status" = 'IN_PROGRESS';
-- Только одна активная (PENDING) передача на задачу.
CREATE UNIQUE INDEX "TaskHandoff_task_pending_key" ON "TaskHandoff"("taskId") WHERE "status" = 'PENDING';

-- CHECK: loadUnits >= 1; зависимость не может ссылаться на саму себя.
ALTER TABLE "WorkflowTask" ADD CONSTRAINT "WorkflowTask_loadUnits_check" CHECK ("loadUnits" >= 1);
ALTER TABLE "TaskDependency" ADD CONSTRAINT "TaskDependency_no_self_check" CHECK ("taskId" <> "dependsOnTaskId");

-- AddForeignKey
ALTER TABLE "WorkflowTask" ADD CONSTRAINT "WorkflowTask_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkflowTask" ADD CONSTRAINT "WorkflowTask_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkflowTask" ADD CONSTRAINT "WorkflowTask_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkflowTask" ADD CONSTRAINT "WorkflowTask_assignedShiftId_fkey" FOREIGN KEY ("assignedShiftId") REFERENCES "WorkShift"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TaskDependency" ADD CONSTRAINT "TaskDependency_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "WorkflowTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskDependency" ADD CONSTRAINT "TaskDependency_dependsOnTaskId_fkey" FOREIGN KEY ("dependsOnTaskId") REFERENCES "WorkflowTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskHandoff" ADD CONSTRAINT "TaskHandoff_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "WorkflowTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskHandoff" ADD CONSTRAINT "TaskHandoff_fromShiftId_fkey" FOREIGN KEY ("fromShiftId") REFERENCES "WorkShift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TaskHandoff" ADD CONSTRAINT "TaskHandoff_toShiftId_fkey" FOREIGN KEY ("toShiftId") REFERENCES "WorkShift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
