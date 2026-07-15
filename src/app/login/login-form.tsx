"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "@/app/actions/auth";
import { Button, Field } from "@/components/ui";

const initial: LoginState = {};

export function LoginForm({ next }: { next?: string }) {
  const [state, formAction, pending] = useActionState(loginAction, initial);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {next && <input type="hidden" name="next" value={next} />}
      <Field
        label="Телефон"
        name="login"
        type="tel"
        placeholder="+7 985 180-16-50"
        required
        inputMode="tel"
        autoComplete="tel"
      />
      <p className="-mt-2 text-xs text-neutral-400">Можно вводить с +7, с 8 или сразу с 9.</p>
      <Field
        label="Пароль"
        name="password"
        type="password"
        placeholder="••••••••"
        required
        autoComplete="current-password"
      />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <Button type="submit" disabled={pending}>
        {pending ? "Вход…" : "Войти"}
      </Button>
    </form>
  );
}
