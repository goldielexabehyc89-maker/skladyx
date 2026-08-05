-- Этап 5/Пакет 7 (коррекция) · additive, forward-only: состояние разрешения расхождений.
-- Каждая строка расхождения ControlCheckLine получает статус разрешения (PENDING/RESOLVED),
-- способ, автора/время и комментарий исправления; + отсканированная при контроле группа.
-- Миграцию 20260804170000_order_control_s5p7 НЕ редактируем (уже применена на staging). Legacy не трогаем.

-- CreateEnum
CREATE TYPE "ControlLineResolution" AS ENUM ('PENDING', 'RESOLVED');
CREATE TYPE "ControlResolutionMethod" AS ENUM ('ALIGNED', 'RETURNED', 'ISOLATED_DISCREPANCY');

-- AlterTable
ALTER TABLE "ControlCheckLine" ADD COLUMN "handlingGroupId" TEXT;
ALTER TABLE "ControlCheckLine" ADD COLUMN "resolutionStatus" "ControlLineResolution";
ALTER TABLE "ControlCheckLine" ADD COLUMN "resolutionMethod" "ControlResolutionMethod";
ALTER TABLE "ControlCheckLine" ADD COLUMN "resolvedById" TEXT;
ALTER TABLE "ControlCheckLine" ADD COLUMN "resolvedAt" TIMESTAMP(3);
ALTER TABLE "ControlCheckLine" ADD COLUMN "resolutionComment" TEXT;
