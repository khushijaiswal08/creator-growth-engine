"use client";

import { useEffect } from "react";

/** Registers the tiny service worker that makes the portal installable (phones: Share to Creator Setu). */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);
  return null;
}
