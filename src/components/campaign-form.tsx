"use client";

import Link from "next/link";
import { createCampaign } from "@/actions/campaigns";
import { FormError } from "@/components/form-error";
import { NativeSelect } from "@/components/native-select";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { usePreservedForm } from "@/components/use-preserved-form";
import { CAMPAIGN_STATUS_LABELS, CAMPAIGN_STATUSES } from "@/lib/status";

export function CampaignForm({ brands, defaultBrand }: { brands: { id: string; name: string }[]; defaultBrand: string }) {
  const { state, onSubmit, pending } = usePreservedForm(createCampaign);

  return (
    <form onSubmit={onSubmit} className="grid gap-4 p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required maxLength={120} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="brandId">Brand</Label>
          <NativeSelect id="brandId" name="brandId" defaultValue={defaultBrand}>
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="brief">Brief</Label>
        <Textarea id="brief" name="brief" required rows={5} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="nicheKeywords">Niche keywords</Label>
          <Input id="nicheKeywords" name="nicheKeywords" placeholder="home decor, tablescape, slow living" />
          <p className="text-xs text-muted-foreground">Separate with commas.</p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="negativeKeywords">Negative keywords</Label>
          <Input id="negativeKeywords" name="negativeKeywords" placeholder="dropshipping, giveaway only" />
          <p className="text-xs text-muted-foreground">Creators matching these are a poor fit.</p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="targetPosts">Target posts</Label>
          <Input id="targetPosts" name="targetPosts" type="number" min={0} step={1} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="deadline">Deadline</Label>
          <Input id="deadline" name="deadline" type="date" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="status">Status</Label>
          <NativeSelect id="status" name="status" defaultValue="draft">
            {CAMPAIGN_STATUSES.map((status) => (
              <option key={status} value={status}>
                {CAMPAIGN_STATUS_LABELS[status]}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>

      <FormError state={state} />

      <div className="flex justify-end gap-2">
        <Button asChild variant="outline">
          <Link href="/campaigns">Cancel</Link>
        </Button>
        <SubmitButton variant="action" pending={pending} pendingLabel="Creating...">
          Create campaign
        </SubmitButton>
      </div>
    </form>
  );
}
