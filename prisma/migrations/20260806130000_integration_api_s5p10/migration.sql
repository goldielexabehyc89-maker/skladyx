-- Этап 5/Пакет 10: нейтральный API интеграции.
-- Аддитивно и обратимо: делаем createdById внешнего заказа nullable (интеграционный импорт без
-- сессии передаёт NULL) и добавляем tenant-scoped уникальность внешнего идентификатора товара
-- (NULL в Postgres считается различным → ограничение действует только для непустых externalId).

-- ExternalOrder.createdById → nullable
ALTER TABLE "ExternalOrder" ALTER COLUMN "createdById" DROP NOT NULL;

-- Идемпотентность интеграционного upsert по [companyId, externalId] на Item
CREATE UNIQUE INDEX "Item_companyId_externalId_key" ON "Item"("companyId", "externalId");
