import { cn } from "cn";

/**
 * The Creator Setu mark: a white S (for Setu, "bridge") standing on a bridge arch cut into a rose tile.
 * The same drawing is src/app/icon.svg (browser tab) and public/icons/icon-*.png (phone home screen).
 * The rose stays the same in both themes: white on #b24a6b clears 4.5:1, and the tile reads on dark pages too.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden className={cn("size-9 shrink-0", className)}>
      <path d="M14 0H50A14 14 0 0 1 64 14V50A14 14 0 0 1 50 64H48A20 20 0 0 0 16 64H14A14 14 0 0 1 0 50V14A14 14 0 0 1 14 0Z" fill="#b24a6b" />
      <path d="M47 13H26A7.5 7.5 0 0 0 26 28H38A7.5 7.5 0 0 1 38 43H17" fill="none" stroke="#ffffff" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
