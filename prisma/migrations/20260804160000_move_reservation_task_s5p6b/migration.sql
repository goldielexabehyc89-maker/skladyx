-- Этап 5/Пакет 6 (коррекция) · additive, forward-only: однозначная бронь перестановки.
-- Не редактируем 20260804150000 (уже на staging) — отдельная correction-миграция.
-- CellReservation.taskId — привязка брони перестановки к конкретной MOVE_GROUP-задаче
-- (completeMoveGroup ищет по taskId). Partial-unique по (handlingGroupId WHERE status='ACTIVE')
-- запрещает две активные перестановки одной группы. Брони охлаждения (handlingGroupId IS NULL)
-- не конфликтуют (NULL в unique-индексе допускает множество строк).

ALTER TABLE "CellReservation" ADD COLUMN "taskId" TEXT;

CREATE INDEX "CellReservation_taskId_idx" ON "CellReservation"("taskId");
CREATE UNIQUE INDEX "CellReservation_group_active_key" ON "CellReservation"("handlingGroupId") WHERE "status" = 'ACTIVE';
