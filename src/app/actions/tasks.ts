"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { workflowTasksEnabled } from "@/lib/roles";
import {
  startWorkflowTask,
  requestTaskHandoff,
  acceptTaskHandoff,
  rejectTaskHandoff,
} from "@/lib/workflow-tasks";

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
