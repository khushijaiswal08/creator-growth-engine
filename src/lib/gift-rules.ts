import rulesFile from "../../config/gift-rules.json";

/**
 * The auto-approval rules, read from config/gift-rules.json so anyone can
 * read and change them without touching code. Validated once at start-up:
 * a broken file stops the app rather than approving orders by accident.
 */
export type GiftRules = {
  allowedCountries: string[];
  maxQuantity: number;
  maxProductPriceUsd: number | null;
  repeatGiftDays: number;
  paidCollaborationNeedsApprovedFee: boolean;
};

export const RULE_LABELS: Record<keyof GiftRules, string> = {
  allowedCountries: "ships to an allowed country",
  maxQuantity: "within the quantity limit",
  maxProductPriceUsd: "within the price limit",
  repeatGiftDays: "no other gift within the repeat window",
  paidCollaborationNeedsApprovedFee: "no unapproved fee",
};

function read(): GiftRules {
  const raw = (rulesFile as { rules: Record<string, { value: unknown }> }).rules;
  const value = (name: string) => raw?.[name]?.value;

  const allowedCountries = value("allowedCountries");
  const maxQuantity = value("maxQuantity");
  const maxProductPriceUsd = value("maxProductPriceUsd");
  const repeatGiftDays = value("repeatGiftDays");
  const paidCollaborationNeedsApprovedFee = value("paidCollaborationNeedsApprovedFee");

  if (!Array.isArray(allowedCountries) || allowedCountries.length === 0 || !allowedCountries.every((c) => typeof c === "string" && c.trim())) {
    throw new Error("config/gift-rules.json: allowedCountries must be a list of country names.");
  }
  if (!Number.isInteger(maxQuantity) || (maxQuantity as number) < 1) throw new Error("config/gift-rules.json: maxQuantity must be a whole number of at least 1.");
  if (maxProductPriceUsd !== null && (typeof maxProductPriceUsd !== "number" || maxProductPriceUsd <= 0)) {
    throw new Error("config/gift-rules.json: maxProductPriceUsd must be a positive number or null.");
  }
  if (!Number.isInteger(repeatGiftDays) || (repeatGiftDays as number) < 0) throw new Error("config/gift-rules.json: repeatGiftDays must be a whole number.");
  if (typeof paidCollaborationNeedsApprovedFee !== "boolean") throw new Error("config/gift-rules.json: paidCollaborationNeedsApprovedFee must be true or false.");

  return {
    allowedCountries: (allowedCountries as string[]).map((c) => c.trim()),
    maxQuantity: maxQuantity as number,
    maxProductPriceUsd: maxProductPriceUsd as number | null,
    repeatGiftDays: repeatGiftDays as number,
    paidCollaborationNeedsApprovedFee: paidCollaborationNeedsApprovedFee as boolean,
  };
}

export const GIFT_RULES: GiftRules = read();

export type RuleCheck = { rule: keyof GiftRules; passed: boolean; reason: string | null };

export type OrderFacts = {
  country: string;
  quantity: number;
  /** Amazon price in US dollars, when known. */
  productPriceUsd: number | null;
  collaborationType: string | null;
  approvedFee: number | null;
  /** When the creator's latest other gift order was made, if any. */
  lastGiftAt: Date | null;
  now: Date;
};

/** Pure: applies every rule to the facts and says which passed. */
export function checkGiftRules(facts: OrderFacts, rules: GiftRules = GIFT_RULES): RuleCheck[] {
  const checks: RuleCheck[] = [];
  const countryOk = rules.allowedCountries.includes(facts.country);
  checks.push({ rule: "allowedCountries", passed: countryOk, reason: countryOk ? null : `Ships to ${facts.country}, which is not in the allowed list.` });

  const quantityOk = facts.quantity <= rules.maxQuantity;
  checks.push({ rule: "maxQuantity", passed: quantityOk, reason: quantityOk ? null : `Quantity is ${facts.quantity}; the limit is ${rules.maxQuantity}.` });

  const priceOk = rules.maxProductPriceUsd === null || facts.productPriceUsd === null || facts.productPriceUsd <= rules.maxProductPriceUsd;
  checks.push({
    rule: "maxProductPriceUsd",
    passed: priceOk,
    reason: priceOk ? null : `The product costs $${facts.productPriceUsd}; the limit is $${rules.maxProductPriceUsd}.`,
  });

  const repeatOk = !facts.lastGiftAt || facts.now.getTime() - facts.lastGiftAt.getTime() > rules.repeatGiftDays * 24 * 60 * 60 * 1000;
  checks.push({
    rule: "repeatGiftDays",
    passed: repeatOk,
    reason: repeatOk ? null : `Already has a gift order from ${facts.lastGiftAt!.toISOString().slice(0, 10)} (within ${rules.repeatGiftDays} days).`,
  });

  const feeOk = !rules.paidCollaborationNeedsApprovedFee || facts.collaborationType !== "paid" || facts.approvedFee !== null;
  checks.push({ rule: "paidCollaborationNeedsApprovedFee", passed: feeOk, reason: feeOk ? null : "Paid collaboration with no approved fee yet." });

  return checks;
}

/** One line for the activity log naming every rule that was applied. */
export function describeRuleChecks(checks: RuleCheck[]): string {
  const failed = checks.filter((check) => !check.passed);
  if (failed.length === 0) return `Approved under the rules: ${checks.map((check) => RULE_LABELS[check.rule]).join(", ")} (config/gift-rules.json).`;
  return `Held for a person. Failed: ${failed.map((check) => `${RULE_LABELS[check.rule]} (${check.reason})`).join("; ")} (config/gift-rules.json).`;
}
