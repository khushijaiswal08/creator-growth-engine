import { KeyRound, LogOut } from "lucide-react";
import Link from "next/link";
import { logout } from "@/actions/auth";
import { BrandBadge, BrandSwitcher } from "@/components/brand-switcher";
import { SidebarNav } from "@/components/nav";
import { brandName, brandShortName } from "@/lib/brands";
import { requireUser } from "@/lib/session";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "")).toUpperCase();
}

const FOOT_LINK =
  "flex h-8 items-center justify-center gap-2 rounded-md text-xs text-muted-foreground outline-none hover:bg-surface-2/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring lg:justify-start lg:px-3";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  return (
    // A light sidebar on the left: a full column on wide windows, an icon rail on narrow ones.
    <div className="grid min-h-screen grid-cols-[3.5rem_minmax(0,1fr)] lg:grid-cols-[14.5rem_minmax(0,1fr)]">
      <aside className="sticky top-0 flex h-screen flex-col gap-6 overflow-y-auto border-r bg-surface px-2 py-4 lg:px-3 lg:py-5">
        <Link
          href="/today"
          title="Creator Growth Engine"
          className="flex items-center justify-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring lg:justify-start lg:px-2"
        >
          {/* Logo mark: four blocks, like a print stamp. */}
          <span aria-hidden className="grid size-8 shrink-0 grid-cols-2 gap-px rounded-[6px] bg-foreground p-[6px]">
            <span className="rounded-[1px] bg-primary" />
            <span className="rounded-[1px] bg-background/70" />
            <span className="rounded-[1px] bg-background/70" />
            <span className="rounded-[1px] bg-primary" />
          </span>
          <span className="sr-only font-heading text-[18px] leading-tight font-medium lg:not-sr-only">
            Creator Growth
            <span className="eyebrow block font-sans font-normal">Engine</span>
          </span>
        </Link>

        {/* Someone tied to a brand is told which; someone who may see both chooses what the lists show. */}
        {user.brandId ? (
          <BrandBadge name={brandName(user.brandId)} short={brandShortName(user.brandId)} />
        ) : (
          <BrandSwitcher current={user.viewBrand} />
        )}

        <SidebarNav isAdmin={user.role === "admin"} />

        <div className="mt-auto grid gap-2 border-t pt-4">
          <div className="flex items-center justify-center gap-2.5 lg:justify-start lg:px-2" title={`${user.name} (${user.role})`}>
            <span
              aria-hidden
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground font-heading text-[12px] font-medium text-background"
            >
              {initials(user.name)}
            </span>
            <span className="sr-only min-w-0 lg:not-sr-only">
              <span className="block truncate text-sm font-medium">{user.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                <span className="capitalize">{user.role}</span>
                {user.brandId ? `, ${brandShortName(user.brandId)}` : ""}
              </span>
            </span>
          </div>

          <div className="grid gap-0.5">
            <Link href="/account/password" title="Change password" className={FOOT_LINK}>
              <KeyRound aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
              <span className="sr-only lg:not-sr-only">Change password</span>
            </Link>
            <form action={logout}>
              <button type="submit" title="Sign out" className={`${FOOT_LINK} w-full`}>
                <LogOut aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
                <span className="sr-only lg:not-sr-only">Sign out</span>
              </button>
            </form>
          </div>
        </div>
      </aside>

      <main className="min-w-0 px-5 py-8 lg:px-10 lg:py-10">
        <div className="mx-auto max-w-[1120px]">{children}</div>
      </main>
    </div>
  );
}
