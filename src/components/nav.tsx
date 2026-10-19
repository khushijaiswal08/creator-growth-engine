"use client";

import { cn } from "cn";
import { BarChart3, Clapperboard, Gift, Kanban, LayoutDashboard, Settings, SlidersHorizontal, Users, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSidebar } from "@/components/sidebar-context";

type NavLink = { href: string; label: string; icon: LucideIcon };

export const NAV_LINKS: NavLink[] = [
  { href: "/today", label: "Home", icon: LayoutDashboard },
  { href: "/influencers", label: "Creators", icon: Users },
  { href: "/campaigns", label: "Pipeline", icon: Kanban },
  { href: "/orders", label: "Gifts", icon: Gift },
  { href: "/content", label: "Content", icon: Clapperboard },
  { href: "/reports", label: "Reports", icon: BarChart3 },
];

export const SETTINGS_LINK: NavLink = { href: "/settings", label: "Settings", icon: SlidersHorizontal };
export const ADMIN_LINK: NavLink = { href: "/admin", label: "Admin", icon: Settings };

/**
 * Main navigation in the left sidebar: the six places, a hairline, then
 * Settings and Admin. In the icon rail (narrow window, or collapsed by choice)
 * labels are hidden visually and shown as tooltips.
 */
export function SidebarNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const ui = useSidebar();
  const lower = isAdmin ? [SETTINGS_LINK, ADMIN_LINK] : [SETTINGS_LINK];

  const item = ({ href, label, icon: Icon }: NavLink) => {
    const active = pathname === href || pathname.startsWith(`${href}/`);
    return (
      <Link
        key={href}
        href={href}
        title={label}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-9 items-center gap-2.5 rounded-md text-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring",
          ui.align,
          active ? "bg-primary-soft font-semibold text-primary-text" : "font-medium text-accent-text hover:bg-surface-2 hover:text-foreground",
        )}
      >
        <Icon aria-hidden className="size-[18px] shrink-0" strokeWidth={1.9} />
        <span className={ui.label}>{label}</span>
      </Link>
    );
  };

  return (
    <nav aria-label="Main" className="grid gap-0.5">
      {NAV_LINKS.map(item)}
      <div aria-hidden className="my-2 border-t" />
      {lower.map(item)}
    </nav>
  );
}

const ADMIN_TABS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/templates", label: "Message templates" },
  { href: "/admin/products", label: "Products" },
  { href: "/admin/suppression", label: "Do-not-contact list" },
  { href: "/admin/calibration", label: "Scoring calibration" },
  { href: "/admin/users", label: "Users" },
  { href: "/import", label: "Import" },
];

export function AdminTabs() {
  const pathname = usePathname();

  return (
    <nav aria-label="Admin sections" className="tabs mb-6">
      {ADMIN_TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link key={tab.href} href={tab.href} aria-current={active ? "page" : undefined} className="tab">
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
