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

/** "Maya Torres" -> "Maya". Used for {name} so greetings read naturally. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}
