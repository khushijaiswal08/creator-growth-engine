"use client";

import { useMemo, useState } from "react";
import { submitSelection } from "@/actions/selection";
import { FormError } from "@/components/form-error";
import { NativeSelect } from "@/components/native-select";
import { ProductPhoto } from "@/components/product-photo";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { usePreservedForm } from "@/components/use-preserved-form";

export type SelectableProduct = {
  id: string;
  title: string;
  listingName: string | null;
  color: string | null;
  size: string | null;
  amazonUrl: string | null;
  websiteUrl: string | null;
  imageUrl: string | null;
};

const describe = (product: SelectableProduct) => [product.title, product.color, product.size].filter(Boolean).join(", ");

/** The search box appears once there are more prints than fit on a phone screen. */
const SEARCH_FROM = 13;

/**
 * Product, then print or colour (with photos), then size. A missing colour or
 * size counts as a choice of its own, and when several listings still match
 * (plain, ruffled and scalloped versions of the same cover, say) the creator
 * picks between them, so every product can be reached and none is guessed.
 */
export function SelectionForm({ token, categories, products }: { token: string; categories: string[]; products: SelectableProduct[] }) {
  const { state, onSubmit, pending } = usePreservedForm(submitSelection);

  const [title, setTitle] = useState(categories.length === 1 ? categories[0] : "");
  const [pickedColor, setPickedColor] = useState<string | null>(null);
  const [pickedSize, setPickedSize] = useState<string | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const ofTitle = useMemo(() => products.filter((product) => product.title === title), [products, title]);

  // Prints arrive best-stocked first; each shows the first photo found for it.
  const colors = useMemo(() => {
    const photos = new Map<string, string | null>();
    for (const product of ofTitle) {
      const key = product.color ?? "";
      if (!photos.get(key)) photos.set(key, product.imageUrl);
    }
    return [...photos].map(([key, imageUrl]) => ({ key, imageUrl }));
  }, [ofTitle]);
  const color = colors.length === 1 ? colors[0].key : pickedColor;

  const ofColor = color === null ? [] : ofTitle.filter((product) => (product.color ?? "") === color);
  const sizes = [...new Set(ofColor.map((product) => product.size ?? ""))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const size = sizes.length === 1 ? sizes[0] : pickedSize;

  const matches = size === null ? [] : ofColor.filter((product) => (product.size ?? "") === size);
  const chosen = matches.length === 1 ? matches[0] : (matches.find((product) => product.id === pickedId) ?? null);

  const wanted = search.trim().toLowerCase();
  const shownColors = wanted ? colors.filter((option) => option.key.toLowerCase().includes(wanted)) : colors;

  if (state?.message) {
    return (
      <p role="status" className="rounded-md bg-success-soft px-4 py-3 text-success-text">
        {state.message}
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-5">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="productId" value={chosen?.id ?? ""} />
      {/* Left empty by people; filled in by bots. */}
      <div aria-hidden className="hidden">
        <label>
          Website
          <input name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      <fieldset className="grid gap-4">
        <legend className="mb-1 font-heading text-lg font-medium">1. Choose your product</legend>

        <div className="grid gap-1.5 sm:max-w-xs">
          <Label htmlFor="sel-title">Product</Label>
          <NativeSelect
            id="sel-title"
            required
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setPickedColor(null);
              setPickedSize(null);
              setPickedId(null);
              setSearch("");
            }}
          >
            <option value="">Choose</option>
            {categories.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </NativeSelect>
        </div>

        {title && colors.length > 1 ? (
          <fieldset className="grid gap-2">
            <legend className="mb-1.5 text-sm font-medium">
              Print or colour <span className="font-normal text-muted-foreground">({colors.length} to choose from)</span>
            </legend>
            {colors.length >= SEARCH_FROM ? (
              <Input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search, for example: blue"
                aria-label="Search prints and colours"
                className="sm:max-w-xs"
              />
            ) : null}
            <div className="grid max-h-[27rem] grid-cols-3 gap-2 overflow-y-auto rounded-lg border bg-surface-2 p-2 sm:grid-cols-4">
              {shownColors.map((option) => (
                <label key={option.key} className="cursor-pointer">
                  <input
                    type="radio"
                    name="pick-color"
                    value={option.key}
                    checked={color === option.key}
                    onChange={() => {
                      setPickedColor(option.key);
                      setPickedSize(null);
                      setPickedId(null);
                    }}
                    className="peer sr-only"
                  />
                  <span className="block h-full overflow-hidden rounded-md border-2 border-transparent bg-surface shadow-card peer-checked:border-primary peer-checked:bg-primary-soft peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
                    <ProductPhoto url={option.imageUrl} size={150} className="aspect-square w-full" />
                    <span className="block px-1 py-1.5 text-center text-xs leading-tight">{option.key || "As pictured"}</span>
                  </span>
                </label>
              ))}
              {shownColors.length === 0 ? (
                <p className="col-span-full px-2 py-6 text-center text-muted-foreground">Nothing matches that search. Try a shorter word.</p>
              ) : null}
            </div>
          </fieldset>
        ) : null}

        {color !== null && sizes.length > 1 ? (
          <div className="grid gap-1.5 sm:max-w-xs">
            <Label htmlFor="sel-size">Size</Label>
            <NativeSelect
              id="sel-size"
              required
              value={size === null ? "" : String(sizes.indexOf(size))}
              onChange={(event) => {
                setPickedSize(event.target.value === "" ? null : sizes[Number(event.target.value)]);
                setPickedId(null);
              }}
            >
              <option value="">Choose</option>
              {sizes.map((option, index) => (
                <option key={option} value={index}>
                  {option || "Standard"}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : null}

        {matches.length > 1 ? (
          <fieldset className="grid gap-2">
            <legend className="mb-1.5 text-sm font-medium">This comes in {matches.length} versions. Which one would you like?</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {matches.map((product) => (
                <label key={product.id} className="cursor-pointer">
                  <input
                    type="radio"
                    name="pick-version"
                    value={product.id}
                    checked={pickedId === product.id}
                    onChange={() => setPickedId(product.id)}
                    className="peer sr-only"
                  />
                  <span className="flex h-full items-center gap-3 rounded-md border-2 border-border bg-surface p-2 peer-checked:border-primary peer-checked:bg-primary-soft peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
                    <ProductPhoto url={product.imageUrl} size={80} className="size-20 shrink-0 rounded" />
                    <span className="text-sm leading-snug">{product.listingName ?? describe(product)}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        {chosen ? (
          <div className="flex items-start gap-3 rounded-md bg-primary-soft p-3">
            {chosen.imageUrl ? <ProductPhoto url={chosen.imageUrl} size={112} className="size-28 shrink-0 rounded-md" /> : null}
            <div className="grid min-w-0 gap-1">
              <p>
                You chose: <strong>{describe(chosen)}</strong>
              </p>
              {/* The full name only where it was what told the versions apart. */}
              {matches.length > 1 && chosen.listingName ? <p className="text-sm text-muted-foreground">{chosen.listingName}</p> : null}
              {chosen.amazonUrl || chosen.websiteUrl ? (
                <p>
                  {chosen.amazonUrl ? (
                    <a className="link" href={chosen.amazonUrl} target="_blank" rel="noopener noreferrer">
                      See it on Amazon
                    </a>
                  ) : null}
                  {chosen.amazonUrl && chosen.websiteUrl ? " or " : null}
                  {chosen.websiteUrl ? (
                    <a className="link" href={chosen.websiteUrl} target="_blank" rel="noopener noreferrer">
                      {chosen.amazonUrl ? "on our website" : "See it on our website"}
                    </a>
                  ) : null}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </fieldset>

      <fieldset className="grid gap-3">
        <legend className="mb-1 font-heading text-lg font-medium">2. Where should we send it?</legend>
        <div className="grid gap-1.5">
          <Label htmlFor="shipName">Full name</Label>
          <Input id="shipName" name="shipName" required maxLength={100} autoComplete="name" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="address1">Address</Label>
          <Input id="address1" name="address1" required maxLength={150} autoComplete="address-line1" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="address2">Apartment, suite (optional)</Label>
          <Input id="address2" name="address2" maxLength={150} autoComplete="address-line2" />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="city">City</Label>
            <Input id="city" name="city" required maxLength={80} autoComplete="address-level2" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="state">State</Label>
            <Input id="state" name="state" required maxLength={60} autoComplete="address-level1" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="postalCode">ZIP code</Label>
            <Input id="postalCode" name="postalCode" required maxLength={20} autoComplete="postal-code" />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="country">Country</Label>
            <Input id="country" name="country" required maxLength={60} defaultValue="United States" autoComplete="country-name" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="phone">Phone (for the courier, optional)</Label>
            <Input id="phone" name="phone" type="tel" maxLength={30} autoComplete="tel" />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="note">Anything we should know? (optional)</Label>
          <Textarea id="note" name="note" rows={2} maxLength={500} />
        </div>
      </fieldset>

      <label className="flex items-start gap-2">
        <input type="checkbox" name="consent" value="yes" required className="mt-1" />
        <span>
          I agree to these details being used to send me this product. See our{" "}
          <a className="link" href="/privacy" target="_blank">
            privacy page
          </a>
          .
        </span>
      </label>

      <FormError state={state} />
      {!chosen ? <p className="text-sm text-muted-foreground">Choose your product above to continue.</p> : null}
      <SubmitButton variant="action" size="lg" pending={pending} pendingLabel="Sending..." disabled={!chosen}>
        Confirm my choice
      </SubmitButton>
    </form>
  );
}
