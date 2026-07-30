"use client";

import { Link2 } from "lucide-react";
import { useActionState, useState, useTransition } from "react";
import {
  createUserAction,
  issuePasswordLinkAction,
  type UserFormState,
} from "@/app/actions/users";
import { Button, ChipSelect, Field } from "@/components/ui";
import { ASSIGNABLE_ROLES, roleOptions } from "@/lib/role-labels";
import { WarehousePicker } from "./warehouse-picker";

function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-xl border border-green-200 bg-green-50 p-3 text-sm">
      <p className="font-medium text-green-800">Ссылка для установки пароля (действует 24 ч):</p>
      <p className="mt-1 break-all font-mono text-xs text-green-700">{link}</p>
      <button
        type="button"
        className="mt-2 rounded-lg border border-green-300 bg-white px-3 py-1.5 text-xs font-medium"
        onClick={async () => {
          await navigator.clipboard.writeText(link).catch(() => {});
          setCopied(true);
        }}
      >
        {copied ? "✓ Скопировано" : "Скопировать"}
      </button>
    </div>
  );
}

const initial: UserFormState = {};

export function NewUserForm({ warehouses }: { warehouses: { id: string; name: string }[] }) {
  const [state, formAction, pending] = useActionState(createUserAction, initial);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <Field label="Имя и фамилия" name="name" required placeholder="Иван Петров" />
      <Field
        label="Телефон (логин)"
        name="phone"
        type="tel"
        required
        inputMode="tel"
        placeholder="+7 985 180-16-50"
      />
      <fieldset className="flex flex-col gap-2">
        <span className="text-sm font-medium text-[#555]">
          Роли <span className="text-red-500">*</span>
        </span>
        <ChipSelect name="roles" multiple options={roleOptions(ASSIGNABLE_ROLES)} defaultValue={[]} />
        <span className="text-xs text-neutral-400">Можно выбрать несколько. Минимум одна роль.</span>
      </fieldset>
      <WarehousePicker warehouses={warehouses} initialAll={false} />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      {state.link && <CopyLink link={state.link} />}
      <Button type="submit" disabled={pending}>
        {pending ? "Создание…" : "Добавить сотрудника"}
      </Button>
    </form>
  );
}

export function PasswordLinkButton({ userId }: { userId: string }) {
  const [busy, startTransition] = useTransition();
  const [state, setState] = useState<UserFormState | null>(null);

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="ghost"
        disabled={busy}
        onClick={() =>
          startTransition(async () => {
            setState(await issuePasswordLinkAction(userId));
          })
        }
      >
        {busy ? (
          "Создание…"
        ) : (
          <>
            <Link2 size={18} /> Новая ссылка для входа
          </>
        )}
      </Button>
      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
      {state?.link && <CopyLink link={state.link} />}
    </div>
  );
}
