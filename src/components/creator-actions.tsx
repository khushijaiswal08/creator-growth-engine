"use client";

import { useState } from "react";
import { EditInfluencerForm } from "@/components/influencer-forms";
import { LogReplyForm } from "@/components/journey-forms";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** "Log a reply" in the creator's header: the reply form in a dialog. */
export function LogReplyButton({ campaignCreatorId, campaignName }: { campaignCreatorId: string; campaignName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        Log a reply
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Log a reply</DialogTitle>
            <DialogDescription>Paste what the creator wrote in {campaignName}. Rachna reads it and suggests what it means; your choice moves them to the right stage and sets the next step.</DialogDescription>
          </DialogHeader>
          <LogReplyForm campaignCreatorId={campaignCreatorId} />
        </DialogContent>
      </Dialog>
    </>
  );
}

/** "Edit" on the About card: the details form in a dialog. */
export function EditDetailsButton({ influencer }: { influencer: { id: string; name: string; email: string | null; location: string | null; usSignal: number | null; notes: string | null } }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        Edit
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit details</DialogTitle>
            <DialogDescription>Name, email, location, the US signal and notes.</DialogDescription>
          </DialogHeader>
          <EditInfluencerForm influencer={influencer} />
        </DialogContent>
      </Dialog>
    </>
  );
}
