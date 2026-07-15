"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { warehouseAccess, isWhAllowed } from "@/lib/warehouse-access";
import { logEvent } from "@/lib/events";
import { resolveQr, parseScannedCode } from "@/lib/qr";
import { nextNumber } from "@/lib/counters";
import { applyLotMovement, moveUnit, StockError, type Loc } from "@/lib/stock";
import { fmtQty } from "@/lib/format";
import type { FormState } from "@/app/actions/warehouses";
import type { ScanResult } from "@/components/scan-collect";

// Списание: со склада (scope "W:<id>") или с сотрудника (scope "E:<id>"), причина обязательна.

export async function createWriteOffAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);
  const scope = String(formData.get("scope") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { error: "Укажите причину списания" };

  let warehouseId: string | null = null;
  let employeeId: string | null = null;
  if (scope.startsWith("W:")) {
    warehouseId = scope.slice(2);
    await s.warehouse(warehouseId);
    if (!isWhAllowed(await warehouseAccess(session), warehouseId))
      return { error: "Нет доступа к этому складу" };
  } else if (scope.startsWith("E:")) {
    employeeId = scope.slice(2);
    await s.user(employeeId);
  } else {
    return { error: "Выберите склад или сотрудника" };
  }

  const writeOff = await prisma.$transaction(async (tx) => {
    const number = await nextNumber(tx, s.companyId, "writeoff");
    return tx.writeOff.create({
      data: {
        companyId: s.companyId,
        number,
        warehouseId,
        employeeId,
        reason,
        createdById: session.userId,
      },
    });
  });
  revalidatePath("/warehouse/writeoffs");
  redirect(`/warehouse/writeoffs/${writeOff.id}`);
}

export async function addWriteOffLineByScanAction(
  writeOffId: string,
  raw: string,
): Promise<ScanResult> {
  const session = await requireAdmin();
  const s = scoped(session);
  const writeOff = await s.writeOff(writeOffId);
  if (writeOff.status !== "DRAFT") return { error: "Списание уже проведено" };

  const code = parseScannedCode(raw);
  if (!code) return { error: "Код не распознан" };
  const qr = await resolveQr(code);
  if (!qr || qr.companyId !== s.companyId) return { error: "Код не найден" };

  if (qr.type === "LOT") {
    const lot = await prisma.lot.findFirst({ where: { id: qr.refId, companyId: s.companyId } });
    if (!lot) return { error: "Партия не найдена" };
    if (writeOff.lines.some((l) => l.lotId === lot.id)) return { error: "Партия уже в списке" };
    const item = await s.item(lot.itemId);
    const balances = await prisma.stockBalance.findMany({
      where: {
        lotId: lot.id,
        ...(writeOff.warehouseId
          ? { warehouseId: writeOff.warehouseId, employeeId: null }
          : { employeeId: writeOff.employeeId, locKey: { startsWith: "E:" } }),
      },
    });
    const available = balances.reduce((sum, b) => sum + b.qty.toNumber(), 0);
    if (available <= 0) return { error: `«${item.name}»: нет остатка в выбранном месте` };
    await prisma.writeOffLine.create({
      data: {
        companyId: s.companyId,
        writeOffId,
        itemId: lot.itemId,
        lotId: lot.id,
        qty: new Prisma.Decimal(available),
      },
    });
    revalidatePath(`/warehouse/writeoffs/${writeOffId}`);
    return { ok: `${item.name}: ${fmtQty(available)} ${item.uom.name} (можно уменьшить)` };
  }

  if (qr.type === "UNIT") {
    const unit = await prisma.itemUnit.findFirst({
      where: { id: qr.refId, companyId: s.companyId },
    });
    if (!unit) return { error: "Единица не найдена" };
    const inScope = writeOff.warehouseId
      ? unit.status === "IN_STOCK" && unit.warehouseId === writeOff.warehouseId
      : unit.status === "ISSUED" && unit.employeeId === writeOff.employeeId;
    if (!inScope) return { error: "Единицы нет в выбранном месте списания" };
    if (writeOff.lines.some((l) => l.unitId === unit.id)) return { error: "Единица уже в списке" };
    const item = await s.item(unit.itemId);
    await prisma.writeOffLine.create({
      data: {
        companyId: s.companyId,
        writeOffId,
        itemId: unit.itemId,
        unitId: unit.id,
        qty: new Prisma.Decimal(1),
      },
    });
    revalidatePath(`/warehouse/writeoffs/${writeOffId}`);
    return { ok: `${item.name} №${unit.serial}` };
  }

  return { error: "Сканируйте QR партии или единицы" };
}

export async function setWriteOffLineQtyAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);
  const lineId = String(formData.get("lineId") ?? "");
  const qty = Number(String(formData.get("qty") ?? "").trim().replace(",", "."));
  const line = await prisma.writeOffLine.findFirst({
    where: { id: lineId, companyId: s.companyId },
    include: { writeOff: true },
  });
  if (!line || line.writeOff.status !== "DRAFT") return { error: "Позиция недоступна" };
  if (!line.lotId) return { error: "У единицы количество всегда 1" };
  if (!Number.isFinite(qty) || qty <= 0) return { error: "Некорректное количество" };
  await prisma.writeOffLine.update({
    where: { id: lineId },
    data: { qty: new Prisma.Decimal(qty) },
  });
  revalidatePath(`/warehouse/writeoffs/${line.writeOffId}`);
  return {};
}

export async function removeWriteOffLineAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const s = scoped(session);
  const lineId = String(formData.get("lineId") ?? "");
  const line = await prisma.writeOffLine.findFirst({
    where: { id: lineId, companyId: s.companyId },
    include: { writeOff: true },
  });
  if (!line || line.writeOff.status !== "DRAFT") return;
  await prisma.writeOffLine.delete({ where: { id: lineId } });
  revalidatePath(`/warehouse/writeoffs/${line.writeOffId}`);
}

export async function postWriteOffAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);
  const writeOffId = String(formData.get("writeOffId") ?? "");
  const writeOff = await s.writeOff(writeOffId);
  if (writeOff.status !== "DRAFT") return { error: "Уже проведено" };
  if (writeOff.lines.length === 0) return { error: "Добавьте позиции сканированием" };

  try {
    await prisma.$transaction(async (tx) => {
      for (const line of writeOff.lines) {
        if (line.lotId) {
          let remaining = line.qty;
          const balances = await tx.stockBalance.findMany({
            where: {
              lotId: line.lotId,
              qty: { gt: 0 },
              ...(writeOff.warehouseId
                ? { warehouseId: writeOff.warehouseId, employeeId: null }
                : { employeeId: writeOff.employeeId, locKey: { startsWith: "E:" } }),
            },
            orderBy: { cellId: { sort: "asc", nulls: "first" } },
          });
          for (const b of balances) {
            if (remaining.lte(0)) break;
            const take = Prisma.Decimal.min(remaining, b.qty);
            const from: Loc = b.employeeId
              ? { kind: "employee", employeeId: b.employeeId }
              : b.cellId
                ? { kind: "cell", warehouseId: b.warehouseId!, cellId: b.cellId }
                : { kind: "warehouse", warehouseId: b.warehouseId! };
            await applyLotMovement(tx, {
              companyId: s.companyId,
              docType: "WRITEOFF",
              docId: writeOff.id,
              itemId: line.itemId,
              lotId: line.lotId,
              qty: take,
              from,
              to: null,
              createdById: session.userId,
            });
            remaining = remaining.sub(take);
          }
          if (remaining.gt(0)) throw new StockError("Недостаточно остатка для списания");
        } else if (line.unitId) {
          const unit = await tx.itemUnit.findFirst({
            where: { id: line.unitId, companyId: s.companyId },
          });
          const inScope =
            unit &&
            (writeOff.warehouseId
              ? unit.status === "IN_STOCK" && unit.warehouseId === writeOff.warehouseId
              : unit.status === "ISSUED" && unit.employeeId === writeOff.employeeId);
          if (!unit || !inScope) throw new StockError("Единица уже недоступна для списания");
          await moveUnit(tx, {
            companyId: s.companyId,
            docType: "WRITEOFF",
            docId: writeOff.id,
            unit,
            to: null,
            status: "WRITTEN_OFF",
            createdById: session.userId,
            issueId: null,
          });
        }
      }
      await tx.writeOff.update({
        where: { id: writeOff.id },
        data: { status: "POSTED", postedAt: new Date() },
      });
    });
  } catch (e) {
    if (e instanceof StockError) return { error: e.message };
    throw e;
  }

  await logEvent({
    companyId: s.companyId,
    type: "writeoff_posted",
    warehouseIds: writeOff.warehouseId ? [writeOff.warehouseId] : undefined,
    title: `Списание №${writeOff.number} проведено`,
    body: `Причина: ${writeOff.reason}. Позиций: ${writeOff.lines.length}`,
    url: `/warehouse/writeoffs/${writeOff.id}`,
    actorId: session.userId,
  });
  revalidatePath("/warehouse/writeoffs");
  revalidatePath(`/warehouse/writeoffs/${writeOff.id}`);
  revalidatePath("/warehouse/stock");
  return {};
}

// Удаление списания (админ): только черновик — проведённое двигало остатки.
export async function deleteWriteOffAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdmin();
  const s = scoped(session);
  const writeOff = await prisma.writeOff.findFirst({
    where: { id: String(formData.get("writeOffId") ?? ""), companyId: s.companyId },
  });
  if (!writeOff) return { error: "Списание не найдено" };
  if (writeOff.status !== "DRAFT") return { error: "Проведённое списание удалить нельзя" };

  await prisma.writeOff.delete({ where: { id: writeOff.id } }); // строки — каскадом
  await logEvent({
    companyId: s.companyId,
    type: "writeoff_deleted",
    warehouseIds: writeOff.warehouseId ? [writeOff.warehouseId] : undefined,
    title: `Черновик списания №${writeOff.number} удалён`,
    body: "",
    actorId: session.userId,
  });
  revalidatePath("/warehouse/writeoffs");
  redirect("/warehouse/writeoffs");
}
