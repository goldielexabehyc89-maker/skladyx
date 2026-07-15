-- Черновики заявок/перемещений: документ виден кладовщикам после «Сохранить».
ALTER TABLE "PickList" ADD COLUMN "savedAt" TIMESTAMP(3);

-- Бэкфилл: всё, что уже в работе или содержит позиции, считаем сохранённым,
-- чтобы существующие документы не пропали из «Активных» после деплоя.
UPDATE "PickList" p
SET "savedAt" = p."createdAt"
WHERE p."status" <> 'NEW'
   OR EXISTS (SELECT 1 FROM "PickLine" l WHERE l."pickListId" = p."id");
