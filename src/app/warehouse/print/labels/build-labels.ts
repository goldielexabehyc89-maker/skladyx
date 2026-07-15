import "server-only";
import { prisma } from "@/lib/db";
import { fmtDate, fmtQty } from "@/lib/format";

// Сборка этикеток по параметрам (?cells | ?cell | ?receipt | ?order | ?employee |
// ?picklist). Используется страницей печати и PDF-скачиванием.

export interface Label {
  code: string;
  line1: string;
  line2?: string;
  line3?: string;
}

export async function buildLabels(
  companyId: string,
  params: {
    cells?: string;
    cell?: string;
    receipt?: string;
    order?: string;
    employee?: string;
    picklist?: string;
  },
): Promise<{ title: string; labels: Label[] }> {
  // Этикетки из заказа поставщику — печатаются ДО приемки (id позиций уже присвоены),
  // клеятся на товар, затем приемка идёт сканированием.
  if (params.order) {
    const order = await prisma.supplierOrder.findFirst({
      where: { id: params.order, companyId },
      include: { lines: { orderBy: { createdAt: "asc" } }, supplier: true },
    });
    if (!order) return { title: "Заказ", labels: [] };
    const items = await prisma.item.findMany({
      where: { id: { in: order.lines.map((l) => l.itemId) } },
      include: { uom: true },
    });
    const itemById = new Map(items.map((i) => [i.id, i]));
    const labels: Label[] = [];
    for (const line of order.lines) {
      const item = itemById.get(line.itemId);
      if (!item || !line.lineCode) continue;
      if (item.tracking === "LOT") {
        // обычный товар: одинаковый QR на каждую штуку (дробный остаток — доп. этикетка)
        const copies = Math.max(1, Math.ceil(line.qty.toNumber()));
        for (let i = 0; i < copies; i++) {
          labels.push({
            code: line.lineCode,
            line1: item.name,
            line2: `Заказ №${order.number} от ${fmtDate(order.createdAt)} · ${order.supplier.name}`,
            line3: `${fmtQty(line.qty)} ${item.uom.name}`,
          });
        }
      } else {
        const count = line.qty.toNumber();
        for (let serial = 1; serial <= count; serial++) {
          labels.push({
            code: `${line.lineCode}-${serial}`,
            line1: item.name,
            line2: `Ед. №${serial} · заказ №${order.number}`,
            line3: fmtDate(order.createdAt),
          });
        }
      }
    }
    return { title: `Заказ поставщику №${order.number}`, labels };
  }

  if (params.cells || params.cell) {
    const cells = params.cell
      ? await prisma.cell.findMany({ where: { id: params.cell, companyId } })
      : await prisma.cell.findMany({
          where: { warehouseId: params.cells, companyId, isActive: true },
          orderBy: { code: "asc" },
        });
    if (cells.length === 0) return { title: "Ячейки", labels: [] };
    const warehouse = await prisma.warehouse.findFirst({
      where: { id: cells[0].warehouseId, companyId },
    });
    const qrs = await prisma.qrCode.findMany({
      where: { type: "CELL", refId: { in: cells.map((c) => c.id) } },
    });
    const qrByRef = new Map(qrs.map((q) => [q.refId, q.code]));
    return {
      title: `Ячейки · ${warehouse?.name ?? ""}`,
      labels: cells
        .filter((c) => qrByRef.has(c.id))
        .map((c) => ({
          code: qrByRef.get(c.id)!,
          line1: c.code,
          line2: warehouse?.name,
          line3: c.isStaging ? "Зона выдачи" : undefined,
        })),
    };
  }

  if (params.receipt) {
    const receipt = await prisma.receipt.findFirst({
      where: { id: params.receipt, companyId },
      include: { lines: true },
    });
    if (!receipt) return { title: "Приемка", labels: [] };
    const items = await prisma.item.findMany({
      where: { id: { in: receipt.lines.map((l) => l.itemId) } },
      include: { uom: true },
    });
    const itemById = new Map(items.map((i) => [i.id, i]));
    const labels: Label[] = [];

    const lineIds = receipt.lines.map((l) => l.id);
    const lots = await prisma.lot.findMany({ where: { receiptLineId: { in: lineIds } } });
    const units = await prisma.itemUnit.findMany({
      where: { receiptLineId: { in: lineIds } },
      orderBy: { serial: "asc" },
    });
    const qrs = await prisma.qrCode.findMany({
      where: {
        OR: [
          { type: "LOT", refId: { in: lots.map((l) => l.id) } },
          { type: "UNIT", refId: { in: units.map((u) => u.id) } },
        ],
      },
    });
    const qrByRef = new Map(qrs.map((q) => [q.refId, q.code]));
    const lineById = new Map(receipt.lines.map((l) => [l.id, l]));

    for (const lot of lots) {
      const line = lineById.get(lot.receiptLineId);
      const item = line ? itemById.get(line.itemId) : undefined;
      const code = qrByRef.get(lot.id);
      if (!item || !code || !line) continue;
      const copies = Math.max(1, Math.ceil(line.qty.toNumber()));
      for (let i = 0; i < copies; i++) {
        labels.push({
          code,
          line1: item.name,
          line2: `Приемка №${receipt.number} от ${fmtDate(receipt.createdAt)}`,
          line3: `${fmtQty(line.qty)} ${item.uom.name}`,
        });
      }
    }
    for (const unit of units) {
      const line = lineById.get(unit.receiptLineId);
      const item = line ? itemById.get(line.itemId) : undefined;
      const code = qrByRef.get(unit.id);
      if (!item || !code) continue;
      labels.push({
        code,
        line1: item.name,
        line2: `Ед. №${unit.serial} · приемка №${receipt.number}`,
        line3: fmtDate(receipt.createdAt),
      });
    }
    return { title: `Приемка №${receipt.number}`, labels };
  }

  if (params.employee) {
    const user = await prisma.user.findFirst({ where: { id: params.employee, companyId } });
    if (!user) return { title: "Бейдж", labels: [] };
    const qr = await prisma.qrCode.findUnique({
      where: { type_refId: { type: "EMPLOYEE", refId: user.id } },
    });
    return {
      title: `Бейдж · ${user.name}`,
      labels: qr ? [{ code: qr.code, line1: user.name, line2: "Бейдж сотрудника" }] : [],
    };
  }

  if (params.picklist) {
    const pl = await prisma.pickList.findFirst({ where: { id: params.picklist, companyId } });
    if (!pl) return { title: "Заявка", labels: [] };
    const employee = pl.targetEmployeeId
      ? await prisma.user.findFirst({ where: { id: pl.targetEmployeeId, companyId } })
      : null;
    const targetWh = pl.targetWarehouseId
      ? await prisma.warehouse.findFirst({ where: { id: pl.targetWarehouseId, companyId } })
      : null;
    const docTitle = pl.targetWarehouseId ? `Перемещение №${pl.number}` : `Заявка №${pl.number}`;
    const qr = await prisma.qrCode.findUnique({
      where: { type_refId: { type: "PICKLIST", refId: pl.id } },
    });
    return {
      title: docTitle,
      labels: qr
        ? [
            {
              code: qr.code,
              line1: docTitle,
              line2: pl.targetWarehouseId ? `На склад: ${targetWh?.name ?? "—"}` : employee?.name,
            },
          ]
        : [],
    };
  }

  return { title: "Этикетки", labels: [] };
}
