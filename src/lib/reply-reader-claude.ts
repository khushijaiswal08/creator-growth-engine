import Anthropic from "@anthropic-ai/sdk";
import { REPLY_CLASSES, type ReplyClass } from "@/lib/replies";
import { feeIn, isWarmth, questionsIn, readWithRules, SURE, WARMTH_OF, type Reading } from "@/lib/reply-reader";
import { scoringConfigured } from "@/lib/scoring";

/**
 * The Claude reader, server-side only. With ANTHROPIC_API_KEY set it reads the
 * reply; without it, or when the call fails, the built-in rules read it. The
 * key never reaches the browser.
 */

export const CLAUDE_READER_VERSION = "claude-reply-v1";
const DEFAULT_MODEL = "claude-sonnet-5-5";

export function readerModel(): string {
  return process.env.ANTHROPIC_READER_MODEL?.trim() || DEFAULT_MODEL;
}

export function readerConfigured(): boolean {
  return scoringConfigured();
}

export type ReplyContext = {
  brand: string;
  campaign: string;
  creatorName: string;
  /** Where the reply came in: Instagram DM, email or Amazon. */
  channel: string;
  /** The last message the team sent, so a short "yes" makes sense. */
  lastOutbound: string | null;
};

const SYSTEM = `You read short replies from social media creators to a small home-decor brand that offers free block-printed products (tablecloths, napkins, cushion covers) in exchange for a post. Sort each reply into exactly one class:
- interested_gifted: happy to receive a free product and post about it.
- interested_affiliate: wants an affiliate or commission arrangement rather than, or as well as, a gift.
- rate_requested: asks to be paid, names a fee, or asks about budget.
- product_info: asks which products they can choose, or about the products themselves, without saying yes or no yet.
- needs_details: has questions the brand must answer before they decide (shipping, timing, what is expected).
- maybe_later: not now, busy, asks to be contacted later.
- not_interested: declines.
- other: none of the above, or impossible to tell.
Also give: confidence 0 to 1; warmth hot (keen), warm (open, needs something first) or cold (declining or parking); a one-line summary in plain English of at most 120 characters, starting with the gist ("Keen on a gifted collab, asks which products"); the questions they asked, each as one short sentence, at most three; and the fee in whole US dollars if they named one, else null. Never invent facts that are not in the reply.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    reply_class: { type: "string", enum: [...REPLY_CLASSES] },
    confidence: { type: "number" },
    warmth: { type: "string", enum: ["hot", "warm", "cold"] },
    summary: { type: "string" },
    questions: { type: "array", items: { type: "string" } },
    fee: { type: ["number", "null"] },
  },
  required: ["reply_class", "confidence", "warmth", "summary", "questions", "fee"],
  additionalProperties: false,
} as const;

/** Claude's answer, checked field by field; null when it cannot be trusted. */
function parse(text: string, raw: string): Reading | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const v = data as Record<string, unknown>;
  const replyClass = typeof v.reply_class === "string" && (REPLY_CLASSES as readonly string[]).includes(v.reply_class) ? (v.reply_class as ReplyClass) : null;
  if (!replyClass) return null;
  const confidence = typeof v.confidence === "number" && Number.isFinite(v.confidence) ? Math.min(1, Math.max(0, v.confidence)) : 0;
  const sure = confidence >= SURE;
  const summary = typeof v.summary === "string" ? v.summary.trim().slice(0, 160) : "";
  const questions = Array.isArray(v.questions) ? v.questions.filter((q): q is string => typeof q === "string" && q.trim().length > 3).map((q) => q.trim().slice(0, 160)).slice(0, 3) : questionsIn(raw);
  const feeRaw = typeof v.fee === "number" && Number.isFinite(v.fee) ? Math.round(v.fee) : null;
  const fee = feeRaw !== null && feeRaw >= 0 && feeRaw <= 1_000_000 ? feeRaw : feeIn(raw);
  return {
    replyClass,
    confidence,
    sure,
    warmth: sure ? (isWarmth(v.warmth) ? v.warmth : WARMTH_OF[replyClass]) : null,
    summary: sure && summary ? summary : "Not sure what they mean, please pick.",
    questions,
    fee,
    reader: "claude",
    version: CLAUDE_READER_VERSION,
  };
}

/** Read with Claude; on any failure, the rules. Never throws. */
export async function readReply(text: string, context: ReplyContext): Promise<Reading> {
  const raw = text.trim().slice(0, 5000);
  if (!readerConfigured()) return readWithRules(raw);
  try {
    const client = new Anthropic({ maxRetries: 2, timeout: 20_000 });
    const response = await client.beta.messages.create({
      model: readerModel(),
      max_tokens: 400,
      system: [{ type: "text", text: SYSTEM }],
      output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            `Brand: ${context.brand}. Campaign: ${context.campaign}. Creator: ${context.creatorName}. Channel: ${context.channel}.`,
            context.lastOutbound ? `The team last wrote: """${context.lastOutbound.slice(0, 600)}"""` : "The team's last message is not on record.",
            `The creator replied: """${raw}"""`,
          ].join("\n\n"),
        },
      ],
    });
    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") return readWithRules(raw);
    const answer = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    return parse(answer, raw) ?? readWithRules(raw);
  } catch (error) {
    // A missing key, a rate limit or a network blip: the rules read it, nobody waits.
    console.warn("Reply reader fell back to rules", error instanceof Error ? error.message : error);
    return readWithRules(raw);
  }
}
