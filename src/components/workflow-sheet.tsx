"use client";

import { RefreshCw } from "lucide-react";
import { QrScanner } from "@/components/qr-scanner";
import { Button } from "@/components/ui";

// Единая скан-шторка складских процессов (приёмка, сборка, выдача, скан-подряд):
// каркас с заголовком, прогресс-баром, телом (список ⇄ камера), нижними кнопками,
// встроенное окно ошибки и универсальное центральное окно (подтверждение/финал).
// Логика сканов остаётся в экранах — сюда передаются только колбэки и содержимое.

export interface SheetModal {
  icon?: React.ReactNode; // по умолчанию зелёная галка
  title: React.ReactNode;
  body?: React.ReactNode;
  actions: React.ReactNode; // кнопки окна (стек)
}

export function WorkflowSheet({
  title,
  subtitle,
  progressPct,
  scanning,
  scanHint,
  onScan,
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
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  progressPct?: number; // прогресс-бар, если задан
  scanning: boolean; // true — камера вместо списка
  scanHint?: React.ReactNode; // подсказка под камерой
  onScan: (raw: string) => void;
  scanPaused?: boolean;
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
                <QrScanner onScan={onScan} paused={!!scanPaused || !!error || !!modal} />
                <div className="min-h-14 text-center">
                  {scanHint && <p className="text-sm font-medium text-[#667eea]">{scanHint}</p>}
                  {busy && <p className="mt-1 text-sm text-neutral-400">Обработка…</p>}
                </div>
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

      {/* Центральное окно (подтверждение шага / финал) */}
      {modal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-6">
          <div className="w-full max-w-xs rounded-3xl bg-white p-6 text-center shadow-[0_20px_60px_rgba(0,0,0,0.35)]">
            {modal.icon ?? (
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#e8f5e9] text-3xl text-[#2e7d32]">
                ✓
              </div>
            )}
            <div className="mt-3 text-lg font-bold text-[#1a1a1a]">{modal.title}</div>
            {modal.body && <div className="mt-1.5 text-sm text-neutral-500">{modal.body}</div>}
            <div className="mt-5 flex flex-col gap-2">{modal.actions}</div>
          </div>
        </div>
      )}

      {/* Окно ошибки — одинаковое во всех процессах */}
      {error && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-6">
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
