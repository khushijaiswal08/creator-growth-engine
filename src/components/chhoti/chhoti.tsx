"use client";

import type { CreatorStatus } from "@prisma/client";
import { cn } from "cn";
import { X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { setChhotiTips } from "@/actions/account";
import { Button } from "@/components/ui/button";
import { CONFETTI_MS, IDLE_MS, MILESTONES, dayKey, greetingDue, greetingFor, nudgeFor, placeBubble, storageKey, tipsAllowed, tourKeyFor, type ChhotiPose, type Rect, type Speech, type TipKind } from "@/lib/chhoti";
import tours from "./tours.json";

/*
 * Chhoti, the guide. One bubble at a time, beside the thing she is talking
 * about or in the bottom-right corner. She never covers a button or a field,
 * never blocks input, makes no sound and loads no outside picture: her art is
 * the one illustration in public/chhoti, with small overlays for each pose.
 */

type Bubble = Speech & { anchor: string | null; kind: TipKind; title?: string; tour?: { step: number; total: number } };

type Api = {
  userId: string;
  tipsOn: boolean;
  say(bubble: Bubble): void;
  nudge(creatorId: string, status: CreatorStatus, context?: { arrivalDays?: number }): void;
  milestone(key: string, speech: Speech): void;
  startTour(): void;
  close(): void;
};

const ChhotiContext = createContext<Api | null>(null);

export function useChhoti(): Api | null {
  return useContext(ChhotiContext);
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

export function ChhotiProvider({ userId, tipsOn, children }: { userId: string; tipsOn: boolean; children: React.ReactNode }) {
  const pathname = usePathname();
  const [current, setCurrent] = useState<Bubble | null>(null);
  const queue = useRef<Bubble[]>([]);
  const [asleep, setAsleep] = useState(false);
  const tourStep = useRef<{ key: keyof typeof tours; step: number } | null>(null);

  const show = useCallback((bubble: Bubble) => {
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

  const showTourStep = useCallback(
    (key: keyof typeof tours, step: number) => {
      const steps = tours[key];
      const item = steps[step];
      tourStep.current = { key, step };
      setCurrent({ pose: "point", text: item.text, title: item.title, anchor: item.anchor, kind: "tour", tour: { step, total: steps.length }, action: undefined });
    },
    [],
  );

  const startTour = useCallback(() => {
    const key = tourKeyFor(pathname);
    queue.current = [];
    if (!key) {
      tourStep.current = null;
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

  // Ten quiet minutes and she naps in the corner; any click or key wakes her. Off with the tips.
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

  // Esc closes whatever she is saying.
  useEffect(() => {
    if (!current) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [current, close]);

  // A page change ends a tour mid-way.
  useEffect(() => {
    if (tourStep.current) {
      tourStep.current = null;
      setCurrent(null);
    }
  }, [pathname]);

  return (
    <ChhotiContext.Provider value={{ userId, tipsOn, say, nudge, milestone, startTour, close }}>
      {children}
      {current ? <BubbleLayer bubble={current} onClose={close} onTour={tourNext} /> : asleep && tipsOn ? <SleepingFigure /> : null}
    </ChhotiContext.Provider>
  );
}

const CONFETTI = ["#e8647f", "#6f9a5a", "#f29bb4", "#b98a63", "#e3b23c", "#b24a6b"];

/** Her illustration with the pose's small overlay. Decorative: the words are in the bubble. */
export function ChhotiFigure({ pose, height = 120, className }: { pose: ChhotiPose; height?: number; className?: string }) {
  const width = Math.round(height * (2 / 3));
  return (
    <span aria-hidden className={cn("relative block shrink-0 overflow-visible", className)} style={{ width, height, pointerEvents: "none" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/chhoti/chhoti.webp"
        alt=""
        width={width}
        height={height}
        className={cn("block rounded-lg bg-surface object-contain transition-transform", pose === "point" && "-scale-x-100", pose === "sleep" && "-rotate-6 opacity-80", pose === "cheer" && "motion-safe:animate-bounce")}
        style={{ width, height }}
      />
      {pose === "cheer" ? (
        <span className="chhoti-confetti absolute inset-0">
          {CONFETTI.map((color, index) => (
            <span key={color} style={{ left: `${8 + index * 15}%`, top: `${index % 2 === 0 ? 6 : 18}%`, background: color, animationDelay: `${index * 60}ms` }} />
          ))}
        </span>
      ) : null}
      {pose === "think" ? <span className="absolute -top-2 -right-2 flex size-7 items-center justify-center rounded-full border bg-surface text-[15px] font-bold text-foreground shadow-sm">?</span> : null}
      {pose === "sleep" ? <span className="absolute -top-1 right-0 text-[14px] leading-none font-bold text-foreground">z z</span> : null}
    </span>
  );
}

/** Blocked rectangles: every button and field on screen, plus anything marked data-no-overlay, except her own. */
function blockedRects(exclude: HTMLElement | null): Rect[] {
  const out: Rect[] = [];
  document.querySelectorAll<HTMLElement>("button, input, select, textarea, [data-no-overlay]").forEach((element) => {
    if (exclude && exclude.contains(element)) return;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;
    out.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height });
  });
  return out;
}

function BubbleLayer({ bubble, onClose, onTour }: { bubble: Bubble; onClose: () => void; onTour: (direction: 1 | -1) => void }) {
  const router = useRouter();
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [cheering, setCheering] = useState(bubble.pose === "cheer");

  // Confetti for one second, then she is quiet.
  useEffect(() => {
    if (bubble.pose !== "cheer") return;
    setCheering(true);
    const timer = window.setTimeout(() => setCheering(false), CONFETTI_MS);
    return () => window.clearTimeout(timer);
  }, [bubble]);

  // Measure, then place; again on resize and scroll. The anchor keeps a ring while she points at it.
  useLayoutEffect(() => {
    const anchorElement = bubble.anchor ? document.getElementById(bubble.anchor) : null;
    if (anchorElement && bubble.kind === "tour") {
      anchorElement.scrollIntoView({ block: "center", behavior: "auto" });
      anchorElement.classList.add("chhoti-spot");
    }

    function place() {
      const element = box.current;
      if (!element) return;
      const size = { w: element.offsetWidth, h: element.offsetHeight };
      const rect = anchorElement?.getBoundingClientRect();
      const anchor = rect ? { x: rect.left, y: rect.top, w: rect.width, h: rect.height } : null;
      const viewport = { w: window.innerWidth, h: window.innerHeight };
      const next = placeBubble({ anchor, size, viewport, blocked: blockedRects(element) });
      setPos({ x: next.x, y: next.y });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, { passive: true });
    return () => {
      anchorElement?.classList.remove("chhoti-spot");
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place);
    };
  }, [bubble]);

  const pose: ChhotiPose = bubble.pose === "cheer" && !cheering ? "idle" : bubble.pose;

  return (
    <div
      ref={box}
      role="status"
      aria-live="polite"
      className="fixed z-40 flex max-w-[calc(100vw-24px)] items-end gap-3 max-md:bottom-[4.5rem]"
      style={pos ? { left: pos.x, top: pos.y, visibility: "visible" } : { left: -9999, top: 0, visibility: "hidden" }}
      data-chhoti
    >
      <ChhotiFigure pose={pose} height={120} />
      <div className="card relative max-w-[320px] px-4 py-3 pr-10 text-sm shadow-lg">
        <span aria-hidden className="absolute -left-[7px] bottom-6 size-3 rotate-45 border-b border-l bg-surface" />
        <button type="button" aria-label="Close" onClick={onClose} className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground">
          <X className="size-4" />
        </button>
        {bubble.title ? <p className="label mb-1">{bubble.title}</p> : null}
        <p>{bubble.text}</p>
        {bubble.tour ? (
          <div className="mt-3 flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {bubble.tour.step + 1} of {bubble.tour.total}
            </span>
            <span className="flex-1" />
            {bubble.tour.step > 0 ? (
              <Button size="sm" variant="ghost" onClick={() => onTour(-1)}>
                Back
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={onClose}>
                Skip
              </Button>
            )}
            <Button size="sm" variant="action" onClick={() => onTour(1)}>
              {bubble.tour.step + 1 === bubble.tour.total ? "Done" : "Next"}
            </Button>
          </div>
        ) : bubble.action ? (
          <div className="mt-3 flex items-center gap-2">
            <Button asChild size="sm" variant="action">
              <Link href={bubble.action.href} onClick={onClose}>
                {bubble.action.label}
              </Link>
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Not now
            </Button>
          </div>
        ) : bubble.kind === "greeting" ? (
          <div className="mt-3">
            <Button
              size="sm"
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
      </div>
    </div>
  );
}

/** After ten quiet minutes: asleep in the corner, no bubble, never in the way. */
function SleepingFigure() {
  return (
    <div aria-hidden className="pointer-events-none fixed right-4 bottom-4 z-30 max-md:bottom-[4.5rem]">
      <ChhotiFigure pose="sleep" height={96} />
    </div>
  );
}

/**
 * Home: the first visit of the day gets her note built from the real counts,
 * and the weekly target earns a cheer once per week.
 */
export function ChhotiGreeting({ name, replies, parcels, total, weekSent, weekTarget, weekKey }: { name: string; replies: number; parcels: number; total: number; weekSent: number; weekTarget: number; weekKey: string }) {
  const chhoti = useChhoti();
  useEffect(() => {
    if (!chhoti || !chhoti.tipsOn) return;
    const key = storageKey(chhoti.userId, "greeted");
    const today = dayKey();
    if (greetingDue(store.get(key), today)) {
      store.set(key, today);
      const speech = greetingFor(name, { replies, parcels, total });
      chhoti.say({ ...speech, anchor: total > 0 ? "task-first" : null, kind: "greeting" });
    }
    if (weekTarget > 0 && weekSent >= weekTarget) chhoti.milestone(`week:${weekKey}`, MILESTONES.weeklyTarget(weekTarget));
    // Once per page load is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

/** The round "?" in the top bar: a three-step tour of the current page. Works even when tips are off. */
export function ChhotiTourButton() {
  const chhoti = useChhoti();
  if (!chhoti) return null;
  return (
    <button
      type="button"
      onClick={chhoti.startTour}
      title="Show me around this page"
      aria-label="Show me around this page"
      className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface text-[15px] font-bold text-accent-text outline-none hover:bg-primary-soft hover:text-primary-text focus-visible:ring-2 focus-visible:ring-ring"
    >
      ?
    </button>
  );
}

/** Settings: the per-person switch. */
export function ChhotiTipsToggle({ on }: { on: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [checked, setChecked] = useState(on);
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={pending}
        onClick={() => {
          const next = !checked;
          setChecked(next);
          startTransition(async () => {
            await setChhotiTips(next);
            router.refresh();
          });
        }}
        className={cn("relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors", checked ? "bg-primary" : "bg-border-strong")}
      >
        <span className={cn("absolute top-0.5 size-5 rounded-full bg-surface shadow transition-all", checked ? "left-[22px]" : "left-0.5")} />
      </button>
      <span>
        <span className="block font-semibold">Show Chhoti tips</span>
        <span className="block text-xs text-muted-foreground">Her morning note, nudges after a status change and milestones. Off leaves only the &quot;?&quot; tour. Saved for you alone.</span>
      </span>
    </label>
  );
}
