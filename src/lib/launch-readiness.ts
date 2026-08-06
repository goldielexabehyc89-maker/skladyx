import "server-only";
import { prisma } from "@/lib/db";

// Этап 5/Пакет 10 (коррекция): чек-лист готовности к запуску. Склад-зависимые проверки считаются
// СТРОГО по единственному активному складу (его warehouseId), только активные ячейки. Если активных
// складов не один — все склад-зависимые проверки красные (ячейки других/неактивных складов не в счёт).

export interface ReadinessCheck { label: string; ok: boolean; detail: string }
export interface SingleWarehouse { id: string; name: string; coolingRate: number | null }
export interface LaunchReadiness {
  activeWarehouseCount: number;
  singleWarehouse: SingleWarehouse | null;
  checks: ReadinessCheck[];
}

const WORK_ROLES = ["RECEIVER", "LOADER", "PICKER", "CONTROLLER"] as const;

export async function getLaunchReadiness(companyId: string, tempThresholdX: number | null): Promise<LaunchReadiness> {
  const [activeWarehouses, itemsWithEan, roleRows] = await Promise.all([
    prisma.warehouse.findMany({ where: { companyId, isActive: true }, orderBy: { name: "asc" } }),
    prisma.item.count({ where: { companyId, isActive: true, barcodes: { some: { isActive: true } } } }),
    prisma.userRole.groupBy({ by: ["role"], where: { role: { in: [...WORK_ROLES] }, user: { companyId, isActive: true } }, _count: true }),
  ]);
  const wh = activeWarehouses.length === 1 ? activeWarehouses[0] : null;
  const singleWarehouse: SingleWarehouse | null = wh
    ? { id: wh.id, name: wh.name, coolingRate: wh.coolingRate == null ? null : Number(wh.coolingRate) }
    : null;

  const cellCount = (kind: "STORAGE" | "COOLING" | "ISSUE" | "BUFFER") =>
    wh ? prisma.cell.count({ where: { companyId, warehouseId: wh.id, isActive: true, zone: { kind } } }) : Promise.resolve(0);
  const [storageLevels, coolingCells, issueCells, bufferCells] = await Promise.all([
    wh
      ? prisma.cell.groupBy({ by: ["level"], where: { companyId, warehouseId: wh.id, isActive: true, zone: { kind: "STORAGE" } }, _count: true })
      : Promise.resolve([] as { level: number | null }[]),
    cellCount("COOLING"),
    cellCount("ISSUE"),
    cellCount("BUFFER"),
  ]);

  const hasLevel = (pred: (l: number) => boolean) => !!wh && storageLevels.some((g) => g.level != null && pred(g.level));
  const roleCount = (r: string) => roleRows.find((g) => g.role === r)?._count ?? 0;

  const xFilled = tempThresholdX !== null;
  const rFilled = singleWarehouse?.coolingRate != null;

  const checks: ReadinessCheck[] = [
    { label: "Ровно один активный склад", ok: activeWarehouses.length === 1, detail: `активных складов: ${activeWarehouses.length}` },
    { label: "Порог температуры X задан", ok: xFilled, detail: xFilled ? `X = ${tempThresholdX} °C` : "не задан" },
    { label: "Скорость охлаждения R задана", ok: !!rFilled, detail: singleWarehouse ? (rFilled ? `R = ${singleWarehouse.coolingRate} °C/час` : "не задана") : "нужен один склад" },
    { label: "STORAGE-ячейки уровней 1, 2 и 3+", ok: hasLevel((l) => l === 1) && hasLevel((l) => l === 2) && hasLevel((l) => l >= 3), detail: wh ? `ур.1: ${hasLevel((l) => l === 1) ? "есть" : "нет"}, ур.2: ${hasLevel((l) => l === 2) ? "есть" : "нет"}, ур.3+: ${hasLevel((l) => l >= 3) ? "есть" : "нет"}` : "нужен один активный склад" },
    { label: "Физические ячейки COOLING, ISSUE, BUFFER", ok: coolingCells > 0 && issueCells > 0 && bufferCells > 0, detail: wh ? `COOLING: ${coolingCells}, ISSUE: ${issueCells}, BUFFER: ${bufferCells}` : "нужен один активный склад" },
    { label: "Активная номенклатура с активными EAN", ok: itemsWithEan > 0, detail: `товаров с EAN: ${itemsWithEan}` },
    ...WORK_ROLES.map((r) => ({ label: `Сотрудник с ролью ${r}`, ok: roleCount(r) > 0, detail: `${roleCount(r)} чел.` })),
  ];

  return { activeWarehouseCount: activeWarehouses.length, singleWarehouse, checks };
}
