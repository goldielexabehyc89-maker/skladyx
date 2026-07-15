"use client";

import { useState, useMemo } from "react";
import { useActionState } from "react";
import { createPickListAction } from "@/app/actions/picklists";
import { Button, ChipSelect, Field, SelectField } from "@/components/ui";
import type { FormState } from "@/app/actions/warehouses";

interface Emp {
  id: string;
  name: string;
  allWarehouses: boolean;
  warehouseIds: string[];
}

const initial: FormState = {};

// Создание заявки: склад — плитками (один тап), затем сотрудник (только
// привязанные к выбранному складу).
export function PickListCreateForm({
  warehouses,
  employees,
}: {
  warehouses: { id: string; name: string }[];
  employees: Emp[];
}) {
  const [wh, setWh] = useState("");
  const [emp, setEmp] = useState("");
  const [state, formAction, pending] = useActionState(createPickListAction, initial);

  const emps = useMemo(
    () => (wh ? employees.filter((e) => e.allWarehouses || e.warehouseIds.includes(wh)) : []),
    [wh, employees],
  );

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-2">
        <span className="text-sm font-medium text-[#555]">Склад</span>
        <ChipSelect
          name="warehouseId"
          required
          options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
          value={wh}
          onChange={(next) => {
            setWh(next[0] ?? "");
            setEmp(""); // сбрасываем сотрудника при смене склада
          }}
        />
      </fieldset>

      <SelectField
        label="Для сотрудника"
        name="targetEmployeeId"
        required
        disabled={!wh}
        value={emp}
        onChange={(e) => setEmp(e.target.value)}
      >
        <option value="">
          {!wh
            ? "— сначала выберите склад —"
            : emps.length === 0
              ? "— нет сотрудников этого склада —"
              : "— выберите сотрудника —"}
        </option>
        {emps.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </SelectField>

      <Field label="Комментарий (необязательно)" name="note" />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <Button type="submit" disabled={pending}>
        {pending ? "Создание…" : "Создать заявку"}
      </Button>
    </form>
  );
}
