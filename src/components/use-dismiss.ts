"use client";

import { type RefObject, useEffect, useRef } from "react";

/** A pop-over closes on a click outside its box and, unless escape is false, on Escape. Returns the ref for the box. */
export function useDismiss(open: boolean, setOpen: (open: boolean) => void, escape = true): RefObject<HTMLDivElement | null> {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    if (escape) document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      if (escape) document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen, escape]);

  return box;
}
