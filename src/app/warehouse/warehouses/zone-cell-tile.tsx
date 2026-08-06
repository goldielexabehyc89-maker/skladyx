"use client";

import { useState, useActionState } from "react";
import { clsx } from "clsx";
import { Badge, Button } from "@/components/ui";
import {
  changeCellZoneAction,
  setCellActiveAction,
  renameCellAction,
  deleteCellAction,
  type FormState,
} from "@/app/actions/warehouses";
import { ZONE_KIND_LABEL, ZONE_KIND_TONE } from "@/lib/zones";
import type { ZoneKind } from "@prisma/client";

export interface ZoneOption {
  id: string;
  name: string;
  kind: ZoneKind;
}

// Плитка ячейки (режим зон): код + зона + уровень; по тапу — лист со сменой зоны и вкл/выкл.
export function ZoneCellTile({
  cell,
  zones,
}: {
  cell: {
    id: string;
    code: string;
    level: number | null;
    isActive: boolean;
    zoneId: string | null;
    zoneName: string | null;
    zoneKind: ZoneKind | null;
  };
  zones: ZoneOption[];
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<FormState, FormData>(changeCellZoneAction, {});
  const [renState, renAction, renPending] = useActionState<FormState, FormData>(renameCellAction, {});
  const [actState, actAction, actPending] = useActionState<FormState, FormData>(setCellActiveAction, {});
  const [delState, delAction, delPending] = useActionState<FormState, FormData>(deleteCellAction, {});
  // Выбор по умолчанию — фактическая зона ячейки (если она физическая и есть в списке),
  // иначе первая доступная. Так форма открывается на настоящей зоне, а не на zones[0].
  const initialZoneId =
    cell.zoneId && zones.some((z) => z.id === cell.zoneId) ? cell.zoneId : (zones[0]?.id ?? "");
  const [zoneId, setZoneId] = useState(initialZoneId);
  const selKind = zones.find((z) => z.id === zoneId)?.kind ?? null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={clsx(
          "flex min-h-16 flex-col items-center justify-center gap-1 rounded-lg border p-2 text-center transition active:bg-neutral-50",
          cell.isActive ? "border-neutral-200 bg-white" : "border-neutral-100 bg-neutral-50 opacity-50",
        )}
      >
        <span className="font-mono text-base font-bold">{cell.code}</span>
        <span className="flex flex-wrap justify-center gap-1">
          {cell.zoneKind && (
            <Badge tone={ZONE_KIND_TONE[cell.zoneKind]}>{ZONE_KIND_LABEL[cell.zoneKind]}</Badge>
          )}
          {cell.level != null && <Badge tone="neutral">ур. {cell.level}</Badge>}
          {!cell.isActive && <Badge tone="red">откл</Badge>}
        </span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-t-2xl bg-white p-5 shadow-[0_-8px_40px_rgba(0,0,0,0.25)] sm:rounded-2xl"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 20px)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 text-center">
              <div className="font-mono text-2xl font-bold text-[#1a1a1a]">{cell.code}</div>
              <div className="mt-1.5 flex justify-center gap-1.5">
                {cell.zoneKind ? (
                  <Badge tone={ZONE_KIND_TONE[cell.zoneKind]}>
                    {cell.zoneName ?? ZONE_KIND_LABEL[cell.zoneKind]}
                    {cell.level != null ? ` · ур. ${cell.level}` : ""}
                  </Badge>
                ) : (
                  <Badge tone="neutral">без зоны</Badge>
                )}
                {!cell.isActive && <Badge tone="red">отключена</Badge>}
              </div>
            </div>

            <form action={action} className="flex flex-col gap-2">
              <input type="hidden" name="cellId" value={cell.id} />
              <label className="text-xs font-medium text-neutral-500">Перенести в зону</label>
              <select
                name="zoneId"
                value={zoneId}
                onChange={(e) => setZoneId(e.target.value)}
                className="rounded-lg border border-[#e4e4f0] px-3 py-2 text-sm"
              >
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name} · {ZONE_KIND_LABEL[z.kind]}
                  </option>
                ))}
              </select>
              {selKind === "STORAGE" && (
                <input
                  name="level"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  placeholder="Уровень (напр. 1)"
                  defaultValue={cell.level ?? ""}
                  className="rounded-lg border border-[#e4e4f0] px-3 py-2 text-sm"
                />
              )}
              {state.error && <p className="text-xs text-red-600">{state.error}</p>}
              <Button type="submit" variant="ghost" disabled={pending} className="w-full">
                {pending ? "…" : "Перенести в зону"}
              </Button>
            </form>

            <form action={renAction} className="mt-2 flex flex-col gap-2 border-t border-[#eee] pt-2">
              <input type="hidden" name="cellId" value={cell.id} />
              <label className="text-xs font-medium text-neutral-500">Переименовать (только неиспользованную)</label>
              <input name="code" defaultValue={cell.code} className="rounded-lg border border-[#e4e4f0] px-3 py-2 text-sm" />
              {renState.error && <p className="text-xs text-red-600">{renState.error}</p>}
              {renState.ok && <p className="text-xs text-green-700">{renState.ok}</p>}
              <Button type="submit" variant="ghost" disabled={renPending} className="w-full">
                {renPending ? "…" : "Сохранить код"}
              </Button>
            </form>

            <div className="mt-2 flex flex-col gap-2">
              <form action={actAction}>
                <input type="hidden" name="cellId" value={cell.id} />
                <input type="hidden" name="active" value={cell.isActive ? "false" : "true"} />
                <Button type="submit" variant="ghost" disabled={actPending} className="w-full">
                  {cell.isActive ? "Отключить ячейку" : "Включить ячейку"}
                </Button>
              </form>
              {actState.error && <p className="text-xs text-red-600">{actState.error}</p>}
              <form action={delAction}>
                <input type="hidden" name="cellId" value={cell.id} />
                <Button type="submit" variant="ghost" disabled={delPending} className="w-full">
                  {delPending ? "…" : "Удалить (только неиспользованную)"}
                </Button>
              </form>
              {delState.error && <p className="text-xs text-red-600">{delState.error}</p>}
              <Button type="button" variant="primary" onClick={() => setOpen(false)} className="w-full">
                Закрыть
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
