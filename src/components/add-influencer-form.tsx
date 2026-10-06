"use client";

import Link from "next/link";
import { addInfluencerByUrl } from "@/actions/influencers";
import { FormError } from "@/components/form-error";
import { NativeSelect } from "@/components/native-select";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePreservedForm } from "@/components/use-preserved-form";

export function AddInfluencerForm({
  campaigns,
  defaultCampaignId,
  campaignRequired,
  defaultUrl = "",
}: {
  campaigns: { id: string; name: string }[];
  defaultCampaignId: string;
  campaignRequired: boolean;
  /** Filled in when the page was opened from a profile (the bookmark, or the check box above). */
  defaultUrl?: string;
}) {
  const { state, onSubmit, pending } = usePreservedForm(addInfluencerByUrl);

  return (
    <form onSubmit={onSubmit} className="grid gap-4 p-4">
      <div className="grid gap-1.5">
        <Label htmlFor="url">Profile URL</Label>
        <Input
          id="url"
          name="url"
          required
          autoFocus={!defaultUrl}
          defaultValue={defaultUrl}
          inputMode="url"
          placeholder="https://www.instagram.com/handle/"
        />
        <p className="text-xs text-muted-foreground">
          Instagram, TikTok or YouTube. The platform and handle are read from the URL. If the profile is
          already in the system you are taken to the existing influencer.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="name">Name (optional)</Label>
          <Input id="name" name="name" maxLength={120} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="email">Email (optional)</Label>
          <Input id="email" name="email" type="email" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="location">Location (optional)</Label>
          <Input id="location" name="location" placeholder="City, ST" />
        </div>
      </div>

      <div className="grid gap-1.5 sm:max-w-sm">
        <Label htmlFor="campaignId">{campaignRequired ? "Add to campaign" : "Add to campaign (optional)"}</Label>
        <NativeSelect id="campaignId" name="campaignId" defaultValue={defaultCampaignId} required={campaignRequired}>
          <option value="">{campaignRequired ? "Choose a campaign" : "No campaign"}</option>
          {campaigns.map((campaign) => (
            <option key={campaign.id} value={campaign.id}>
              {campaign.name}
            </option>
          ))}
        </NativeSelect>
        {campaignRequired && campaigns.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            There is no campaign yet.{" "}
            <Link href="/campaigns/new" className="link">
              Create one first
            </Link>
            .
          </p>
        ) : null}
      </div>

      <FormError state={state} />

      <div className="flex justify-end gap-2">
        <Button asChild variant="outline">
          <Link href="/influencers">Cancel</Link>
        </Button>
        <SubmitButton variant="action" pending={pending} pendingLabel="Adding...">
          Add creator
        </SubmitButton>
      </div>
    </form>
  );
}
