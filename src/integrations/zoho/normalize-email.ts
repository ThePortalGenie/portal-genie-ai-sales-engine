import { splitCurrentEmailMessage } from "../../content/email-current-message.js";
import { htmlToPlainText } from "../../content/html-to-text.js";
import type {
  EmailDirection,
  EmailInteractionFacts,
  EmailParty,
  EmailSourceType,
  NormalizedEmail,
} from "../../domain/normalized-email.js";
import { asJsonObject } from "./http.js";

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeAddress(value: string | null): string | null {
  return value ? value.trim().toLowerCase() : null;
}

export function parseEmailParty(value: unknown): EmailParty | null {
  const object = asJsonObject(value);
  if (object) {
    const email = text(object.email) ?? text(object.Email);
    const name = text(object.user_name) ?? text(object.name);
    if (!email && !name) return null;
    return { name, email };
  }
  if (typeof value === "string" && value.includes("@")) {
    return { name: null, email: value.trim() };
  }
  return null;
}

export function parseEmailParties(value: unknown): EmailParty[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.map(parseEmailParty).filter((item): item is EmailParty => item !== null);
  }
  const single = parseEmailParty(value);
  return single ? [single] : [];
}

export function sourceTypeFromListType(listType: string | "default" | undefined): EmailSourceType {
  if (listType === "sent_from_crm" || listType === "scheduled_in_crm" || listType === "drafts") {
    return "crm_email";
  }
  if (listType === "user_emails") {
    return "user_email";
  }
  return "other";
}

/**
 * Direction from Zoho metadata and addresses only. Never from subject or body wording.
 */
export function resolveEmailDirection(options: {
  sent: boolean | null;
  statusTypes: string[];
  senderEmail: string | null;
  recipientEmails: string[];
  prospectEmails: string[];
}): { direction: EmailDirection; evidence: string } {
  if (options.sent === true) {
    return { direction: "outbound", evidence: "Zoho sent=true" };
  }
  if (options.sent === false) {
    return { direction: "inbound", evidence: "Zoho sent=false" };
  }
  if (options.statusTypes.includes("sent") || options.statusTypes.includes("scheduled")) {
    return { direction: "outbound", evidence: `Zoho status=${options.statusTypes.join(",")}` };
  }

  const prospect = new Set(options.prospectEmails.map(normalizeAddress).filter(Boolean) as string[]);
  const from = normalizeAddress(options.senderEmail);
  const recipients = options.recipientEmails.map(normalizeAddress).filter(Boolean) as string[];

  if (from && prospect.has(from)) {
    return { direction: "inbound", evidence: "sender matches the Zoho record email" };
  }
  if (from && !prospect.has(from) && recipients.some((email) => prospect.has(email))) {
    return { direction: "outbound", evidence: "recipient matches the Zoho record email; sender does not" };
  }

  return { direction: "unknown", evidence: "sent flag and address comparison were insufficient" };
}

function usableTime(value: unknown): string | null {
  const raw = text(value);
  if (!raw || Number.isNaN(Date.parse(raw))) return null;
  return raw;
}

export function normalizeZohoEmail(options: {
  listItem?: Record<string, unknown> | null;
  bodyItem?: Record<string, unknown> | null;
  listType?: string | "default";
  prospectEmails?: string[];
}): NormalizedEmail {
  const listItem = options.listItem ?? {};
  const bodyItem = options.bodyItem ?? {};
  const merged = { ...listItem, ...bodyItem };

  const sender = parseEmailParty(merged.from) ?? { name: null, email: null };
  const recipients = parseEmailParties(merged.to);
  const cc = parseEmailParties(merged.cc);
  const statusTypes = asArray(merged.status)
    .map((item) => text(asJsonObject(item)?.type)?.toLowerCase())
    .filter((item): item is string => Boolean(item));
  const sent = typeof merged.sent === "boolean" ? merged.sent : null;
  const { direction, evidence } = resolveEmailDirection({
    sent,
    statusTypes,
    senderEmail: sender.email,
    recipientEmails: [...recipients, ...cc].map((party) => party.email).filter((item): item is string => Boolean(item)),
    prospectEmails: options.prospectEmails ?? [],
  });

  const rawBody = text(bodyItem.content);
  const cleaned = rawBody ? htmlToPlainText(rawBody) : { text: "", truncated: false };
  const split = splitCurrentEmailMessage(cleaned.text);

  return {
    messageId: text(merged.message_id),
    threadId: text(merged.thread_id),
    at: usableTime(merged.time) ?? usableTime(merged.sent_time),
    direction,
    directionEvidence: evidence,
    sender,
    recipients,
    cc,
    subject: text(merged.subject),
    bodyText: split.fullCleanedBody || null,
    currentMessageText: split.currentMessageText || null,
    quoteStrippingConfidence: split.quoteStrippingConfidence,
    strippedQuotedHistory: split.strippedQuotedHistory,
    bodyTruncated: cleaned.truncated,
    sourceType: sourceTypeFromListType(options.listType),
    hasAttachment:
      typeof merged.has_attachment === "boolean"
        ? merged.has_attachment
        : Array.isArray(merged.attachments)
          ? merged.attachments.length > 0
          : null,
  };
}

export function buildEmailInteractionFacts(emails: NormalizedEmail[]): EmailInteractionFacts {
  const dated = emails
    .filter((email) => email.at && !Number.isNaN(Date.parse(email.at)))
    .slice()
    .sort((left, right) => Date.parse(left.at!) - Date.parse(right.at!));

  const last = dated[dated.length - 1];
  let inboundAfterOutbound = false;
  let consecutiveOutboundWithoutLaterInbound = 0;
  let seenOutbound = false;
  let streak = 0;

  for (const email of dated) {
    if (email.direction === "outbound") {
      seenOutbound = true;
      streak += 1;
    } else if (email.direction === "inbound") {
      if (seenOutbound) inboundAfterOutbound = true;
      streak = 0;
    }
  }
  consecutiveOutboundWithoutLaterInbound = streak;

  return {
    outboundCount: emails.filter((email) => email.direction === "outbound").length,
    inboundCount: emails.filter((email) => email.direction === "inbound").length,
    unknownDirectionCount: emails.filter((email) => email.direction === "unknown").length,
    lastAt: last?.at ?? null,
    lastDirection: last?.direction ?? null,
    inboundAfterOutbound,
    consecutiveOutboundWithoutLaterInbound,
  };
}

export function normalizeRetrievedEmail(
  header: {
    messageId: string | null;
    threadId?: string | null;
    subject: string | null;
    time: string | null;
    sent: boolean | null;
    from?: Record<string, unknown> | null;
    to?: unknown;
    cc?: unknown;
    hasAttachment: boolean | null;
    listType?: string | "default";
    statusTypes?: string[];
  },
  body: { rawContent?: string | null; threadId?: string | null; subject?: string | null } | undefined,
  prospectEmails: string[],
): NormalizedEmail {
  const sender = parseEmailParty(header.from) ?? { name: null, email: null };
  const recipients = parseEmailParties(header.to);
  const cc = parseEmailParties(header.cc);
  const { direction, evidence } = resolveEmailDirection({
    sent: header.sent,
    statusTypes: header.statusTypes ?? [],
    senderEmail: sender.email,
    recipientEmails: [...recipients, ...cc].map((party) => party.email).filter((item): item is string => Boolean(item)),
    prospectEmails,
  });
  const cleaned = body?.rawContent ? htmlToPlainText(body.rawContent) : { text: "", truncated: false };
  const split = splitCurrentEmailMessage(cleaned.text);
  return {
    messageId: header.messageId,
    threadId: body?.threadId ?? header.threadId ?? null,
    at: header.time && !Number.isNaN(Date.parse(header.time)) ? header.time : null,
    direction,
    directionEvidence: evidence,
    sender,
    recipients,
    cc,
    subject: body?.subject ?? header.subject,
    bodyText: split.fullCleanedBody || null,
    currentMessageText: split.currentMessageText || null,
    quoteStrippingConfidence: split.quoteStrippingConfidence,
    strippedQuotedHistory: split.strippedQuotedHistory,
    bodyTruncated: cleaned.truncated,
    sourceType: sourceTypeFromListType(header.listType),
    hasAttachment: header.hasAttachment,
  };
}

export function prospectEmailsFromRecord(record: Record<string, unknown> | null | undefined): string[] {
  if (!record) return [];
  const values = [record.Email, record.Secondary_Email, record.email];
  return values.map((value) => text(value)).filter((item): item is string => Boolean(item));
}
