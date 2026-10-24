import type { CreatorStatus } from "@prisma/client";
import { cookies } from "next/headers";
import { logout } from "@/actions/auth";
import { AppShell } from "@/components/app-shell";
import type { SidebarPreference } from "@/components/sidebar-context";
import { viewed } from "@/lib/brand-scope";
import { BRANDS, brandName, brandShortName } from "@/lib/brands";
import { db } from "@/lib/db";
import { DUE_STATUSES, dueWhere } from "@/lib/due";
import { startOfDayInZone, startOfWeekInZone } from "@/lib/format";
import { brandTargets } from "@/lib/outreach-stats";
import { RACHNA_INTRO_COOKIE, type RachnaCounts } from "@/lib/rachna";
import { requireUser } from "@/lib/session";
import { SIDEBAR_COOKIE } from "@/lib/sidebar";

const DAY = 24 * 60 * 60 * 1000;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const view = viewed(user);
  const now = new Date();
  // The person's own choice for the sidebar, so every page loads the way they left it.
  const jar = await cookies();
  const stored = jar.get(SIDEBAR_COOKIE)?.value;
  const initialPreference: SidebarPreference = stored === "collapsed" || stored === "expanded" ? stored : null;
  // The sign-in action leaves this; Rachna's provider reads it once and clears it.
  const rachnaIntro = jar.get(RACHNA_INTRO_COOKIE)?.value === "1";

  // The figures the frame shows everywhere: what is due today (the bell), this person's week (the sidebar),
  // and the counts behind Rachna's quests and mood.
  const dueNow = dueWhere(view, DUE_STATUSES, now);
  const [dueByStatus, weekSent, todaySent, targets, approvals, oldest, hotReplies] = await Promise.all([
    db.campaignCreator.groupBy({ by: ["status"], where: dueNow, _count: { _all: true } }),
    db.message.count({ where: { userId: user.id, direction: "outbound", sentAt: { gte: startOfWeekInZone(now) } } }),
    db.message.count({ where: { userId: user.id, direction: "outbound", sentAt: { gte: startOfDayInZone(now) } } }),
    brandTargets(BRANDS.filter((brand) => view.includes(brand.id)).map((brand) => brand.id)),
    db.giftOrder.count({ where: { ...view.gifts, status: "needs_approval" } }),
    db.campaignCreator.findFirst({ where: dueNow, orderBy: { nextActionDueAt: "asc" }, select: { nextActionDueAt: true } }),
    db.campaignCreator.count({ where: { ...dueNow, replyWarmth: "hot" } }),
  ]);
  const countOf = (statuses: CreatorStatus[]) => dueByStatus.filter((row) => statuses.includes(row.status)).reduce((sum, row) => sum + row._count._all, 0);
  const due = countOf(DUE_STATUSES);
  const target = targets.get(view.brandId ?? BRANDS[0].id);
  const weekTarget = target?.weekly ?? 0;
  const rachna: RachnaCounts = {
    due,
    lateMax: oldest?.nextActionDueAt ? Math.max(0, Math.floor((now.getTime() - oldest.nextActionDueAt.getTime()) / DAY)) : 0,
    replies: countOf(["replied", "negotiating"]),
    parcels: countOf(["product_shipped"]),
    approvals,
    todaySent,
    dailyTarget: target?.daily ?? 0,
    hot: hotReplies,
  };

  return (
    <AppShell
      user={{
        id: user.id,
        name: user.name,
        email: user.email,
        rachnaTips: user.showRachnaTips,
        role: user.role,
        avatarUrl: user.avatarUrl,
        brandName: user.brandId ? brandName(user.brandId) : null,
        brandShort: user.brandId ? brandShortName(user.brandId) : null,
        viewBrand: user.viewBrand,
      }}
      isAdmin={user.role === "admin"}
      initialPreference={initialPreference}
      stats={{ due, weekSent, weekTarget, rachna }}
      rachnaIntro={rachnaIntro}
      logout={logout}
    >
      {children}
    </AppShell>
  );
}
