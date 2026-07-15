"use client";

import { useActionState } from "react";
import type { UserFormState } from "@/app/actions/users";
import { Button, ChipSelect, Field } from "@/components/ui";
import { WarehousePicker } from "../warehouse-picker";

export function UserEditForm({
  action,
  user,
  warehouses,
}: {
  action: (prev: UserFormState, formData: FormData) => Promise<UserFormState>;
  user: {
    id: string;
    name: string;
    role: string;
    isActive: boolean;
    phone: string | null;
    allWarehouses: boolean;
    warehouseIds: string[];
  };
  warehouses: { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, {} as UserFormState);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={user.id} />
      <Field label="Имя" name="name" required defaultValue={user.name} />
      <Field
        label="Телефон (логин)"
        name="phone"
        type="tel"
        inputMode="tel"
        defaultValue={user.phone ?? ""}
        placeholder="+7 985 180-16-50"
      />
      <fieldset className="flex flex-col gap-2">
        <span className="text-sm font-medium text-[#555]">Роль</span>
        <ChipSelect
          name="role"
          options={[
            { value: "EMPLOYEE", label: "Сотрудник" },
            { value: "STOREKEEPER", label: "Кладовщик" },
            { value: "ADMIN", label: "Администратор" },
          ]}
          defaultValue={user.role}
        />
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="isActive" defaultChecked={user.isActive} className="h-5 w-5" />
        Доступ активен
      </label>
      <WarehousePicker
        warehouses={warehouses}
        initialAll={user.allWarehouses}
        initialIds={user.warehouseIds}
      />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <Button type="submit" variant="ghost" disabled={pending}>
        {pending ? "Сохранение…" : "Сохранить"}
      </Button>
    </form>
  );
}
