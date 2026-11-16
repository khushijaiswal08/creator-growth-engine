const TEMPLATE_VARS = ["name", "handle", "platform", "sender", "product", "brand", "selection_link", "upload_link", "amazon_link"] as const;

type TemplateVar = (typeof TEMPLATE_VARS)[number];
type TemplateVars = Record<TemplateVar, string>;

// Built from the list above, so a new placeholder only has to be added once.
const PLACEHOLDER_RE = new RegExp(`\\{(${TEMPLATE_VARS.join("|")})\\}`, "g");

/**
 * Replaces {name} {handle} {platform} {sender} {product} {brand} {selection_link} {upload_link} {amazon_link}.
 * A placeholder with no value is left as is, so it shows up as still to fill in.
 */
export function fillTemplate(body: string, vars: TemplateVars): string {
  return body.replace(PLACEHOLDER_RE, (match, key: TemplateVar) => vars[key].trim() || match);
}

/** Placeholders still present in a message, i.e. not yet filled in. */
export function remainingPlaceholders(text: string): TemplateVar[] {
  return [...new Set([...text.matchAll(PLACEHOLDER_RE)].map((match) => match[1] as TemplateVar))];
}

/**
 * What an exact product from the dropdown puts into {product}: its colour and type, e.g.
 * "our Aquamarine Blue Pillow Cover", so "gifting you {product}" and "{product} would sit well in your home"
 * name the real piece and still read naturally. (The Amazon listing name is up to 200 characters of search
 * keywords, which would read badly in a DM.)
 */
export function productPhrase(product: { title: string; color: string | null }): string {
  const words = [product.color, product.title].map((part) => (part ?? "").trim().replace(/\s+/g, " ")).filter(Boolean);
  return words.length ? `our ${words.join(" ")}` : "";
}

/**
 * The name shown in the Product dropdown: the Amazon listing name without the brand word at the start and
 * without the keyword tail after the first comma, so two pillow covers of the same colour (ruffle or plain)
 * can still be told apart. Falls back to colour, type and size when there is no listing name.
 */
export function productLabel(product: { title: string; color: string | null; size: string | null; listingName: string | null }): string {
  const size = (product.size ?? "").replace(/\s+/g, " ").trim();
  const fallback = [product.color, product.title, size].filter(Boolean).join(" · ");
  const listing = (product.listingName ?? "").replace(/\s+/g, " ").trim();
  if (!listing) return fallback;
  const name = listing
    .replace(/^(Ridhi|CPC|Cotton Print Club)\b\s*/i, "")
    .split(",")[0]
    .trim();
  if (!name) return fallback;
  const short = name.length > 80 ? `${name.slice(0, 79).replace(/[\uD800-\uDBFF]$/, "").trimEnd()}…` : name;
  // The size always shows, at the end, so the sizes of one print never look the same in the list.
  return size ? `${short} · ${size}` : short;
}

/** Products whose labels still match (same print, size and wording) get their SKU, so every row can be told apart. */
export function distinctLabels<T extends { label: string; sku: string }>(items: T[]): T[] {
  const seen = new Map<string, number>();
  for (const item of items) seen.set(item.label, (seen.get(item.label) ?? 0) + 1);
  return items.map((item) => ((seen.get(item.label) ?? 0) > 1 ? { ...item, label: `${item.label} · ${item.sku}` } : item));
}

/** "Maya Torres" -> "Maya". Used for {name} so greetings read naturally. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}
