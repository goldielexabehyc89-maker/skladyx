"use client";

import { useActionState } from "react";
import { setPasswordAction, type SetPasswordState } from "@/app/actions/password";
import { Button, Field } from "@/components/ui";

const initial: SetPasswordState = {};

export function SetPasswordForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(setPasswordAction, initial);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      <Field
        label="Новый пароль (не короче 8 символов)"
        name="password"
        type="password"
        required
        autoComplete="new-password"
      />
      <Field
        label="Повторите пароль"
        name="password2"
        type="password"
        required
        autoComplete="new-password"
      />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <Button type="submit" disabled={pending}>
        {pending ? "Сохранение…" : "Сохранить и войти"}
      </Button>
    </form>
  );
}
