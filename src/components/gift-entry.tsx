"use client";

import { Gift } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  enterGiftByHand,
  giftNewCreator,
  productsForCampaign,
  productsForGift,
  type GiftProductOption,
} from "@/actions/gift-entry";
import { FormError } from "@/components/form-error";
import { NativeSelect } from "@/components/native-select";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { usePreservedForm } from "@/components/use-preserved-form";
import { US_STATES } from "@/lib/us-states";

type ProductList =
  { ok: true; products: GiftProductOption[] } | { ok: false; error: string };

/** Loads a product list whenever `load` changes; null `key` means nothing to load yet. */
function useProducts(
  key: string | null,
  load: (key: string) => Promise<ProductList>,
) {
  const [state, setState] = useState<{
    key: string;
    products: GiftProductOption[] | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    load(key)
      .then((result) => {
        if (live)
          setState({
            key,
            products: result.ok ? result.products : null,
            error: result.ok ? null : result.error,
          });
      })
      .catch(() => {
        if (live)
          setState({
            key,
            products: null,
            error:
              "The products could not be loaded. Close this and try again in a moment.",
          });
      });
    return () => {
      live = false;
    };
  }, [key, load]);
  // A result for an earlier key (another campaign) counts as still loading.
  return state && state.key === key ? state : null;
}

/** Every product with this ASIN (an ASIN is 10 characters), or none. */
function withAsin(
  products: GiftProductOption[],
  raw: string,
): GiftProductOption[] {
  const code = raw.trim().toUpperCase();
  return code.length >= 10
    ? products.filter((product) => product.asin?.toUpperCase() === code)
    : [];
}

/**
 * Paste an ASIN to pick the product at once, or choose the product type, then the exact
 * product: the campaign's real product names. Only products this campaign offers can be found.
 */
function ProductPickers({
  products,
  productId,
  onProduct,
}: {
  products: GiftProductOption[];
  productId: string;
  onProduct: (id: string) => void;
}) {
  const [type, setType] = useState("");
  const [asin, setAsin] = useState("");
  const types = useMemo(
    () => [...new Set(products.map((product) => product.type))],
    [products],
  );
  const ofType = useMemo(
    () => products.filter((product) => product.type === type),
    [products, type],
  );
  const matches = withAsin(products, asin);
  const chosen = products.find((product) => product.id === productId) ?? null;

  const lookup = (value: string) => {
    setAsin(value);
    const found = withAsin(products, value);
    if (found.length > 0) {
      setType(found[0].type);
      onProduct(found.length === 1 ? found[0].id : "");
    }
  };

  return (
    <div className="grid gap-3">
      <input type="hidden" name="productId" value={productId} />
      <div className="grid gap-1.5">
        <Label htmlFor="ge-asin">ASIN (paste it to pick the product)</Label>
        <Input
          id="ge-asin"
          value={asin}
          onChange={(event) => lookup(event.target.value)}
          maxLength={20}
          placeholder="B0XXXXXXXX"
          autoComplete="off"
        />
        {asin.trim().length >= 10 && matches.length === 0 ? (
          <p className="text-sm text-destructive">
            No product with this ASIN is offered in this campaign. Check the
            ASIN, or choose the product below.
          </p>
        ) : matches.length > 1 ? (
          <p className="text-sm text-muted-foreground">
            {matches.length} products share this ASIN. Choose the exact one
            below.
          </p>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="ge-type">Product type</Label>
          <NativeSelect
            id="ge-type"
            required
            value={type}
            onChange={(event) => {
              setType(event.target.value);
              onProduct("");
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
          <NativeSelect
            id="ge-product"
            required
            disabled={!type}
            value={productId}
            onChange={(event) => onProduct(event.target.value)}
          >
            <option value="">{type ? "Choose" : "Choose a type first"}</option>
            {(matches.length > 1 ? matches : ofType).map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      {chosen ? (
        <p className="rounded-md bg-primary-soft px-3 py-2 text-sm">
          Chosen: <strong>{chosen.label}</strong>
          {chosen.asin ? ` · ASIN ${chosen.asin}` : ""}
        </p>
      ) : null}
    </div>
  );
}

/** Ship-to fields, the same as on the creator's selection link. Never autofilled from the browser. */
function AddressFields() {
  // The state is a dropdown of two-letter codes for the US (the ERP takes only the code); free text elsewhere.
  const [country, setCountry] = useState("United States");
  const inUs = [
    "united states",
    "usa",
    "us",
    "u.s.",
    "u.s.a.",
    "united states of america",
  ].includes(country.trim().toLowerCase());
  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor="ge-shipName">Full name (as on the parcel)</Label>
        <Input
          id="ge-shipName"
          name="shipName"
          required
          maxLength={100}
          autoComplete="off"
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="ge-address1">Address</Label>
        <Input
          id="ge-address1"
          name="address1"
          required
          maxLength={150}
          autoComplete="off"
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="ge-address2">Apartment, suite (optional)</Label>
        <Input
          id="ge-address2"
          name="address2"
          maxLength={150}
          autoComplete="off"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="ge-city">City</Label>
          <Input
            id="ge-city"
            name="city"
            required
            maxLength={80}
            autoComplete="off"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ge-state">State</Label>
          {inUs ? (
            <NativeSelect id="ge-state" name="state" required defaultValue="">
              <option value="">Choose</option>
              {US_STATES.map(([code, name]) => (
                <option key={code} value={code}>
                  {name} ({code})
                </option>
              ))}
            </NativeSelect>
          ) : (
            <Input
              id="ge-state"
              name="state"
              required
              maxLength={60}
              autoComplete="off"
            />
          )}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ge-postalCode">ZIP code</Label>
          <Input
            id="ge-postalCode"
            name="postalCode"
            required
            maxLength={20}
            autoComplete="off"
          />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="ge-country">Country</Label>
          <Input
            id="ge-country"
            name="country"
            required
            maxLength={60}
            value={country}
            onChange={(event) => setCountry(event.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ge-phone">Phone (optional)</Label>
          <Input
            id="ge-phone"
            name="phone"
            type="tel"
            maxLength={30}
            autoComplete="off"
          />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="ge-note">Note from the creator (optional)</Label>
        <Textarea id="ge-note" name="note" rows={2} maxLength={500} />
      </div>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          name="confirm"
          value="yes"
          required
          className="mt-1"
        />
        <span>The creator sent these details themselves, for this gift.</span>
      </label>
    </>
  );
}

function Saved({ message }: { message: string }) {
  return (
    <div className="grid gap-3">
      <p
        role="status"
        className="rounded-md bg-success-soft px-4 py-3 text-success-text"
      >
        {message}
      </p>
      <Link className="link" href="/orders">
        Open Gifts
      </Link>
    </div>
  );
}

function Problem({ text }: { text: string }) {
  return (
    <p role="alert" className="text-destructive">
      {text}
    </p>
  );
}

/**
 * "Enter gift by hand" on the creator's Gift card: for a creator who sent their
 * product and address in a DM or email instead of using their link. The gift goes
 * through the same rules as one chosen on the link.
 */
export function EnterGiftButton({
  campaignCreatorId,
  campaignName,
}: {
  campaignCreatorId: string;
  campaignName: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        Enter gift by hand
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Enter gift by hand</DialogTitle>
            <DialogDescription>
              For a creator who sent their choice and address by message instead
              of using their link ({campaignName}). The same gift rules apply,
              and the address is stored encrypted.
            </DialogDescription>
          </DialogHeader>
          {open ? (
            <EnterGiftForm campaignCreatorId={campaignCreatorId} />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function EnterGiftForm({ campaignCreatorId }: { campaignCreatorId: string }) {
  const { state, onSubmit, pending } = usePreservedForm(enterGiftByHand);
  const [productId, setProductId] = useState("");
  const list = useProducts(campaignCreatorId, productsForGift);

  if (state?.message) return <Saved message={state.message} />;
  if (list?.error) return <Problem text={list.error} />;
  if (!list?.products)
    return (
      <p className="text-muted-foreground">
        Loading this campaign&apos;s products...
      </p>
    );

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <input type="hidden" name="campaignCreatorId" value={campaignCreatorId} />
      <ProductPickers
        products={list.products}
        productId={productId}
        onProduct={setProductId}
      />
      <AddressFields />
      <FormError state={state} />
      <SubmitButton
        variant="action"
        pending={pending}
        pendingLabel="Saving..."
        disabled={!productId}
      >
        Save gift
      </SubmitButton>
    </form>
  );
}

export type GiftCampaignOption = { id: string; name: string; brand: string };

/**
 * "Gift a creator" on the Gifts page: straight to a gift, without discovery or outreach,
 * for a test shipment or a creator the team arranged elsewhere. Same checks and rules as
 * every other gift; the creator is found by handle or added once.
 */
export function GiftCreatorButton({
  campaigns,
}: {
  campaigns: GiftCampaignOption[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <Gift strokeWidth={2.4} />
        Gift a creator
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Gift a creator</DialogTitle>
            <DialogDescription>
              Straight to a gift, with no discovery or outreach step. The
              creator is found by their handle, or added if they are new. The
              usual gift rules apply, and the address is stored encrypted.
            </DialogDescription>
          </DialogHeader>
          {open ? <GiftCreatorForm campaigns={campaigns} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function GiftCreatorForm({ campaigns }: { campaigns: GiftCampaignOption[] }) {
  const { state, onSubmit, pending } = usePreservedForm(giftNewCreator);
  const [campaignId, setCampaignId] = useState(
    campaigns.length === 1 ? campaigns[0].id : "",
  );
  const [productId, setProductId] = useState("");
  const list = useProducts(campaignId || null, productsForCampaign);

  if (state?.message) return <Saved message={state.message} />;
  if (campaigns.length === 0)
    return (
      <Problem text="There is no open campaign to gift from. Create one in Campaigns first." />
    );

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="gc-campaign">Campaign</Label>
        <NativeSelect
          id="gc-campaign"
          name="campaignId"
          required
          value={campaignId}
          onChange={(event) => {
            setCampaignId(event.target.value);
            setProductId("");
          }}
        >
          <option value="">Choose</option>
          {campaigns.map((campaign) => (
            <option key={campaign.id} value={campaign.id}>
              {campaign.name} · {campaign.brand}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="gc-handle">Instagram handle or profile link</Label>
          <Input
            id="gc-handle"
            name="handle"
            required
            maxLength={200}
            placeholder="@creatorname"
            autoComplete="off"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="gc-name">Creator name (optional)</Label>
          <Input
            id="gc-name"
            name="creatorName"
            maxLength={120}
            autoComplete="off"
          />
        </div>
      </div>

      {!campaignId ? (
        <p className="text-sm text-muted-foreground">
          Choose a campaign to see its products.
        </p>
      ) : list?.error ? (
        <Problem text={list.error} />
      ) : !list?.products ? (
        <p className="text-muted-foreground">
          Loading this campaign&apos;s products...
        </p>
      ) : (
        <ProductPickers
          key={campaignId}
          products={list.products}
          productId={productId}
          onProduct={setProductId}
        />
      )}

      <AddressFields />
      <FormError state={state} />
      <SubmitButton
        variant="action"
        pending={pending}
        pendingLabel="Saving..."
        disabled={!productId}
      >
        Save gift
      </SubmitButton>
    </form>
  );
}
