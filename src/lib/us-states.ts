/**
 * US states, DC, territories and military "states", with their two-letter USPS codes.
 * The ERP (and Amazon) take only the two letters, so a US address is always stored
 * and sent with the code: "Florida", "florida" and "FL" all become "FL".
 */
export const US_STATES: ReadonlyArray<readonly [code: string, name: string]> = [
  ["AL", "Alabama"],
  ["AK", "Alaska"],
  ["AZ", "Arizona"],
  ["AR", "Arkansas"],
  ["CA", "California"],
  ["CO", "Colorado"],
  ["CT", "Connecticut"],
  ["DE", "Delaware"],
  ["DC", "District of Columbia"],
  ["FL", "Florida"],
  ["GA", "Georgia"],
  ["HI", "Hawaii"],
  ["ID", "Idaho"],
  ["IL", "Illinois"],
  ["IN", "Indiana"],
  ["IA", "Iowa"],
  ["KS", "Kansas"],
  ["KY", "Kentucky"],
  ["LA", "Louisiana"],
  ["ME", "Maine"],
  ["MD", "Maryland"],
  ["MA", "Massachusetts"],
  ["MI", "Michigan"],
  ["MN", "Minnesota"],
  ["MS", "Mississippi"],
  ["MO", "Missouri"],
  ["MT", "Montana"],
  ["NE", "Nebraska"],
  ["NV", "Nevada"],
  ["NH", "New Hampshire"],
  ["NJ", "New Jersey"],
  ["NM", "New Mexico"],
  ["NY", "New York"],
  ["NC", "North Carolina"],
  ["ND", "North Dakota"],
  ["OH", "Ohio"],
  ["OK", "Oklahoma"],
  ["OR", "Oregon"],
  ["PA", "Pennsylvania"],
  ["RI", "Rhode Island"],
  ["SC", "South Carolina"],
  ["SD", "South Dakota"],
  ["TN", "Tennessee"],
  ["TX", "Texas"],
  ["UT", "Utah"],
  ["VT", "Vermont"],
  ["VA", "Virginia"],
  ["WA", "Washington"],
  ["WV", "West Virginia"],
  ["WI", "Wisconsin"],
  ["WY", "Wyoming"],
  ["PR", "Puerto Rico"],
  ["VI", "U.S. Virgin Islands"],
  ["GU", "Guam"],
  ["AS", "American Samoa"],
  ["MP", "Northern Mariana Islands"],
  ["AA", "Armed Forces Americas"],
  ["AE", "Armed Forces Europe"],
  ["AP", "Armed Forces Pacific"],
];

const squash = (text: string) => text.toLowerCase().replace(/[^a-z]/g, "");
const BY_KEY = new Map<string, string>();
for (const [code, name] of US_STATES) {
  BY_KEY.set(squash(code), code);
  BY_KEY.set(squash(name), code);
}
// Common other spellings.
for (const [alias, code] of [
  ["washington dc", "DC"],
  ["washingtondc", "DC"],
  ["virgin islands", "VI"],
  ["us virgin islands", "VI"],
] as const)
  BY_KEY.set(squash(alias), code);

/** The two-letter code for a US state written as its code or its name, or null when it is not one. */
export function usStateCode(raw: string | null | undefined): string | null {
  const key = squash(raw ?? "");
  return key ? (BY_KEY.get(key) ?? null) : null;
}
