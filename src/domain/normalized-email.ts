export type EmailDirection = "inbound" | "outbound" | "unknown";

export type EmailSourceType = "crm_email" | "user_email" | "other";

export type EmailParty = {
  name: string | null;
  email: string | null;
};

/**
 * Commercial interaction record for Sales Intelligence.
 * Direction is metadata-derived only. Body is cleaned plain text, not raw HTML.
 */
export type NormalizedEmail = {
  messageId: string | null;
  threadId: string | null;
  at: string | null;
  direction: EmailDirection;
  directionEvidence: string;
  sender: EmailParty;
  recipients: EmailParty[];
  cc: EmailParty[];
  subject: string | null;
  /** Full cleaned plain-text body, including quoted history. Not sent to OpenAI when currentMessageText is reliable. */
  bodyText: string | null;
  currentMessageText: string | null;
  quoteStrippingConfidence: "HIGH" | "MEDIUM" | "LOW";
  strippedQuotedHistory: boolean;
  bodyTruncated: boolean;
  sourceType: EmailSourceType;
  hasAttachment: boolean | null;
};

export type EmailInteractionFacts = {
  outboundCount: number;
  inboundCount: number;
  unknownDirectionCount: number;
  lastAt: string | null;
  lastDirection: EmailDirection | null;
  inboundAfterOutbound: boolean;
  consecutiveOutboundWithoutLaterInbound: number;
};
