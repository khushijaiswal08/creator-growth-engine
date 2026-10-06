import { cn } from "cn";
import { sizedImage } from "@/lib/product-image";

/**
 * A product photo, or an empty tile when there is none. Give the box its size
 * through className; `size` is the longest side in CSS pixels, used to ask
 * Amazon's image server for a picture no bigger than needed.
 *
 * A plain <img> on purpose: the picture already arrives at the right size, so
 * Next's image optimiser would only download and re-process it.
 */
export function ProductPhoto({ url, size, className }: { url: string | null; size: number; className?: string }) {
  if (!url) return <span aria-hidden className={cn("block bg-surface-2", className)} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={sizedImage(url, size * 2)}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className={cn("block bg-surface-2 object-cover", className)}
    />
  );
}
