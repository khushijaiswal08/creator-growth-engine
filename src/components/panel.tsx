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
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        {eyebrow ? <p className="mb-1.5 text-[13px] font-semibold text-muted-foreground">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {meta ? <div className="mt-1.5 text-[15px] font-medium text-muted-foreground">{meta}</div> : null}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2.5">{children}</div> : null}
    </header>
  );
}

/**
 * One section of a page. Boxed by default: a white card with a bold title
 * row. `plain` drops the box and keeps the title and hairline, for sections
 * that should sit directly on the page.
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
        <div className={cn("flex flex-wrap items-center justify-between gap-3", plain ? "border-b pb-3" : "border-b px-5 py-4")}>
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
      <td colSpan={colSpan} className="px-4 py-12 text-center font-medium text-muted-foreground">
        {children}
      </td>
    </tr>
  );
}
