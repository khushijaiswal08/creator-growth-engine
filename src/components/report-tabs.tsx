import Link from "next/link";

const TABS = [
  { key: "performance", href: "/reports/performance", label: "Performance" },
  { key: "outreach", href: "/reports/outreach", label: "Outreach by person" },
  { key: "ranking", href: "/influencers/ranking", label: "Creator leaderboard" },
] as const;

/** The reports, as underlined tabs under the page title. Amazon sales joins once the imports exist. */
export function ReportTabs({ current }: { current: (typeof TABS)[number]["key"] }) {
  return (
    <nav aria-label="Reports" className="tabs mb-5">
      {TABS.map((tab) => (
        <Link key={tab.key} href={tab.href} className="tab" aria-current={tab.key === current ? "true" : undefined}>
          {tab.label}
        </Link>
      ))}
      <span className="tab cursor-default text-muted-foreground/70" title="Arrives with the Amazon imports">
        Amazon sales <span className="chip border-transparent bg-surface-2 px-1.5 py-0 text-[11px]">soon</span>
      </span>
    </nav>
  );
}
