export const TEMPLATE_VARS = ["name", "handle", "platform", "sender", "product", "brand", "selection_link"] as const;

export type TemplateVar = (typeof TEMPLATE_VARS)[number];
export type TemplateVars = Record<TemplateVar, string>;

const PLACEHOLDER_RE = /\{(name|handle|platform|sender|product|brand|selection_link)\}/g;

/**
 * Replaces {name} {handle} {platform} {sender} {product} {brand} {selection_link}.
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
