import { evidence, type EvidenceItem } from "../domain/evidence.js";
import { fingerprintEmailText } from "../content/email-current-message.js";
import type {
  CommercialSignal,
  CommercialSignalType,
  InteractionDirection,
  InteractionType,
  RealWorldInteraction,
  ReconstructedTimelineEvent,
} from "../domain/real-world-interaction.js";
import { consolidateInteractions } from "./event-consolidation.js";

export type NoteInput = {
  id?: string;
  title?: string;
  content?: string;
  at?: string;
  ownerName?: string;
  ownerRecordId?: string;
};

export type ExtractionResult = {
  interactions: RealWorldInteraction[];
  signals: CommercialSignal[];
  evidence: EvidenceItem[];
  timeline: ReconstructedTimelineEvent[];
  relationshipProgression: string;
  confirmedCrmActivity: string;
  inferredRealWorldActivity: string;
};

let interactionSeq = 0;

function nextInteractionId(): string {
  interactionSeq += 1;
  return `rw-${interactionSeq}`;
}

export function resetInteractionIds(): void {
  interactionSeq = 0;
}

function clip(value: string, max = 220): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function sentenceWindow(text: string, index: number): string {
  const start = text.lastIndexOf(".", index);
  const end = text.indexOf(".", index);
  const from = start >= 0 ? start + 1 : 0;
  const to = end >= 0 ? end + 1 : text.length;
  return text.slice(from, to).trim();
}

const CALL_FALSE_POSITIVES =
  /\b(call it|called it|we call|they call|what we call|callback url|conference call line|roll call|call centre software)\b/i;

function isFalseCallMention(text: string): boolean {
  return CALL_FALSE_POSITIVES.test(text) && !/\b(thank you for taking my call|took (my|our|the) call|called (him|her|them|james|john|me))\b/i.test(text);
}

type PatternHit = {
  type: InteractionType;
  direction: InteractionDirection;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  summary: string;
  outcome?: string;
  followUp?: string;
};

function classifyPhoneDirection(text: string, emailDirection?: string): InteractionDirection {
  if (/\b(customer|client|prospect|they|he|she)\s+called\b/i.test(text) || /\binbound call\b/i.test(text) || /\breturned (my|our) call\b/i.test(text)) {
    return "INBOUND";
  }
  if (/\b(i|we)\s+called\b/i.test(text) || /^\s*called\b/im.test(text) || /\bcalled\s+[A-Z]/i.test(text)) {
    return "OUTBOUND";
  }
  if (/\bthank you for taking my call\b/i.test(text)) {
    if (emailDirection === "outbound") return "OUTBOUND";
    if (emailDirection === "inbound") return "INBOUND";
    return "UNKNOWN";
  }
  if (emailDirection === "outbound") return "OUTBOUND";
  if (emailDirection === "inbound") return "INBOUND";
  return "UNKNOWN";
}

function extractFollowUp(text: string): string | undefined {
  const match =
    text.match(/\bfollow(?:ing)?[ -]?up\s+(?:next\s+)?(month|week|quarter|year|on\s+[^.]{3,40})\b/i) ??
    text.match(/\bfollow up\s+(next month|next week|in a month|tomorrow|on [^.]+)\b/i) ??
    text.match(/\b(next month|next week)\b/i);
  if (!match) return undefined;
  if (/\bfollow/i.test(text) || /\bnext (month|week)\b/i.test(text) && /\b(follow|catch up|touch base|ping)\b/i.test(text)) {
    return match[0];
  }
  if (/\bfollow/i.test(text)) return match[0];
  return undefined;
}

function phoneHit(text: string, emailDirection?: string): PatternHit | undefined {
  if (isFalseCallMention(text)) return undefined;
  if (isRoadshowContext(text) && !/\b(thank you for taking my call|telephone|phone call|on the phone|voicemail)\b/i.test(text)) {
    return undefined;
  }
  const thankYouCall = /\bthank you for taking my call\b/i.test(text) || /\bthanks for taking (my|the) call\b/i.test(text);
  const calledName = /\bcalled\s+[A-Za-z][a-zA-Z'-]+\b/i.test(text) || /^\s*called\b/im.test(text);
  const spokeCall = /\b(spoke to|spoke with)\b/i.test(text) && /\b(call|phone|telephone)\b/i.test(text);
  const voicemail = /\bvoicemail\b/i.test(text) || /\bleft a (voice\s*)?mail\b/i.test(text);
  const inbound = /\b(customer|client|prospect)\s+called\b/i.test(text) || /\binbound call\b/i.test(text) || /\breturned (my|our) call\b/i.test(text);
  const phoneWord = /\b(telephone|phone call|on the phone)\b/i.test(text);

  if (!(thankYouCall || calledName || spokeCall || voicemail || inbound || phoneWord)) {
    if (/\bcall\b/i.test(text) && !/\b(taking my call|took my call|called |phone)\b/i.test(text)) {
      return undefined;
    }
    return undefined;
  }

  const direction = classifyPhoneDirection(text, emailDirection);
  const followUp = extractFollowUp(text);
  const interested = /\b(likes? the concept|interested|keen)\b/i.test(text);
  return {
    type: "PHONE_CALL",
    direction,
    confidence: thankYouCall || calledName || inbound ? "HIGH" : "MEDIUM",
    summary: clip(sentenceWindow(text, text.search(/\b(call|called|phone|voicemail|telephone)\b/i)) || text),
    outcome: interested ? "interested; internal discussion may be required" : undefined,
    followUp,
  };
}

function isRoadshowContext(text: string): boolean {
  return /\broadshow\b/i.test(text);
}

function independentMeetingRequest(text: string): boolean {
  if (/\[book a meeting\]/i.test(text) && !/\b(meeting request|set up |accepted:)/i.test(text)) {
    return false;
  }
  return (
    /\b(calendar invite|accept(ed)? the meeting|meeting request)\b/i.test(text) ||
    /^accepted:/im.test(text) ||
    /\bset up (a |an )?(quick )?(online )?meeting\b/i.test(text)
  );
}

function meetingHit(text: string): PatternHit | undefined {
  if (isRoadshowContext(text) && !independentMeetingRequest(text)) {
    return undefined;
  }
  if (independentMeetingRequest(text)) {
    return {
      type: "MEETING",
      direction: "BIDIRECTIONAL",
      confidence: "MEDIUM",
      summary: clip(text),
      outcome: /\baccepted\b/i.test(text) ? "meeting accepted/arranged" : "meeting requested",
    };
  }
  if (
    /\bthank you for meeting(?: with me| with us)?\b/i.test(text) ||
    /\bfollowing our meeting\b/i.test(text) ||
    /\bmet with\b/i.test(text) ||
    /\bhad a meeting\b/i.test(text)
  ) {
    return {
      type: "MEETING",
      direction: "BIDIRECTIONAL",
      confidence: "HIGH",
      summary: clip(sentenceWindow(text, text.search(/\b(meeting|met with)\b/i)) || text),
    };
  }
  return undefined;
}

function demoHit(text: string): PatternHit | undefined {
  if (/\b(would like a demo|book a demo|schedule a demo|request(ed)? a demo|demo link)\b/i.test(text) && !/\b(following our|after (the|our)|thank you for (the|attending)|as demonstrated)\b/i.test(text)) {
    return undefined;
  }
  if (
    /\bfollowing (our|today'?s) .{0,40}(demo|demonstration)\b/i.test(text) ||
    /\bthank you for (the|attending (the|our)|joining (the|our)) (demo|demonstration)\b/i.test(text) ||
    /\bafter (the|our) (demo|demonstration)\b/i.test(text) ||
    /\bwe (ran|gave|hosted) (a|the) (demo|demonstration)\b/i.test(text) ||
    /\bas demonstrated during\b/i.test(text)
  ) {
    return {
      type: "DEMO",
      direction: "OUTBOUND",
      confidence: "HIGH",
      summary: clip(sentenceWindow(text, text.search(/\b(demo|demonstration|demonstrated)\b/i)) || text),
    };
  }
  return undefined;
}

function roadshowHit(text: string): PatternHit | undefined {
  if (!/\broadshow\b/i.test(text)) return undefined;
  if (/\b(conversation|spoke|speaking|met|meeting|caught up|discussed|connecting|connected)\b/i.test(text) || /\bfollowing our conversation at\b/i.test(text)) {
    return {
      type: "ROADSHOW_CONVERSATION",
      direction: "BIDIRECTIONAL",
      confidence: "HIGH",
      summary: clip(sentenceWindow(text, text.search(/\broadshow\b/i)) || text),
    };
  }
  return undefined;
}

function speakingAmbiguousHit(text: string): PatternHit | undefined {
  if (isRoadshowContext(text)) return undefined;
  if (/\b(great|nice|lovely|good)\s+(speaking|talking)\s+with\b/i.test(text) || /\bspeaking with both of you\b/i.test(text)) {
    if (/\b(call|phone|telephone|meeting|demo)\b/i.test(text)) return undefined;
    return {
      type: "POSSIBLE_INTERACTION",
      direction: "BIDIRECTIONAL",
      confidence: "MEDIUM",
      summary: clip(text),
      outcome: "A conversation is evidenced; channel is not confirmed as a phone call or meeting",
    };
  }
  return undefined;
}

function partnerDiscussionHit(text: string): PatternHit | undefined {
  if (/\b(partner (programme|program|offer|agreement|deal)|become a partner|firm partner)\b/i.test(text) && /\b(discuss|conversation|spoke|meeting|offer)\b/i.test(text)) {
    return {
      type: "PARTNER_DISCUSSION",
      direction: "UNKNOWN",
      confidence: "MEDIUM",
      summary: clip(text),
    };
  }
  return undefined;
}

function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+|\n+/).map((item) => item.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [text];
}

function classifyFragment(text: string, emailDirection?: string): PatternHit[] {
  return [
    phoneHit(text, emailDirection),
    meetingHit(text),
    demoHit(text),
    roadshowHit(text),
    partnerDiscussionHit(text),
    speakingAmbiguousHit(text),
  ].filter((item): item is PatternHit => Boolean(item));
}

export function classifyText(text: string, emailDirection?: string): PatternHit[] {
  const rank = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  const hits: PatternHit[] = [];
  for (const sentence of splitSentences(text)) {
    hits.push(...classifyFragment(sentence, emailDirection));
  }
  if (hits.length === 0) {
    hits.push(...classifyFragment(text, emailDirection));
  }
  const byType = new Map<InteractionType, PatternHit>();
  for (const hit of hits) {
    const existing = byType.get(hit.type);
    if (!existing || rank[hit.confidence] > rank[existing.confidence]) {
      byType.set(hit.type, hit);
    }
  }
  if (byType.has("ROADSHOW_CONVERSATION")) {
    byType.delete("POSSIBLE_INTERACTION");
  }
  if (byType.has("DEMO") && byType.has("MEETING")) {
    const demo = byType.get("DEMO");
    if (demo && /as demonstrated during/i.test(demo.summary)) {
      byType.delete("MEETING");
    }
  }
  const followUp = extractFollowUp(text);
  if (followUp) {
    for (const hit of byType.values()) {
      if (!hit.followUp) hit.followUp = followUp;
    }
  }
  return [...byType.values()];
}

const SIGNAL_PATTERNS: Array<{ type: CommercialSignalType; pattern: RegExp; layer: CommercialSignal["layer"] }> = [
  { type: "management_approval_required", pattern: /\b(management|director|board)\b.{0,40}\b(review|approv|consider|sign[- ]off)\b/i, layer: "source_fact" },
  { type: "management_approval_required", pattern: /\b(take it to|run it by|discuss(?:ing)? it with) (management|my partner|the partners|the director)\b/i, layer: "source_fact" },
  { type: "promised_follow_up", pattern: /\bfollow(?:ing)?[ -]?up\b/i, layer: "source_fact" },
  { type: "next_step_commitment", pattern: /\b(next step|I will send|we will send|let me take this to)\b/i, layer: "source_fact" },
  { type: "pricing_discussion", pattern: /\b(price|pricing|too expensive|cost|fee|discount)\b/i, layer: "source_fact" },
  { type: "discount_discussion", pattern: /\bdiscount\b/i, layer: "source_fact" },
  { type: "partner_interest", pattern: /\b(partner programme|partner program|become a partner|firm partner|interested in partnering)\b/i, layer: "interpretation" },
  { type: "referral_opportunity", pattern: /\b(refer(ral)?|introduce (you to|us to) (a |our )?client)\b/i, layer: "interpretation" },
  { type: "registration_intent", pattern: /\b(want to register|ready to register|please register|complete(?:d)? registration)\b/i, layer: "source_fact" },
  { type: "requested_feature", pattern: /\b(would like a demo|book a demo|schedule a demo|request(ed)? a demo)\b/i, layer: "source_fact" },
  { type: "objection", pattern: /\b(too expensive|not a priority|already use|no budget|not interested)\b/i, layer: "interpretation" },
  { type: "timing", pattern: /\b(next month|after year[- ]end|in (q[1-4]|january|february|march))\b/i, layer: "source_fact" },
  { type: "decision_maker_involvement", pattern: /\b(decision[- ]maker|needs? (his|her|their) partner|discuss it with (his|her|my) partner)\b/i, layer: "source_fact" },
  { type: "relationship_sentiment", pattern: /\b(great speaking|thank you for your time|stalled|gone quiet)\b/i, layer: "interpretation" },
];

function extractSignals(text: string, evidenceIds: string[]): CommercialSignal[] {
  const found: CommercialSignal[] = [];
  const seen = new Set<string>();
  for (const item of SIGNAL_PATTERNS) {
    const match = text.match(item.pattern);
    if (!match) continue;
    const key = `${item.type}:${match[0].toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      type: item.type,
      text: clip(match[0], 80),
      layer: item.layer,
      sourceEvidenceIds: evidenceIds,
    });
  }
  return found;
}

function toInteraction(options: {
  hit: PatternHit;
  sourceTypes: RealWorldInteraction["source_types"];
  evidenceIds: string[];
  at?: string;
  participants: string[];
  organisation?: string;
  provenance: string;
  signals: CommercialSignal[];
}): RealWorldInteraction {
  const approximate = Boolean(options.at);
  return {
    id: nextInteractionId(),
    interaction_type: options.hit.type,
    occurred_at: undefined,
    approximate_date: approximate ? options.at : undefined,
    participants: options.participants,
    organisation: options.organisation,
    direction: options.hit.direction,
    source_evidence_ids: options.evidenceIds,
    source_types: options.sourceTypes,
    summary: options.hit.summary,
    outcome: options.hit.outcome,
    commercial_signals: options.signals,
    follow_up_commitment: options.hit.followUp,
    confidence: options.hit.confidence,
    provenance: options.provenance,
    supporting_evidence_count: options.evidenceIds.length,
    corroboration: "single",
  };
}

export function extractFromNote(note: NoteInput, organisation?: string): { interactions: RealWorldInteraction[]; signals: CommercialSignal[]; evidence: EvidenceItem[] } {
  const text = note.content ?? "";
  if (!text.trim()) return { interactions: [], signals: [], evidence: [] };
  const hits = classifyText(text);
  const sourceEvidence = evidence({
    type: "crm_fact",
    claim: `Zoho Note${note.title ? ` “${note.title}”` : ""} dated ${note.at ?? "unknown"}: ${clip(text, 160)}`,
    source: "ZOHO_NOTE",
    recordId: note.id,
    observedAt: note.at,
  });
  const signals = extractSignals(text, [sourceEvidence.id]);
  if (hits.length === 0 && signals.length === 0) return { interactions: [], signals: [], evidence: [] };
  const interactions = hits.map((hit) =>
    toInteraction({
      hit,
      sourceTypes: ["INFERRED_FROM_NOTE", "ZOHO_NOTE"],
      evidenceIds: [sourceEvidence.id],
      at: note.at,
      participants: note.ownerName ? [note.ownerName] : [],
      organisation,
      provenance: `Inferred from Zoho Note${note.ownerName ? ` on ${note.ownerName}` : ""}${note.ownerRecordId ? ` (${note.ownerRecordId})` : ""}; not a Zoho ${hit.type === "PHONE_CALL" ? "Call" : hit.type === "MEETING" ? "Meeting" : "activity"} record.`,
      signals,
    }),
  );
  const derived = interactions.map((item) =>
    evidence({
      type: "derived_signal",
      claim: `Note evidence indicates a ${item.interaction_type.replaceAll("_", " ").toLowerCase()} (${item.direction.toLowerCase()}, confidence ${item.confidence}). This is not a Zoho ${item.interaction_type === "PHONE_CALL" ? "Call" : "activity"} record.`,
      source: "Note interaction reconstruction",
      derivedFrom: [sourceEvidence.id],
      observedAt: note.at,
    }),
  );
  for (const item of interactions) {
    item.source_evidence_ids = [sourceEvidence.id, ...derived.map((entry) => entry.id)];
  }
  return { interactions, signals, evidence: [sourceEvidence, ...derived] };
}

export function extractFromEmail(email: {
  messageId?: string | null;
  at?: string | null;
  direction: string;
  subject?: string | null;
  currentMessageText: string;
  organisation?: string;
  participants?: string[];
  ownerName?: string;
}): { interactions: RealWorldInteraction[]; signals: CommercialSignal[]; evidence: EvidenceItem[] } {
  const text = [email.subject, email.currentMessageText].filter(Boolean).join("\n");
  if (!text.trim()) return { interactions: [], signals: [], evidence: [] };
  const hits = classifyText(text, email.direction);
  const signals = extractSignals(text, []);
  if (hits.length === 0 && signals.length === 0) return { interactions: [], signals: [], evidence: [] };
  const sourceEvidence = evidence({
    type: "crm_fact",
    claim: `Zoho email${email.subject ? ` “${email.subject}”` : ""} dated ${email.at ?? "unknown"}: ${clip(email.currentMessageText || text, 160)}`,
    source: "ZOHO_EMAIL",
    recordId: email.messageId ?? undefined,
    observedAt: email.at ?? undefined,
  });
  for (const signal of signals) signal.sourceEvidenceIds = [sourceEvidence.id];
  const interactions = hits.map((hit) =>
    toInteraction({
      hit,
      sourceTypes: ["INFERRED_FROM_EMAIL", "ZOHO_EMAIL"],
      evidenceIds: [sourceEvidence.id],
      at: email.at ?? undefined,
      participants: email.participants?.length ? email.participants : email.ownerName ? [email.ownerName] : [],
      organisation: email.organisation,
      provenance: `Inferred from email wording. The email itself is a Zoho email; the referenced ${hit.type.replaceAll("_", " ").toLowerCase()} is not a Zoho activity record unless separately retrieved.`,
      signals,
    }),
  );
  const derived = interactions.map((item) =>
    evidence({
      type: "derived_signal",
      claim:
        item.interaction_type === "PHONE_CALL"
          ? `No formal Zoho Call record is required for this inference. Email evidence indicates a telephone conversation occurred (${item.confidence} confidence).`
          : item.interaction_type === "MEETING"
            ? `Email evidence indicates a meeting occurred. This is not a Zoho Meeting record.`
            : `Email evidence indicates ${item.interaction_type.replaceAll("_", " ").toLowerCase()}.`,
      source: "Email interaction reconstruction",
      derivedFrom: [sourceEvidence.id],
      observedAt: email.at ?? undefined,
    }),
  );
  for (const item of interactions) {
    item.source_evidence_ids = [sourceEvidence.id, ...derived.map((entry) => entry.id)];
  }
  return { interactions, signals, evidence: [sourceEvidence, ...derived] };
}

export function dedupeEmailCurrentMessages<T extends { currentMessageText: string; messageId?: string | null; threadId?: string | null }>(
  emails: T[],
): T[] {
  const seenFingerprints = new Set<string>();
  const seenIds = new Set<string>();
  const kept: T[] = [];
  for (const email of emails) {
    if (email.messageId && seenIds.has(email.messageId)) continue;
    const fingerprint = fingerprintEmailText(email.currentMessageText);
    if (fingerprint.length >= 12 && seenFingerprints.has(fingerprint)) continue;
    if (email.messageId) seenIds.add(email.messageId);
    if (fingerprint.length >= 12) seenFingerprints.add(fingerprint);
    kept.push(email);
  }
  return kept;
}

export function buildRelationshipProgression(options: {
  zohoCalls: number;
  zohoMeetings: number;
  interactions: RealWorldInteraction[];
  emailOutbound: number;
  emailInbound: number;
  leadSource?: string;
}): { relationshipProgression: string; confirmedCrmActivity: string; inferredRealWorldActivity: string } {
  const types = new Set(options.interactions.map((item) => item.interaction_type));
  const inferredCalls = options.interactions.filter((item) => item.interaction_type === "PHONE_CALL").length;
  const inferredMeetings = options.interactions.filter((item) => item.interaction_type === "MEETING").length;
  const roadshow = types.has("ROADSHOW_CONVERSATION") || /roadshow/i.test(options.leadSource ?? "");
  const partner = types.has("PARTNER_DISCUSSION") || options.interactions.some((item) => item.commercial_signals.some((signal) => signal.type === "partner_interest"));
  const management = options.interactions.some((item) => item.commercial_signals.some((signal) => signal.type === "management_approval_required"));
  const followUps = options.interactions.some((item) => item.follow_up_commitment || item.commercial_signals.some((signal) => signal.type === "promised_follow_up"));

  const confirmed: string[] = [];
  if (options.emailOutbound || options.emailInbound) {
    confirmed.push(`${options.emailOutbound} outbound and ${options.emailInbound} inbound Zoho email(s)`);
  }
  confirmed.push(`${options.zohoCalls} Zoho Call record(s)`);
  confirmed.push(`${options.zohoMeetings} Zoho Meeting record(s)`);
  if (roadshow && options.leadSource) confirmed.push(`Lead source ${options.leadSource}`);

  const inferred: string[] = [];
  if (inferredCalls > 0) inferred.push(`${inferredCalls} telephone interaction(s) inferred from notes/emails`);
  if (inferredMeetings > 0) inferred.push(`${inferredMeetings} meeting(s) inferred from notes/emails`);
  if (types.has("DEMO")) inferred.push("at least one demonstration referenced in correspondence");
  if (types.has("ROADSHOW_CONVERSATION")) inferred.push("a roadshow conversation referenced in correspondence");
  if (types.has("POSSIBLE_INTERACTION")) inferred.push("at least one conversation whose channel is not confirmed");
  if (inferred.length === 0) inferred.push("No real-world interactions were inferred beyond recorded CRM objects.");

  let progression = "Limited CRM object history; treat empty Calls/Meetings as missing records, not proof that conversations did not happen.";
  if (roadshow && options.emailOutbound > 0 && inferredCalls === 0 && inferredMeetings === 0 && options.emailInbound === 0) {
    progression = "Roadshow/source contact followed by outbound email with no evidenced conversation — not equivalent to a progressed sales discussion.";
  }
  if (inferredCalls > 0 || inferredMeetings > 0 || types.has("DEMO")) {
    const steps = [
      roadshow ? "roadshow contact" : undefined,
      options.emailOutbound > 0 ? "email outreach" : undefined,
      inferredCalls > 0 ? "telephone interaction" : undefined,
      inferredMeetings > 0 ? "meeting arranged or held" : undefined,
      types.has("DEMO") ? "demonstration or substantive discussion" : undefined,
      partner ? "partner/commercial discussion" : undefined,
      management ? "internal/management consideration" : undefined,
      followUps || options.emailOutbound > 2 ? "follow-up" : undefined,
    ].filter(Boolean);
    progression = `Progression evidenced: ${steps.join(" → ")}. Empty Zoho Calls/Meetings lists do not override inferred real-world activity.`;
    if (management && followUps) {
      progression += " The relationship appears more advanced than a single marketing email.";
    }
  }

  return {
    relationshipProgression: progression,
    confirmedCrmActivity: confirmed.join(". ") + ".",
    inferredRealWorldActivity: inferred.join(". "),
  };
}

export function mergeTimeline(options: {
  crmEvents: Array<{ at: string; title: string; source: string }>;
  interactions: RealWorldInteraction[];
}): ReconstructedTimelineEvent[] {
  const events: ReconstructedTimelineEvent[] = options.crmEvents.map((event) => ({
    at: event.at,
    approximate: false,
    kind: event.source.startsWith("email") || event.source === "note" || event.source === "deal" || event.source === "call" || event.source === "meeting"
      ? "confirmed_crm"
      : "confirmed_crm",
    title: event.title,
    source: event.source,
  }));
  for (const item of options.interactions) {
    events.push({
      at: item.approximate_date ?? item.occurred_at,
      approximate: !item.occurred_at,
      kind: "inferred_real_world",
      title: `${item.interaction_type.replaceAll("_", " ")} — ${item.summary}`,
      interactionId: item.id,
      source: item.source_types.join(","),
    });
  }
  return events.sort((left, right) => {
    const leftTime = left.at ? Date.parse(left.at) : 0;
    const rightTime = right.at ? Date.parse(right.at) : 0;
    return leftTime - rightTime;
  });
}

export function reconstructFromSources(options: {
  notes: NoteInput[];
  emails: Array<{
    messageId?: string | null;
    threadId?: string | null;
    at?: string | null;
    direction: string;
    subject?: string | null;
    currentMessageText: string;
    ownerName?: string;
    ownerRecordId?: string;
  }>;
  organisation?: string;
  zohoCalls: number;
  zohoMeetings: number;
  emailOutbound: number;
  emailInbound: number;
  leadSource?: string;
  crmEvents: Array<{ at: string; title: string; source: string }>;
}): ExtractionResult {
  resetInteractionIds();
  const evidenceItems: EvidenceItem[] = [];
  const interactions: RealWorldInteraction[] = [];
  const signals: CommercialSignal[] = [];

  for (const note of options.notes) {
    const extracted = extractFromNote(note, options.organisation);
    evidenceItems.push(...extracted.evidence);
    interactions.push(...extracted.interactions);
    signals.push(...extracted.signals);
  }

  const uniqueEmails = dedupeEmailCurrentMessages(options.emails);
  for (const email of uniqueEmails) {
    const extracted = extractFromEmail({ ...email, organisation: options.organisation, ownerName: email.ownerName });
    evidenceItems.push(...extracted.evidence);
    interactions.push(...extracted.interactions);
    signals.push(...extracted.signals);
  }

  const consolidated = consolidateInteractions(interactions);

  if (options.zohoCalls === 0 && consolidated.some((item) => item.interaction_type === "PHONE_CALL")) {
    evidenceItems.push(
      evidence({
        type: "derived_signal",
        claim: "No formal Zoho Call records were found. Other evidence indicates at least one telephone interaction.",
        source: "Real-world interaction reconstruction",
      }),
    );
  }
  if (options.zohoMeetings === 0 && consolidated.some((item) => item.interaction_type === "MEETING")) {
    evidenceItems.push(
      evidence({
        type: "derived_signal",
        claim: "No formal Zoho Meeting records were found. Other evidence indicates at least one meeting.",
        source: "Real-world interaction reconstruction",
      }),
    );
  }

  const progression = buildRelationshipProgression({
    zohoCalls: options.zohoCalls,
    zohoMeetings: options.zohoMeetings,
    interactions: consolidated,
    emailOutbound: options.emailOutbound,
    emailInbound: options.emailInbound,
    leadSource: options.leadSource,
  });

  return {
    interactions: consolidated,
    signals,
    evidence: evidenceItems,
    timeline: mergeTimeline({ crmEvents: options.crmEvents, interactions: consolidated }),
    ...progression,
  };
}
