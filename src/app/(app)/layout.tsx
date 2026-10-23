import { cookies } from "next/headers";
import { logout } from "@/actions/auth";
import { AppShell } from "@/components/app-shell";
import type { SidebarPreference } from "@/components/sidebar-context";
import { viewed } from "@/lib/brand-scope";
import { BRANDS, brandName, brandShortName } from "@/lib/brands";
import { db } from "@/lib/db";
import { DUE_STATUSES, dueWhere } from "@/lib/due";
import { startOfWeekInZone } from "@/lib/format";
import { brandTargets } from "@/lib/outreach-stats";
import { requireUser } from "@/lib/session";
import { SIDEBAR_COOKIE } from "@/lib/sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const view = viewed(user);
  const now = new Date();
  // The person's own choice for the sidebar, so every page loads the way they left it.
  const stored = (await cookies()).get(SIDEBAR_COOKIE)?.value;
  const initialPreference: SidebarPreference = stored === "collapsed" || stored === "expanded" ? stored : null;

  // The two figures the frame shows everywhere: what is due today (the bell) and this person's week (the sidebar).
  const [due, weekSent, targets] = await Promise.all([
    db.campaignCreator.count({ where: dueWhere(view, DUE_STATUSES, now) }),
    db.message.count({ where: { userId: user.id, direction: "outbound", sentAt: { gte: startOfWeekInZone(now) } } }),
    brandTargets(BRANDS.filter((brand) => view.includes(brand.id)).map((brand) => brand.id)),
  ]);
  const weekTarget = targets.get(view.brandId ?? BRANDS[0].id)?.weekly ?? 0;

  return (
    <AppShell
      user={{
        id: user.id,
        name: user.name,
        email: user.email,
        chhotiTips: user.showChhotiTips,
        role: user.role,
        avatarUrl: user.avatarUrl,
        brandName: user.brandId ? brandName(user.brandId) : null,
        brandShort: user.brandId ? brandShortName(user.brandId) : null,
        viewBrand: user.viewBrand,
      }}
      isAdmin={user.role === "admin"}
      initialPreference={initialPreference}
      stats={{ due, weekSent, weekTarget }}
      logout={logout}
    >
      {children}
    </AppShell>
  );
}
