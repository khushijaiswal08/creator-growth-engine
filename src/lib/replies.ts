import type { CollaborationType, CreatorStatus } from "@prisma/client";

/** How a creator's reply is sorted. Each class decides the status and what happens next. */
export const REPLY_CLASSES = [
  "interested_gifted",
  "interested_affiliate",
  "rate_requested",
  "product_info",
  "needs_details",
  "maybe_later",
  "not_interested",
  "other",
] as const;

export type ReplyClass = (typeof REPLY_CLASSES)[number];

export const REPLY_CLASS_LABELS: Record<ReplyClass, string> = {
  interested_gifted: "Interested in a gifted collaboration",
  interested_affiliate: "Wants affiliate only",
  rate_requested: "Asks for payment",
  product_info: "Asks which products they can choose",
  needs_details: "Has questions, needs an answer",
  maybe_later: "Maybe later",
  not_interested: "Not interested",
  other: "Something else",
};

export const REPLY_OUTCOMES: Record<
  ReplyClass,
  { status: CreatorStatus; collaborationType?: CollaborationType; explains: string }
> = {
  interested_gifted: { status: "interested", collaborationType: "gifted", explains: "Next: send the product selection link." },
  interested_affiliate: { status: "interested", collaborationType: "affiliate", explains: "Next: send the product selection link and affiliate terms." },
  rate_requested: { status: "negotiating", collaborationType: "paid", explains: "Next: a person decides on the fee." },
  product_info: { status: "interested", explains: "Next: send the product selection link." },
  needs_details: { status: "replied", explains: "Next: answer the creator." },
  maybe_later: { status: "on_hold", explains: "Parked until the date you choose." },
  not_interested: { status: "not_interested", explains: "Closed. No more follow-ups." },
  other: { status: "replied", explains: "Next: answer the creator." },
};

export function isReplyClass(value: string): value is ReplyClass {
  return (REPLY_CLASSES as readonly string[]).includes(value);
}
