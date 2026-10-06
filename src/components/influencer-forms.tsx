"use client";

import { useActionState } from "react";
import { addInfluencerToCampaign, addProfileToInfluencer, updateInfluencer } from "@/actions/influencers";
import { FormError } from "@/components/form-error";
import { NativeSelect } from "@/components/native-select";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { usePreservedForm } from "@/components/use-preserved-form";
import type { FormState } from "@/lib/form";

function FormMessage({ state }: { state: FormState }) {
  if (!state?.message) return null;
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {state.message}
    </p>
  );
}

export function EditInfluencerForm({
  influencer,
}: {
  influencer: {
    id: string;
    name: string;
    email: string | null;
    location: string | null;
    usSignal: number | null;
    notes: string | null;
  };
}) {
  const { state, onSubmit, pending } = usePreservedForm(updateInfluencer);

  return (
    <form onSubmit={onSubmit} className="grid gap-3 pt-3">
      <input type="hidden" name="influencerId" value={influencer.id} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="inf-name">Name</Label>
          <Input id="inf-name" name="name" required maxLength={120} defaultValue={influencer.name} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="inf-email">Email</Label>
          <Input id="inf-email" name="email" type="email" defaultValue={influencer.email ?? ""} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="inf-location">Location</Label>
          <Input id="inf-location" name="location" defaultValue={influencer.location ?? ""} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="inf-signal">US signal (0-100)</Label>
          <Input
            id="inf-signal"
            name="usSignal"
            type="number"
            min={0}
            max={100}
            step={1}
            defaultValue={influencer.usSignal ?? ""}
          />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="inf-notes">Notes</Label>
        <Textarea id="inf-notes" name="notes" rows={3} defaultValue={influencer.notes ?? ""} />
      </div>
      <FormError state={state} />
      <div className="flex items-center justify-end gap-3">
        <FormMessage state={state} />
        <SubmitButton pending={pending} pendingLabel="Saving...">
          Save details
        </SubmitButton>
      </div>
    </form>
  );
}

export function AddProfileForm({ influencerId }: { influencerId: string }) {
  const [state, action] = useActionState(addProfileToInfluencer, null);

  return (
    <form action={action} className="grid gap-2 pt-3">
      <input type="hidden" name="influencerId" value={influencerId} />
      <Label htmlFor="profile-url">Add another profile of this person</Label>
      <div className="flex gap-2">
        <Input id="profile-url" name="url" required placeholder="https://www.tiktok.com/@handle" />
        <SubmitButton variant="outline" pendingLabel="Adding...">
          Add profile
        </SubmitButton>
      </div>
      <FormError state={state} />
      <FormMessage state={state} />
    </form>
  );
}

export function AddToCampaignForm({
  influencerId,
  campaigns,
}: {
  influencerId: string;
  campaigns: { id: string; name: string }[];
}) {
  const [state, action] = useActionState(addInfluencerToCampaign, null);

  if (campaigns.length === 0) {
    return <p className="pt-3 text-muted-foreground">Already in every campaign.</p>;
  }

  return (
    <form action={action} className="grid gap-2 pt-3">
      <input type="hidden" name="influencerId" value={influencerId} />
      <Label htmlFor="add-campaign">Add to a campaign</Label>
      <div className="flex gap-2">
        <NativeSelect id="add-campaign" name="campaignId" required defaultValue="">
          <option value="" disabled>
            Choose a campaign
          </option>
          {campaigns.map((campaign) => (
            <option key={campaign.id} value={campaign.id}>
              {campaign.name}
            </option>
          ))}
        </NativeSelect>
        <SubmitButton variant="outline" pendingLabel="Adding...">
          Add
        </SubmitButton>
      </div>
      <FormError state={state} />
      <FormMessage state={state} />
    </form>
  );
}
