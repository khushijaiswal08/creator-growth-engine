"use client";

import { Gift, Plus, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { editGiftAddress, enterGiftByHand, giftNewCreator, productsForCampaign, productsForGift, type GiftProductOption } from "@/actions/gift-entry";
import { FormError } from "@/components/form-error";
import { NativeSelect } from "@/components/native-select";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { usePreservedForm } from "@/components/use-preserved-form";
import { countryNames } from "@/lib/countries";
import { US_STATES, usStateCode } from "@/lib/us-states";

/*
 * The gift forms follow Amazon's "Create MCF order" page: 1. the customer address
 * (country, name, street with "Add a line", city, state, ZIP, phone, email), then
 * 2. Add items (search by title, SKU or ASIN; each product with its units). The order
 * ID is the gift's CGE- reference, made when it is saved. Shipping choices (speed,
 * packaging) are left to the ERP team, who place the Amazon order.
 */

const MAX_UNITS = 20;
const MAX_LINES = 20;

type ProductList = { ok: true; products: GiftProductOption[] } | { ok: false; error: string };

/** Loads a product list whenever `key` changes; null `key` means nothing to load yet. */
function useProducts(key: string | null, load: (key: string) => Promise<ProductList>) {
  const [state, setState] = useState<{ key: string; products: GiftProductOption[] | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    load(key)
      .then((result) => {
        if (live) setState({ key, products: result.ok ? result.products : null, error: result.ok ? null : result.error });
      })
      .catch(() => {
        if (live) setState({ key, products: null, error: "The products could not be loaded. Close this and try again in a moment." });
      });
    return () => {
      live = false;
    };
  }, [key, load]);
  // A result for an earlier key (another campaign) counts as still loading.
  return state && state.key === key ? state : null;
}

/** Products whose title, SKU or ASIN contain every word typed. An exact ASIN or SKU comes first. */
function search(products: GiftProductOption[], text: string): GiftProductOption[] {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const whole = text.trim().toLowerCase();
  const hits = products.filter((product) => {
    const haystack = `${product.label} ${product.type} ${product.sku} ${product.asin ?? ""}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
  const exact = (product: GiftProductOption) => product.sku.toLowerCase() === whole || product.asin?.toLowerCase() === whole;
  return [...hits.filter(exact), ...hits.filter((product) => !exact(product))];
}

/** A product row: units as typed, so the box can be cleared while typing; checked when saved. */
type Item = { product: GiftProductOption; units: string };

/** "2. Add items": search, add, set units, remove. Sends itemProductId and itemUnits rows. */
function AddItems({ products, items, setItems }: { products: GiftProductOption[]; items: Item[]; setItems: (items: Item[]) => void }) {
  const [text, setText] = useState("");
  const results = useMemo(() => search(products, text).slice(0, 8), [products, text]);
  const add = (product: GiftProductOption) => {
    const existing = items.find((item) => item.product.id === product.id);
    if (existing) setItems(items.map((item) => (item === existing ? { ...item, units: String(Math.min(MAX_UNITS, (Number(item.units) || 0) + 1)) } : item)));
    else if (items.length < MAX_LINES) setItems([...items, { product, units: "1" }]);
    setText("");
  };

  return (
    <fieldset className="grid gap-3">
      <legend className="mb-1 font-heading text-base font-semibold">2. Add items</legend>
      <div className="grid gap-1.5">
        <Label htmlFor="ge-search" className="sr-only">
          Search products
        </Label>
        <Input
          id="ge-search"
          type="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter adds the best match, as pasting an ASIN and pressing Enter does on Amazon.
            if (event.key === "Enter") {
              event.preventDefault();
              if (results[0]) add(results[0]);
            }
          }}
          placeholder="Search by title, SKU or ASIN"
          autoComplete="off"
        />
        {text.trim() ? (
          results.length > 0 ? (
            <ul className="grid max-h-60 gap-1 overflow-y-auto rounded-md border bg-surface-2 p-1" aria-label="Matching products">
              {results.map((product) => (
                <li key={product.id}>
                  <button type="button" onClick={() => add(product)} className="flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-sm hover:bg-surface">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{product.label}</span>
                      <span className="block text-xs text-muted-foreground">
                        SKU {product.sku}
                        {product.asin ? ` · ASIN ${product.asin}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs font-semibold text-primary-text">Add</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-destructive">Nothing offered in this campaign matches. Check the ASIN or SKU, or try a word from the name.</p>
          )
        ) : null}
      </div>

      <div className="rounded-md border">
        <div className="flex justify-between border-b px-3 py-2 text-xs font-semibold text-muted-foreground uppercase">
          <span>SKUs</span>
          <span>Units</span>
        </div>
        {items.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-muted-foreground">Use the search field above to add items to this gift.</p>
        ) : (
          <ul className="divide-y">
            {items.map((item, index) => (
              <li key={item.product.id} className="flex items-center gap-3 px-3 py-2">
                <input type="hidden" name="itemProductId" value={item.product.id} />
                <div className="min-w-0 flex-1 text-sm">
                  <p className="truncate font-medium">{item.product.label}</p>
                  <p className="text-xs text-muted-foreground">
                    SKU {item.product.sku}
                    {item.product.asin ? ` · ASIN ${item.product.asin}` : ""}
                  </p>
                </div>
                {/* Typed freely (it may be empty while typing "12"); the browser and the server check 1 to MAX_UNITS. */}
                <Input
                  name="itemUnits"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_UNITS}
                  step={1}
                  required
                  value={item.units}
                  onChange={(event) => setItems(items.map((other, at) => (at === index ? { ...other, units: event.target.value } : other)))}
                  className="w-20"
                  aria-label={`Units of ${item.product.label}`}
                />
                <button type="button" onClick={() => setItems(items.filter((_, at) => at !== index))} aria-label={`Remove ${item.product.label}`} className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground">
                  <X className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="ge-order-id">Order ID</Label>
        <Input id="ge-order-id" disabled value="" placeholder="Made when saved (CGE-…), so the ERP can report back" />
      </div>
    </fieldset>
  );
}

/** An address already saved, to start "Edit address" from. */
export type SavedAddress = { shipName: string; address1: string; address2: string | null; city: string; state: string; postalCode: string; country: string; phone: string | null };

/** "1. Enter customer address", as on Amazon's MCF page. Never autofilled from the browser. */
function AddressFields({ initial, withEmail = true, title = "1. Enter customer address" }: { initial?: SavedAddress; withEmail?: boolean; title?: string }) {
  const countries = useMemo(() => {
    const names = countryNames();
    // An older gift may hold a country spelled differently; keep it choosable as it is.
    return initial && !names.includes(initial.country) && !isUs(initial.country) ? [initial.country, ...names] : names;
  }, [initial]);
  const [country, setCountry] = useState(initial ? (isUs(initial.country) ? "United States" : initial.country) : "United States");
  const [secondLine, setSecondLine] = useState(Boolean(initial?.address2));
  const inUs = country === "United States";
  // A saved US state may be the full name (gifts before 19 Nov): the list shows it by its code.
  const initialState = initial ? (inUs ? (usStateCode(initial.state) ?? "") : initial.state) : "";
  return (
    <fieldset className="grid gap-3">
      <legend className="mb-1 font-heading text-base font-semibold">{title}</legend>
      <div className="grid gap-1.5">
        <Label htmlFor="ge-country">Country</Label>
        <NativeSelect id="ge-country" name="country" required value={country} onChange={(event) => setCountry(event.target.value)}>
          {countries.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </NativeSelect>
        <p className="text-xs text-muted-foreground">International postal addresses allowed.</p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="ge-shipName">Full name</Label>
        <Input id="ge-shipName" name="shipName" required maxLength={100} defaultValue={initial?.shipName} autoComplete="off" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="ge-address1">Street address</Label>
        <Input id="ge-address1" name="address1" required maxLength={150} defaultValue={initial?.address1} placeholder="Street address, P.O. box, company name, c/o" autoComplete="off" />
        {secondLine ? (
          <Input id="ge-address2" name="address2" maxLength={150} defaultValue={initial?.address2 ?? ""} placeholder="Apartment, suite, unit, building, floor" aria-label="Address line 2" autoComplete="off" />
        ) : (
          <button type="button" onClick={() => setSecondLine(true)} className="flex w-fit items-center gap-1 text-sm font-medium text-primary-text hover:underline">
            <Plus className="size-4" /> Add a line
          </button>
        )}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="ge-city">City</Label>
        <Input id="ge-city" name="city" required maxLength={80} defaultValue={initial?.city} autoComplete="off" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="ge-state">{inUs ? "State" : "State / Province"}</Label>
          {inUs ? (
            <NativeSelect id="ge-state" name="state" required defaultValue={initialState}>
              <option value="">Choose</option>
              {US_STATES.map(([code, name]) => (
                <option key={code} value={code}>
                  {name} ({code})
                </option>
              ))}
            </NativeSelect>
          ) : (
            <Input id="ge-state" name="state" required maxLength={60} defaultValue={initialState} autoComplete="off" />
          )}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ge-postalCode">ZIP / Postal code</Label>
          <Input id="ge-postalCode" name="postalCode" required maxLength={20} defaultValue={initial?.postalCode} autoComplete="off" />
        </div>
      </div>
      <p className="text-sm font-semibold">Customer contact information</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="ge-phone">Phone number (optional)</Label>
          <Input id="ge-phone" name="phone" type="tel" maxLength={30} defaultValue={initial?.phone ?? ""} autoComplete="off" />
        </div>
        {withEmail ? (
          <div className="grid gap-1.5">
            <Label htmlFor="ge-email">Email address (optional)</Label>
            <Input id="ge-email" name="email" type="email" maxLength={200} placeholder="customer@mail.com" autoComplete="off" />
          </div>
        ) : null}
      </div>
    </fieldset>
  );
}

/** The end of both forms: the creator's note, the confirmation and Save. */
function FormEnd({ state, pending, items }: { state: Parameters<typeof FormError>[0]["state"]; pending: boolean; items: Item[] }) {
  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor="ge-note">Note from the creator (optional)</Label>
        <Textarea id="ge-note" name="note" rows={2} maxLength={500} />
      </div>
      <label className="flex items-start gap-2">
        <input type="checkbox" name="confirm" value="yes" required className="mt-1" />
        <span>The creator sent these details themselves, for this gift. Saving approves it in my name.</span>
      </label>
      <FormError state={state} />
      {items.length === 0 ? <p className="text-sm text-muted-foreground">Add at least one product to save.</p> : null}
      <SubmitButton variant="action" pending={pending} pendingLabel="Saving..." disabled={items.length === 0}>
        Save gift
      </SubmitButton>
    </>
  );
}

function Saved({ message }: { message: string }) {
  return (
    <div className="grid gap-3">
      <p role="status" className="rounded-md bg-success-soft px-4 py-3 text-success-text">
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
 * products and address in a DM or email instead of using their link.
 */
export function EnterGiftButton({ campaignCreatorId, campaignName }: { campaignCreatorId: string; campaignName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Enter gift by hand
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Enter gift by hand</DialogTitle>
            <DialogDescription>For a creator who sent their choice and address by message instead of using their link ({campaignName}). Saving approves the gift in your name; the address is stored encrypted.</DialogDescription>
          </DialogHeader>
          {open ? <EnterGiftForm campaignCreatorId={campaignCreatorId} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function EnterGiftForm({ campaignCreatorId }: { campaignCreatorId: string }) {
  const { state, onSubmit, pending } = usePreservedForm(enterGiftByHand);
  const [items, setItems] = useState<Item[]>([]);
  const list = useProducts(campaignCreatorId, productsForGift);

  if (state?.message) return <Saved message={state.message} />;
  if (list?.error) return <Problem text={list.error} />;
  if (!list?.products) return <p className="text-muted-foreground">Loading this campaign&apos;s products...</p>;

  return (
    <form onSubmit={onSubmit} className="grid gap-5">
      <input type="hidden" name="campaignCreatorId" value={campaignCreatorId} />
      <AddressFields />
      <AddItems products={list.products} items={items} setItems={setItems} />
      <FormEnd state={state} pending={pending} items={items} />
    </form>
  );
}

export type GiftCampaignOption = { id: string; name: string; brand: string };

/**
 * "Gift a creator" on the Gifts page: straight to a gift, without discovery or outreach,
 * for a test shipment or a creator the team arranged elsewhere. The creator is found by
 * handle or added once.
 */
export function GiftCreatorButton({ campaigns }: { campaigns: GiftCampaignOption[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <Gift strokeWidth={2.4} />
        Gift a creator
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Gift a creator</DialogTitle>
            <DialogDescription>Straight to a gift, with no discovery or outreach step. The creator is found by their handle, or added if they are new. Saving approves the gift in your name; the address is stored encrypted.</DialogDescription>
          </DialogHeader>
          {open ? <GiftCreatorForm campaigns={campaigns} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function GiftCreatorForm({ campaigns }: { campaigns: GiftCampaignOption[] }) {
  const { state, onSubmit, pending } = usePreservedForm(giftNewCreator);
  const [campaignId, setCampaignId] = useState(campaigns.length === 1 ? campaigns[0].id : "");
  const [items, setItems] = useState<Item[]>([]);
  const list = useProducts(campaignId || null, productsForCampaign);

  if (state?.message) return <Saved message={state.message} />;
  if (campaigns.length === 0) return <Problem text="There is no open campaign to gift from. Create one in Campaigns first." />;

  return (
    <form onSubmit={onSubmit} className="grid gap-5">
      <fieldset className="grid gap-3">
        <legend className="mb-1 font-heading text-base font-semibold">Creator</legend>
        <div className="grid gap-1.5">
          <Label htmlFor="gc-campaign">Campaign</Label>
          <NativeSelect
            id="gc-campaign"
            name="campaignId"
            required
            value={campaignId}
            onChange={(event) => {
              setCampaignId(event.target.value);
              setItems([]);
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
            <Input id="gc-handle" name="handle" required maxLength={200} placeholder="@creatorname" autoComplete="off" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="gc-name">Creator name (optional)</Label>
            <Input id="gc-name" name="creatorName" maxLength={120} autoComplete="off" />
          </div>
        </div>
      </fieldset>

      <AddressFields />

      {!campaignId ? (
        <p className="text-sm text-muted-foreground">Choose a campaign to add its products.</p>
      ) : list?.error ? (
        <Problem text={list.error} />
      ) : !list?.products ? (
        <p className="text-muted-foreground">Loading this campaign&apos;s products...</p>
      ) : (
        <AddItems key={campaignId} products={list.products} items={items} setItems={setItems} />
      )}

      <FormEnd state={state} pending={pending} items={items} />
    </form>
  );
}

/**
 * "Edit address" in the gift drawer: fix a typo or a wrong state before the order leaves.
 * Shown only while the gift has not gone to the ERP or Amazon (the server checks again).
 */
export function EditAddressButton({ giftId, address }: { giftId: string; address: SavedAddress }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Edit address
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Edit address</DialogTitle>
            <DialogDescription>Fix the shipping address before the order goes to the ERP. The change is noted in the gift&apos;s history.</DialogDescription>
          </DialogHeader>
          {open ? <EditAddressForm giftId={giftId} address={address} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function EditAddressForm({ giftId, address }: { giftId: string; address: SavedAddress }) {
  const { state, onSubmit, pending } = usePreservedForm(editGiftAddress);
  if (state?.message) {
    return (
      <p role="status" className="rounded-md bg-success-soft px-4 py-3 text-success-text">
        {state.message}
      </p>
    );
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <input type="hidden" name="giftId" value={giftId} />
      <AddressFields initial={address} withEmail={false} title="Shipping address" />
      <FormError state={state} />
      <SubmitButton variant="action" pending={pending} pendingLabel="Saving...">
        Save address
      </SubmitButton>
    </form>
  );
}

const US_NAMES = new Set(["united states", "usa", "us", "u.s.", "u.s.a.", "united states of america"]);
function isUs(country: string): boolean {
  return US_NAMES.has(country.trim().toLowerCase());
}
