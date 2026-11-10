"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * What a person sees when a page fails to load, instead of the browser's own
 * error. The error text is never shown (it can name tables or files); the short
 * reference Next.js gives it is, so the person can quote it and the cause can be
 * found in the server log.
 */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6">
      <div className="grid w-full max-w-md gap-4 rounded-3xl border bg-surface p-8 text-center shadow-[var(--shadow-card)]">
        <h1 className="text-2xl font-extrabold tracking-[-0.02em]">That page did not load</h1>
        <p className="text-[15px] font-medium text-muted-foreground">
          Something went wrong on our side. It is often a short hiccup, so try again in a moment. If it keeps happening, tell your portal admin and quote the reference below.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
          <Button type="button" variant="action" onClick={reset}>
            Try again
          </Button>
          <Button asChild variant="outline">
            <Link href="/today">Go to Home</Link>
          </Button>
        </div>
        {error.digest ? <p className="text-xs font-semibold text-muted-foreground">Reference: {error.digest}</p> : null}
      </div>
    </main>
  );
}
