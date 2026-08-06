"use client";

import { useState, useActionState } from "react";
import { clsx } from "clsx";
import { Button } from "@/components/ui";
import { createCellsAction, type FormState } from "@/app/actions/warehouses";
import { ZONE_KIND_LABEL } from "@/lib/zones";
import type { ZoneKind } from "@prisma/client";

export interface PhysZone {
  id: string;
  name: string;
  kind: ZoneKind;
}

// маленький контролируемый инпут (Field не поддерживает value/onChange)
function Inp({ label, name, value, onChange, placeholder, numeric }: { label: string; name: string; value: string; onChange: (v: string) => void; placeholder?: string; numeric?: boolean }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs font-medium text-neutral-500">{label}</span>
      <input
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={numeric ? "numeric" : "text"}
        className="rounded-lg border border-[#e4e4f0] px-3 py-2 text-sm"
      />
    </label>
  );
}

// Пакет 9A: создание ячеек — ручное (один код) или массовое (диапазон мест + для STORAGE диапазон
// уровней). Клиентский предпросмотр; сервер создаёт одной транзакцией (≤500), отчёт created/skipped.
export function CreateCellsForm({ warehouseId, zones }: { warehouseId: string; zones: PhysZone[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createCellsAction, {});
  const [zoneId, setZoneId] = useState(zones[0]?.id ?? "");
  const [mode, setMode] = useState<"manual" | "bulk">("bulk");
  const isStorage = zones.find((z) => z.id === zoneId)?.kind === "STORAGE";

  const [code, setCode] = useState("");
  const [prefix, setPrefix] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [level, setLevel] = useState("");
  const [levelFrom, setLevelFrom] = useState("");
  const [levelTo, setLevelTo] = useState("");

  if (zones.length === 0)
    return <p className="text-sm text-neutral-500">Нет физических зон для создания ячеек.</p>;

  const preview: string[] = [];
  if (mode === "manual") {
    if (code.trim()) preview.push(code.trim());
  } else {
    const f = Number(from), t = Number(to);
    if (prefix.trim() && Number.isInteger(f) && Number.isInteger(t) && f >= 0 && t >= f) {
      const pad = String(t).length > 2 ? String(t).length : 2;
      let levels: (number | null)[] = [null];
      if (isStorage) {
        const lf = Number(levelFrom), lt = Number(levelTo);
        levels = Number.isInteger(lf) && Number.isInteger(lt) && lf >= 1 && lt >= lf
          ? Array.from({ length: lt - lf + 1 }, (_, i) => lf + i)
          : [];
      }
      for (const lv of levels)
        for (let i = f; i <= t; i++) {
          const place = `${prefix.trim()}${String(i).padStart(pad, "0")}`;
          preview.push(lv == null ? place : `${place}-У${lv}`);
        }
    }
  }
  const tooMany = preview.length > 500;

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="warehouseId" value={warehouseId} />
      <input type="hidden" name="zoneId" value={zoneId} />
      <input type="hidden" name="mode" value={mode} />

      <div>
        <div className="mb-1.5 text-xs font-medium text-neutral-500">Зона</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {zones.map((z) => (
            <button
              key={z.id}
              type="button"
              onClick={() => setZoneId(z.id)}
              className={clsx(
                "flex flex-col items-center gap-0.5 rounded-lg border p-2 text-center text-sm transition",
                zoneId === z.id ? "border-brand bg-brand/5 font-semibold" : "border-neutral-200 bg-white active:bg-neutral-50",
              )}
            >
              <span className="truncate">{z.name}</span>
              <span className="text-[11px] text-neutral-400">{ZONE_KIND_LABEL[z.kind]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        {(["bulk", "manual"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={clsx(
              "rounded-lg border px-3 py-1.5 text-sm transition",
              mode === m ? "border-brand bg-brand/5 font-semibold" : "border-neutral-200 active:bg-neutral-50",
            )}
          >
            {m === "bulk" ? "Массово (диапазон)" : "Одна ячейка"}
          </button>
        ))}
      </div>

      {mode === "manual" ? (
        <>
          <Inp label="Код ячейки" name="code" value={code} onChange={setCode} placeholder="А-01" />
          {isStorage && <Inp label="Уровень (обязателен для хранения)" name="level" value={level} onChange={setLevel} placeholder="1" numeric />}
        </>
      ) : (
        <>
          <Inp label="Префикс" name="prefix" value={prefix} onChange={setPrefix} placeholder="А-" />
          <div className="grid grid-cols-2 gap-3">
            <Inp label="С места" name="from" value={from} onChange={setFrom} placeholder="1" numeric />
            <Inp label="По место" name="to" value={to} onChange={setTo} placeholder="20" numeric />
          </div>
          {isStorage && (
            <div className="grid grid-cols-2 gap-3">
              <Inp label="Уровень с" name="levelFrom" value={levelFrom} onChange={setLevelFrom} placeholder="1" numeric />
              <Inp label="Уровень по" name="levelTo" value={levelTo} onChange={setLevelTo} placeholder="3" numeric />
            </div>
          )}
        </>
      )}

      {preview.length > 0 && (
        <div className="rounded-lg border border-[#eee] bg-neutral-50/60 p-2 text-xs">
          <div className={clsx("mb-1 font-medium", tooMany ? "text-red-600" : "text-neutral-600")}>
            Будет создано: {preview.length}{tooMany ? " — не больше 500 за раз" : ""}
          </div>
          <div className="font-mono text-[11px] text-neutral-500">
            {preview.slice(0, 8).join(", ")}{preview.length > 8 ? ` … ${preview[preview.length - 1]}` : ""}
          </div>
        </div>
      )}

      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      {state.ok && <p className="text-sm text-green-700">{state.ok}</p>}
      <Button type="submit" disabled={pending || preview.length === 0 || tooMany}>
        {pending ? "…" : "Создать ячейки"}
      </Button>
    </form>
  );
}
