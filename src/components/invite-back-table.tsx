"use client";

import { cn } from "cn";
import { UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { inviteBackToCampaign } from "@/actions/invite-back";
import { Avatar } from "@/components/avatar";
import { CreatorName } from "@/components/creator-card";
import { ProfileLinks } from "@/components/profile-links";
import { Pill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { GRADES } from "@/lib/creator-card";
import { formatCount, formatShortDay } from "@/lib/format";
import type { InviteBackRow } from "@/lib/invite-back";

/**
 * The Invite back list: tick proven creators, press Invite, and they join
 * the chosen campaign as Approved with a welcome-back message waiting.
 */
export function InviteBackTable({ rows, campaign }: { rows: InviteBackRow[]; campaign: { id: string; name: string } | null }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ text: string; refused: boolean } | null>(null);
  const open = rows.filter((row) => row.invitable);
  const chosen = open.filter((row) => selected.has(row.id));

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function invite() {
    if (!campaign || chosen.length === 0) return;
    startTransition(async () => {
      try {
        const result = await inviteBackToCampaign(
          campaign.id,
          chosen.map((row) => row.id),
        );
        if (!result.ok) {
          setNotice({ text: result.error, refused: true });
          return;
        }
        const invited = result.invited > 0 ? `${result.invited} invited to ${result.campaign} as Approved. Their welcome-back message is waiting on Home; nothing has been sent.` : "Nobody was invited.";
        const skipped = result.skipped.map((entry) => `${entry.name}: ${entry.reason}.`).join(" ");
        setNotice({ text: skipped ? `${invited} Skipped: ${skipped}` : invited, refused: result.invited === 0 });
        setSelected(new Set());
        router.refresh();
      } catch {
        setNotice({ text: "The invite did not go through. Try again in a minute.", refused: true });
      }
    });
  }

  return (
    <section className="card overflow-hidden">
      <div className={cn("flex min-h-14 flex-wrap items-center gap-2 border-b px-5 py-2.5", chosen.length > 0 ? "bg-primary-faint" : "bg-surface")}>
        {chosen.length > 0 ? (
          <>
            <span className="mr-1 text-sm font-bold">{chosen.length} selected</span>
            <Button size="sm" variant="action" disabled={pending || !campaign} onClick={invite}>
              <UserPlus className="size-4" />
              {pending ? "Inviting..." : campaign ? `Invite ${chosen.length} to ${campaign.name}` : "Choose a campaign first"}
            </Button>
            <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </>
        ) : (
          <span className="text-sm font-bold">
            {rows.length} proven {rows.length === 1 ? "creator" : "creators"} · {open.length} can be invited
          </span>
        )}
        {notice ? (
          <span role={notice.refused ? "alert" : "status"} className={cn("text-xs", notice.refused ? "font-semibold text-danger-text" : "text-success-text")}>
            {notice.text}
          </span>
        ) : null}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#f8f9fb] text-[11.5px] font-bold tracking-[0.06em] whitespace-nowrap text-muted-foreground uppercase">
              <th className="w-9 py-3 pr-1 pl-5 text-left">
                <input
                  type="checkbox"
                  aria-label="Select everyone who can be invited"
                  checked={open.length > 0 && chosen.length === open.length}
                  onChange={(event) => setSelected(event.target.checked ? new Set(open.map((row) => row.id)) : new Set())}
                />
              </th>
              <th className="px-3 py-3 text-left">Creator</th>
              <th className="px-3 py-3 text-left">Rachna says</th>
              <th className="px-3 py-3 text-right max-md:hidden">Followers</th>
              <th className="px-3 py-3 text-right">Content</th>
              <th className="px-3 py-3 text-right max-md:hidden">Content rate</th>
              <th className="px-3 py-3 text-left max-lg:hidden">Last worked with</th>
              <th className="px-3 py-3 pr-5 text-left">Invite</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center font-medium text-muted-foreground">
                  Nobody yet. Creators appear here once they have delivered content for us.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const can = row.invitable;
                return (
                  <tr key={row.id} className={cn("border-t border-[#f1f3f6]", selected.has(row.id) && can && "bg-primary-faint", !can && "text-muted-foreground")}>
                    <td className="py-3.5 pr-1 pl-5">
                      <input type="checkbox" aria-label={`Select ${row.name}`} disabled={!can} checked={can && selected.has(row.id)} onChange={() => toggle(row.id)} />
                    </td>
                    <td className="px-3 py-3.5">
                      <div className="flex items-center gap-3">
                        <Avatar name={row.name} className="size-9 text-xs max-md:hidden" />
                        <div className="min-w-0">
                          <CreatorName id={row.id} name={row.name} className="font-bold text-foreground hover:text-primary-text" />
                          <ProfileLinks profiles={row.profiles} inline />
                          {row.linkOrders > 0 || row.linkSales > 0 ? (
                            <div className="text-xs font-semibold text-primary-text">
                              Our links: {row.linkOrders} {row.linkOrders === 1 ? "order" : "orders"} · ${Math.round(row.linkSales).toLocaleString("en-US")}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3.5">
                      <Pill tone={GRADES[row.grade].tone}>{GRADES[row.grade].label}</Pill>
                    </td>
                    <td className="px-3 py-3.5 text-right tabular-nums max-md:hidden">{row.followers ? formatCount(row.followers) : ""}</td>
                    <td className="px-3 py-3.5 text-right tabular-nums">{row.content}</td>
                    <td className="px-3 py-3.5 text-right tabular-nums max-md:hidden">{row.rate === null ? "" : `${row.rate}%`}</td>
                    <td className="px-3 py-3.5 whitespace-nowrap max-lg:hidden">
                      <div>{row.lastCollaboration ? formatShortDay(row.lastCollaboration) : ""}</div>
                      <div className="text-xs text-muted-foreground">{row.gifts} {row.gifts === 1 ? "gift" : "gifts"}</div>
                    </td>
                    <td className="px-3 py-3.5 pr-5 text-xs">
                      {row.blocked ? (
                        <span className="font-semibold text-danger-text">{row.blocked}</span>
                      ) : row.inCampaign ? (
                        <>
                          <Pill tone="info">In this campaign</Pill>
                          <div className="mt-1">{row.inCampaign}</div>
                        </>
                      ) : row.busyIn ? (
                        <span>Working with us now in {row.busyIn}</span>
                      ) : row.giftAgainFrom ? (
                        <span title="A gift before this date waits for a person's approval, as the gift rules say.">Ready · gift needs approval until {formatShortDay(row.giftAgainFrom)}</span>
                      ) : (
                        <span className="font-semibold text-success-text">Ready</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
