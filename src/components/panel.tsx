import { cn } from "cn";

export function PageHeader({
  eyebrow,
  title,
  meta,
  children,
}: {
  /** A quiet line above the title, such as the date or the campaign a page belongs to. */
  eyebrow?: React.ReactNode;
  title: string;
  meta?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        {eyebrow ? <p className="eyebrow mb-1.5">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {meta ? <div className="mt-1.5 text-muted-foreground">{meta}</div> : null}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </header>
  );
}

/**
 * One section of a page. Boxed by default: a quiet white card on the paper
 * with a serif title. `plain` drops the box and keeps the title and hairline,
 * for sections that should sit directly on the page.
 */
export function Panel({
  title,
  aside,
  plain = false,
  className,
  children,
}: {
  title?: string;
  aside?: React.ReactNode;
  plain?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn(plain ? "" : "card overflow-hidden", className)}>
      {title ? (
        <div className={cn("flex items-center justify-between gap-3 border-b", plain ? "pb-2.5" : "px-4 py-3")}>
          <h2>{title}</h2>
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function EmptyRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-8 text-center text-muted-foreground">
        {children}
      </td>
    </tr>
  );
}
