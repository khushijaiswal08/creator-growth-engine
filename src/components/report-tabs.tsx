import Link from "next/link";

const TABS = [
  { key: "performance", href: "/reports/performance", label: "Performance" },
  { key: "outreach", href: "/reports/outreach", label: "Outreach by person" },
  { key: "ranking", href: "/influencers/ranking", label: "Creator ranking" },
] as const;

/** The reports, as underlined tabs under the page title. */
export function ReportTabs({ current }: { current: (typeof TABS)[number]["key"] }) {
  return (
    <nav aria-label="Reports" className="tabs mb-5">
      {TABS.map((tab) => (
        <Link key={tab.key} href={tab.href} className="tab" aria-current={tab.key === current ? "true" : undefined}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
