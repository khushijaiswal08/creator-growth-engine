import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * The portal's own "not found" page, in the portal's colours and theme. Next.js's built-in one follows the
 * device's dark setting on its own, so on a dark-mode computer it showed dark text on a black page.
 */
export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6">
      <div className="grid w-full max-w-md gap-4 rounded-3xl border bg-surface p-8 text-center shadow-[var(--shadow-card)]">
        <h1 className="text-2xl font-extrabold tracking-[-0.02em]">Page not found</h1>
        <p className="text-[15px] font-medium text-muted-foreground">
          This page does not exist, or you do not have access to it. Check the link, or go back to Home.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
          <Button asChild variant="action">
            <Link href="/today">Go to Home</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
