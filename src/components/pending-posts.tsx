"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { attributePostAction, dismissPostAction } from "@/actions/discovery";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type PendingPostCard = { runId: string; permalink: string; caption: string; timestamp: string | null };

/** "https://www.instagram.com/p/ABC123/" -> the embed address Instagram serves without an API. */
function embedUrl(permalink: string): string | null {
  const match = /instagram\.com\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/.exec(permalink);
  return match ? `https://www.instagram.com/${match[1] === "reels" ? "reel" : match[1]}/${match[2]}/embed/captioned/` : null;
}

/**
 * Instagram posts found by hashtag whose author Meta would not name. The
 * reviewer looks at the post, types the handle, and the account is added as
 * Discovered (after the usual dedupe and do-not-contact checks) with stats
 * from Business Discovery when Meta is configured.
 */
export function PendingPosts({ posts }: { posts: PendingPostCard[] }) {
  const router = useRouter();
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const visible = posts.filter((post) => !gone.has(post.permalink));
  if (visible.length === 0) return null;

  function name(post: PendingPostCard, form: HTMLFormElement) {
    const handle = (new FormData(form).get("handle") as string | null)?.trim() ?? "";
    if (!handle) return;
    startTransition(async () => {
      const result = await attributePostAction(post.runId, post.permalink, handle);
      if (!result.ok) {
        setNotes((all) => ({ ...all, [post.permalink]: result.error }));
        return;
      }
      const text =
        result.outcome === "added"
          ? `Added @${handle.replace(/^@/, "")} as Discovered${result.statsFound === false ? " (not a professional account, so no stats)" : result.statsFound === null ? " (Meta not configured, so no stats)" : ""}.`
          : result.outcome === "known"
            ? `@${handle.replace(/^@/, "")} is already in the portal.`
            : `@${handle.replace(/^@/, "")} is on the do-not-contact list and was not added.`;
      setNotes((all) => ({ ...all, [post.permalink]: text }));
      setTimeout(() => setGone((all) => new Set(all).add(post.permalink)), 2500);
      router.refresh();
    });
  }

  function dismiss(post: PendingPostCard) {
    startTransition(async () => {
      await dismissPostAction(post.runId, post.permalink);
      setGone((all) => new Set(all).add(post.permalink));
    });
  }

  return (
    <Panel plain title="Posts that need a handle" aside={<span className="text-xs text-muted-foreground">{visible.length}</span>} className="mb-8">
      <p className="pt-3 text-muted-foreground">
        Instagram found these posts by hashtag but would not say who posted them. Open the post, read the handle from it, and type it
        here. The account is then checked against the portal and the do-not-contact list before it is added.
      </p>
      <ol className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {visible.map((post) => {
          const embed = embedUrl(post.permalink);
          return (
            <li key={post.permalink} className="card grid gap-3 p-3">
              {embed ? (
                <iframe src={embed} title="Instagram post" className="h-[420px] w-full rounded-md border-0" loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups" />
              ) : null}
              <p className="line-clamp-3 text-xs text-muted-foreground">{post.caption || "No caption."}</p>
              <a href={post.permalink} target="_blank" rel="noopener noreferrer" className="link text-xs">
                Open on Instagram
              </a>
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  name(post, event.currentTarget);
                }}
              >
                <Input name="handle" placeholder="@handle from the post" required disabled={pending} className="h-9" />
                <Button type="submit" size="sm" disabled={pending}>
                  Add
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => dismiss(post)}>
                  Skip
                </Button>
              </form>
              {notes[post.permalink] ? <p className="text-xs text-muted-foreground">{notes[post.permalink]}</p> : null}
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
