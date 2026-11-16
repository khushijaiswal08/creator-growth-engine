import type { CreatorStatus } from "@prisma/client";
import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import type { SidebarPreference } from "@/components/sidebar-context";
import { brandsIn, viewed } from "@/lib/brand-scope";
import { brandName, brandShortName, DEFAULT_BRAND } from "@/lib/brands";
import { db } from "@/lib/db";
import { DUE_STATUSES, QUEUES, dueWhere } from "@/lib/due";
import { DAY_MS, startOfDayInZone, startOfWeekInZone } from "@/lib/format";
import { giftsToApprove, sharedBrandTargets } from "@/lib/outreach-stats";
import { RACHNA_INTRO_COOKIE, type RachnaCounts } from "@/lib/rachna";
import { requireUser } from "@/lib/session";
import { SIDEBAR_COOKIE } from "@/lib/sidebar";

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

  // The figures the frame shows everywhere: what is due today, queue by queue (the bell), this person's week (the sidebar),
  // and the counts behind Rachna's quests and mood.
  const dueNow = dueWhere(view, DUE_STATUSES, now);
  const todayStart = startOfDayInZone(now);
  const [dueByStatus, weekMessages, targets, approvals] = await Promise.all([
    // Split by warmth too, so the hot count comes from the same rows, and with each group's earliest due date for the longest wait.
    db.campaignCreator.groupBy({ by: ["status", "replyWarmth"], where: dueNow, _count: { _all: true }, _min: { nextActionDueAt: true } }),
    // Today is part of the week, so one list of this week's send times gives both counts.
    db.message.findMany({ where: { userId: user.id, direction: "outbound", sentAt: { gte: startOfWeekInZone(now) } }, select: { sentAt: true } }),
    sharedBrandTargets(brandsIn(view).map((brand) => brand.id)),
    giftsToApprove(view.brandId),
  ]);
  const weekSent = weekMessages.length;
  const todaySent = weekMessages.filter((message) => message.sentAt >= todayStart).length;
  const countOf = (statuses: CreatorStatus[]) => dueByStatus.filter((row) => statuses.includes(row.status)).reduce((sum, row) => sum + row._count._all, 0);
  const hotReplies = dueByStatus.filter((row) => row.replyWarmth === "hot").reduce((sum, row) => sum + row._count._all, 0);
  const oldest = dueByStatus.reduce<Date | null>((earliest, row) => {
    const at = row._min.nextActionDueAt;
    return at && (!earliest || at < earliest) ? at : earliest;
  }, null);
  // Rachna's reply and parcel counts come from the same queues her quests link to, so the bell, the quests and the task list cannot drift apart.
  const queueCount = (key: string) => countOf(QUEUES.find((queue) => queue.key === key)?.statuses ?? []);
  const due = countOf(DUE_STATUSES);
  const target = targets.get(view.brandId ?? DEFAULT_BRAND);
  const weekTarget = target?.weekly ?? 0;
  const rachna: RachnaCounts = {
    due,
    lateMax: oldest ? Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / DAY_MS)) : 0,
    replies: queueCount("replies"),
    parcels: queueCount("delivery"),
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
      stats={{ due, weekSent, weekTarget, rachna, queues: QUEUES.map((queue) => ({ key: queue.key, title: queue.title, count: countOf(queue.statuses) })) }}
      rachnaIntro={rachnaIntro}
    >
      {children}
    </AppShell>
  );
}
