"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { workflowTasksEnabled, coolingWorkflowEnabled, groupReceivingEnabled } from "@/lib/roles";
import {
  startWorkflowTask,
  requestTaskHandoff,
  acceptTaskHandoff,
  rejectTaskHandoff,
  rebalanceQueuedTasks,
} from "@/lib/workflow-tasks";
import { startGroupPlacement, GroupError } from "@/lib/group-receiving";
import { prepareCoolingRetrieval, placeCoolingRetrieval, verifyCoolingRetrievalEan, verifyCoolingRetrievalSourceCell, CoolingError } from "@/lib/cooling";

export interface TaskActionState {
  error?: string;
  ok?: boolean;
  ready?: boolean;
  targetCellCode?: string | null;
}

const DISABLED: TaskActionState = { error: "Очередь задач сейчас отключена" };

export async function startTaskAction(_prev: TaskActionState, formData: FormData): Promise<TaskActionState> {
  if (!workflowTasksEnabled()) return DISABLED;
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "");
  const skipReason = String(formData.get("skipReason") ?? "").trim();
  // P3B-FIX-2: PLACE_GROUP стартует АТОМАРНО (резерв целевой ячейки + IN_PROGRESS + task_started одной
  // транзакцией). Нет свободной ячейки → бизнес-ошибка, задача остаётся ASSIGNED без единой записи —
  // сотрудник не заблокирован невыполнимой задачей. Прочие типы — штатный старт очереди.
  if (groupReceivingEnabled()) {
    const task = await prisma.workflowTask.findFirst({ where: { id: taskId, companyId: s.companyId }, select: { type: true } });
    if (task?.type === "PLACE_GROUP") {
      try {
        await startGroupPlacement({ companyId: s.companyId, userId: session.userId, taskId, skipReason: skipReason || undefined });
      } catch (e) {
        if (e instanceof GroupError) { revalidatePath("/warehouse/tasks"); return { error: e.message }; }
        throw e;
      }
      revalidatePath("/warehouse/tasks");
      return { ok: true };
    }
  }
  const res = await startWorkflowTask(session.userId, s.companyId, taskId, skipReason || undefined);
  revalidatePath("/warehouse/tasks");
  return res;
}

export async function requestHandoffAction(_prev: TaskActionState, formData: FormData): Promise<TaskActionState> {
  if (!workflowTasksEnabled()) return DISABLED;
  const session = await requireUser();
  const s = scoped(session);
  const res = await requestTaskHandoff(
    s.companyId,
    String(formData.get("taskId") ?? ""),
    session.userId,
    String(formData.get("toUserId") ?? ""),
  );
  revalidatePath("/warehouse/tasks");
  return res;
}

export async function acceptHandoffAction(_prev: TaskActionState, formData: FormData): Promise<TaskActionState> {
  if (!workflowTasksEnabled()) return DISABLED;
  const session = await requireUser();
  const s = scoped(session);
  const res = await acceptTaskHandoff(s.companyId, String(formData.get("handoffId") ?? ""), session.userId);
  revalidatePath("/warehouse/tasks");
  return res;
}

export async function rejectHandoffAction(_prev: TaskActionState, formData: FormData): Promise<TaskActionState> {
  if (!workflowTasksEnabled()) return DISABLED;
  const session = await requireUser();
  const s = scoped(session);
  const res = await rejectTaskHandoff(s.companyId, String(formData.get("handoffId") ?? ""), session.userId);
  revalidatePath("/warehouse/tasks");
  return res;
}

// Пакет 5: завершение срочной задачи «Забрать из охлаждения» — погрузчик вводит фактическую температуру.
// COOL-003 (фаза замера): авторитетная read-only проверка EAN до показа температуры. БД не меняет.
export async function verifyCoolingRetrievalEanAction(_prev: TaskActionState, formData: FormData): Promise<TaskActionState> {
  if (!coolingWorkflowEnabled()) return { error: "Охлаждение сейчас отключено" };
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "");
  const ean = String(formData.get("ean") ?? "").trim();
  if (!ean) return { error: "Отсканируйте EAN товара" };
  try {
    await verifyCoolingRetrievalEan({ companyId: s.companyId, userId: session.userId, taskId, ean });
    return { ok: true };
  } catch (e) {
    if (e instanceof CoolingError) return { error: e.message };
    throw e;
  }
}

// COOL-004 (фаза вывоза): авторитетная read-only проверка исходной COOLING-ячейки до скана цели. БД не меняет.
export async function verifyCoolingRetrievalSourceCellAction(_prev: TaskActionState, formData: FormData): Promise<TaskActionState> {
  if (!coolingWorkflowEnabled()) return { error: "Охлаждение сейчас отключено" };
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "");
  const fromCellCode = String(formData.get("fromCellCode") ?? "").trim();
  if (!fromCellCode) return { error: "Отсканируйте исходную ячейку охлаждения" };
  try {
    const r = await verifyCoolingRetrievalSourceCell({ companyId: s.companyId, userId: session.userId, taskId, fromCellCode });
    return { ok: true, targetCellCode: r.targetCellCode };
  } catch (e) {
    if (e instanceof CoolingError) return { error: e.message };
    throw e;
  }
}

export async function prepareCoolingRetrievalAction(_prev: TaskActionState, formData: FormData): Promise<TaskActionState> {
  if (!coolingWorkflowEnabled()) return { error: "Охлаждение сейчас отключено" };
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "");
  const ean = String(formData.get("ean") ?? "").trim();
  const temperature = Number(String(formData.get("temperature") ?? "").trim().replace(",", "."));
  if (!ean) return { error: "Отсканируйте EAN товара" };
  if (!Number.isFinite(temperature)) return { error: "Укажите фактическую температуру" };
  try {
    const r = await prepareCoolingRetrieval({ companyId: s.companyId, userId: session.userId, taskId, ean, temperature });
    revalidatePath("/warehouse/tasks");
    return { ready: r.ready, targetCellCode: r.targetCellCode };
  } catch (e) {
    if (e instanceof CoolingError) return { error: e.message };
    throw e;
  }
}

// Пакет 9B, Фаза 2: скан назначенной целевой ячейки → физическое размещение (движение через ядро).
export async function placeCoolingRetrievalAction(_prev: TaskActionState, formData: FormData): Promise<TaskActionState> {
  if (!coolingWorkflowEnabled()) return { error: "Охлаждение сейчас отключено" };
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "");
  const fromCellCode = String(formData.get("fromCellCode") ?? "").trim();
  const ean = String(formData.get("ean") ?? "").trim();
  const targetCellCode = String(formData.get("targetCellCode") ?? "").trim();
  if (!fromCellCode || !ean || !targetCellCode) return { error: "Отсканируйте ячейку охлаждения, EAN и целевую ячейку" };
  try {
    await placeCoolingRetrieval({ companyId: s.companyId, userId: session.userId, taskId, fromCellCode, ean, targetCellCode });
  } catch (e) {
    if (e instanceof CoolingError) return { error: e.message };
    throw e;
  }
  // Событие «Охлаждение завершено» пишется в движке placeCoolingRetrieval (стабильный ключ, идемпотентно).
  revalidatePath("/warehouse/tasks");
  return {};
}

// Пакет 5: DB-backed активация наступивших отложенных задач (лёгкий периодический вызов с экрана
// очереди). Идемпотентно, под lockCompany, безопасно для нескольких экземпляров приложения.
// Не revalidate — назначение эмитит task_assigned → realtime сам обновит клиентов.
export async function activateDueTasksAction(): Promise<{ ok: boolean }> {
  if (!workflowTasksEnabled()) return { ok: false };
  const session = await requireUser();
  const s = scoped(session);
  await rebalanceQueuedTasks(s.companyId);
  return { ok: true };
}
