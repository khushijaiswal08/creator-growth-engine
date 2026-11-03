/** State returned by form Server Actions to useActionState. */
export type FormState = { error?: string; message?: string } | null;

/** Trimmed string value of a form field, "" when absent. */
export function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** Trimmed string value of a form field, null when absent or blank. */
export function optionalField(formData: FormData, name: string): string | null {
  return field(formData, name) || null;
}

/** The largest file the import forms accept: 3 MB. */
export const MAX_IMPORT_BYTES = 3 * 1024 * 1024;

/** "linen, block print ,  table" -> ["linen", "block print", "table"] */
export function splitKeywords(raw: string): string[] {
  return [...new Set(raw.split(/[,\n]/).map((part) => part.trim().toLowerCase()).filter(Boolean))];
}

/** The same set with one item ticked on when it was off, or off when it was on. */
export function toggled<T>(set: ReadonlySet<T>, item: T): Set<T> {
  const next = new Set(set);
  if (next.has(item)) next.delete(item);
  else next.add(item);
  return next;
}
