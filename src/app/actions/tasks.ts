"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { workflowTasksEnabled, coolingWorkflowEnabled } from "@/lib/roles";
import {
  startWorkflowTask,
  requestTaskHandoff,
  acceptTaskHandoff,
  rejectTaskHandoff,
  rebalanceQueuedTasks,
} from "@/lib/workflow-tasks";
import { completeCoolingRetrieval, CoolingError } from "@/lib/cooling";

export interface TaskActionState {
  error?: string;
}

const DISABLED: TaskActionState = { error: "Очередь задач сейчас отключена" };

export async function startTaskAction(_prev: TaskActionState, formData: FormData): Promise<TaskActionState> {
  if (!workflowTasksEnabled()) return DISABLED;
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "");
  const skipReason = String(formData.get("skipReason") ?? "").trim();
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
export async function completeCoolingRetrievalAction(_prev: TaskActionState, formData: FormData): Promise<TaskActionState> {
  if (!coolingWorkflowEnabled()) return { error: "Охлаждение сейчас отключено" };
  const session = await requireUser();
  const s = scoped(session);
  const taskId = String(formData.get("taskId") ?? "");
  const temperature = Number(String(formData.get("temperature") ?? "").trim().replace(",", "."));
  if (!Number.isFinite(temperature)) return { error: "Укажите фактическую температуру" };
  try {
    await completeCoolingRetrieval({ companyId: s.companyId, userId: session.userId, taskId, temperature });
  } catch (e) {
    if (e instanceof CoolingError) return { error: e.message };
    throw e;
  }
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
