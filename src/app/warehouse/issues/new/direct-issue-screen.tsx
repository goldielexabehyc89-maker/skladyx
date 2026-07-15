"use client";

import { ScanLine, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { QrScanner } from "@/components/qr-scanner";
import { resolveScanAction } from "@/app/actions/scan";
import { completeDirectIssueAction, type DirectIssueItem } from "@/app/actions/issues";
import { Button, SelectField } from "@/components/ui";

interface Entry {
  raw: string;
  refId: string;
  title: string;
  type: "LOT" | "UNIT";
  qty: number;
  max: number;
  uom: string;
}

type Phase = "scan-items" | "assign" | "scan-badge";

// Прямая выдача: сканируем товары подряд → назначаем сотрудника (список или бейдж).
export function DirectIssueScreen({
  employees,
}: {
  employees: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("scan-items");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [msg, setMsg] = useState<{ ok?: string; error?: string } | null>(null);
  const [employeeId, setEmployeeId] = useState("");
  const [busy, startTransition] = useTransition();

  function handleItemScan(raw: string) {
    if (busy) return;
    startTransition(async () => {
      let info;
      try {
        info = await resolveScanAction(raw);
      } catch {
        return setMsg({ error: "Нет связи с сервером — проверьте интернет и отсканируйте ещё раз" });
      }
      if (info.error) return setMsg({ error: info.error });
      if (info.type !== "LOT" && info.type !== "UNIT")
        return setMsg({ error: "Сканируйте QR партии или единицы товара" });
      if (!info.refId || entries.some((e) => e.refId === info.refId))
        return setMsg({ error: "Уже в списке" });
      if (!info.available || info.available <= 0)
        return setMsg({ error: `«${info.title}» — нет доступного остатка` });
      setEntries((prev) => [
        ...prev,
        {
          raw,
          refId: info.refId!,
          title: info.title ?? "",
          type: info.type as "LOT" | "UNIT",
          qty: info.available!,
          max: info.available!,
          uom: info.uom ?? "",
        },
      ]);
      setMsg({ ok: `Добавлено: ${info.title}` });
    });
  }

  function submit(employee: { userId?: string; badgeRaw?: string }) {
    startTransition(async () => {
      const items: DirectIssueItem[] = entries.map((e) => ({
        raw: e.raw,
        qty: e.type === "LOT" ? e.qty : undefined,
      }));
      let res;
      try {
        res = await completeDirectIssueAction(items, employee);
      } catch {
        setMsg({ error: "Нет связи с сервером — выдача не оформлена, попробуйте ещё раз" });
        if (phase === "scan-badge") setPhase("assign");
        return;
      }
      if (res.error) {
        setMsg({ error: res.error });
        if (phase === "scan-badge") setPhase("assign");
        return;
      }
      router.push(res.issueId ? `/warehouse/issues/${res.issueId}` : "/warehouse/issues");
    });
  }

  if (phase === "scan-badge") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-center text-sm text-neutral-600">Сканируйте QR-бейдж сотрудника</p>
        <QrScanner onScan={(raw) => submit({ badgeRaw: raw })} paused={busy} />
        {msg?.error && <p className="text-center text-sm text-red-600">{msg.error}</p>}
        <Button type="button" variant="ghost" onClick={() => setPhase("assign")}>
          Назад
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {phase === "scan-items" && (
        <>
          <QrScanner onScan={handleItemScan} paused={busy} />
          <div className="min-h-6 text-center text-sm">
            {busy && <span className="text-neutral-400">Обработка…</span>}
            {!busy && msg?.ok && <span className="font-medium text-green-600">✓ {msg.ok}</span>}
            {!busy && msg?.error && <span className="font-medium text-red-600">{msg.error}</span>}
          </div>
        </>
      )}

      {entries.length > 0 && (
        <div className="rounded-2xl bg-white p-3 shadow-[0_2px_8px_rgba(20,20,60,0.06)]">
          <p className="mb-2 text-sm font-semibold">К выдаче ({entries.length})</p>
          <div className="flex flex-col divide-y divide-neutral-100">
            {entries.map((e, idx) => (
              <div key={e.refId} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0 flex-1 truncate text-sm">{e.title}</span>
                {e.type === "LOT" ? (
                  <span className="flex items-center gap-1 text-sm">
                    <input
                      type="number"
                      step="0.001"
                      inputMode="decimal"
                      value={e.qty}
                      max={e.max}
                      onChange={(ev) =>
                        setEntries((prev) =>
                          prev.map((p, i) =>
                            i === idx ? { ...p, qty: Number(ev.target.value) } : p,
                          ),
                        )
                      }
                      className="w-24 rounded-lg border border-[#e4e4f0] px-2 py-1 text-sm"
                    />
                    <span className="text-neutral-500">
                      / {e.max} {e.uom}
                    </span>
                  </span>
                ) : (
                  <span className="text-sm text-neutral-500">1 {e.uom}</span>
                )}
                <button
                  type="button"
                  title="Убрать из списка"
                  className="p-1.5 text-neutral-400 active:text-red-500"
                  onClick={() => setEntries((prev) => prev.filter((_, i) => i !== idx))}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {phase === "scan-items" && entries.length > 0 && (
        <Button type="button" onClick={() => setPhase("assign")}>
          Дальше: кому выдаём →
        </Button>
      )}

      {phase === "assign" && (
        <div className="flex flex-col gap-3 rounded-2xl bg-white shadow-[0_2px_8px_rgba(20,20,60,0.06)] p-4">
          <p className="text-sm font-semibold">Кому выдаём?</p>
          <SelectField value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">— выберите сотрудника —</option>
            {employees.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </SelectField>
          {msg?.error && <p className="text-sm text-red-600">{msg.error}</p>}
          <Button
            type="button"
            disabled={!employeeId || busy}
            onClick={() => submit({ userId: employeeId })}
          >
            {busy ? "Оформление…" : "Выдать"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setPhase("scan-badge")}>
            <ScanLine size={18} /> Сканировать бейдж сотрудника
          </Button>
          <Button type="button" variant="ghost" onClick={() => setPhase("scan-items")}>
            ← Вернуться к сканированию
          </Button>
        </div>
      )}
    </div>
  );
}
