import { PageHeader } from "@/components/ui";

// Каркас страницы: закреплённая шапка (заголовок + бейдж + действия), опциональное
// описание под ней и контент. Единый для всех вкладок — вместо PageTitle.
export function PageShell({
  title,
  action,
  description,
  children,
}: {
  title: React.ReactNode;
  action?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={title} action={action} />
      {description && <p className="-mt-1 text-sm text-neutral-500">{description}</p>}
      {children}
    </div>
  );
}

// Каркас страницы-формы (создание/редактирование сущности): узкий центрированный
// контейнер, в котором шапка и карточки формы имеют одинаковую ширину и края.
// Карточки внутри НЕ должны сами задавать max-w — ширину держит контейнер.
export function FormPageShell({
  title,
  action,
  description,
  maxWidth = "2xl",
  children,
}: {
  title: React.ReactNode;
  action?: React.ReactNode;
  description?: React.ReactNode;
  maxWidth?: "xl" | "2xl" | "3xl";
  children: React.ReactNode;
}) {
  const width = { xl: "max-w-xl", "2xl": "max-w-2xl", "3xl": "max-w-3xl" }[maxWidth];
  return (
    <div className={`mx-auto w-full ${width}`}>
      <PageShell title={title} action={action} description={description}>
        {children}
      </PageShell>
    </div>
  );
}
