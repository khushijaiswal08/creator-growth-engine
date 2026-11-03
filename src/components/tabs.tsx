"use client";

import { useEffect, useState } from "react";

type TabSpec = { key: string; label: string; count?: number };

/**
 * Underlined tabs over a set of panels that are all rendered on the server
 * and shown one at a time. The open tab is kept in the address hash, so a
 * link can point straight at "#messages" and reloading keeps the place.
 */
export function Tabs({ tabs, panels }: { tabs: TabSpec[]; panels: Record<string, React.ReactNode> }) {
  const [active, setActive] = useState(tabs[0]?.key ?? "");

  useEffect(() => {
    function onHash() {
      const key = window.location.hash.replace(/^#/, "");
      if (key && tabs.some((tab) => tab.key === key)) setActive(key);
    }
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [tabs]);

  function choose(key: string) {
    setActive(key);
    window.history.replaceState(null, "", `#${key}`);
  }

  return (
    <div>
      <div role="tablist" aria-label="Sections" className="tabs mb-5 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            id={`tab-${tab.key}`}
            aria-selected={active === tab.key}
            aria-current={active === tab.key ? "true" : undefined}
            aria-controls={`panel-${tab.key}`}
            onClick={() => choose(tab.key)}
            className="tab"
          >
            {tab.label}
            {tab.count !== undefined ? <span className="chip border-transparent bg-surface-2 px-1.5 py-0 text-[11px]">{tab.count}</span> : null}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div key={tab.key} role="tabpanel" id={`panel-${tab.key}`} aria-labelledby={`tab-${tab.key}`} hidden={active !== tab.key}>
          {panels[tab.key]}
        </div>
      ))}
    </div>
  );
}
