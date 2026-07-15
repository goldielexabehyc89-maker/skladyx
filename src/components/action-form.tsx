"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui";
import type { FormState } from "@/app/actions/warehouses";

// Обёртка форм над server actions с состоянием {error?}: показывает ошибку и pending.
export function ActionForm({
  action,
  children,
  submitLabel,
  className,
  variant = "primary",
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  children: React.ReactNode;
  submitLabel: string;
  className?: string;
  variant?: "primary" | "ghost" | "danger";
}) {
  const [state, formAction, pending] = useActionState(action, {} as FormState);

  return (
    <form action={formAction} className={className ?? "flex flex-col gap-3"}>
      {children}
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <Button type="submit" variant={variant} disabled={pending}>
        {pending ? "Сохранение…" : submitLabel}
      </Button>
    </form>
  );
}
