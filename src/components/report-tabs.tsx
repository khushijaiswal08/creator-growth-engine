import Link from "next/link";

const TABS = [
  { key: "performance", href: "/reports/performance", label: "Performance" },
  { key: "outreach", href: "/reports/outreach", label: "Outreach by person" },
] as const;

/** The two reports, as chips under the page title. */
export function ReportTabs({ current }: { current: (typeof TABS)[number]["key"] }) {
  return (
    <nav aria-label="Reports" className="mb-6 flex flex-wrap gap-1.5">
      {TABS.map((tab) => (
        <Link key={tab.key} href={tab.href} className="chip" aria-current={tab.key === current ? "true" : undefined}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
