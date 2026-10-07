"use client";

import { createContext, useContext } from "react";

/**
 * Whether the sidebar is a full column or an icon rail. `null` means
 * automatic: full on wide windows, a rail on narrow ones. A person's own
 * choice (the toggle at the top of the sidebar) wins at every width.
 */
export type SidebarPreference = "expanded" | "collapsed" | null;

export type SidebarUi = {
  preference: SidebarPreference;
  /** Classes that hide a label in the rail and show it in the full column. */
  label: string;
  /** Classes that centre an item in the rail and left-align it in the full column. */
  align: string;
  /** Shown only in the full column (a block element). */
  wideOnly: string;
  /** Shown only in the rail. */
  railOnly: string;
};

export function sidebarUi(preference: SidebarPreference): SidebarUi {
  if (preference === "collapsed") {
    return { preference, label: "sr-only", align: "justify-center", wideOnly: "hidden", railOnly: "" };
  }
  if (preference === "expanded") {
    return { preference, label: "", align: "justify-start px-3", wideOnly: "", railOnly: "hidden" };
  }
  return {
    preference,
    label: "sr-only lg:not-sr-only",
    align: "justify-center lg:justify-start lg:px-3",
    wideOnly: "hidden lg:block",
    railOnly: "lg:hidden",
  };
}

export const SidebarContext = createContext<SidebarUi>(sidebarUi(null));

export function useSidebar(): SidebarUi {
  return useContext(SidebarContext);
}
