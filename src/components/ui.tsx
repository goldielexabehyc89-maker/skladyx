import { clsx } from "clsx";
import Link from "next/link";
import type { StatusInfo } from "@/lib/statuses";

// UI-примитивы в стиле CRM: белые карточки 16px с мягкой тенью,
// градиентные primary-кнопки (#667eea→#764ba2), чипы-бейджи.

export function Card({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        "rounded-xl bg-white p-4 shadow-[0_2px_8px_rgba(20,20,60,0.06)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-3 text-sm font-semibold text-neutral-500">{children}</h3>;
}

const BTN_BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:opacity-50";
const BTN_VARIANTS = {
  primary:
    "bg-gradient-to-br from-[#667eea] to-[#764ba2] text-white shadow-[0_4px_12px_rgba(102,126,234,0.35)] active:opacity-85",
  ghost: "border border-[#e4e4f0] bg-white text-[#333] active:bg-neutral-100",
  danger: "bg-red-600 text-white active:opacity-85",
} as const;

export function Button({
  children,
  type = "submit",
  variant = "primary",
  className,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  type?: "submit" | "button";
  variant?: keyof typeof BTN_VARIANTS;
  className?: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={clsx(BTN_BASE, BTN_VARIANTS[variant], className)}
    >
      {children}
    </button>
  );
}

export function LinkButton({
  href,
  children,
  variant = "ghost",
  className,
}: {
  href: string;
  children: React.ReactNode;
  variant?: keyof typeof BTN_VARIANTS;
  className?: string;
}) {
  return (
    <Link href={href} className={clsx(BTN_BASE, BTN_VARIANTS[variant], className)}>
      {children}
    </Link>
  );
}

// Обычная <a>-кнопка для скачиваемых файлов (PDF): без next/link и префетча.
export function DownloadButton({
  href,
  children,
  variant = "ghost",
  className,
}: {
  href: string;
  children: React.ReactNode;
  variant?: keyof typeof BTN_VARIANTS;
  className?: string;
}) {
  return (
    <a href={href} className={clsx(BTN_BASE, BTN_VARIANTS[variant], className)}>
      {children}
    </a>
  );
}

export function Field({
  label,
  name,
  type = "text",
  placeholder,
  required,
  defaultValue,
  inputMode,
  step,
  autoComplete,
}: {
  label: string;
  name: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string;
  inputMode?: "text" | "decimal" | "numeric" | "email" | "tel";
  step?: string;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-[#555]">{label}</span>
      <input
        name={name}
        type={type}
        placeholder={placeholder}
        required={required}
        defaultValue={defaultValue}
        inputMode={inputMode}
        step={step}
        autoComplete={autoComplete}
        className="min-h-11 w-full rounded-xl border border-[#e4e4f0] bg-white px-3 py-2 text-base outline-none transition focus:border-brand focus:shadow-[0_0_0_3px_rgba(102,126,234,0.15)]"
      />
    </label>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "green" | "orange" | "red" | "blue";
}) {
  return (
    <span
      className={clsx(
        "rounded-full px-2.5 py-0.5 text-xs font-semibold",
        tone === "neutral" && "bg-[#f0f0f5] text-[#666]",
        tone === "green" && "bg-[#e8f5e9] text-[#2e7d32]",
        tone === "orange" && "bg-[#fff3e0] text-[#e65100]",
        tone === "red" && "bg-[#ffebee] text-[#c62828]",
        tone === "blue" && "bg-[#e9ecfb] text-[#4c5fd7]",
      )}
    >
      {children}
    </span>
  );
}

// Устаревший алиас PageHeader: страницы на PageTitle автоматически получают
// ту же закреплённую белую шапку, что и остальные (единый вид без переделки).
export function PageTitle({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return <PageHeader title={children} action={action} />;
}

export function EmptyState({
  children,
  title,
  action,
}: {
  children: React.ReactNode;
  title?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-[#d6d8ea] p-8 text-center text-sm text-neutral-500">
      {title && <div className="mb-1 text-base font-semibold text-neutral-700">{title}</div>}
      <div>{children}</div>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

// Закреплённый заголовок вкладки (название + действие) — прилипает к верху при
// прокрутке. Используется на всех страницах-списках (Таблица 1).
export function PageHeader({
  title,
  action,
}: {
  title: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="sticky top-14 z-10 mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-[#e7e8f2] bg-white px-4 py-3 shadow-[0_2px_8px_rgba(20,20,60,0.06)] lg:top-0">
      <h1 className="min-w-0 text-xl font-bold text-[#1a1a1a]">{title}</h1>
      {action}
    </div>
  );
}

// Статусный бейдж по единой карте статусов (src/lib/statuses.ts).
export function StatusBadge({ status }: { status: StatusInfo }) {
  return <Badge tone={status.tone}>{status.label}</Badge>;
}

// Единый select в стиле Field: подпись + рамка. Заменяет ручную вёрстку селектов.
export function SelectField({
  label,
  className,
  ...props
}: { label?: string; className?: string } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  const select = (
    <select
      {...props}
      className={clsx(
        "min-h-11 w-full rounded-xl border border-[#e4e4f0] bg-white px-3 py-2 text-base outline-none transition focus:border-brand disabled:bg-neutral-100 disabled:text-neutral-400",
        className,
      )}
    />
  );
  if (!label) return select;
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-[#555]">{label}</span>
      {select}
    </label>
  );
}

// Выбор из небольшого числа вариантов крупными кнопками-плитками (склады, роли,
// тип учёта). Под капотом радио/чекбоксы — в обычной форме работает без JS
// (multiple отправляется как несколько значений одного name → FormData.getAll).
// Управляемый режим (value + onChange) — только из клиентских компонентов:
// onChange всегда получает ИТОГОВЫЙ массив выбранных значений.
export function ChipSelect({
  name,
  options,
  multiple = false,
  required,
  defaultValue,
  value,
  onChange,
}: {
  name: string;
  options: { value: string; label: string; hint?: string; disabled?: boolean }[];
  multiple?: boolean;
  required?: boolean;
  defaultValue?: string | string[];
  value?: string | string[]; // управляемый режим (только из клиентских компонентов)
  onChange?: (next: string[]) => void; // итоговый выбор целиком
}) {
  const selected: string[] =
    value === undefined ? [] : Array.isArray(value) ? value : value ? [value] : [];
  const isChecked = (v: string): boolean => selected.includes(v);
  const nextFor = (v: string): string[] => {
    if (!multiple) return [v];
    return selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
  };
  const isDefault = (v: string): boolean =>
    Array.isArray(defaultValue) ? defaultValue.includes(v) : defaultValue === v;
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <label
          key={o.value}
          className={clsx("cursor-pointer", o.disabled && "cursor-not-allowed opacity-40")}
        >
          <input
            type={multiple ? "checkbox" : "radio"}
            name={name}
            value={o.value}
            className="peer sr-only"
            required={required && !multiple}
            disabled={o.disabled}
            {...(value !== undefined
              ? { checked: isChecked(o.value), onChange: () => onChange?.(nextFor(o.value)) }
              : { defaultChecked: isDefault(o.value) })}
          />
          <span className="flex min-h-11 flex-col items-start justify-center rounded-xl border border-[#e4e4f0] bg-white px-4 py-2 text-sm font-semibold text-[#333] transition peer-checked:border-[#667eea] peer-checked:bg-[#e9ecfb] peer-checked:text-[#4c5fd7]">
            {o.label}
            {o.hint && <span className="text-xs font-normal text-neutral-400">{o.hint}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

// Единая строка фильтров над списком (GET-форма текущей страницы).
export function FilterBar({ children }: { children: React.ReactNode }) {
  return (
    <form
      data-realtime-ignore-dirty
      className="flex flex-col gap-2 rounded-xl bg-white p-3 shadow-[0_2px_8px_rgba(20,20,60,0.06)] sm:flex-row sm:flex-wrap sm:items-center"
    >
      {children}
    </form>
  );
}

export function FilterSubmit({ label = "Показать" }: { label?: string }) {
  return (
    <button
      type="submit"
      className="min-h-11 shrink-0 rounded-xl border border-[#e4e4f0] bg-white px-4 text-sm font-medium active:bg-neutral-100"
    >
      {label}
    </button>
  );
}
