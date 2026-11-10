"use client";

import { useState, useTransition } from "react";
import { checkMarketplaceFieldsAction } from "@/actions/discovery";
import { Button } from "@/components/ui/button";
import type { FieldCheck } from "@/lib/fetching/adapters/creator-marketplace";

/** Admin › Connected services: asks Meta once which fields a marketplace creator has, and lists their names (never values). */
export function MarketplaceFieldsButton({ configured }: { configured: boolean }) {
  const [result, setResult] = useState<FieldCheck | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="grid gap-2">
      <div>
        <Button type="button" variant="outline" size="sm" disabled={pending || !configured} onClick={() => startTransition(async () => setResult(await checkMarketplaceFieldsAction()))}>
          {pending ? "Asking Meta..." : "Check available fields"}
        </Button>
      </div>
      {!configured ? <p className="text-xs text-muted-foreground">Needs META_ACCESS_TOKEN (a Page access token) and IG_BUSINESS_ID on the server first.</p> : null}
      {result && !result.ok ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {result.error}
        </p>
      ) : null}
      {result?.ok ? (
        <div role="status" className="grid gap-1 rounded-md border px-3 py-2 text-sm">
          <p className="font-medium">Meta lists {result.fields.length} fields for a creator (names only):</p>
          <p className="font-mono text-xs break-words">{result.fields.join(", ")}</p>
          <p className="text-xs text-muted-foreground">Put the ones to request (at least the username) in MARKETPLACE_FIELDS in src/lib/fetching/adapters/creator-marketplace.ts, or in the META_MARKETPLACE_FIELDS setting, then redeploy.</p>
        </div>
      ) : null}
    </div>
  );
}
