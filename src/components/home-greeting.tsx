"use client";

import { useEffect, useState } from "react";
import { timeOfDay, todayWords } from "@/lib/format";

/**
 * The clock behind Home's greeting and date. The server renders the first
 * value; the browser then keeps it current, so a tab opened in the morning
 * reads "Good evening" by evening and shows the new date after midnight.
 * Hours are on the team's clock (IST), not the computer's.
 */
function useNow(at: string): Date {
  const [now, setNow] = useState(() => new Date(at));
  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const timer = window.setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  return now;
}

export function HomeGreeting({ name, at }: { name: string; at: string }) {
  const now = useNow(at);
  return (
    <>
      Good {timeOfDay(now)}, {name}
    </>
  );
}

export function HomeDate({ at }: { at: string }) {
  return <>{todayWords(useNow(at))}</>;
}
