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

/** "linen, block print ,  table" -> ["linen", "block print", "table"] */
export function splitKeywords(raw: string): string[] {
  return [...new Set(raw.split(/[,\n]/).map((part) => part.trim().toLowerCase()).filter(Boolean))];
}
