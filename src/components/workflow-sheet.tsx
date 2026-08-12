"use client";

import { useRef } from "react";
import { RefreshCw } from "lucide-react";
import { QrScanner, type ScanFormat } from "@/components/qr-scanner";
export type { ScanFormat };
import { Button } from "@/components/ui";

// Единая скан-шторка складских процессов (приёмка, сборка, выдача, скан-подряд):
// каркас с заголовком, прогресс-баром, телом (список ⇄ камера), нижними кнопками,
// встроенное окно ошибки и универсальное центральное окно (подтверждение/финал).
// Логика сканов остаётся в экранах — сюда передаются только колбэки и содержимое.

export interface SheetModal {
  icon?: React.ReactNode; // по умолчанию зелёная галка
  title: React.ReactNode;
  body?: React.ReactNode;
  actions?: React.ReactNode; // кнопки окна (стек); можно опустить для авто-переходов (UI-005)
  tone?: "success" | "neutral"; // UI-005: neutral — нейтральное окно «проверки» (без зелёной галки)
}

export function WorkflowSheet({
  title,
  subtitle,
  progressPct,
  scanning,
  scanHint,
  onScan,
  scanFormats,
  scanPaused,
  onBackToList,
  onClose,
  footer,
  children,
  busy,
  error,
  onErrorRetry,
  onErrorExit,
  modal,
  manualPlaceholder,
  manualInputMode,
  context,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  progressPct?: number; // прогресс-бар, если задан
  // Постоянный компактный контекст под заголовком — виден и при сканировании, и в режиме списка
  // (напр. товар · количество · назначенная ячейка при размещении).
  context?: React.ReactNode;
  scanning: boolean; // true — камера вместо списка
  scanHint?: React.ReactNode; // UI-005: подсказка НАД камерой (точное обозначение ожидаемого объекта)
  onScan: (raw: string) => void;
  scanFormats?: ScanFormat[]; // Пакет 9B: форматы текущего шага (ячейка/товар/заказ)
  scanPaused?: boolean;
  // UI-004: ручной ввод текущего шага — та же машина состояний, что и камера (onScan). Один input,
  // не набор полей; Enter подтверждает. Показывается под камерой как fallback.
  manualPlaceholder?: string;
  manualInputMode?: "text" | "numeric" | "decimal";
  onBackToList: () => void;
  onClose: () => void;
  footer?: React.ReactNode; // нижние кнопки (в режиме списка)
  children: React.ReactNode; // список позиций / произвольное тело
  busy?: boolean;
  error: string | null; // окно ошибки (стандартное)
  onErrorRetry: () => void;
  onErrorExit: () => void;
  modal?: SheetModal | null; // центральное окно поверх шторки
}) {
  const manualRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <div data-workflow-sheet className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
        <div className="flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-t-3xl bg-white shadow-[0_-8px_40px_rgba(0,0,0,0.25)] sm:rounded-3xl sm:shadow-[0_8px_40px_rgba(0,0,0,0.25)]">
          {/* Заголовок */}
          <div className="flex items-center justify-between border-b border-neutral-100 px-5 py-4">
            <div className="min-w-0">
              <div className="text-base font-bold text-[#1a1a1a]">{title}</div>
              {subtitle && (
                <div className="mt-0.5 truncate text-xs text-neutral-500">{subtitle}</div>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Закрыть"
              className="rounded-lg px-2.5 py-1 text-lg text-neutral-400 active:bg-neutral-100"
            >
              ✕
            </button>
          </div>

          {/* Постоянный контекст (виден и при сканировании) */}
          {context && <div className="border-b border-neutral-100 px-5 py-2.5">{context}</div>}

          {/* Прогресс */}
          {progressPct !== undefined && (
            <div className="px-5 pt-4">
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-[#eef0f8]">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[#667eea] to-[#764ba2] transition-all"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          )}

          {/* Тело: камера или список */}
          <div
            className="flex-1 overflow-y-auto px-5 py-4"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 16px)" }}
          >
            {scanning ? (
              <div className="flex flex-col gap-3">
                {/* UI-005: подсказка НАД камерой — точно называет ожидаемый объект (товар/ячейка/заказ). */}
                {scanHint && <p className="min-h-6 text-center text-sm font-semibold text-[#667eea]">{scanHint}</p>}
                <QrScanner onScan={onScan} formats={scanFormats} paused={!!scanPaused || !!error || !!modal} />
                <div className="min-h-6 text-center">
                  {busy && <p className="text-sm text-neutral-400">Проверяем…</p>}
                </div>
                {/* UI-004: ручной ввод текущего шага — тот же onScan (одно поле, Enter подтверждает) */}
                {manualPlaceholder && (
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => { e.preventDefault(); const v = manualRef.current?.value?.trim(); if (v) { onScan(v); if (manualRef.current) manualRef.current.value = ""; } }}
                  >
                    <input
                      ref={manualRef}
                      inputMode={manualInputMode ?? "text"}
                      placeholder={manualPlaceholder}
                      className="min-w-0 flex-1 rounded-lg border border-[#e4e4f0] px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                    <Button type="submit" variant="ghost" disabled={!!busy}>Ввести</Button>
                  </form>
                )}
                <Button type="button" variant="ghost" onClick={onBackToList} className="w-full">
                  Назад к списку
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">{children}</div>
            )}
          </div>

          {/* Нижние кнопки */}
          {!scanning && footer && (
            <div
              className="flex flex-col gap-2 border-t border-neutral-100 px-5 pt-4"
              style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 16px)" }}
            >
              {footer}
            </div>
          )}
        </div>
      </div>

      {/* Центральное окно (подтверждение шага / финал). UI-005: role=status/aria-live — озвучивается
          скринридером; цвет не единственный сигнал (иконка + текст). */}
      {modal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-6" role="status" aria-live="polite">
          <div className="w-full max-w-xs rounded-3xl bg-white p-6 text-center shadow-[0_20px_60px_rgba(0,0,0,0.35)]">
            {modal.icon ?? (
              modal.tone === "neutral" ? (
                <div className="mx-auto flex h-16 w-16 animate-pulse items-center justify-center rounded-full bg-[#eef0f8] text-3xl text-[#667eea]">⏳</div>
              ) : (
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#e8f5e9] text-3xl text-[#2e7d32]">✓</div>
              )
            )}
            <div className="mt-3 text-lg font-bold text-[#1a1a1a]">{modal.title}</div>
            {modal.body && <div className="mt-1.5 text-sm text-neutral-500">{modal.body}</div>}
            {modal.actions && <div className="mt-5 flex flex-col gap-2">{modal.actions}</div>}
          </div>
        </div>
      )}

      {/* Окно ошибки — одинаковое во всех процессах. UI-005: role=alert (блокирующее, с иконкой и текстом). */}
      {error && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-6" role="alert" aria-live="assertive">
          <div className="w-full max-w-xs rounded-3xl bg-white p-6 text-center shadow-[0_20px_60px_rgba(0,0,0,0.35)]">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#ffebee] text-3xl text-[#c62828]">
              !
            </div>
            <div className="mt-3 text-base font-bold text-[#1a1a1a]">Ошибка сканирования</div>
            <div className="mt-2 text-sm text-neutral-600">{error}</div>
            <div className="mt-5 flex flex-col gap-2">
              <Button type="button" variant="primary" onClick={onErrorRetry} className="w-full">
                <RefreshCw size={18} /> Повторить
              </Button>
              <Button type="button" variant="ghost" onClick={onErrorExit} className="w-full">
                К списку
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
