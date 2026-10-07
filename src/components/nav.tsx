"use client";

import { cn } from "cn";
import { Gift, Megaphone, Settings, SlidersHorizontal, Sun, Upload, Users, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSidebar } from "@/components/sidebar-context";

const LINKS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/today", label: "Today", icon: Sun },
  { href: "/influencers", label: "Creators", icon: Users },
  { href: "/campaigns", label: "Campaigns", icon: Megaphone },
  { href: "/orders", label: "Gifts", icon: Gift },
  { href: "/import", label: "Import", icon: Upload },
  { href: "/settings", label: "Settings", icon: SlidersHorizontal },
];

const ADMIN_LINK = { href: "/admin", label: "Admin", icon: Settings };

/**
 * Main navigation in the left sidebar. In the icon rail (narrow window, or
 * collapsed by choice) labels are hidden visually and shown as tooltips.
 */
export function SidebarNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const ui = useSidebar();
  const links = isAdmin ? [...LINKS, ADMIN_LINK] : LINKS;

  return (
    <nav aria-label="Main" className="grid gap-0.5">
      {links.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            title={label}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex h-9 items-center gap-2.5 rounded-md text-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ui.align,
              active ? "bg-surface-2 font-medium text-foreground" : "text-muted-foreground hover:bg-surface-2/60 hover:text-foreground",
            )}
          >
            {active ? <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary" /> : null}
            <Icon aria-hidden className="size-[17px] shrink-0" strokeWidth={1.75} />
            <span className={ui.label}>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

const ADMIN_TABS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/templates", label: "Message templates" },
  { href: "/admin/products", label: "Products" },
  { href: "/admin/suppression", label: "Do-not-contact list" },
  { href: "/admin/users", label: "Users" },
];

export function AdminTabs() {
  const pathname = usePathname();

  return (
    <nav aria-label="Admin sections" className="mb-6 flex flex-wrap gap-1.5">
      {ADMIN_TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link key={tab.href} href={tab.href} aria-current={active ? "page" : undefined} className="chip">
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
