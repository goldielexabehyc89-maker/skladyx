"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAdmin, requireUser , assertLegacyUiEnabled } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { logEvent } from "@/lib/events";
import { resolveQr, parseScannedCode } from "@/lib/qr";
import { nextNumber } from "@/lib/counters";
import { getSettings } from "@/lib/settings";
import { sendPushToUser } from "@/lib/push";
import { applyLotMovement, moveUnit, StockError, type Loc } from "@/lib/stock";
import type { FormState } from "@/app/actions/warehouses";

// Позиция прямой выдачи, собранная сканами на клиенте.
export interface DirectIssueItem {
  raw: string; // отсканированный код
  qty?: number; // для партий (по умолчанию — весь доступный остаток)
}

export interface DirectIssueResult {
  ok?: string;
  error?: string;
  issueId?: string;
}

// Прямая выдача: сканы товаров → сотрудник (из списка или сканом бейджа).
export async function completeDirectIssueAction(
  items: DirectIssueItem[],
  employee: { userId?: string; badgeRaw?: string },
): Promise<DirectIssueResult> {
  const session = await requireAdmin();
  assertLegacyUiEnabled();
  const s = scoped(session);
  const settings = await getSettings(s.companyId);
  if (!settings.directIssueEnabled)
    return { error: "Прямая выдача отключена в настройках компании" };
  if (items.length === 0) return { error: "Сначала отсканируйте товары" };

  // Сотрудник: по id или по QR-бейджу
  let employeeId = employee.userId ?? "";
  if (!employeeId && employee.badgeRaw) {
    const code = parseScannedCode(employee.badgeRaw);
    const qr = code ? await resolveQr(code) : null;
    if (!qr || qr.companyId !== s.companyId || qr.type !== "EMPLOYEE")
      return { error: "Это не QR-бейдж сотрудника" };
    employeeId = qr.refId;
  }
  if (!employeeId) return { error: "Укажите сотрудника" };
  const target = await s.user(employeeId);
  if (!target.isActive) return { error: "Сотрудник отключён" };

  // бейдж отсканирован лично — это и есть подтверждение получения
  const pending = settings.issueConfirmationRequired && !employee.badgeRaw;
  const toLoc: Loc = pending
    ? { kind: "employeePending", employeeId }
    : { kind: "employee", employeeId };

  try {
    const issue = await prisma.$transaction(async (tx) => {
      const number = await nextNumber(tx, s.companyId, "issue");
      const issue = await tx.issue.create({
        data: {
          companyId: s.companyId,
          number,
          employeeId,
          source: "DIRECT",
          status: pending ? "PENDING" : "CONFIRMED",
          confirmedAt: pending ? null : new Date(),
          issuedById: session.userId,
        },
      });

      for (const entry of items) {
        const code = parseScannedCode(entry.raw);
        const qr = code ? await tx.qrCode.findUnique({ where: { code } }) : null;
        if (!qr || qr.companyId !== s.companyId) throw new StockError("Код не найден");

        if (qr.type === "UNIT") {
          const unit = await tx.itemUnit.findFirst({
            where: { id: qr.refId, companyId: s.companyId },
          });
          if (!unit || unit.status !== "IN_STOCK")
            throw new StockError("Единица недоступна для выдачи");
          const unitBusy = await tx.pickLine.findFirst({
            where: {
              companyId: s.companyId,
              unitId: unit.id,
              pickList: { status: { in: ["NEW", "PICKING"] } },
            },
            include: { pickList: true },
          });
          if (unitBusy)
            throw new StockError(
              `Единица в резерве ${unitBusy.pickList.targetWarehouseId ? "перемещения" : "заявки"} №${unitBusy.pickList.number}`,
            );
          await moveUnit(tx, {
            companyId: s.companyId,
            docType: "ISSUE",
            docId: issue.id,
            unit,
            to: toLoc,
            status: pending ? "ISSUE_PENDING" : "ISSUED",
            createdById: session.userId,
            issueId: issue.id,
          });
          await tx.issueLine.create({
            data: {
              companyId: s.companyId,
              issueId: issue.id,
              itemId: unit.itemId,
              unitId: unit.id,
              qty: new Prisma.Decimal(1),
              price: unit.price,
            },
          });
        } else if (qr.type === "LOT") {
          const lot = await tx.lot.findFirst({
            where: { id: qr.refId, companyId: s.companyId },
          });
          if (!lot) throw new StockError("Партия не найдена");
          const balances = await tx.stockBalance.findMany({
            where: { lotId: lot.id, employeeId: null, qty: { gt: 0 } },
            orderBy: { cellId: { sort: "asc", nulls: "first" } },
          });
          // резерв активных заявок на сбор (несобранное/неразмещённое) по ячейкам
          const reservingLines = await tx.pickLine.findMany({
            where: {
              companyId: s.companyId,
              lotId: lot.id,
              pickList: { status: { in: ["NEW", "PICKING"] } },
            },
            select: {
              cellId: true,
              qtyRequested: true,
              fulfillments: { select: { qty: true, toCellId: true } },
            },
          });
          const reserveByCell = new Map<string, Prisma.Decimal>();
          let reservedTotal = new Prisma.Decimal(0);
          for (const rl of reservingLines) {
            const placed = rl.fulfillments
              .filter((fu) => fu.toCellId)
              .reduce((s2, fu) => s2.add(fu.qty), new Prisma.Decimal(0));
            const rem = rl.qtyRequested.sub(placed);
            if (rem.lte(0)) continue;
            reservedTotal = reservedTotal.add(rem);
            const key = rl.cellId ?? "";
            reserveByCell.set(key, (reserveByCell.get(key) ?? new Prisma.Decimal(0)).add(rem));
          }
          const physical = balances.reduce((sum, b) => sum.add(b.qty), new Prisma.Decimal(0));
          const available = physical.sub(reservedTotal);
          const qty = entry.qty !== undefined ? new Prisma.Decimal(entry.qty) : available;
          if (qty.lte(0)) throw new StockError("Количество должно быть больше нуля");
          if (qty.gt(available))
            throw new StockError("Недостаточно свободного остатка (часть в резерве заявок)");

          let remaining = qty;
          for (const b of balances) {
            if (remaining.lte(0)) break;
            // свободная часть ячейки — за вычетом резерва заявок на неё
            const cellReserve = reserveByCell.get(b.cellId ?? "") ?? new Prisma.Decimal(0);
            const free = b.qty.sub(cellReserve);
            if (free.lte(0)) continue;
            const take = Prisma.Decimal.min(remaining, free);
            const from: Loc = b.cellId
              ? { kind: "cell", warehouseId: b.warehouseId!, cellId: b.cellId }
              : { kind: "warehouse", warehouseId: b.warehouseId! };
            await applyLotMovement(tx, {
              companyId: s.companyId,
              docType: "ISSUE",
              docId: issue.id,
              itemId: lot.itemId,
              lotId: lot.id,
              qty: take,
              from,
              to: toLoc,
              createdById: session.userId,
            });
            remaining = remaining.sub(take);
          }
          if (remaining.gt(0))
            throw new StockError("Свободного остатка не хватает — часть в резерве заявок");
          await tx.issueLine.create({
            data: {
              companyId: s.companyId,
              issueId: issue.id,
              itemId: lot.itemId,
              lotId: lot.id,
              qty,
              price: lot.price,
            },
          });
        } else {
          throw new StockError("Сканируйте QR партий и единиц товара");
        }
      }
      return issue;
    });

    await logEvent({
      companyId: s.companyId,
      type: "issue_created",
      title: `Выдача №${issue.number} — ${target.name}`,
      body: pending ? "Ожидает подтверждения сотрудником" : "Выдано и подтверждено",
      url: `/warehouse/issues/${issue.id}`,
      actorId: session.userId,
      userIds: [employeeId],
    });
    if (pending) {
      await sendPushToUser(employeeId, {
        title: "Подтвердите получение товара",
        body: `Выдача №${issue.number} — откройте и подтвердите`,
        url: "/warehouse/my",
        tag: `issue-${issue.id}`,
      });
    }
    revalidatePath("/warehouse/issues");
    revalidatePath("/warehouse/my");
    revalidatePath("/warehouse/stock");
    return {
      ok: pending
        ? `Выдача №${issue.number} создана — ${target.name} должен подтвердить получение`
        : `Выдача №${issue.number} оформлена на ${target.name}`,
      issueId: issue.id,
    };
  } catch (e) {
    if (e instanceof StockError) return { error: e.message };
    throw e;
  }
}

// Подтверждение получения сотрудником (кнопка в «Мои ТМЦ»).
export async function confirmIssueAction(formData: FormData): Promise<void> {
  const session = await requireUser();
  assertLegacyUiEnabled();
  const s = scoped(session);
  const issueId = String(formData.get("issueId") ?? "");
  const issue = await s.issue(issueId);
  if (issue.status !== "PENDING" || issue.employeeId !== session.userId) return;

  await prisma.$transaction(async (tx) => {
    for (const line of issue.lines) {
      if (line.lotId) {
        await applyLotMovement(tx, {
          companyId: s.companyId,
          docType: "ISSUE_CONFIRM",
          docId: issue.id,
          itemId: line.itemId,
          lotId: line.lotId,
          qty: line.qty,
          from: { kind: "employeePending", employeeId: issue.employeeId },
          to: { kind: "employee", employeeId: issue.employeeId },
          createdById: session.userId,
        });
      } else if (line.unitId) {
        const unit = await tx.itemUnit.findFirst({
          where: { id: line.unitId, companyId: s.companyId },
        });
        if (!unit || unit.status !== "ISSUE_PENDING") continue;
        await moveUnit(tx, {
          companyId: s.companyId,
          docType: "ISSUE_CONFIRM",
          docId: issue.id,
          unit,
          to: { kind: "employee", employeeId: issue.employeeId },
          status: "ISSUED",
          createdById: session.userId,
        });
      }
    }
    await tx.issue.update({
      where: { id: issue.id },
      data: { status: "CONFIRMED", confirmedAt: new Date() },
    });
  });

  await logEvent({
    companyId: s.companyId,
    type: "issue_confirmed",
    title: `Выдача №${issue.number} подтверждена`,
    body: `${session.name} подтвердил получение`,
    url: `/warehouse/issues/${issue.id}`,
    actorId: session.userId,
    userIds: [issue.employeeId],
  });
  revalidatePath("/warehouse/my");
  revalidatePath("/warehouse/issues");
  revalidatePath("/warehouse/stock");
}

// Отмена выдачи (админ): товар возвращается туда, откуда был выдан (по журналу
// движений). Выдача по заявке возвращает заявку в зону выдачи (STAGED) — её можно
// выдать заново. Сама выдача остаётся в истории со статусом «отменена».
export async function cancelIssueAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdmin();
  assertLegacyUiEnabled();
  const s = scoped(session);
  const issue = await s.issue(String(formData.get("issueId") ?? ""));
  if (issue.status === "CANCELLED") return { error: "Выдача уже отменена" };
  const employee = await s.user(issue.employeeId);

  const moves = await prisma.stockMovement.findMany({
    where: { companyId: s.companyId, docType: "ISSUE", docId: issue.id, toEmployeeId: { not: null } },
    orderBy: { createdAt: "asc" },
  });
  if (moves.length === 0) return { error: "Движения выдачи не найдены" };
  const pickList = issue.pickListId
    ? await prisma.pickList.findFirst({
        where: { id: issue.pickListId, companyId: s.companyId },
      })
    : null;

  try {
    await prisma.$transaction(async (tx) => {
      for (const m of moves) {
        const backLoc: Loc = m.fromCellId
          ? { kind: "cell", warehouseId: m.fromWarehouseId!, cellId: m.fromCellId }
          : m.fromWarehouseId
            ? { kind: "warehouse", warehouseId: m.fromWarehouseId }
            : null;
        if (!backLoc) throw new StockError("Не удалось определить, куда вернуть товар");
        if (m.unitId) {
          const unit = await tx.itemUnit.findFirst({
            where: { id: m.unitId, companyId: s.companyId },
          });
          if (!unit || (unit.status !== "ISSUED" && unit.status !== "ISSUE_PENDING"))
            throw new StockError("Единица уже не у сотрудника — отмена невозможна");
          await moveUnit(tx, {
            companyId: s.companyId,
            docType: "ISSUE",
            docId: issue.id,
            unit,
            to: backLoc,
            // выдача по заявке: единица снова в резерве заявки (зона выдачи)
            status: pickList ? "PICKED" : "IN_STOCK",
            createdById: session.userId,
            pickListId: pickList ? pickList.id : null,
            issueId: null,
          });
        } else if (m.lotId) {
          const fromLoc: Loc =
            issue.status === "PENDING"
              ? { kind: "employeePending", employeeId: issue.employeeId }
              : { kind: "employee", employeeId: issue.employeeId };
          await applyLotMovement(tx, {
            companyId: s.companyId,
            docType: "ISSUE",
            docId: issue.id,
            itemId: m.itemId,
            lotId: m.lotId,
            qty: m.qty,
            from: fromLoc,
            to: backLoc,
            createdById: session.userId,
          });
        }
      }
      if (pickList)
        await tx.pickList.update({
          where: { id: pickList.id },
          data: { status: "STAGED", issuedAt: null },
        });
      await tx.issue.update({ where: { id: issue.id }, data: { status: "CANCELLED" } });
    });
  } catch (e) {
    if (e instanceof StockError) return { error: e.message };
    throw e;
  }

  await logEvent({
    companyId: s.companyId,
    type: "issue_cancelled",
    userIds: [issue.employeeId],
    title: `Выдача №${issue.number} отменена`,
    body: `Товар возвращён от «${employee.name}» на прежние места${pickList ? `, ${pickList.targetWarehouseId ? "перемещение" : "заявка"} №${pickList.number} снова в зоне выдачи` : ""}`,
    url: `/warehouse/issues/${issue.id}`,
    actorId: session.userId,
  });
  revalidatePath("/warehouse/issues");
  revalidatePath(`/warehouse/issues/${issue.id}`);
  revalidatePath("/warehouse/my");
  revalidatePath("/warehouse/stock");
  revalidatePath("/warehouse/staging");
  revalidatePath("/warehouse/picklists");
  revalidatePath("/warehouse/active");
  return {};
}
