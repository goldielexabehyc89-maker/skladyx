"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAdmin, requireStaff } from "@/lib/auth";
import { scoped, CompanyForbiddenError } from "@/lib/tenant";
import { warehouseAccess, isWhAllowed } from "@/lib/warehouse-access";
import { logEvent } from "@/lib/events";
import { broadcastRealtime } from "@/lib/realtime";
import { nextNumber } from "@/lib/counters";
import { resolveQr, parseScannedCode } from "@/lib/qr";
import { applyLotMovement, StockError, type Loc } from "@/lib/stock";
import { assertCellNotHeldByGroup } from "@/lib/cells";
import { fmtQty } from "@/lib/format";
import { sendPushToWarehouseStorekeepers } from "@/lib/push";
import type { FormState } from "@/app/actions/warehouses";

// Заказы поставщикам (МойСклад-стиль). При сохранении позициям присваиваются id
// «дата-№заказа-№строки» (6072026-12-1): номера заказов монотонные и не переиспользуются,
// поэтому id не задваиваются ни при каких условиях. Этикетки печатаются ИЗ ЗАКАЗА,
// клеятся на товар, затем приемка идёт сканированием: QR товара → QR ячейки.

async function getOrder(companyId: string, orderId: string) {
  const order = await prisma.supplierOrder.findFirst({
    where: { id: orderId, companyId },
    include: { lines: { orderBy: { createdAt: "asc" } }, supplier: true },
  });
  if (!order) throw new CompanyForbiddenError();
  return order;
}

// «6072026» для 6.07.2026 (день без нуля; московское время).
function dateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "numeric",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}${get("month")}${get("year")}`;
}

// Ввод чисел: принимаем и запятую, и точку («550,50» → 550.5).
function decimalInput(v: FormDataEntryValue | null): string {
  return String(v ?? "").trim().replace(",", ".");
}

export async function createSupplierOrderAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);

  const supplierId = String(formData.get("supplierId") ?? "");
  const warehouseId = String(formData.get("warehouseId") ?? "");
  const supplier = supplierId
    ? await prisma.supplier.findFirst({
        where: { id: supplierId, companyId: s.companyId, isActive: true },
      })
    : null;
  if (!supplier) return { error: "Выберите поставщика из подсказок" };
  const warehouse = warehouseId
    ? await prisma.warehouse.findFirst({ where: { id: warehouseId, companyId: s.companyId } })
    : null;
  if (!warehouse) return { error: "Выберите склад из подсказок" };
  if (!isWhAllowed(await warehouseAccess(session), warehouse.id))
    return { error: "Нет доступа к этому складу" };

  const order = await prisma.$transaction(async (tx) => {
    const number = await nextNumber(tx, s.companyId, "supplier_order");
    return tx.supplierOrder.create({
      data: {
        companyId: s.companyId,
        number,
        supplierId,
        warehouseId,
        note: String(formData.get("note") ?? "").trim() || null,
        createdById: session.userId,
      },
    });
  });
  revalidatePath("/warehouse/orders");
  redirect(`/warehouse/orders/${order.id}`);
}

const lineSchema = z.object({
  orderId: z.string().min(1),
  itemId: z.string().min(1, "Выберите товар"),
  qty: z.coerce.number().positive("Количество должно быть больше нуля"),
  price: z.coerce.number().min(0).optional(),
});

export async function addOrderLineAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);

  const priceRaw = decimalInput(formData.get("price"));
  const parsed = lineSchema.safeParse({
    orderId: formData.get("orderId"),
    itemId: formData.get("itemId"),
    qty: decimalInput(formData.get("qty")),
    price: priceRaw === "" ? undefined : priceRaw,
  });
  if (!parsed.success) return { error: parsed.error.errors[0].message };
  const { orderId, itemId, qty, price } = parsed.data;

  const order = await getOrder(s.companyId, orderId);
  if (order.status !== "DRAFT") return { error: "Заказ уже сохранён — позиции не редактируются" };
  const item = await s.item(itemId);

  if (!item.uom.allowFraction && !Number.isInteger(qty))
    return { error: `«${item.uom.name}» не допускает дробное количество` };
  if (item.tracking === "UNIT") {
    if (!Number.isInteger(qty)) return { error: "Серийный товар — только целое количество" };
    if (qty > 200) return { error: "Не больше 200 единиц в одной позиции" };
  }

  await prisma.supplierOrderLine.create({
    data: {
      companyId: s.companyId,
      orderId,
      itemId,
      qty: new Prisma.Decimal(qty),
      price: price !== undefined ? new Prisma.Decimal(price.toFixed(2)) : null,
    },
  });
  broadcastRealtime({
    type: "document.updated",
    entity: "order",
    entityId: orderId,
    companyId: s.companyId,
    warehouseIds: [order.warehouseId],
    actorUserId: session.userId,
  });
  revalidatePath(`/warehouse/orders/${orderId}`);
  return {};
}

export async function updateOrderLineAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);
  const lineId = String(formData.get("lineId") ?? "");
  const line = await prisma.supplierOrderLine.findFirst({
    where: { id: lineId, companyId: s.companyId },
    include: { order: true },
  });
  if (!line || line.order.status !== "DRAFT") return { error: "Позиция не редактируется" };

  const qty = Number(decimalInput(formData.get("qty")));
  const priceRaw = decimalInput(formData.get("price"));
  const price = priceRaw === "" ? null : Number(priceRaw);
  if (!Number.isFinite(qty) || qty <= 0) return { error: "Некорректное количество" };
  if (price !== null && (!Number.isFinite(price) || price < 0))
    return { error: "Некорректная цена" };

  const item = await s.item(line.itemId);
  if (!item.uom.allowFraction && !Number.isInteger(qty))
    return { error: `«${item.uom.name}» не допускает дробное количество` };
  if (item.tracking === "UNIT" && !Number.isInteger(qty))
    return { error: "Серийный товар — только целое количество" };

  await prisma.supplierOrderLine.update({
    where: { id: lineId },
    data: {
      qty: new Prisma.Decimal(qty),
      price: price !== null ? new Prisma.Decimal(price.toFixed(2)) : null,
    },
  });
  broadcastRealtime({
    type: "document.updated",
    entity: "order",
    entityId: line.orderId,
    companyId: s.companyId,
    warehouseIds: [line.order.warehouseId],
    actorUserId: session.userId,
  });
  revalidatePath(`/warehouse/orders/${line.orderId}`);
  return {};
}

export async function removeOrderLineAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const s = scoped(session);
  const lineId = String(formData.get("lineId") ?? "");
  const line = await prisma.supplierOrderLine.findFirst({
    where: { id: lineId, companyId: s.companyId },
    include: { order: true },
  });
  if (!line || line.order.status !== "DRAFT") return;
  await prisma.supplierOrderLine.delete({ where: { id: lineId } });
  broadcastRealtime({
    type: "document.updated",
    entity: "order",
    entityId: line.orderId,
    companyId: s.companyId,
    warehouseIds: [line.order.warehouseId],
    actorUserId: session.userId,
  });
  revalidatePath(`/warehouse/orders/${line.orderId}`);
}

// Сохранение заказа: позициям присваиваются id «дата-№заказа-№строки», статус → ORDERED.
export async function saveSupplierOrderAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);
  const orderId = String(formData.get("orderId") ?? "");
  const order = await getOrder(s.companyId, orderId);
  if (order.status !== "DRAFT") return { error: "Заказ уже сохранён" };
  if (order.lines.length === 0) return { error: "Добавьте хотя бы одну позицию" };

  const key = dateKey(order.createdAt);
  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < order.lines.length; i++) {
      const line = order.lines[i];
      if (line.lineCode) continue;
      await tx.supplierOrderLine.update({
        where: { id: line.id },
        data: { lineCode: `${key}-${order.number}-${i + 1}` },
      });
    }
    await tx.supplierOrder.update({
      where: { id: order.id },
      data: { status: "ORDERED", orderedAt: new Date() },
    });
  });

  await logEvent({
    companyId: s.companyId,
    type: "supplier_order_saved",
    title: `Заказ поставщику №${order.number} сохранён`,
    body: `${order.supplier.name}, позиций: ${order.lines.length}`,
    url: `/warehouse/orders/${order.id}`,
    actorId: session.userId,
    warehouseIds: [order.warehouseId],
  });
  await sendPushToWarehouseStorekeepers(s.companyId, order.warehouseId, {
    title: `Новая приёмка: заказ №${order.number}`,
    body: `${order.supplier.name} — ${order.lines.length} поз.`,
    url: "/warehouse/active",
    tag: `order-${order.id}`,
  });
  revalidatePath("/warehouse/orders");
  revalidatePath("/warehouse/active");
  revalidatePath(`/warehouse/orders/${order.id}`);
  return {};
}

export async function cancelSupplierOrderAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const s = scoped(session);
  const orderId = String(formData.get("orderId") ?? "");
  const order = await getOrder(s.companyId, orderId);
  if (order.status !== "DRAFT" && order.status !== "ORDERED") return;
  if (order.lines.some((l) => l.receivedQty.gt(0))) return; // частично принятый не отменить
  await prisma.supplierOrder.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
  broadcastRealtime({
    type: "document.updated",
    entity: "order",
    entityId: order.id,
    companyId: s.companyId,
    warehouseIds: [order.warehouseId],
    actorUserId: session.userId,
  });
  revalidatePath("/warehouse/orders");
  revalidatePath(`/warehouse/orders/${orderId}`);
}

// ---------- Приемка сканированием: QR товара → QR ячейки ----------

// Разбор кода позиции: "6072026-12-1" (партия/строка) или "6072026-12-1-2" (единица №2).
// Legacy: "6072026001" и "6072026001-2".
async function findOrderLineByCode(companyId: string, code: string) {
  const direct = await prisma.supplierOrderLine.findFirst({
    where: { lineCode: code, companyId },
  });
  if (direct) return { line: direct, unitSerial: null as number | null };
  const cut = code.lastIndexOf("-");
  if (cut > 0) {
    const base = code.slice(0, cut);
    const serial = Number(code.slice(cut + 1));
    if (Number.isInteger(serial) && serial >= 1) {
      const line = await prisma.supplierOrderLine.findFirst({
        where: { lineCode: base, companyId },
      });
      if (line) return { line, unitSerial: serial };
    }
  }
  return null;
}

export interface ReceiveCheck {
  error?: string;
  title?: string;
  sub?: string;
}

// Первый скан (товар): проверка, что этикетка из этого заказа и ещё не принята.
export async function checkOrderReceiveScanAction(
  orderId: string,
  raw: string,
): Promise<ReceiveCheck> {
  const session = await requireStaff();
  const s = scoped(session);
  const order = await getOrder(s.companyId, orderId);
  if (order.status !== "ORDERED") return { error: "Заказ не в статусе «заказан»" };
  if (!isWhAllowed(await warehouseAccess(session), order.warehouseId))
    return { error: "Нет доступа к складу этого заказа" };

  const code = parseScannedCode(raw);
  if (!code) return { error: "Код не распознан" };
  // подсказка, если первым отсканировали ячейку (частая ошибка)
  const asQr = await resolveQr(code);
  if (asQr && asQr.companyId === s.companyId && asQr.type === "CELL")
    return { error: "Это ячейка — сначала сканируйте товар, потом ячейку" };
  const found = await findOrderLineByCode(s.companyId, code);
  if (!found) return { error: "Эта этикетка не из данного заказа" };
  const { line, unitSerial } = found;
  if (line.orderId !== order.id) return { error: "Этикетка из другого заказа" };

  const item = await s.item(line.itemId);
  if (item.tracking === "UNIT") {
    if (unitSerial === null)
      return { error: "У серийного товара сканируйте этикетку конкретной единицы" };
    if (unitSerial > line.qty.toNumber()) return { error: "Такой единицы нет в позиции" };
    const already = await prisma.qrCode.findUnique({ where: { code } });
    if (already) return { error: `Единица №${unitSerial} уже принята` };
    return { title: item.name, sub: `Единица №${unitSerial} · теперь сканируйте ячейку` };
  }
  if (unitSerial !== null) return { error: "Лишний суффикс в коде партии" };
  if (line.receivedQty.gte(line.qty)) return { error: "Эта позиция уже принята полностью" };
  return {
    title: item.name,
    sub: `принято ${fmtQty(line.receivedQty)} из ${fmtQty(line.qty)} ${item.uom.name} · теперь сканируйте ячейку`,
  };
}

export interface ReceiveResult {
  ok?: string;
  error?: string;
  itemLabel?: string; // что принято (для окна подтверждения)
  cellCode?: string; // в какую ячейку
  done?: boolean; // заказ полностью принят
}

// Второй скан (ячейка): оприходование позиции/единицы в ячейку.
export async function receiveOrderScanAction(
  orderId: string,
  itemRaw: string,
  cellRaw: string,
): Promise<ReceiveResult> {
  const session = await requireStaff();
  const s = scoped(session);
  const order = await getOrder(s.companyId, orderId);
  if (order.status !== "ORDERED") return { error: "Заказ не в статусе «заказан»" };
  if (!isWhAllowed(await warehouseAccess(session), order.warehouseId))
    return { error: "Нет доступа к складу этого заказа" };

  const code = parseScannedCode(itemRaw);
  const cellCode = parseScannedCode(cellRaw);
  if (!code || !cellCode) return { error: "Код не распознан" };

  const cellQr = await resolveQr(cellCode);
  if (!cellQr || cellQr.companyId !== s.companyId || cellQr.type !== "CELL")
    return { error: "Вторым сканируйте QR ячейки" };
  const cell = await prisma.cell.findFirst({
    where: { id: cellQr.refId, companyId: s.companyId, isActive: true },
  });
  if (!cell) return { error: "Ячейка не найдена или отключена" };
  if (cell.isStaging)
    return { error: "Это ячейка зоны выдачи — примите в обычную ячейку хранения" };
  if (cell.warehouseId !== order.warehouseId)
    return { error: "Ячейка на другом складе — заказ едет не туда" };

  const found = await findOrderLineByCode(s.companyId, code);
  if (!found || found.line.orderId !== order.id)
    return { error: "Эта этикетка не из данного заказа" };
  const { line, unitSerial } = found;
  const item = await s.item(line.itemId);
  const to: Loc = { kind: "cell", warehouseId: cell.warehouseId, cellId: cell.id };

  let lotTaken: Prisma.Decimal | null = null; // сколько принято этим сканом (обычный товар)
  try {
    await prisma.$transaction(async (tx) => {
      await assertCellNotHeldByGroup(tx, s.companyId, cell.id); // «одна ячейка = одна группа»
      // приемка создаётся при первом скане
      let receiptId = order.receiptId;
      if (!receiptId) {
        const number = await nextNumber(tx, s.companyId, "receipt");
        const receipt = await tx.receipt.create({
          data: {
            companyId: s.companyId,
            number,
            warehouseId: order.warehouseId,
            status: "POSTED",
            postedAt: new Date(),
            supplier: order.supplier.name,
            note: `По заказу поставщику №${order.number}`,
            createdById: session.userId,
          },
        });
        receiptId = receipt.id;
        await tx.supplierOrder.update({
          where: { id: order.id },
          data: { receiptId },
        });
      }

      let receiptLine = await tx.receiptLine.findUnique({ where: { orderLineId: line.id } });
      if (!receiptLine) {
        receiptLine = await tx.receiptLine.create({
          data: {
            companyId: s.companyId,
            receiptId,
            itemId: line.itemId,
            qty: line.qty,
            price: line.price,
            cellId: cell.id,
            orderLineId: line.id,
          },
        });
      }

      if (item.tracking === "LOT") {
        if (unitSerial !== null) throw new StockError("Лишний суффикс в коде партии");
        const fresh = await tx.supplierOrderLine.findUnique({ where: { id: line.id } });
        if (!fresh || fresh.receivedQty.gte(fresh.qty))
          throw new StockError("Позиция уже принята полностью");
        // 1 скан = 1 штука; последний скан добирает дробный остаток
        const take = Prisma.Decimal.min(new Prisma.Decimal(1), fresh.qty.sub(fresh.receivedQty));
        let lot = await tx.lot.findUnique({ where: { receiptLineId: receiptLine.id } });
        if (!lot) {
          lot = await tx.lot.create({
            data: {
              companyId: s.companyId,
              itemId: line.itemId,
              receiptLineId: receiptLine.id,
              qtyReceived: take,
              price: line.price,
            },
          });
          await tx.qrCode.create({
            data: { companyId: s.companyId, code: line.lineCode!, type: "LOT", refId: lot.id },
          });
        } else {
          await tx.lot.update({
            where: { id: lot.id },
            data: { qtyReceived: { increment: take } },
          });
        }
        await applyLotMovement(tx, {
          companyId: s.companyId,
          docType: "RECEIPT",
          docId: receiptId,
          itemId: line.itemId,
          lotId: lot.id,
          qty: take,
          from: null,
          to,
          createdById: session.userId,
        });
        await tx.supplierOrderLine.update({
          where: { id: line.id },
          data: { receivedQty: { increment: take } },
        });
        lotTaken = take;
      } else {
        if (unitSerial === null)
          throw new StockError("У серийного товара сканируйте этикетку единицы");
        if (unitSerial > line.qty.toNumber()) throw new StockError("Такой единицы нет в позиции");
        const exists = await tx.qrCode.findUnique({ where: { code } });
        if (exists) throw new StockError(`Единица №${unitSerial} уже принята`);
        const unit = await tx.itemUnit.create({
          data: {
            companyId: s.companyId,
            itemId: line.itemId,
            receiptLineId: receiptLine.id,
            serial: unitSerial,
            price: line.price,
            status: "IN_STOCK",
            warehouseId: cell.warehouseId,
            cellId: cell.id,
          },
        });
        await tx.qrCode.create({
          data: { companyId: s.companyId, code, type: "UNIT", refId: unit.id },
        });
        await tx.stockMovement.create({
          data: {
            companyId: s.companyId,
            docType: "RECEIPT",
            docId: receiptId,
            itemId: line.itemId,
            unitId: unit.id,
            qty: new Prisma.Decimal(1),
            toWarehouseId: cell.warehouseId,
            toCellId: cell.id,
            createdById: session.userId,
          },
        });
        await tx.supplierOrderLine.update({
          where: { id: line.id },
          data: { receivedQty: { increment: 1 } },
        });
      }
    });
  } catch (e) {
    if (e instanceof StockError) return { error: e.message };
    throw e;
  }

  broadcastRealtime({
    type: "document.updated",
    entity: "receipt",
    entityId: order.id,
    companyId: s.companyId,
    warehouseIds: [order.warehouseId],
    actorUserId: session.userId,
  });
  broadcastRealtime({
    type: "stock.updated",
    entity: "stock",
    companyId: s.companyId,
    warehouseIds: [order.warehouseId],
    actorUserId: session.userId,
  });

  // всё ли принято
  const linesNow = await prisma.supplierOrderLine.findMany({ where: { orderId: order.id } });
  const allReceived = linesNow.every((l) => l.receivedQty.gte(l.qty));
  if (allReceived) {
    await prisma.supplierOrder.update({
      where: { id: order.id },
      data: { status: "RECEIVED", receivedAt: new Date() },
    });
    await logEvent({
      companyId: s.companyId,
      type: "receipt_posted",
      title: `Заказ поставщику №${order.number} принят на склад`,
      body: `${order.supplier.name}, позиций: ${order.lines.length}`,
      url: `/warehouse/orders/${order.id}`,
      actorId: session.userId,
      warehouseIds: [order.warehouseId],
    });
  }
  revalidatePath(`/warehouse/orders/${order.id}`);
  revalidatePath("/warehouse/orders");
  revalidatePath("/warehouse/receipts");
  revalidatePath("/warehouse/stock");
  revalidatePath("/warehouse/active");

  const label =
    item.tracking === "UNIT"
      ? `${item.name} №${unitSerial}`
      : `${item.name} (${fmtQty(lotTaken ?? line.qty)})`;
  return { ok: `${label} → ${cell.code}`, itemLabel: label, cellCode: cell.code, done: allReceived };
}

// Удаление заказа (админ). Родитель не удаляется, пока есть ребёнок: если по заказу
// уже была приёмка — сначала удалить её.
export async function deleteSupplierOrderAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);
  const order = await getOrder(s.companyId, String(formData.get("orderId") ?? ""));
  if (order.receiptId) {
    const receipt = await prisma.receipt.findUnique({ where: { id: order.receiptId } });
    return {
      error: `По заказу есть приёмка №${receipt?.number ?? "—"} — сначала удалите её (вкладка «Приемка»)`,
    };
  }
  if (order.lines.some((l) => l.receivedQty.gt(0)))
    return { error: "По заказу уже принимался товар — удалить нельзя" };

  await prisma.supplierOrder.delete({ where: { id: order.id } });
  await logEvent({
    companyId: s.companyId,
    type: "supplier_order_deleted",
    title: `Заказ поставщику №${order.number} удалён`,
    body: order.supplier.name,
    actorId: session.userId,
    warehouseIds: [order.warehouseId],
  });
  revalidatePath("/warehouse/orders");
  redirect("/warehouse/orders");
}

// Удаление приёмки (админ). Возможно, только пока принятый товар «нетронут»:
// партии целиком на складе, единицы IN_STOCK, нет ссылок из заявок/выдач/
// перемещений/списаний/инвентаризаций. Заказ возвращается в «заказан».
export async function deleteReceiptAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);
  const order = await getOrder(s.companyId, String(formData.get("orderId") ?? ""));
  if (!order.receiptId) return { error: "У заказа нет приёмки" };
  const receipt = await prisma.receipt.findFirst({
    where: { id: order.receiptId, companyId: s.companyId },
    include: { lines: true },
  });
  if (!receipt) return { error: "Приёмка не найдена" };

  const lineIds = receipt.lines.map((l) => l.id);
  const [lots, units] = await Promise.all([
    prisma.lot.findMany({ where: { receiptLineId: { in: lineIds } } }),
    prisma.itemUnit.findMany({ where: { receiptLineId: { in: lineIds } } }),
  ]);
  const lotIds = lots.map((l) => l.id);
  const unitIds = units.map((u) => u.id);
  const refFilter = { OR: [{ lotId: { in: lotIds } }, { unitId: { in: unitIds } }] };

  // проверки «ребёнок держит родителя»: где товар этой приёмки уже используется
  const inPick = await prisma.pickLine.findFirst({ where: refFilter, include: { pickList: true } });
  if (inPick)
    return {
      error: `Товар из приёмки уже в заявке на сбор №${inPick.pickList.number} — сначала удалите или отмените её`,
    };
  const inIssue = await prisma.issueLine.findFirst({ where: refFilter, include: { issue: true } });
  if (inIssue) return { error: `Товар из приёмки уже в выдаче №${inIssue.issue.number} — удалить нельзя` };
  const inTransfer = await prisma.transferLine.findFirst({
    where: refFilter,
    include: { transfer: true },
  });
  if (inTransfer)
    return { error: `Товар из приёмки в перемещении №${inTransfer.transfer.number} — сначала удалите его` };
  const inWriteOff = await prisma.writeOffLine.findFirst({
    where: refFilter,
    include: { writeOff: true },
  });
  if (inWriteOff)
    return { error: `Товар из приёмки в списании №${inWriteOff.writeOff.number} — сначала удалите его` };
  const inInventory = await prisma.inventoryLine.findFirst({
    where: refFilter,
    include: { inventory: true },
  });
  if (inInventory)
    return {
      error: `Товар из приёмки в инвентаризации №${inInventory.inventory.number} — сначала удалите её`,
    };

  for (const u of units) {
    if (u.status !== "IN_STOCK") {
      const item = await s.item(u.itemId);
      return { error: `Единица «${item.name}» №${u.serial} уже не на складе — удалить нельзя` };
    }
  }
  const balances = await prisma.stockBalance.findMany({ where: { lotId: { in: lotIds } } });
  for (const lot of lots) {
    const bs = balances.filter((b) => b.lotId === lot.id);
    const item = await s.item(lot.itemId);
    if (bs.some((b) => b.employeeId))
      return { error: `Партия «${item.name}» уже частично у сотрудника — удалить нельзя` };
    const total = bs.reduce((sum, b) => sum.add(b.qty), new Prisma.Decimal(0));
    if (!total.eq(lot.qtyReceived))
      return { error: `Остаток партии «${item.name}» изменился (${fmtQty(total)} из ${fmtQty(lot.qtyReceived)}) — удалить нельзя` };
  }

  await prisma.$transaction(async (tx) => {
    await tx.stockMovement.deleteMany({
      where: { companyId: s.companyId, OR: [{ lotId: { in: lotIds } }, { unitId: { in: unitIds } }] },
    });
    await tx.stockBalance.deleteMany({ where: { lotId: { in: lotIds } } });
    await tx.qrCode.deleteMany({
      where: {
        companyId: s.companyId,
        OR: [
          { type: "LOT", refId: { in: lotIds } },
          { type: "UNIT", refId: { in: unitIds } },
        ],
      },
    });
    await tx.lot.deleteMany({ where: { id: { in: lotIds } } });
    await tx.itemUnit.deleteMany({ where: { id: { in: unitIds } } });
    await tx.attachment.deleteMany({
      where: {
        companyId: s.companyId,
        OR: [
          { ownerType: "receipt", ownerId: receipt.id },
          { ownerType: "receipt_line", ownerId: { in: lineIds } },
        ],
      },
    });
    await tx.receipt.delete({ where: { id: receipt.id } }); // строки — каскадом
    await tx.supplierOrderLine.updateMany({
      where: { orderId: order.id },
      data: { receivedQty: 0 },
    });
    await tx.supplierOrder.update({
      where: { id: order.id },
      data: { status: "ORDERED", receiptId: null, receivedAt: null },
    });
  });
  await logEvent({
    companyId: s.companyId,
    type: "receipt_deleted",
    title: `Приёмка №${receipt.number} удалена`,
    body: `Заказ поставщику №${order.number} снова ждёт приёмки`,
    url: `/warehouse/orders/${order.id}`,
    actorId: session.userId,
    warehouseIds: [order.warehouseId],
  });
  revalidatePath("/warehouse/receipts");
  revalidatePath("/warehouse/orders");
  revalidatePath("/warehouse/stock");
  revalidatePath("/warehouse/active");
  redirect("/warehouse/receipts");
}
