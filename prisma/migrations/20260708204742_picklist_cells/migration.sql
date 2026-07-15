CREATE TABLE "PickListCell" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "pickListId" TEXT NOT NULL,
    "cellId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PickListCell_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PickListCell_pickListId_cellId_key" ON "PickListCell"("pickListId", "cellId");

CREATE INDEX "PickListCell_pickListId_idx" ON "PickListCell"("pickListId");

ALTER TABLE "PickListCell" ADD CONSTRAINT "PickListCell_pickListId_fkey" FOREIGN KEY ("pickListId") REFERENCES "PickList"("id") ON DELETE CASCADE ON UPDATE CASCADE;
