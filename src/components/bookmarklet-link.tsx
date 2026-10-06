"use client";

import { useEffect, useRef } from "react";

/**
 * A link whose address is a small script: dragged to the bookmarks bar, it
 * sends the Instagram, TikTok or YouTube page you are on to the portal's
 * check-and-add screen. React refuses to render a script address itself, so
 * it is set after the link is on the page.
 */
export function BookmarkletLink({ portalUrl, label }: { portalUrl: string; label: string }) {
  const ref = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    const code = `(function(){location.href=${JSON.stringify(`${portalUrl}/influencers/new?url=`)}+encodeURIComponent(location.href)})()`;
    ref.current?.setAttribute("href", `javascript:${code}`);
  }, [portalUrl]);

  return (
    <a
      ref={ref}
      href="#"
      draggable
      onClick={(event) => event.preventDefault()}
      title="Drag me to your bookmarks bar"
      className="inline-flex h-9 cursor-grab items-center rounded-md bg-primary px-4 text-sm font-medium text-on-primary shadow-card active:cursor-grabbing"
    >
      {label}
    </a>
  );
}
