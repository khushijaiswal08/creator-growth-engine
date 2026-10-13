/**
 * Anthropic list prices in US dollars per million tokens, used to estimate
 * what a scoring run cost. An estimate, never a bill: cached and
 * cache-written input tokens are counted at the full input price, so the
 * figure errs on the high side. Update when Anthropic changes prices.
 * Source: Anthropic pricing, as of October 2026.
 */
export type ModelPrice = { input: number; output: number };

const PRICES: Record<string, ModelPrice> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** The price row for a model id, matching the longest known prefix (so dated ids still match). */
export function priceFor(model: string): ModelPrice | null {
  const known = Object.keys(PRICES)
    .filter((id) => model === id || model.startsWith(`${id}-`))
    .sort((a, b) => b.length - a.length)[0];
  return known ? PRICES[known] : null;
}

/** Dollars, to four decimals; null when the model's price is not known. */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = priceFor(model);
  if (!price) return null;
  return Math.round(((inputTokens * price.input + outputTokens * price.output) / 1_000_000) * 10_000) / 10_000;
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "not known";
  return value < 0.01 && value > 0 ? "under $0.01" : `$${value.toFixed(2)}`;
}
