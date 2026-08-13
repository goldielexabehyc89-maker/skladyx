"use client";

import { useActionState, useEffect, useState } from "react";
import { startWorkShiftAction, endWorkShiftAction, type ShiftState } from "@/app/actions/shifts";
import { Button, Card, CardTitle, ChipSelect, Badge } from "@/components/ui";
import { ROLE_LABEL, ROLE_TONE } from "@/lib/role-labels";
import type { Role } from "@/lib/jwt";

const initial: ShiftState = {};

// Живая длительность смены (обновляется раз в секунду на клиенте).
function useDuration(startIso: string): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = Math.max(0, now - new Date(startIso).getTime());
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

export function ShiftStart({
  workRoles,
  warehouses,
}: {
  workRoles: Role[];
  warehouses: { id: string; name: string }[];
}) {
  // P3A.2/ROLE-003: форма остаётся <form action> (server-action-поля на месте — совместимость с HTTP-
  // проверками смен и прогрессивным улучшением). Успех БЕЗ redirect() возвращает redirectTo, клиент делает
  // полную навигацию window.location.assign в useEffect — свежий рендер целевого экрана по актуальным
  // Host/cookie (исключает Application error/UNAUTHORIZED, digest 852039715). startWorkShiftAction НЕ
  // ревалидирует маршрут, поэтому /warehouse/shift не ре-рендерится в ShiftActive до навигации, и useEffect
  // успевает уйти на рабочий экран. Ошибка → state.error на месте, навигации нет.
  const [state, formAction, pending] = useActionState(startWorkShiftAction, initial);
  useEffect(() => {
    if (state.redirectTo) window.location.assign(state.redirectTo);
  }, [state.redirectTo]);

  if (workRoles.length === 0) {
    return (
      <Card>
        <p className="text-sm text-neutral-600">
          Вам не назначены рабочие роли (приёмка, погрузка, сборка, контроль). Обратитесь к администратору.
        </p>
      </Card>
    );
  }
  if (warehouses.length === 0) {
    return (
      <Card>
        <p className="text-sm text-neutral-600">Нет доступных складов. Обратитесь к администратору.</p>
      </Card>
    );
  }

  return (
    <Card>
      <CardTitle>Начать смену</CardTitle>
      <form action={formAction} className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-2">
          <span className="text-sm font-medium text-[#555]">Склад</span>
          <ChipSelect
            name="warehouseId"
            options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
            defaultValue={warehouses.length === 1 ? warehouses[0].id : undefined}
            required
          />
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <span className="text-sm font-medium text-[#555]">Рабочая роль</span>
          <ChipSelect
            name="role"
            options={workRoles.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
            defaultValue={workRoles.length === 1 ? workRoles[0] : undefined}
            required
          />
        </fieldset>
        {state.error && <p className="text-sm text-red-600">{state.error}</p>}
        <Button type="submit" disabled={pending}>
          {pending ? "Начинаем…" : "Начать смену"}
        </Button>
      </form>
    </Card>
  );
}

export function ShiftActive({
  name,
  role,
  warehouseName,
  startedAtIso,
}: {
  name: string;
  role: Role;
  warehouseName: string;
  startedAtIso: string;
}) {
  // P3A.2/SHIFT-002: завершение ведёт на /warehouse/shift — ТОТ ЖЕ маршрут, поэтому сохраняем
  // <form action>/useActionState: успешное действие БЕЗ redirect() штатно ре-рендерит /warehouse/shift
  // (смена закрыта → показывается форма старта). Ошибка (IN_PROGRESS блокирует) → state.error на месте,
  // навигации нет. Форма сохраняет server-action-поля (совместимость с HTTP-проверками смен).
  const [state, formAction, pending] = useActionState(endWorkShiftAction, initial);
  const duration = useDuration(startedAtIso);
  const started = new Date(startedAtIso);
  const startedLabel = `${String(started.getHours()).padStart(2, "0")}:${String(started.getMinutes()).padStart(2, "0")}`;

  return (
    <Card>
      <CardTitle>
        <span className="flex items-center gap-2">
          <Badge tone="green">На смене</Badge>
          <Badge tone={ROLE_TONE[role]}>{ROLE_LABEL[role]}</Badge>
        </span>
      </CardTitle>
      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex justify-between">
          <dt className="text-neutral-500">Сотрудник</dt>
          <dd className="font-medium">{name}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-neutral-500">Роль</dt>
          <dd className="font-medium">{ROLE_LABEL[role]}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-neutral-500">Склад</dt>
          <dd className="font-medium">{warehouseName}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-neutral-500">Начало</dt>
          <dd className="font-medium">{startedLabel}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-neutral-500">Продолжительность</dt>
          <dd className="font-mono text-base font-semibold tabular-nums">{duration}</dd>
        </div>
      </dl>
      <form action={formAction} className="mt-4">
        {state.error && <p className="mb-2 text-sm text-red-600">{state.error}</p>}
        <Button type="submit" variant="ghost" disabled={pending} className="w-full">
          {pending ? "Завершаем…" : "Завершить смену"}
        </Button>
      </form>
    </Card>
  );
}
