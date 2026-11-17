/**
 * What a list page shows while its data loads: the shape of a page (a title, a row of
 * figure tiles, a list card) in the theme's own colours, so a click answers at once instead of freezing. The
 * left menu and the top bar stay where they are; only this part is replaced when the page is ready. It
 * pulses gently, and not at all for someone who asked for reduced motion.
 *
 * Used only by pages that never look up a single record (Home, Gifts, Content, Reports). A loading screen sends
 * the page in pieces, and once sending has started a "not found" can no longer answer 404 but only 200: a
 * creator or campaign page must keep answering 404 for another brand's record (tests/brand-isolation.test.ts),
 * so those pages have no loading.tsx above them.
 */
export function PageSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="grid gap-6 motion-safe:animate-pulse">
      <div className="grid gap-2">
        <div className="h-8 w-56 rounded-lg bg-surface-2" />
        <div className="h-4 w-80 max-w-full rounded-md bg-surface-2" />
      </div>
      <div className="grid grid-cols-2 gap-3 md:gap-4 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="card grid gap-3 p-5">
            <div className="h-3 w-24 rounded bg-surface-2" />
            <div className="h-8 w-16 rounded-lg bg-surface-2" />
            <div className="h-3 w-32 rounded bg-surface-2" />
          </div>
        ))}
      </div>
      <div className="card grid gap-4 p-5">
        <div className="h-5 w-40 rounded-md bg-surface-2" />
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="flex items-center gap-3">
            <div className="size-10 shrink-0 rounded-full bg-surface-2" />
            <div className="grid flex-1 gap-2">
              <div className="h-4 w-2/5 rounded bg-surface-2" />
              <div className="h-3 w-3/5 rounded bg-surface-2" />
            </div>
            <div className="h-8 w-20 rounded-lg bg-surface-2" />
          </div>
        ))}
      </div>
    </div>
  );
}
