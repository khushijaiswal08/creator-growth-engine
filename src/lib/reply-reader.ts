import { REPLY_CLASSES, type ReplyClass } from "@/lib/replies";

/**
 * Rachna reads a creator's reply: which of the eight classes it is, how sure
 * she is, how warm the creator sounds, a one-line summary, the questions they
 * asked and any fee they named. This file is the built-in reader (rules on
 * words), pure and tested; reply-reader-claude.ts asks Claude when a key is
 * set and falls back to these rules. Either way a person confirms the class
 * before anything moves.
 */

export type Warmth = "hot" | "warm" | "cold";

export type Reading = {
  /** Her best guess, even when unsure; the form pre-selects it only when `sure`. */
  replyClass: ReplyClass;
  /** 0 to 1. */
  confidence: number;
  sure: boolean;
  warmth: Warmth | null;
  summary: string;
  questions: string[];
  /** Whole US dollars named in the text, when any. */
  fee: number | null;
  reader: "rules" | "claude";
  version: string;
};

export const RULES_VERSION = "rules-v1";
/** Below this she says "not sure" and leaves the choice to the person. */
export const SURE = 0.7;
export const MAX_QUESTIONS = 3;

/** How warm each class is. "Other" is unknown. */
export const WARMTH_OF: Record<ReplyClass, Warmth | null> = {
  interested_gifted: "hot",
  product_info: "hot",
  interested_affiliate: "warm",
  rate_requested: "warm",
  needs_details: "warm",
  other: null,
  maybe_later: "cold",
  not_interested: "cold",
};

export const WARMTH_LABELS: Record<Warmth, string> = { hot: "Hot", warm: "Warm", cold: "Cold" };

/** Hot first, then warm, unknown, cold: the order the task list and the pick use. */
export function warmthRank(warmth: Warmth | null | undefined): number {
  if (warmth === "hot") return 0;
  if (warmth === "warm") return 1;
  if (warmth === "cold") return 3;
  return 2;
}

export function isWarmth(value: unknown): value is Warmth {
  return value === "hot" || value === "warm" || value === "cold";
}

export function isReading(value: unknown): value is Reading {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.replyClass === "string" &&
    (REPLY_CLASSES as readonly string[]).includes(v.replyClass) &&
    typeof v.confidence === "number" &&
    v.confidence >= 0 &&
    v.confidence <= 1 &&
    typeof v.sure === "boolean" &&
    (v.warmth === null || isWarmth(v.warmth)) &&
    typeof v.summary === "string" &&
    v.summary.length <= 300 &&
    Array.isArray(v.questions) &&
    v.questions.length <= 5 &&
    v.questions.every((q) => typeof q === "string" && q.length <= 200) &&
    (v.fee === null || (typeof v.fee === "number" && Number.isInteger(v.fee) && v.fee >= 0 && v.fee <= 1_000_000)) &&
    (v.reader === "rules" || v.reader === "claude") &&
    typeof v.version === "string" &&
    v.version.length <= 40
  );
}

const SIGNALS = {
  no: /\bnot interested\b|\bno,? thanks?\b|\bno,? thank you\b|\bi('ll| will) pass\b|\bpass on this\b|\bdon'?t (do|accept|take) (gifted|gifting|free|gifts)\b|\bunsubscribe\b|\bplease stop\b|\bnot for me\b|\bnot a (good )?fit\b|\bnot taking (on )?(any )?(collabs?|partnerships)\b/,
  later: /\bmaybe later\b|\bmaybe (next|in)\b|\bnext (month|year|season|spring|summer|fall|autumn|winter)\b|\bafter (the )?(holidays|christmas|diwali|december|new year|thanksgiving)\b|\bnot (right )?now\b|\bcircle back\b|\btoo busy\b|\bswamped\b|\bin (a few|a couple of|two|three|\d+) (weeks|months)\b|\bget back to you\b|\bcheck back\b/,
  feeWords: /\b(rate|rates|fee|fees|paid|payment|budget|charge|charges|price|pricing|compensation|my usual|usd|dollars)\b/,
  affiliate: /\baffiliate\b|\bcommission\b|\b(discount|promo) code\b|\bltk\b|\bstorefront\b|\bshopmy\b/,
  product: /\bwhich (ones?|products?|items?|pieces?|colou?rs?|designs?|sets?)\b|\bcan i (pick|choose|select)\b|\bwhat (products?|items?|pieces?|options?)\b|\bchoose\b|\bpick\b|\bcatalog(ue)?\b|\boptions\b|\bselection\b/,
  yes: /\blove\b|\bloved\b|\blovely\b|\byes\b|\byess+\b|\byep\b|\byeah\b|\bsure\b|\bhappy to\b|\bwould love\b|\bi'?d love\b|\bsounds? (great|good|perfect|amazing|fun|lovely)\b|\bcount me in\b|\binterested\b|\bdefinitely\b|\babsolutely\b|\bexcited\b|\bkeen\b|\bgorgeous\b|\bbeautiful\b|\bobsessed\b|😍|❤|🙌|🥰|💕|😊|🤩/,
  gifted: /\bgift(ed|ing|s)?\b|\bfree\b|\bsend (me|it|them|one|over)\b|\bcollab(oration)?\b|\bin exchange\b|\bpartnership\b/,
};

/** "$150", "150 USD", "150 dollars": whole dollars. */
export function feeIn(text: string): number | null {
  const match = text.match(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/) ?? text.match(/\b(\d{1,3}(?:,\d{3})+|\d+)\s?(?:usd|dollars)\b/i);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) && value >= 0 && value <= 1_000_000 ? Math.round(value) : null;
}

/** The sentences that end in a question mark, tidied, at most three. */
export function questionsIn(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/(?<=[?!.])\s+|\n+/)) {
    const sentence = raw.trim();
    if (!sentence.endsWith("?")) continue;
    // Leading emoji, dashes and the like go; the question starts at its first letter.
    const clean = sentence
      .replace(/^[^\p{L}\p{N}"'(]+/u, "")
      // "Also do you ship?" stands alone as "Do you ship?".
      .replace(/^(also|and|plus|oh|btw|so),?\s+/i, "")
      .replace(/\s+$/, "")
      .replace(/\s+/g, " ");
    if (clean.length < 4) continue;
    out.push(clean.charAt(0).toUpperCase() + clean.slice(1, 160));
    if (out.length === MAX_QUESTIONS) break;
  }
  return out;
}

/** The built-in reader: signals in the words, in order of certainty. */
export function readWithRules(text: string): Reading {
  const t = text.toLowerCase();
  const has = (re: RegExp) => re.test(t);
  const fee = feeIn(text);
  const questions = questionsIn(text);
  const askedProducts = has(SIGNALS.product);

  let replyClass: ReplyClass = "other";
  let confidence = 0.4;
  if (has(SIGNALS.no)) {
    replyClass = "not_interested";
    confidence = 0.9;
  } else if (has(SIGNALS.later)) {
    replyClass = "maybe_later";
    confidence = 0.8;
  } else if (fee !== null || has(SIGNALS.feeWords)) {
    replyClass = "rate_requested";
    confidence = fee !== null ? 0.85 : 0.72;
  } else if (has(SIGNALS.affiliate)) {
    replyClass = "interested_affiliate";
    confidence = 0.8;
  } else if (askedProducts && has(SIGNALS.yes)) {
    replyClass = "interested_gifted";
    confidence = 0.9;
  } else if (has(SIGNALS.yes) && has(SIGNALS.gifted)) {
    replyClass = "interested_gifted";
    confidence = 0.85;
  } else if (askedProducts) {
    replyClass = "product_info";
    confidence = 0.75;
  } else if (has(SIGNALS.yes)) {
    replyClass = "interested_gifted";
    confidence = 0.72;
  } else if (questions.length > 0) {
    replyClass = "needs_details";
    confidence = 0.7;
  }

  const sure = confidence >= SURE;
  return {
    replyClass,
    confidence,
    sure,
    warmth: sure ? WARMTH_OF[replyClass] : null,
    summary: sure ? summaryFor(replyClass, { fee, askedProducts, questions, keen: has(SIGNALS.yes) }) : "Not sure what they mean, please pick.",
    questions,
    fee,
    reader: "rules",
    version: RULES_VERSION,
  };
}

function summaryFor(replyClass: ReplyClass, facts: { fee: number | null; askedProducts: boolean; questions: string[]; keen: boolean }): string {
  const parts: string[] = [];
  switch (replyClass) {
    case "not_interested":
      parts.push("Not interested");
      break;
    case "maybe_later":
      parts.push("Maybe later");
      break;
    case "rate_requested":
      parts.push(facts.fee !== null ? `Asks for a fee: $${facts.fee.toLocaleString("en-US")}` : "Asks about payment");
      break;
    case "interested_affiliate":
      parts.push("Wants an affiliate deal");
      break;
    case "interested_gifted":
      parts.push("Keen on a gifted collab");
      break;
    case "product_info":
      parts.push("Asks which products they can choose");
      break;
    case "needs_details":
      parts.push("Has questions");
      break;
    default:
      parts.push("Something else");
  }
  if (facts.askedProducts && replyClass !== "product_info") parts.push("asks which products");
  const other = facts.questions.filter((q) => !/\b(which|what|choose|pick)\b.*\b(ones?|products?|items?|pieces?|colou?rs?)\b/i.test(q));
  if (other.length > 0) parts.push(`asks "${other[0]}"`);
  const joined = parts.join(", ");
  const text = /[?.!"]$/.test(joined) ? joined : `${joined}.`;
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

/** What Rachna says once the reply is logged, by the class the person confirmed. */
export function afterReplyLine(replyClass: ReplyClass): { pose: "point" | "idle" | "cheer" | "think"; text: string } | null {
  switch (replyClass) {
    case "interested_gifted":
    case "product_info":
      return { pose: "cheer", text: "Keen! Send the selection link today, while they're warm." };
    case "interested_affiliate":
      return { pose: "point", text: "Affiliate it is. Send the selection link and the affiliate terms." };
    case "rate_requested":
      return { pose: "think", text: "A fee is on the table. A person decides the fee, then you reply." };
    case "needs_details":
      return { pose: "point", text: "Answer their questions first, then it moves on." };
    case "maybe_later":
      return { pose: "idle", text: "Parked. I'll bring them back on the date you set." };
    case "not_interested":
      return { pose: "idle", text: "Closed, no more follow-ups to them." };
    default:
      return null;
  }
}
