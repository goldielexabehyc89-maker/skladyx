import "server-only";
import type { Prisma } from "@prisma/client";

// Сквозные номера документов в рамках компании. Вызывать внутри транзакции
// проведения/создания документа — атомарный инкремент защищает от дублей.

// docType: receipt | transfer | writeoff | picklist | issue | inventory | supplier_order
// | oline:<датаDMYYYY> (сквозной номер позиций заказов поставщикам за день)
export async function nextNumber(
  tx: Prisma.TransactionClient,
  companyId: string,
  docType: string,
): Promise<number> {
  const counter = await tx.counter.upsert({
    where: { companyId_docType: { companyId, docType } },
    update: { value: { increment: 1 } },
    create: { companyId, docType, value: 1 },
  });
  return counter.value;
}
