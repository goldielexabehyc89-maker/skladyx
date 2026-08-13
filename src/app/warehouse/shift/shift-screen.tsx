"use client";

import { useEffect, useState } from "react";
import { startWorkShiftAction, endWorkShiftAction } from "@/app/actions/shifts";
import { Button, Card, CardTitle, ChipSelect, Badge } from "@/components/ui";
import { ROLE_LABEL, ROLE_TONE } from "@/lib/role-labels";
import type { Role } from "@/lib/jwt";

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
  // P3A.2/ROLE-003: действие вызывается ИМПЕРАТИВНО (не через <form action>/useActionState), затем клиент
  // делает полную навигацию window.location.assign(redirectTo). Так исключён server-action redirect()
  // (Application error/UNAUTHORIZED, digest 852039715) И гонка, при которой авто-refresh маршрута после
  // action размонтирует ShiftStart до навигации. Тот же приём, что у logout. Ошибка → остаёмся на экране.
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(undefined);
    const fd = new FormData(e.currentTarget);
    try {
      const res = await startWorkShiftAction({}, fd);
      if (res.redirectTo) { window.location.assign(res.redirectTo); return; } // уходим со страницы — pending не снимаем
      setError(res.error ?? "Не удалось начать смену");
    } catch {
      setError("Не удалось начать смену");
    }
    setPending(false);
  }

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
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
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
        {error && <p className="text-sm text-red-600">{error}</p>}
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
  // P3A.2/SHIFT-002: действие вызывается императивно, затем клиент делает полную навигацию
  // window.location.assign(redirectTo=/warehouse/shift). Без server-action redirect() и без гонки
  // авто-refresh маршрута. Ошибка (IN_PROGRESS блокирует) → остаёмся на экране, без навигации.
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  async function onEnd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      const res = await endWorkShiftAction({}, new FormData());
      if (res.redirectTo) { window.location.assign(res.redirectTo); return; }
      setError(res.error ?? "Не удалось завершить смену");
    } catch {
      setError("Не удалось завершить смену");
    }
    setPending(false);
  }
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
      <form onSubmit={onEnd} className="mt-4">
        {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
        <Button type="submit" variant="ghost" disabled={pending} className="w-full">
          {pending ? "Завершаем…" : "Завершить смену"}
        </Button>
      </form>
    </Card>
  );
}
