"use client";

import type { CreatorStatus } from "@prisma/client";
import { cn } from "cn";
import { Check, Heart, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, useTransition } from "react";
import { setRachnaTips } from "@/actions/account";
import { useSidebar } from "@/components/sidebar-context";
import { Button } from "@/components/ui/button";
import {
  CONFETTI_MS,
  IDLE_MS,
  INTRO,
  MILESTONES,
  RACHNA_INTRO_COOKIE,
  dayCleared,
  dayKey,
  greetingDue,
  greetingFor,
  moodFor,
  nudgeFor,
  questProgress,
  questsFor,
  storageKey,
  tipsAllowed,
  tourKeyFor,
  type Mood,
  type QuestCounts,
  type RachnaCounts,
  type RachnaPose,
  type Speech,
  type TipKind,
} from "@/lib/rachna";
import tours from "./tours.json";

/*
 * Rachna, the guide ("creativity"). She lives in her own slot at the foot of
 * the sidebar (a strip at the top of the page on a phone), so what she says
 * can never sit on top of a row, a button or a line of text. She speaks in a
 * cloud; the thing she means gets a rose ring on the page. Click her and she
 * points: numbered arrows beside what needs doing now. One bubble at a time,
 * no sound, no outside picture: her art is the one illustration in
 * public/rachna.
 */

type Bubble = Speech & { anchor: string | null; kind: TipKind; title?: string; tour?: { step: number; total: number } };

export type Pointer = { label: string; element: HTMLElement };

type Api = {
  userId: string;
  tipsOn: boolean;
  current: Bubble | null;
  asleep: boolean;
  pointing: boolean;
  pointers: string[];
  /** The live counts behind her quests and her mood, from the app layout. */
  counts: RachnaCounts;
  mood: Mood;
  /** True on the first page after signing in. */
  intro: boolean;
  say(bubble: Bubble): void;
  nudge(creatorId: string, status: CreatorStatus, context?: { arrivalDays?: number }): void;
  milestone(key: string, speech: Speech): void;
  startTour(): void;
  tourNext(direction: 1 | -1): void;
  togglePointing(): void;
  close(): void;
};

const RachnaContext = createContext<Api | null>(null);

export function useRachna(): Api | null {
  return useContext(RachnaContext);
}

const store = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Private window or blocked storage: she may repeat herself, nothing worse.
    }
  },
  session(key: string): Set<string> {
    try {
      return new Set(JSON.parse(window.sessionStorage.getItem(key) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  },
  setSession(key: string, values: Set<string>) {
    try {
      window.sessionStorage.setItem(key, JSON.stringify([...values]));
    } catch {
      // see above
    }
  },
};

const MAX_POINTERS = 3;

/** The things on this page that need doing now: elements marked data-rachna-point, in page order. */
function findPointers(): Pointer[] {
  const out: Pointer[] = [];
  document.querySelectorAll<HTMLElement>("[data-rachna-point]").forEach((element) => {
    const label = element.getAttribute("data-rachna-point");
    if (label && out.length < MAX_POINTERS && element.getBoundingClientRect().height > 0) out.push({ label, element });
  });
  return out;
}

export function RachnaProvider({ userId, tipsOn, counts, intro, children }: { userId: string; tipsOn: boolean; counts: RachnaCounts; intro: boolean; children: React.ReactNode }) {
  const pathname = usePathname();
  const [current, setCurrent] = useState<Bubble | null>(null);
  const queue = useRef<Bubble[]>([]);
  const [asleep, setAsleep] = useState(false);
  const [pointing, setPointing] = useState(false);
  const [pointers, setPointers] = useState<Pointer[]>([]);
  const tourStep = useRef<{ key: keyof typeof tours; step: number } | null>(null);

  const show = useCallback((bubble: Bubble) => {
    setAsleep(false);
    setPointing(false);
    setCurrent((open) => {
      if (open) {
        queue.current.push(bubble);
        return open;
      }
      return bubble;
    });
  }, []);

  const say = useCallback(
    (bubble: Bubble) => {
      if (!tipsAllowed(tipsOn, bubble.kind)) return;
      show(bubble);
    },
    [tipsOn, show],
  );

  const close = useCallback(() => {
    tourStep.current = null;
    setPointing(false);
    setCurrent(queue.current.shift() ?? null);
  }, []);

  const nudge = useCallback(
    (creatorId: string, status: CreatorStatus, context: { arrivalDays?: number } = {}) => {
      const speech = nudgeFor(status, context);
      if (!speech) return;
      const key = storageKey(userId, "nudged");
      const done = store.session(key);
      const mark = `${creatorId}:${status}`;
      if (done.has(mark)) return;
      done.add(mark);
      store.setSession(key, done);
      say({ ...speech, anchor: null, kind: "nudge" });
    },
    [userId, say],
  );

  const milestone = useCallback(
    (key: string, speech: Speech) => {
      const storeKey = storageKey(userId, "milestones");
      const done = new Set((store.get(storeKey) ?? "").split("|").filter(Boolean));
      if (done.has(key)) return;
      done.add(key);
      store.set(storeKey, [...done].join("|"));
      say({ ...speech, anchor: null, kind: "milestone" });
    },
    [userId, say],
  );

  const showTourStep = useCallback((key: keyof typeof tours, step: number) => {
    const steps = tours[key];
    const item = steps[step];
    tourStep.current = { key, step };
    setAsleep(false);
    setPointing(false);
    setCurrent({ pose: "point", text: item.text, title: item.title, anchor: item.anchor, kind: "tour", tour: { step, total: steps.length }, action: undefined });
    document.getElementById(item.anchor)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  const startTour = useCallback(() => {
    const key = tourKeyFor(pathname);
    queue.current = [];
    if (!key) {
      tourStep.current = null;
      setAsleep(false);
      setPointing(false);
      setCurrent({ pose: "think", text: "No tour for this page yet. Home, Creators, a campaign board, Gifts and Reports each have one.", anchor: null, kind: "tour" });
      return;
    }
    showTourStep(key, 0);
  }, [pathname, showTourStep]);

  const tourNext = useCallback(
    (direction: 1 | -1) => {
      const state = tourStep.current;
      if (!state) return;
      const next = state.step + direction;
      if (next < 0 || next >= tours[state.key].length) {
        close();
        return;
      }
      showTourStep(state.key, next);
    },
    [close, showTourStep],
  );

  // Click her: numbered arrows beside what needs doing now on this page. Click again to stop.
  const togglePointing = useCallback(() => {
    setAsleep(false);
    setPointing((on) => {
      if (on) return false;
      tourStep.current = null;
      setCurrent(null);
      const found = findPointers();
      setPointers(found);
      found[0]?.element.scrollIntoView({ block: "center", behavior: "smooth" });
      return true;
    });
  }, []);

  // Ten quiet minutes and she naps; any click or key wakes her. Off with the tips.
  useEffect(() => {
    if (!tipsOn) return;
    let timer: number | undefined;
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setAsleep(true), IDLE_MS);
    };
    const wake = () => {
      setAsleep(false);
      arm();
    };
    let last = 0;
    const onMove = () => {
      const now = Date.now();
      if (now - last > 30_000) {
        last = now;
        wake();
      }
    };
    arm();
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);
    window.addEventListener("mousemove", onMove);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
      window.removeEventListener("mousemove", onMove);
    };
  }, [tipsOn]);

  // Esc closes whatever she is saying or pointing at.
  useEffect(() => {
    if (!current && !pointing) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [current, pointing, close]);

  // The ring on the page: only ever an outline around the thing she means.
  useEffect(() => {
    const element = current?.anchor ? document.getElementById(current.anchor) : null;
    element?.classList.add("rachna-spot");
    return () => element?.classList.remove("rachna-spot");
  }, [current]);

  // A page change ends a tour or a pointing session mid-way. Not the first
  // render: the Home greeting is queued by a child before this effect runs.
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    tourStep.current = null;
    setPointing(false);
    setCurrent(null);
  }, [pathname]);

  // The first page after signing in: she says hello. The cookie goes, so a reload stays quiet.
  useEffect(() => {
    if (!intro) return;
    document.cookie = `${RACHNA_INTRO_COOKIE}=; path=/; max-age=0`;
    say({ ...INTRO, anchor: null, kind: "intro" });
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <RachnaContext.Provider value={{ userId, tipsOn, current, asleep, pointing, pointers: pointers.map((pointer) => pointer.label), counts, mood: moodFor(counts), intro, say, nudge, milestone, startTour, tourNext, togglePointing, close }}>
      {children}
      {pointing ? <PointerLayer pointers={pointers} /> : null}
    </RachnaContext.Provider>
  );
}

/** Numbered rose arrows beside the things that need doing, in the page gutter, never on the text. */
function PointerLayer({ pointers }: { pointers: Pointer[] }) {
  const [spots, setSpots] = useState<{ x: number; y: number; inside: boolean }[]>([]);
  useEffect(() => {
    pointers.forEach(({ element }) => element.classList.add("rachna-mark"));
    function place() {
      setSpots(
        pointers.map(({ element }) => {
          const rect = element.getBoundingClientRect();
          // No gutter (phones): the badge sits in the top-right corner of the row, where nothing is written.
          const inside = rect.left < 44;
          return inside ? { x: rect.right - 36, y: rect.top + 8, inside } : { x: rect.left - 38, y: rect.top + rect.height / 2 - 14, inside };
        }),
      );
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, { passive: true });
    return () => {
      pointers.forEach(({ element }) => element.classList.remove("rachna-mark"));
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place);
    };
  }, [pointers]);
  return (
    <>
      {spots.map((spot, index) => (
        <span key={index} aria-hidden className="rachna-arrow fixed z-40" style={{ left: spot.x, top: spot.y }}>
          {index + 1}
        </span>
      ))}
    </>
  );
}

const CONFETTI = ["#e8647f", "#6f9a5a", "#f29bb4", "#b98a63", "#e3b23c", "#b24a6b"];

/** Confetti over her whole slot: twenty pieces in fixed spots, so the burst looks the same every time. */
function Burst() {
  return (
    <span aria-hidden className="rachna-burst pointer-events-none absolute inset-0 overflow-hidden rounded-2xl">
      {Array.from({ length: 20 }, (_, index) => (
        <span key={index} style={{ left: `${2 + index * 5}%`, background: CONFETTI[index % CONFETTI.length], animationDelay: `${(index * 53) % 420}ms` }} />
      ))}
    </span>
  );
}

const BADGE = "absolute -top-1 -right-1 flex items-center justify-center rounded-full border font-bold shadow-sm";

/** Her portrait: head and shoulders of the illustration in a circle with a glowing rose ring. */
export function RachnaPortrait({ pose, size = 80, lively, className }: { pose: RachnaPose; size?: number; lively?: boolean; className?: string }) {
  const small = size < 60;
  return (
    <span aria-hidden className={cn("relative block shrink-0", lively && "rachna-float", className)} style={{ width: size, height: size }}>
      <span
        className={cn("rachna-ring block h-full w-full rounded-full bg-surface bg-no-repeat transition-transform", pose === "point" && "-scale-x-100", pose === "sleep" && "-rotate-6 opacity-80 saturate-[.7]", pose === "cheer" && "motion-safe:animate-bounce")}
        style={{ backgroundImage: "url(/rachna/rachna.webp)", backgroundSize: "150% auto", backgroundPosition: "50% 0" }}
      />
      {pose === "think" ? <span className={cn(BADGE, small ? "size-4 text-[10px]" : "size-6 text-[13px]", "bg-surface text-foreground")}>?</span> : null}
      {pose === "worried" ? <span className={cn(BADGE, small ? "size-4 text-[10px]" : "size-6 text-[13px]", "border-[#f3d9a4] bg-warning-soft text-warning-text")}>!</span> : null}
      {pose === "happy" ? (
        <span className={cn(BADGE, small ? "size-4" : "size-6", "bg-surface")}>
          <Heart className={cn("fill-[#e8647f] text-[#e8647f]", small ? "size-2.5" : "size-3.5")} />
        </span>
      ) : null}
      {pose === "sleep" ? <span className="absolute -top-1 right-0 text-[13px] leading-none font-bold text-foreground">z z</span> : null}
    </span>
  );
}

/** The cloud she speaks in. The tail points up towards her portrait, or left when she is beside the words. */
export function Cloud({ tail = "up", onTap, children }: { tail?: "up" | "left"; onTap?: () => void; children: React.ReactNode }) {
  return (
    <div
      className={cn("rachna-cloud", tail === "up" ? "mt-4" : "ml-4", onTap && "cursor-pointer")}
      onClick={(event) => {
        // The buttons inside keep their own jobs; a tap on the words does the main one.
        if (onTap && !(event.target as HTMLElement).closest("button, a")) onTap();
      }}
    >
      <span className="puff" style={{ width: 34, height: 34, top: -12, left: 22 }} />
      <span className="puff" style={{ width: 26, height: 26, top: -9, right: 26 }} />
      <span className="puff" style={{ width: 28, height: 28, bottom: -9, right: 18 }} />
      <span className="puff" style={{ width: 22, height: 22, bottom: -7, left: 36 }} />
      {tail === "up" ? (
        <>
          <span className="puff" style={{ width: 11, height: 11, top: -19, left: 10 }} />
          <span className="puff" style={{ width: 7, height: 7, top: -29, left: 2 }} />
        </>
      ) : (
        <>
          <span className="puff" style={{ width: 11, height: 11, top: "45%", left: -13 }} />
          <span className="puff" style={{ width: 7, height: 7, top: "30%", left: -22 }} />
        </>
      )}
      <div className="body">{children}</div>
    </div>
  );
}

/**
 * A tap on the cloud does what its main button does: next tour step, her
 * suggested link, "show me" for a greeting, or just closes. While she is
 * pointing, a tap puts the arrows away.
 */
function useCloudTap(bubble: Bubble | null, pointing: boolean): () => void {
  const rachna = useRachna();
  const router = useRouter();
  return () => {
    if (!rachna) return;
    if (pointing) return rachna.togglePointing();
    if (!bubble) return;
    if (bubble.tour) return rachna.tourNext(1);
    if (bubble.action) {
      rachna.close();
      router.push(bubble.action.href);
      return;
    }
    if (bubble.anchor) return document.getElementById(bubble.anchor)?.scrollIntoView({ block: "center", behavior: "smooth" });
    rachna.close();
  };
}

/** What she is saying right now: the words and the buttons, used by the sidebar slot and the phone strip alike. */
function Words({ bubble, compact, onClose }: { bubble: Bubble; compact?: boolean; onClose: () => void }) {
  const rachna = useRachna();
  const router = useRouter();
  const pathname = usePathname();
  const showMe = bubble.anchor ? () => document.getElementById(bubble.anchor!)?.scrollIntoView({ block: "center", behavior: "smooth" }) : null;
  return (
    <>
      {bubble.title ? <p className="label mb-0.5">{bubble.title}</p> : null}
      <p className={cn("text-sm", compact && "text-[13px]")}>{bubble.text}</p>
      {bubble.tour ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">
            {bubble.tour.step + 1} of {bubble.tour.total}
          </span>
          <span className="flex-1" />
          {bubble.tour.step > 0 ? (
            <Button size="xs" variant="ghost" onClick={() => rachna?.tourNext(-1)}>
              Back
            </Button>
          ) : (
            <Button size="xs" variant="ghost" onClick={onClose}>
              Skip
            </Button>
          )}
          <Button size="xs" variant="action" onClick={() => rachna?.tourNext(1)}>
            {bubble.tour.step + 1 === bubble.tour.total ? "Done" : "Next"}
          </Button>
        </div>
      ) : bubble.action ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button asChild size="xs" variant="action">
            <Link href={bubble.action.href} onClick={onClose}>
              {bubble.action.label}
            </Link>
          </Button>
          <Button size="xs" variant="ghost" onClick={onClose}>
            Not now
          </Button>
        </div>
      ) : bubble.kind === "intro" ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button
            size="xs"
            variant="action"
            onClick={() => {
              onClose();
              if (pathname === "/today") rachna?.togglePointing();
              else router.push("/today");
            }}
          >
            Today&apos;s list
          </Button>
          <Button size="xs" variant="ghost" onClick={() => rachna?.startTour()}>
            Show me around
          </Button>
        </div>
      ) : bubble.kind === "greeting" ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {showMe ? (
            <Button size="xs" variant="action" onClick={showMe}>
              Show me
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              onClose();
              router.refresh();
            }}
          >
            Got it
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** Her list of what needs doing now, numbered to match the arrows on the page. */
function PointingWords({ labels, onTour }: { labels: string[]; onTour?: () => void }) {
  const tour = onTour ? (
    <button type="button" onClick={onTour} className="link mt-2 block text-xs">
      Show me around this page
    </button>
  ) : null;
  if (labels.length === 0)
    return (
      <>
        <p className="text-sm">Nothing on this page needs you right now. Home has the day&apos;s list.</p>
        {tour}
      </>
    );
  return (
    <>
      <p className="text-sm font-semibold">What needs doing now:</p>
      <ol className="mt-1.5 grid gap-1">
        {labels.map((label, index) => (
          <li key={label} className="flex items-start gap-2 text-sm">
            <span className="rachna-arrow static shrink-0">{index + 1}</span>
            <span>{label}</span>
          </li>
        ))}
      </ol>
      {tour}
    </>
  );
}

/** The tooltip on her: a word about her mood, then what a click does. */
function title(mood: Mood): string {
  if (mood === "worried") return "Something is three or more days late. Click me for what needs doing now";
  if (mood === "happy") return "All clear. Click me and I'll check again";
  return "Show me what needs doing now";
}

/** A small ring: the share of today's items done. */
function Ring({ share }: { share: number }) {
  const r = 15;
  const length = 2 * Math.PI * r;
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden className="shrink-0">
      <circle cx="20" cy="20" r={r} fill="none" stroke="#f3cdd9" strokeWidth="4" />
      <circle cx="20" cy="20" r={r} fill="none" stroke="var(--primary)" strokeWidth="4" strokeLinecap="round" strokeDasharray={length} strokeDashoffset={length * (1 - share)} className="rachna-quest-ring origin-center" />
      <text x="20" y="23.5" textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--primary)">
        {Math.round(share * 100)}%
      </text>
    </svg>
  );
}

/**
 * Today's quests under her name: the day's queues measured against where they
 * stood at the first visit, and messages against the daily target. Every quest
 * done earns one cheer with confetti, once a day.
 */
function Quests() {
  const rachna = useRachna();
  const [start, setStart] = useState<QuestCounts | null>(null);
  const day = dayKey();
  const userId = rachna?.userId;
  const counts = rachna?.counts;
  useEffect(() => {
    if (!userId || !counts) return;
    const key = storageKey(userId, `quests:${day}`);
    const stored = store.get(key);
    if (stored) {
      try {
        setStart(JSON.parse(stored) as QuestCounts);
        return;
      } catch {
        // Unreadable: today's counts become the start.
      }
    }
    const snapshot: QuestCounts = { replies: counts.replies, parcels: counts.parcels, approvals: counts.approvals, todaySent: counts.todaySent, dailyTarget: counts.dailyTarget, hot: counts.hot };
    store.set(key, JSON.stringify(snapshot));
    setStart(snapshot);
    // The snapshot is taken once per day, not on every count change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, day]);
  const quests = start && counts ? questsFor(counts, start) : [];
  const cleared = dayCleared(quests);
  const milestone = rachna?.milestone;
  useEffect(() => {
    if (cleared && milestone) milestone(`day:${day}`, MILESTONES.dayCleared());
  }, [cleared, day, milestone]);
  if (quests.length === 0) return null;
  const done = quests.filter((quest) => quest.done >= quest.total).length;
  return (
    <div className="mt-3 rounded-xl bg-surface/80 p-2.5">
      <Link href="/today#tasks-card" title="Open today's list" className="flex items-center gap-2.5 rounded-lg outline-none hover:bg-primary-soft/60 focus-visible:ring-2 focus-visible:ring-ring">
        <Ring share={questProgress(quests)} />
        <span className="min-w-0">
          <span className="block text-[12px] font-bold">{cleared ? "Day cleared!" : "Today's quests"}</span>
          <span className="block text-[11px] text-muted-foreground">
            {done} of {quests.length} done
          </span>
        </span>
      </Link>
      <ul className="mt-2 grid gap-1">
        {quests.map((quest) => {
          const finished = quest.done >= quest.total;
          return (
            <li key={quest.key}>
              <Link href={quest.href} className="flex items-center gap-2 rounded-md px-1 py-0.5 text-[12px] hover:bg-primary-soft/60">
                <span aria-hidden className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border", finished ? "border-primary bg-primary text-on-primary" : "border-border-strong bg-surface")}>
                  {finished ? <Check className="size-3" strokeWidth={3} /> : null}
                </span>
                <span className={cn("min-w-0 flex-1 truncate", finished && "text-muted-foreground line-through")}>{quest.label}</span>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {quest.done}/{quest.total}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Her slot at the foot of the sidebar. She is always there: idle with a hint,
 * talking in a cloud, pointing, or napping. Icon rail: the portrait with a dot
 * when she has something to say; the words then show in a small card.
 */
export function RachnaSlot() {
  const rachna = useRachna();
  const ui = useSidebar();
  const [railOpen, setRailOpen] = useState(false);
  const bubble = rachna?.current ?? null;
  const [cheering, setCheering] = useState(false);
  useEffect(() => {
    if (bubble?.pose !== "cheer") return;
    setCheering(true);
    const timer = window.setTimeout(() => setCheering(false), CONFETTI_MS);
    return () => window.clearTimeout(timer);
  }, [bubble]);
  // In the icon rail her words open in a small card the moment she has some; Close hides it.
  const pointingNow = rachna?.pointing ?? false;
  useEffect(() => setRailOpen(Boolean(bubble) || pointingNow), [bubble, pointingNow]);
  const tap = useCloudTap(bubble, pointingNow);
  if (!rachna) return null;
  const quiet = !bubble && !rachna.pointing;
  if (!rachna.tipsOn && quiet) return null;

  const pose: RachnaPose = rachna.asleep && quiet ? "sleep" : rachna.pointing ? "point" : !bubble ? rachna.mood : bubble.pose === "cheer" && !cheering ? rachna.mood : bubble.pose;
  const busy = Boolean(bubble) || rachna.pointing;

  return (
    <>
      {/* The full column */}
      <div className={cn("rachna-home relative mb-3", ui.wideOnly)} data-rachna role="status" aria-live="polite">
        <div className="flex items-center gap-2">
          <button type="button" onClick={rachna.togglePointing} aria-pressed={rachna.pointing} title={title(rachna.mood)} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <RachnaPortrait pose={pose} size={72} lively={busy} />
            <span className="flex min-w-0 flex-1 items-center gap-1 text-[15px] leading-tight font-bold text-primary-text">
              Rachna
              <Sparkles className="size-3.5 text-[#e3b23c]" strokeWidth={2} />
            </span>
          </button>
          {busy ? (
            <button type="button" aria-label="Close" onClick={rachna.close} className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface hover:text-foreground">
              <X className="size-4" />
            </button>
          ) : null}
        </div>
        {bubble ? (
          <Cloud tail="up" onTap={tap}>
            <Words bubble={bubble} onClose={rachna.close} />
          </Cloud>
        ) : rachna.pointing ? (
          <Cloud tail="up" onTap={tap}>
            <PointingWords labels={rachna.pointers} />
          </Cloud>
        ) : (
          <Quests />
        )}
        {cheering ? <Burst /> : null}
      </div>
      {/* The icon rail */}
      <button type="button" onClick={() => (busy ? setRailOpen((value) => !value) : rachna.togglePointing())} aria-label={busy ? "Rachna has something to say" : "Rachna: show me what needs doing now"} className={cn("relative mb-3 flex w-full justify-center rounded-md py-1 outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring", ui.railOnly)}>
        <RachnaPortrait pose={pose} size={40} />
        {busy ? <span aria-hidden className="absolute top-1 right-2 size-2.5 rounded-full border-2 border-surface bg-primary" /> : null}
      </button>
      {railOpen && busy ? (
        <div className={ui.railOnly}>
          <Strip bubble={bubble} pointing={rachna.pointing} labels={rachna.pointers} pose={pose} onClose={rachna.close} />
        </div>
      ) : null}
    </>
  );
}

/** The phone strip at the top of the page (also the small card when the rail portrait is tapped). */
function Strip({ bubble, pointing, labels, pose, onClose, onTour, inline }: { bubble: Bubble | null; pointing: boolean; labels: string[]; pose: RachnaPose; onClose: () => void; onTour?: () => void; inline?: boolean }) {
  const rachna = useRachna();
  const tap = useCloudTap(bubble, pointing);
  return (
    <div
      className={cn(
        "rachna-in rachna-home relative flex items-start gap-2",
        // On a phone she is part of the page, at the top, so she can never sit on the text. With the sidebar
        // collapsed she is a small card beside the rail, bottom-left, where her portrait is.
        inline ? "mb-4 md:hidden" : "fixed bottom-4 left-[4.5rem] z-40 w-[360px] max-w-[calc(100vw-5.5rem)] shadow-lg",
      )}
      data-rachna
      role="status"
      aria-live="polite"
    >
      <button type="button" onClick={rachna?.togglePointing} aria-pressed={pointing} title="Show me what needs doing now" className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <RachnaPortrait pose={pose} size={52} lively />
      </button>
      <div className="min-w-0 flex-1">
        <Cloud tail="left" onTap={tap}>
          {bubble ? <Words bubble={bubble} compact onClose={onClose} /> : pointing ? <PointingWords labels={labels} onTour={onTour} /> : null}
        </Cloud>
      </div>
      <button type="button" aria-label="Close" onClick={onClose} className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface hover:text-foreground">
        <X className="size-4" />
      </button>
      {pose === "cheer" ? <Burst /> : null}
    </div>
  );
}

/** On a phone there is no sidebar: her words sit in a strip at the top of the page, in the flow, never over anything. */
export function RachnaStrip() {
  const rachna = useRachna();
  const bubble = rachna?.current ?? null;
  if (!rachna || (!bubble && !rachna.pointing)) return null;
  return <Strip bubble={bubble} pointing={rachna.pointing} labels={rachna.pointers} pose={rachna.pointing ? "point" : (bubble?.pose ?? "idle")} onClose={rachna.close} onTour={rachna.startTour} inline />;
}

/**
 * Home: the first visit of the day gets her note built from the real counts,
 * and the weekly target earns a cheer once per week.
 */
export function RachnaGreeting({ name, replies, parcels, total, weekSent, weekTarget, weekKey }: { name: string; replies: number; parcels: number; total: number; weekSent: number; weekTarget: number; weekKey: string }) {
  const rachna = useRachna();
  useEffect(() => {
    if (!rachna || !rachna.tipsOn) return;
    const key = storageKey(rachna.userId, "greeted");
    const today = dayKey();
    // After the sign-in hello the day's greeting would be one note too many: the quests card has the counts.
    if (rachna.intro) store.set(key, today);
    else if (greetingDue(store.get(key), today)) {
      store.set(key, today);
      const speech = greetingFor(name, { replies, parcels, total });
      rachna.say({ ...speech, anchor: total > 0 ? "task-first" : null, kind: "greeting" });
    }
    if (weekTarget > 0 && weekSent >= weekTarget) rachna.milestone(`week:${weekKey}`, MILESTONES.weeklyTarget(weekTarget));
    // Once per page load is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

/**
 * Her cameo in the top bar, in place of a "?" button. On a wide screen it
 * starts the three-step tour of the page; on a phone, where her sidebar slot
 * does not exist, it opens what needs doing now (the strip offers the tour).
 */
export function RachnaCameo() {
  const rachna = useRachna();
  if (!rachna) return null;
  const wide = () => typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches;
  return (
    <button
      type="button"
      onClick={() => (wide() ? rachna.startTour() : rachna.togglePointing())}
      title="Rachna: show me around this page"
      aria-label="Rachna: show me around this page"
      className="group relative flex size-10 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <RachnaPortrait pose={rachna.mood} size={34} className="transition-transform group-hover:scale-110" />
      <span aria-hidden className="absolute -right-0.5 -bottom-0.5 flex size-4 items-center justify-center rounded-full border-2 border-surface bg-primary text-on-primary">
        <Sparkles className="size-2.5" strokeWidth={2.5} />
      </span>
    </button>
  );
}

/** Settings: the per-person switch, beside her portrait. */
export function RachnaTipsToggle({ on }: { on: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [checked, setChecked] = useState(on);
  return (
    <div className="flex flex-wrap items-center gap-5">
      <RachnaPortrait pose="idle" size={96} />
      <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          disabled={pending}
          onClick={() => {
            const next = !checked;
            setChecked(next);
            startTransition(async () => {
              await setRachnaTips(next);
              router.refresh();
            });
          }}
          className={cn("relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors", checked ? "bg-primary" : "bg-border-strong")}
        >
          <span className={cn("absolute top-0.5 size-5 rounded-full bg-surface shadow transition-all", checked ? "left-[22px]" : "left-0.5")} />
        </button>
        <span>
          <span className="block font-semibold">Show Rachna tips</span>
          <span className="block text-xs text-muted-foreground">Her morning note, nudges after a status change and milestones. Off leaves only the &quot;?&quot; tour and her pointers. Saved for you alone.</span>
        </span>
      </label>
    </div>
  );
}
