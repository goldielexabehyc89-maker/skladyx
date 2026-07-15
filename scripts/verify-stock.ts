// Интеграционная проверка ядра остатков (lib/stock) на живой dev-базе:
// назначение ячейки, перемещение, выдача с подтверждением, запрет минуса,
// инвентаризационные корректировки. Опирается на каркас из verify-http.mjs
// (склад «Основной склад», ячейки А-01/А-02, сотрудник), а стартовую партию
// с остатком 40.5 на складе без ячейки создаёт сама.
// Запуск: npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-stock.ts
/* eslint-disable no-console */
import { Prisma, PrismaClient } from "@prisma/client";
import { applyLotMovement, moveUnit, StockError, locKey } from "@/lib/stock";

const prisma = new PrismaClient();
let failures = 0;

function ok(name: string, cond: boolean, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

async function main() {
  const company = await prisma.company.findFirstOrThrow();
  const admin = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
  const warehouse = await prisma.warehouse.findFirstOrThrow({
    where: { companyId: company.id, name: "Основной склад" },
  });
  const cellA1 = await prisma.cell.findFirstOrThrow({
    where: { warehouseId: warehouse.id, code: "А-01" },
  });
  const cellA2 = await prisma.cell.findFirstOrThrow({
    where: { warehouseId: warehouse.id, code: "А-02" },
  });
  const employee = await prisma.user.findFirstOrThrow({ where: { role: "EMPLOYEE" } });

  // Стартовая партия с остатком 40.5 на складе без ячейки (самосев, независимо от приёмок).
  let lot = await prisma.lot.findFirst({ where: { companyId: company.id } });
  if (!lot) {
    const uom = await prisma.uom.findFirstOrThrow({ where: { companyId: company.id } });
    const item = await prisma.item.create({
      data: {
        companyId: company.id,
        name: "Проверка остатков",
        uomId: uom.id,
        tracking: "LOT",
      },
    });
    lot = await prisma.lot.create({
      data: {
        companyId: company.id,
        itemId: item.id,
        receiptLineId: `verify-stock-seed-${company.id}`,
        qtyReceived: new Prisma.Decimal("40.5"),
        price: new Prisma.Decimal("550"),
      },
    });
    await prisma.$transaction((tx) =>
      applyLotMovement(tx, {
        companyId: company.id,
        itemId: item.id,
        lotId: lot!.id,
        docType: "RECEIPT",
        docId: `verify-stock-seed-${company.id}`,
        qty: "40.5",
        from: null,
        to: { kind: "warehouse", warehouseId: warehouse.id },
        createdById: admin.id,
      }),
    );
  }

  const base = {
    companyId: company.id,
    itemId: lot.itemId,
    lotId: lot.id,
    createdById: admin.id,
  } as const;

  const qtyAt = async (key: string) =>
    (
      await prisma.stockBalance.findUnique({ where: { lotId_locKey: { lotId: lot.id, locKey: key } } })
    )?.qty.toNumber() ?? 0;

  console.log("1. Назначение ячейки: весь остаток склада → А-01");
  {
    const whKey = locKey({ kind: "warehouse", warehouseId: warehouse.id });
    const startQty = await qtyAt(whKey);
    ok("исходный остаток 40.5 без ячейки", startQty === 40.5, `=${startQty}`);
    await prisma.$transaction((tx) =>
      applyLotMovement(tx, {
        ...base,
        docType: "CELL_ASSIGN",
        docId: cellA1.id,
        qty: startQty,
        from: { kind: "warehouse", warehouseId: warehouse.id },
        to: { kind: "cell", warehouseId: warehouse.id, cellId: cellA1.id },
      }),
    );
    ok("остаток в А-01 = 40.5", (await qtyAt(`C:${cellA1.id}`)) === 40.5);
    ok("строка «без ячейки» удалена (qty=0 подчищен)", (await qtyAt(whKey)) === 0);
  }

  console.log("2. Запрет минуса: попытка взять больше остатка");
  {
    let threw = false;
    try {
      await prisma.$transaction((tx) =>
        applyLotMovement(tx, {
          ...base,
          docType: "WRITEOFF",
          docId: "test",
          qty: 999,
          from: { kind: "cell", warehouseId: warehouse.id, cellId: cellA1.id },
          to: null,
        }),
      );
    } catch (e) {
      threw = e instanceof StockError;
    }
    ok("StockError при недостатке", threw);
    ok("остаток не изменился", (await qtyAt(`C:${cellA1.id}`)) === 40.5);
  }

  console.log("3. Выдача с подтверждением: 10 кг → EP → подтверждение → E");
  {
    await prisma.$transaction((tx) =>
      applyLotMovement(tx, {
        ...base,
        docType: "ISSUE",
        docId: "test-issue",
        qty: 10,
        from: { kind: "cell", warehouseId: warehouse.id, cellId: cellA1.id },
        to: { kind: "employeePending", employeeId: employee.id },
      }),
    );
    ok("в А-01 осталось 30.5", (await qtyAt(`C:${cellA1.id}`)) === 30.5);
    ok("EP: 10", (await qtyAt(`EP:${employee.id}`)) === 10);

    await prisma.$transaction((tx) =>
      applyLotMovement(tx, {
        ...base,
        docType: "ISSUE_CONFIRM",
        docId: "test-issue",
        qty: 10,
        from: { kind: "employeePending", employeeId: employee.id },
        to: { kind: "employee", employeeId: employee.id },
      }),
    );
    ok("EP очищен", (await qtyAt(`EP:${employee.id}`)) === 0);
    ok("за сотрудником 10", (await qtyAt(`E:${employee.id}`)) === 10);
  }

  console.log("4. Единицы: перемещение в ячейку и выдача");
  {
    // самосев поштучной единицы на складе без ячейки, если её нет
    if (
      (await prisma.itemUnit.count({
        where: { companyId: company.id, status: "IN_STOCK", serial: 1 },
      })) === 0
    ) {
      const uom = await prisma.uom.findFirstOrThrow({ where: { companyId: company.id } });
      const unitItem = await prisma.item.create({
        data: {
          companyId: company.id,
          name: "Проверка остатков · инструмент",
          uomId: uom.id,
          tracking: "UNIT",
        },
      });
      await prisma.itemUnit.create({
        data: {
          companyId: company.id,
          itemId: unitItem.id,
          receiptLineId: `verify-stock-seed-unit-${company.id}`,
          serial: 1,
          status: "IN_STOCK",
          warehouseId: warehouse.id,
        },
      });
    }
    const unit = await prisma.itemUnit.findFirstOrThrow({
      where: { companyId: company.id, status: "IN_STOCK", serial: 1 },
    });
    await prisma.$transaction((tx) =>
      moveUnit(tx, {
        companyId: company.id,
        docType: "CELL_ASSIGN",
        docId: cellA2.id,
        unit,
        to: { kind: "cell", warehouseId: warehouse.id, cellId: cellA2.id },
        status: "IN_STOCK",
        createdById: admin.id,
      }),
    );
    const inCell = await prisma.itemUnit.findUniqueOrThrow({ where: { id: unit.id } });
    ok("единица в А-02", inCell.cellId === cellA2.id && inCell.status === "IN_STOCK");

    await prisma.$transaction((tx) =>
      moveUnit(tx, {
        companyId: company.id,
        docType: "ISSUE",
        docId: "test-issue-2",
        unit: inCell,
        to: { kind: "employeePending", employeeId: employee.id },
        status: "ISSUE_PENDING",
        createdById: admin.id,
      }),
    );
    const pendingUnit = await prisma.itemUnit.findUniqueOrThrow({ where: { id: unit.id } });
    ok(
      "единица «ждёт подтверждения» у сотрудника",
      pendingUnit.status === "ISSUE_PENDING" && pendingUnit.employeeId === employee.id,
    );

    await prisma.$transaction((tx) =>
      moveUnit(tx, {
        companyId: company.id,
        docType: "ISSUE_CONFIRM",
        docId: "test-issue-2",
        unit: pendingUnit,
        to: { kind: "employee", employeeId: employee.id },
        status: "ISSUED",
        createdById: admin.id,
      }),
    );
    const issued = await prisma.itemUnit.findUniqueOrThrow({ where: { id: unit.id } });
    ok("единица числится за сотрудником", issued.status === "ISSUED");
  }

  console.log("5. Инвентаризация: излишек +2 и недостача -0.5");
  {
    await prisma.$transaction((tx) =>
      applyLotMovement(tx, {
        ...base,
        docType: "INVENTORY",
        docId: "test-inv",
        qty: 2,
        from: null,
        to: { kind: "cell", warehouseId: warehouse.id, cellId: cellA1.id },
      }),
    );
    ok("после излишка 32.5", (await qtyAt(`C:${cellA1.id}`)) === 32.5);
    await prisma.$transaction((tx) =>
      applyLotMovement(tx, {
        ...base,
        docType: "INVENTORY",
        docId: "test-inv",
        qty: 0.5,
        from: { kind: "cell", warehouseId: warehouse.id, cellId: cellA1.id },
        to: null,
      }),
    );
    ok("после недостачи 32", (await qtyAt(`C:${cellA1.id}`)) === 32);
  }

  console.log("6. Ledger: сумма движений сходится с остатками");
  {
    const movements = await prisma.stockMovement.findMany({ where: { lotId: lot.id } });
    let net = new Prisma.Decimal(0);
    for (const m of movements) {
      const inbound = m.toWarehouseId || m.toEmployeeId;
      const outbound = m.fromWarehouseId || m.fromEmployeeId;
      if (inbound && !outbound) net = net.add(m.qty);
      if (!inbound && outbound) net = net.sub(m.qty);
    }
    const balances = await prisma.stockBalance.findMany({ where: { lotId: lot.id } });
    const total = balances.reduce((s, b) => s.add(b.qty), new Prisma.Decimal(0));
    ok(
      `нетто движений (${net}) = сумма остатков (${total})`,
      net.eq(total),
    );
  }

  console.log(failures === 0 ? "\nЯДРО ОСТАТКОВ: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ ✓" : `\nПРОВАЛОВ: ${failures}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
