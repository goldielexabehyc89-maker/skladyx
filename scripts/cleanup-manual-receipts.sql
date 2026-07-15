-- Удаление старых приемок, НЕ привязанных к заказам поставщикам (ручные приемки),
-- вместе с созданным ими стоком (партии/единицы/QR/остатки/движения/вложения).
-- Транзакция: либо всё, либо ничего. Запускать один раз.
BEGIN;

CREATE TEMP TABLE _mr AS
  SELECT r.id FROM "Receipt" r
  WHERE NOT EXISTS (
    SELECT 1 FROM "ReceiptLine" rl
    WHERE rl."receiptId" = r.id AND rl."orderLineId" IS NOT NULL
  );

CREATE TEMP TABLE _ml AS
  SELECT id FROM "ReceiptLine" WHERE "receiptId" IN (SELECT id FROM _mr);

CREATE TEMP TABLE _mlot AS
  SELECT id FROM "Lot" WHERE "receiptLineId" IN (SELECT id FROM _ml);

CREATE TEMP TABLE _munit AS
  SELECT id FROM "ItemUnit" WHERE "receiptLineId" IN (SELECT id FROM _ml);

DELETE FROM "StockMovement"
  WHERE ("docType" = 'RECEIPT' AND "docId" IN (SELECT id FROM _mr))
     OR "lotId" IN (SELECT id FROM _mlot)
     OR "unitId" IN (SELECT id FROM _munit);

DELETE FROM "StockBalance" WHERE "lotId" IN (SELECT id FROM _mlot);

DELETE FROM "QrCode"
  WHERE ("type" = 'LOT' AND "refId" IN (SELECT id FROM _mlot))
     OR ("type" = 'UNIT' AND "refId" IN (SELECT id FROM _munit));

DELETE FROM "ItemUnit" WHERE id IN (SELECT id FROM _munit);
DELETE FROM "Lot" WHERE id IN (SELECT id FROM _mlot);

DELETE FROM "Attachment"
  WHERE ("ownerType" = 'receipt' AND "ownerId" IN (SELECT id FROM _mr))
     OR ("ownerType" = 'receipt_line' AND "ownerId" IN (SELECT id FROM _ml));

-- события старых приемок ведут на удаляемые страницы
DELETE FROM "Event" WHERE "url" LIKE '/warehouse/receipts/%';

DELETE FROM "Receipt" WHERE id IN (SELECT id FROM _mr);

SELECT (SELECT count(*) FROM _mr) AS deleted_receipts,
       (SELECT count(*) FROM _mlot) AS deleted_lots,
       (SELECT count(*) FROM _munit) AS deleted_units;

COMMIT;
