"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { enterGiftByHand, productsForGift, type GiftProductOption } from "@/actions/gift-entry";
import { FormError } from "@/components/form-error";
import { NativeSelect } from "@/components/native-select";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { usePreservedForm } from "@/components/use-preserved-form";

/**
 * "Enter gift by hand" on the creator's Gift card: for a creator who sent their
 * product and address in a DM or email instead of using their link. The gift goes
 * through the same rules as one chosen on the link.
 */
export function EnterGiftButton({ campaignCreatorId, campaignName }: { campaignCreatorId: string; campaignName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Enter gift by hand
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Enter gift by hand</DialogTitle>
            <DialogDescription>
              For a creator who sent their choice and address by message instead of using their link ({campaignName}). The same gift rules apply, and the address is stored encrypted.
            </DialogDescription>
          </DialogHeader>
          {open ? <EnterGiftForm campaignCreatorId={campaignCreatorId} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function EnterGiftForm({ campaignCreatorId }: { campaignCreatorId: string }) {
  const { state, onSubmit, pending } = usePreservedForm(enterGiftByHand);
  const [products, setProducts] = useState<GiftProductOption[] | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [type, setType] = useState("");
  const [productId, setProductId] = useState("");

  useEffect(() => {
    let live = true;
    productsForGift(campaignCreatorId)
      .then((result) => {
        if (!live) return;
        if (result.ok) setProducts(result.products);
        else setBlocked(result.error);
      })
      .catch(() => {
        if (live) setBlocked("The products could not be loaded. Close this and try again in a moment.");
      });
    return () => {
      live = false;
    };
  }, [campaignCreatorId]);

  const types = useMemo(() => [...new Set((products ?? []).map((product) => product.type))], [products]);
  const ofType = useMemo(() => (products ?? []).filter((product) => product.type === type), [products, type]);

  if (state?.message) {
    return (
      <div className="grid gap-3">
        <p role="status" className="rounded-md bg-success-soft px-4 py-3 text-success-text">
          {state.message}
        </p>
        <Link className="link" href="/orders">
          Open Gifts
        </Link>
      </div>
    );
  }
  if (blocked) {
    return (
      <p role="alert" className="text-destructive">
        {blocked}
      </p>
    );
  }
  if (products === null) return <p className="text-muted-foreground">Loading this campaign&apos;s products...</p>;

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <input type="hidden" name="campaignCreatorId" value={campaignCreatorId} />
      <input type="hidden" name="productId" value={productId} />

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="ge-type">Product type</Label>
          <NativeSelect
            id="ge-type"
            required
            value={type}
            onChange={(event) => {
              setType(event.target.value);
              setProductId("");
            }}
          >
            <option value="">Choose</option>
            {types.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ge-product">Product</Label>
          <NativeSelect id="ge-product" required disabled={!type} value={productId} onChange={(event) => setProductId(event.target.value)}>
            <option value="">{type ? "Choose" : "Choose a type first"}</option>
            {ofType.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="ge-shipName">Full name</Label>
        <Input id="ge-shipName" name="shipName" required maxLength={100} autoComplete="off" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="ge-address1">Address</Label>
        <Input id="ge-address1" name="address1" required maxLength={150} autoComplete="off" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="ge-address2">Apartment, suite (optional)</Label>
        <Input id="ge-address2" name="address2" maxLength={150} autoComplete="off" />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="ge-city">City</Label>
          <Input id="ge-city" name="city" required maxLength={80} autoComplete="off" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ge-state">State</Label>
          <Input id="ge-state" name="state" required maxLength={60} autoComplete="off" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ge-postalCode">ZIP code</Label>
          <Input id="ge-postalCode" name="postalCode" required maxLength={20} autoComplete="off" />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="ge-country">Country</Label>
          <Input id="ge-country" name="country" required maxLength={60} defaultValue="United States" autoComplete="off" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ge-phone">Phone (optional)</Label>
          <Input id="ge-phone" name="phone" type="tel" maxLength={30} autoComplete="off" />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="ge-note">Note from the creator (optional)</Label>
        <Textarea id="ge-note" name="note" rows={2} maxLength={500} />
      </div>

      <label className="flex items-start gap-2">
        <input type="checkbox" name="confirm" value="yes" required className="mt-1" />
        <span>The creator sent these details themselves, for this gift.</span>
      </label>

      <FormError state={state} />
      <SubmitButton variant="action" pending={pending} pendingLabel="Saving..." disabled={!productId}>
        Save gift
      </SubmitButton>
    </form>
  );
}
