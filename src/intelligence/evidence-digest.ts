import type { EvidenceItem } from "../domain/evidence.js";
import type { OrganisationGraph } from "../domain/organisation-graph.js";
import type { OrganisationRelationship, ProductRelationship } from "../domain/product-relationship.js";
import type { RealWorldInteraction, ReconstructedTimelineEvent } from "../domain/real-world-interaction.js";
import type { ContactIntelligence } from "./contact-intelligence.js";
import { orgEmailMetrics } from "./org-graph.js";
import type { OrganisationEvidenceProfile } from "./org-intelligence.js";
import { hasUnansweredOutboundSequence, trailingOutboundStreak } from "./unanswered-sequences.js";
import { buildSalesEventTemporal, salesEventsToTimeline } from "./sales-event-digest.js";
import { buildOperatorContextDigest } from "./operator-context-digest.js";
import type { OperatorDecision } from "../domain/operator-decision.js";
import type { SalesEvent } from "../domain/sales-event.js";

export const DEFAULT_REASONING_CONTEXT_BUDGET_CHARS = 10_000;

export function loadReasoningContextBudget(source: NodeJS.ProcessEnv = process.env): { maxChars: number } {
  const raw = source.REASONING_CONTEXT_BUDGET_CHARS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed >= 2000) {
    return { maxChars: Math.floor(parsed) };
  }
  return { maxChars: DEFAULT_REASONING_CONTEXT_BUDGET_CHARS };
}

export type DigestEmail = {
  at?: string;
  direction: string;
  subject?: string;
  current_message_text: string;
  evidence_id?: string;
  selection_reason: string;
  contact_name?: string;
  contact_id?: string;
  quote_stripping_confidence?: string;
};

export type DigestNote = {
  at?: string;
  title?: string;
  text: string;
  evidence_id?: string;
  selection_reason: string;
  owner_name?: string;
  owner_record_id?: string;
};

export type CommercialEvidenceDigest = {
  identity: ContactIntelligence["identity"];
  selected_contact: {
    name: string;
    record_id: string;
    email?: string;
    title?: string;
  };
  organisation: {
    name?: string;
    domains: string[];
    zohoAccountId?: string;
    certainty: "resolved" | "uncertain";
    member_count: number;
    members: Array<{ name: string; email?: string; title?: string; selected: boolean; certainty: string }>;
  };
  organisation_resolution: {
    certainty: "resolved" | "uncertain";
    domains: string[];
    zoho_records_merged: false;
    note: string;
  };
  related_contacts: Array<{
    name: string;
    record_id: string;
    email?: string;
    title?: string;
    selected: boolean;
    association_reasons: string[];
    role: string;
    role_layer: string;
  }>;
  related_accounts: Array<{
    name: string;
    record_id: string;
    association_reasons: string[];
    certainty: string;
  }>;
  possible_accounts_review: Array<{ name: string; record_id: string; association_reasons: string[] }>;
  possible_crm_fragmentation: OrganisationGraph["fragmentation"] | { possible_crm_fragmentation: false };
  product_relationships: ProductRelationship[];
  product_opportunities: OrganisationGraph["productOpportunities"];
  organisation_relationship: OrganisationRelationship;
  crm_state: {
    calls: number;
    meetings: number;
    tasks: number;
    deals: ContactIntelligence["deals"];
    lead_source?: string;
    confirmed_crm_activity: string;
  };
  usage_state: {
    product: "PORTAL_GENIE";
    status: string;
    label: string;
    message: string;
    imported_at?: string;
    organisation_summary?: OrganisationEvidenceProfile["usage"]["organisationSummary"];
    signals?: Array<{ code: string; message: string }>;
    contradictions?: Array<{ code: string; message: string }>;
    unmatched_contacts?: OrganisationEvidenceProfile["usage"]["unmatchedContacts"];
    profiles: Array<{
      layer?: string;
      name?: string;
      email?: string;
      client_id?: string;
      accounting_connected?: boolean | "unknown";
      accounting_platform?: string;
      last_login?: string;
      portal_visits_current?: number;
      portal_visits_previous?: number;
      portal_visits_two_months_ago?: number;
      portal_visit_trend?: string;
      document_upload_usage?: string;
      match_reason?: string;
      matched_contact?: string;
      data_quality?: string;
    }>;
    evidence_ids?: string[];
    portal_visits_note: "Portal visits = visits by the subscriber's clients, not subscriber logins.";
  };
  email_metrics: {
    outbound: number;
    inbound: number;
    last_inbound_at?: string | null;
    last_outbound_at?: string | null;
    last_direction?: string | null;
    contacts_engaged?: number;
    contacts_with_two_way?: number;
    selected_contact_trailing_outbound_streak: number;
    selected_contact_unanswered_sequence: boolean;
    organisation_unanswered_sequences: number;
    by_contact?: Array<{
      contact_id: string;
      name?: string;
      outbound: number;
      inbound: number;
      two_way: boolean;
      unanswered_last_outbound: boolean;
    }>;
  };
  contact_engagement_summary: string;
  operator_sales_events: Array<{
    id: string;
    occurred_at: string;
    event_type: string;
    outcome?: string;
    product_scope: string;
    contact_name?: string;
    contact_id?: string;
    summary: string;
    next_step?: string;
    follow_up_date?: string;
    provenance: string;
    layer: "operator_sales_event";
  }>;
  operator_context_notes: Array<{
    id: string;
    created_at: string;
    product_scope: string;
    watch_item_id: string;
    note: string;
    provenance: "OPERATOR";
    layer: "operator_context";
  }>;
  sales_event_temporal: {
    as_of: string;
    recent_operator_events: number;
    consecutive_no_answer_calls: Array<{ contact_name?: string; contact_id?: string; product_scope: string; count: number }>;
    consecutive_meeting_no_shows: Array<{ contact_name?: string; product_scope: string; count: number }>;
    explicit_follow_ups: Array<{
      event_id: string;
      contact_name?: string;
      product_scope: string;
      follow_up_date: string;
      due: boolean;
      next_step?: string;
    }>;
  };
  historical_losses: Array<{ product: string; deal_name?: string; stage?: string; contact_name?: string; deal_id: string }>;
  current_opportunities: Array<{ product: string; deal_name?: string; stage?: string; contact_name?: string; deal_id: string }>;
  data_quality_signals: string[];
  expansion_omissions: string[];
  consolidated_interactions: Array<{
    id: string;
    interaction_type: string;
    direction: string;
    approximate_date?: string;
    summary: string;
    outcome?: string;
    follow_up_commitment?: string;
    confidence: string;
    provenance: string;
    source_evidence_ids: string[];
    supporting_evidence_count: number;
    corroboration: string;
    commercial_signals: string[];
    participants?: string[];
  }>;
  commercial_timeline: Array<{ at?: string; approximate: boolean; kind: string; title: string; source: string }>;
  key_commercial_signals: string[];
  key_commitments_objections: string[];
  latest_relationship_state: string;
  unanswered_follow_up: string;
  important_unknowns: string[];
  contradictions: string[];
  selected_emails: DigestEmail[];
  selected_notes: DigestNote[];
  evidence_references: Array<{ id: string; type: string; claim: string; source: string }>;
  omitted_due_to_budget: string[];
  budget: { max_chars: number; used_chars: number };
};

const COMMERCIAL_EMAIL_PATTERNS: Array<{ pattern: RegExp; score: number; reason: string }> = [
  { pattern: /\b(management|director|board)\b.{0,40}\b(review|approv|consider|sign[- ]off)\b/i, score: 45, reason: "management consideration" },
  { pattern: /\b(too expensive|not a priority|already use|no budget|not interested|not proceeding)\b/i, score: 45, reason: "objection or loss" },
  { pattern: /\b(thank you for taking my call|telephone conversation|phone call)\b/i, score: 40, reason: "call outcome" },
  { pattern: /\b(following our meeting|thank you for meeting|accepted:|meeting request)\b/i, score: 40, reason: "meeting outcome" },
  { pattern: /\b(partner programme|partner program|firm partner|become a partner)\b/i, score: 35, reason: "partner discussion" },
  { pattern: /\b(price|pricing|discount|fee|cost)\b/i, score: 25, reason: "pricing" },
  { pattern: /\b(register|registration)\b/i, score: 30, reason: "registration" },
  { pattern: /\bimplement/i, score: 25, reason: "implementation" },
  { pattern: /\bfollow(?:ing)?[ -]?up\b/i, score: 25, reason: "follow-up commitment" },
  { pattern: /\b(would like a demo|ready to (buy|purchase|sign))\b/i, score: 30, reason: "buying intent" },
];

const ADMIN_NOTE = /^(updated?|changed|corrected)\s+(the\s+)?(phone|email|address|mobile|owner)/i;

function clip(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function latestAt(dates: Array<string | null | undefined>): string | null {
  const valid = dates.filter((item): item is string => typeof item === "string" && !Number.isNaN(Date.parse(item)));
  if (valid.length === 0) return null;
  return valid.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

export function scoreCommercialText(text: string): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  for (const item of COMMERCIAL_EMAIL_PATTERNS) {
    if (item.pattern.test(text)) {
      score += item.score;
      reasons.push(item.reason);
    }
  }
  return { score, reasons };
}

export function selectCommercialEmails(
  emails: Array<{
    at?: string | null;
    direction: string;
    subject?: string | null;
    bodyText?: string | null;
    currentMessageText?: string | null;
    messageId?: string | null;
    ownerName?: string;
    ownerRecordId?: string;
    quoteStrippingConfidence?: string;
  }>,
  limit = 4,
): Array<typeof emails[number] & { selectionScore: number; selectionReason: string }> {
  const ranked = emails.map((email, index) => {
    const text = `${email.subject ?? ""} ${email.currentMessageText || email.bodyText || ""}`;
    const { score, reasons } = scoreCommercialText(text);
    const inboundBonus = email.direction === "inbound" ? 50 : 0;
    const recencyBonus = Math.max(0, 12 - index);
    const total = score + inboundBonus + recencyBonus;
    return {
      ...email,
      selectionScore: total,
      selectionReason: [...(email.direction === "inbound" ? ["inbound response"] : []), ...reasons].join(", ") || "context",
    };
  });
  const meaningful = ranked.filter((item) => item.selectionScore >= 20 || item.direction === "inbound");
  const pool = meaningful.length > 0 ? meaningful : ranked;
  return [...pool].sort((left, right) => right.selectionScore - left.selectionScore).slice(0, limit);
}

export function selectCommercialNotes(
  notes: Array<{
    id?: string;
    title?: string;
    content?: string;
    at?: string;
    ownerName?: string;
    ownerRecordId?: string;
  }>,
  limit = 3,
): Array<typeof notes[number] & { selectionScore: number; selectionReason: string }> {
  const ranked = notes.map((note) => {
    const text = `${note.title ?? ""} ${note.content ?? ""}`;
    if (ADMIN_NOTE.test(text.trim())) {
      return { ...note, selectionScore: 0, selectionReason: "administrative" };
    }
    const { score, reasons } = scoreCommercialText(text);
    const callNote = /\b(called|voicemail|met with|demo)\b/i.test(text) ? 40 : 0;
    return {
      ...note,
      selectionScore: score + callNote,
      selectionReason: reasons.join(", ") || (callNote ? "interaction note" : "note"),
    };
  });
  return ranked
    .filter((item) => item.selectionScore >= 20)
    .sort((left, right) => right.selectionScore - left.selectionScore)
    .slice(0, limit);
}

function preferredCurrentMessage(email: {
  currentMessageText?: string | null;
  bodyText?: string | null;
  quoteStrippingConfidence?: string;
}): string {
  const current = email.currentMessageText?.trim() ?? "";
  const confidence = email.quoteStrippingConfidence;
  if ((confidence === "HIGH" || confidence === "MEDIUM") && current) {
    return clip(current, 420);
  }
  return clip(current || email.bodyText || "", 420);
}

function compactUsageState(
  usage: OrganisationEvidenceProfile["usage"],
): CommercialEvidenceDigest["usage_state"] {
  return {
    product: "PORTAL_GENIE",
    status: usage.status,
    label: usage.label,
    message: usage.message,
    imported_at: usage.importedAt,
    organisation_summary: usage.organisationSummary,
    signals: (usage.signals ?? []).map((item) => ({ code: item.code, message: item.message })),
    contradictions: (usage.contradictions ?? []).map((item) => ({ code: item.code, message: item.message })),
    unmatched_contacts: usage.unmatchedContacts,
    profiles: usage.profiles.map((profile) => ({
      layer: profile.layer,
      name: profile.name,
      email: profile.email,
      client_id: profile.clientId,
      accounting_connected: profile.accountingConnected,
      accounting_platform: profile.accountingPlatform ?? profile.accountingSoftware,
      last_login: profile.lastLoginAt,
      portal_visits_current: profile.portalVisitsCurrentMonth,
      portal_visits_previous: profile.portalVisitsPreviousMonth,
      portal_visits_two_months_ago: profile.portalVisitsTwoMonthsAgo,
      portal_visit_trend: profile.portalVisitTrend,
      document_upload_usage: profile.documentUploadUsage,
      match_reason: profile.matchReason ?? profile.matchMethod,
      matched_contact: profile.matchedContactName,
      data_quality: profile.dataQualityStatus,
    })),
    evidence_ids: usage.evidence.map((item) => item.id).slice(0, 12),
    portal_visits_note: "Portal visits = visits by the subscriber's clients, not subscriber logins.",
  };
}

function compactTimeline(
  events: ReconstructedTimelineEvent[],
  unanswered?: string,
): CommercialEvidenceDigest["commercial_timeline"] {
  const operators = events.filter((event) => event.kind === "operator_sales_event");
  const inferred = events.filter((event) => event.kind === "inferred_real_world");
  const usage = events.filter((event) => event.kind === "usage");
  const crm = events.filter((event) => event.kind === "confirmed_crm").slice(-8);
  const compact = [...operators, ...inferred, ...usage, ...crm]
    .sort((left, right) => (right.at ? Date.parse(right.at) : 0) - (left.at ? Date.parse(left.at) : 0))
    .slice(0, 20)
    .map((event) => ({
      at: event.at,
      approximate: event.approximate,
      kind: event.kind,
      title: clip(event.title.replace(/\s+—.*/, (match) => (match.length > 80 ? `${match.slice(0, 80)}…` : match)), 140),
      source: event.source,
    }));
  if (unanswered) {
    compact.push({ at: undefined, approximate: true, kind: "confirmed_crm", title: unanswered, source: "email_metrics" });
  }
  return compact;
}

export function buildCommercialEvidenceDigest(options: {
  contact: ContactIntelligence;
  organisation: OrganisationEvidenceProfile;
  emails: Array<{
    at: string | null;
    direction: string;
    subject: string | null;
    bodyText?: string | null;
    currentMessageText?: string | null;
    messageId?: string | null;
    ownerName?: string;
    ownerRecordId?: string;
    quoteStrippingConfidence?: string;
  }>;
  evidence: EvidenceItem[];
  reconstruction: {
    interactions: RealWorldInteraction[];
    timeline: ReconstructedTimelineEvent[];
    relationshipProgression: string;
    confirmedCrmActivity: string;
    inferredRealWorldActivity: string;
  };
  products: ProductRelationship[];
  organisationRelationship: OrganisationRelationship;
  contradictions: string[];
  budget?: { maxChars: number };
  graph?: OrganisationGraph;
  salesEvents?: SalesEvent[];
  operatorContextDecisions?: OperatorDecision[];
  asOf?: string;
}): CommercialEvidenceDigest {
  const budget = options.budget ?? loadReasoningContextBudget();
  const emails = options.emails;
  const lastInbound = latestAt(emails.filter((item) => item.direction === "inbound").map((item) => item.at));
  const lastOutbound = latestAt(emails.filter((item) => item.direction === "outbound").map((item) => item.at));
  const graph = options.graph;
  const salesEvents = options.salesEvents ?? graph?.salesEvents ?? [];
  const operatorContextDecisions = options.operatorContextDecisions ?? [];
  const asOf = options.asOf ?? new Date().toISOString();
  const selectedContactEmails = graph
    ? graph.emails.filter((email) => email.ownerRecordId === options.contact.identity.recordId)
    : emails;
  const selectedContactTrailing = trailingOutboundStreak(selectedContactEmails);
  const selectedContactUnanswered = hasUnansweredOutboundSequence(selectedContactEmails);

  const digestEmails = graph
    ? graph.emails.map((email) => ({
        at: email.at,
        direction: email.direction,
        subject: email.subject,
        bodyText: email.bodyText,
        currentMessageText: email.currentMessageText,
        messageId: email.messageId,
        ownerName: email.ownerName,
        ownerRecordId: email.ownerRecordId,
        quoteStrippingConfidence: email.quoteStrippingConfidence,
      }))
    : emails;
  const digestNotes = graph
    ? graph.notes.map((note) => ({
        id: note.id,
        title: note.title,
        content: note.content,
        at: note.at,
        ownerName: note.ownerName,
        ownerRecordId: note.ownerRecordId,
      }))
    : options.organisation.notes;
  const orgMetrics = graph ? orgEmailMetrics(graph.emails) : undefined;
  const organisationUnanswered = orgMetrics?.unanswered_sequences ?? (selectedContactUnanswered ? 1 : 0);
  const unanswered = [
    `selected_contact_unanswered_sequence=${selectedContactUnanswered ? "yes" : "no"}`,
    `selected_contact_trailing_outbound_streak=${selectedContactTrailing}`,
    `organisation_unanswered_sequences=${organisationUnanswered}`,
    "Definition: an unanswered outbound sequence exists when that Contact's latest dated inbound/outbound email is outbound. Trailing streak is consecutive outbounds after the last inbound — a different metric.",
  ].join("; ");
  const selectedEmails = selectCommercialEmails(digestEmails);
  const selectedNotes = selectCommercialNotes(digestNotes);
  const signals = options.reconstruction.interactions.flatMap((item) =>
    item.commercial_signals.map((signal) => `${signal.layer}:${signal.type}:${clip(signal.text, 80)}`),
  );
  const uniqueSignals = [...new Set([
    ...signals,
    ...(options.organisation.usage.signals ?? []).map((item) => `usage:${item.code}`),
    ...(options.organisation.usage.contradictions ?? []).map((item) => `usage_contradiction:${item.code}`),
  ])].slice(0, 16);
  const commitments = uniqueSignals.filter((item) => /follow_up|next_step|objection|management|pricing|partner|referral/.test(item));
  const cited = new Set(
    [
      ...options.reconstruction.interactions.flatMap((item) => item.source_evidence_ids),
      ...options.organisationRelationship.evidence_ids,
      ...options.organisation.usage.evidence.map((item) => item.id),
    ].filter(Boolean),
  );
  const evidenceRefs = options.evidence
    .filter(
      (item) =>
        cited.has(item.id) ||
        item.type === "unknown" ||
        item.type === "operator_sales_event" ||
        item.type === "operator_context" ||
        /contradict/i.test(item.claim),
    )
    .slice(0, 32)
    .map((item) => ({ id: item.id, type: item.type, claim: clip(item.claim, 180), source: item.source }));

  const relatedContacts = graph
    ? graph.contacts.map((contact) => ({
        name: contact.name,
        record_id: contact.recordId,
        email: contact.email,
        title: contact.title,
        selected: contact.selected,
        association_reasons: contact.association_reasons,
        role: contact.commercial_role.role,
        role_layer: contact.commercial_role.layer,
      }))
    : options.organisation.members.map((member) => ({
        name: member.name,
        record_id: member.recordId,
        email: member.email,
        title: member.title,
        selected: member.selected,
        association_reasons: member.reasons,
        role: member.selected ? "SELECTED_CONTACT" : "UNKNOWN",
        role_layer: member.selected ? "crm_fact" : "derived_signal",
      }));
  const opportunities = graph?.productOpportunities ?? [];
  const historicalLosses = opportunities.filter((item) => item.status === "historical_lost");
  const currentOpportunities = opportunities.filter((item) => item.status === "current");
  const engagement = orgMetrics
    ? `${orgMetrics.contacts_engaged} contact(s) with email evidence; ${orgMetrics.contacts_with_two_way} with two-way communication; organisation_unanswered_sequences=${orgMetrics.unanswered_sequences}. Attribution is by Contact. This is not the selected-contact trailing outbound streak.`
    : `Selected Contact email metrics only (${options.contact.emails.outboundCount} outbound / ${options.contact.emails.inboundCount} inbound).`;

  const core: CommercialEvidenceDigest = {
    identity: options.contact.identity,
    selected_contact: {
      name: options.contact.identity.name,
      record_id: options.contact.identity.recordId,
      email: options.contact.identity.email,
      title: options.contact.identity.jobTitle,
    },
    organisation: {
      name: options.organisation.identity.name,
      domains: options.organisation.identity.domains,
      zohoAccountId: options.organisation.identity.zohoAccountId,
      certainty: options.organisation.identity.certainty,
      member_count: options.organisation.members.length,
      members: options.organisation.members.slice(0, 8).map((member) => ({
        name: member.name,
        email: member.email,
        title: member.title,
        selected: member.selected,
        certainty: member.certainty,
      })),
    },
    organisation_resolution: {
      certainty: options.organisation.identity.certainty,
      domains: options.organisation.identity.domains,
      zoho_records_merged: false,
      note: "Organisation associations are an intelligence graph above Zoho. CRM records were not merged, deleted, or rewritten.",
    },
    related_contacts: relatedContacts,
    related_accounts: (graph?.accounts ?? []).map((account) => ({
      name: account.name,
      record_id: account.recordId,
      association_reasons: account.association_reasons,
      certainty: account.certainty,
    })),
    possible_accounts_review: (graph?.possibleAccounts ?? []).map((account) => ({
      name: account.name,
      record_id: account.recordId,
      association_reasons: account.association_reasons,
    })),
    possible_crm_fragmentation: graph?.fragmentation ?? { possible_crm_fragmentation: false },
    organisation_relationship: options.organisationRelationship,
    product_relationships: options.products,
    product_opportunities: opportunities,
    crm_state: {
      calls: options.contact.calls,
      meetings: options.contact.meetings,
      tasks: options.contact.tasks,
      deals: options.organisation.deals.count > 0 ? options.organisation.deals : options.contact.deals,
      lead_source: options.contact.identity.source,
      confirmed_crm_activity: options.reconstruction.confirmedCrmActivity,
    },
    usage_state: compactUsageState(options.organisation.usage),
    email_metrics: {
      outbound: orgMetrics?.outbound ?? options.contact.emails.outboundCount,
      inbound: orgMetrics?.inbound ?? options.contact.emails.inboundCount,
      last_inbound_at: orgMetrics?.last_inbound_at ?? lastInbound,
      last_outbound_at: orgMetrics?.last_outbound_at ?? lastOutbound,
      last_direction: options.contact.emails.lastDirection,
      contacts_engaged: orgMetrics?.contacts_engaged,
      contacts_with_two_way: orgMetrics?.contacts_with_two_way,
      selected_contact_trailing_outbound_streak: selectedContactTrailing,
      selected_contact_unanswered_sequence: selectedContactUnanswered,
      organisation_unanswered_sequences: organisationUnanswered,
      by_contact: orgMetrics?.by_contact.map((row) => ({
        contact_id: row.contact_id,
        name: row.name,
        outbound: row.outbound,
        inbound: row.inbound,
        two_way: row.two_way,
        unanswered_last_outbound: row.unanswered_last_outbound,
      })),
    },
    contact_engagement_summary: engagement,
    operator_sales_events: [...salesEvents]
      .sort((left, right) => Date.parse(right.occurred_at) - Date.parse(left.occurred_at))
      .map((event) => ({
        id: event.id,
        occurred_at: event.occurred_at,
        event_type: event.event_type,
        outcome: event.outcome,
        product_scope: event.product_scope,
        contact_name: event.contact_name,
        contact_id: event.contact_id,
        summary: clip(event.summary, 360),
        next_step: event.next_step,
        follow_up_date: event.follow_up_date,
        provenance: event.provenance,
        layer: "operator_sales_event" as const,
      })),
    operator_context_notes: buildOperatorContextDigest(operatorContextDecisions),
    sales_event_temporal: buildSalesEventTemporal(salesEvents, asOf),
    historical_losses: historicalLosses.map((item) => ({
      product: item.product,
      deal_name: item.deal_name,
      stage: item.stage,
      contact_name: item.contact_name,
      deal_id: item.deal_id,
    })),
    current_opportunities: currentOpportunities.map((item) => ({
      product: item.product,
      deal_name: item.deal_name,
      stage: item.stage,
      contact_name: item.contact_name,
      deal_id: item.deal_id,
    })),
    data_quality_signals: (graph?.dataQualitySignals ?? []).map((item) => `${item.code}: ${item.message}`),
    expansion_omissions: (graph?.omissions ?? []).map((item) => `${item.kind}: ${item.omitted} omitted (${item.reason})`),
    consolidated_interactions: options.reconstruction.interactions.map((item) => ({
      id: item.id,
      interaction_type: item.interaction_type,
      direction: item.direction,
      approximate_date: item.approximate_date,
      summary: clip(item.summary, 160),
      outcome: item.outcome,
      follow_up_commitment: item.follow_up_commitment,
      confidence: item.confidence,
      provenance: clip(item.provenance, 220),
      source_evidence_ids: item.source_evidence_ids,
      supporting_evidence_count: item.supporting_evidence_count,
      corroboration: item.corroboration,
      commercial_signals: item.commercial_signals.map((signal) => `${signal.layer}:${signal.type}:${clip(signal.text, 60)}`),
      participants: item.participants.slice(0, 8),
    })),
    commercial_timeline: compactTimeline(
      [
        ...options.reconstruction.timeline,
        ...salesEventsToTimeline(salesEvents).filter(
          (event) => !options.reconstruction.timeline.some((item) => item.interactionId === event.interactionId),
        ),
      ],
      undefined,
    ),
    key_commercial_signals: uniqueSignals,
    key_commitments_objections: commitments,
    latest_relationship_state: options.reconstruction.relationshipProgression,
    unanswered_follow_up: unanswered,
    important_unknowns: options.evidence.filter((item) => item.type === "unknown").map((item) => item.claim).slice(0, 8),
    contradictions: options.contradictions,
    selected_emails: selectedEmails.map((email) => ({
      at: email.at ?? undefined,
      direction: email.direction,
      subject: email.subject ?? undefined,
      current_message_text: preferredCurrentMessage(email),
      evidence_id: email.messageId ?? undefined,
      selection_reason: email.selectionReason,
      contact_name: email.ownerName,
      contact_id: email.ownerRecordId,
      quote_stripping_confidence: email.quoteStrippingConfidence,
    })),
    selected_notes: selectedNotes.map((note) => ({
      at: note.at,
      title: note.title,
      text: clip(note.content ?? "", 320),
      evidence_id: note.id,
      selection_reason: note.selectionReason,
      owner_name: note.ownerName,
      owner_record_id: note.ownerRecordId,
    })),
    evidence_references: evidenceRefs,
    omitted_due_to_budget: [],
    budget: { max_chars: budget.maxChars, used_chars: 0 },
  };

  return applyBudget(core, budget.maxChars);
}

const DROPPABLE: Array<{ key: keyof CommercialEvidenceDigest; label: string }> = [
  { key: "evidence_references", label: "additional evidence references" },
  { key: "selected_notes", label: "lower-priority notes" },
  { key: "selected_emails", label: "older commercially meaningful emails" },
  { key: "possible_accounts_review", label: "possible account name matches (not joined)" },
  { key: "key_commercial_signals", label: "duplicate commercial signals" },
  { key: "commercial_timeline", label: "extended commercial timeline" },
  { key: "usage_state", label: "detailed usage profiles" },
];

function applyBudget(digest: CommercialEvidenceDigest, maxChars: number): CommercialEvidenceDigest {
  const omitted: string[] = [];
  const current = { ...digest, omitted_due_to_budget: omitted, budget: { max_chars: maxChars, used_chars: 0 } };
  const size = () => JSON.stringify(current).length;
  current.budget.used_chars = size();
  if (current.budget.used_chars <= maxChars) return current;

  for (const section of DROPPABLE) {
    if (size() <= maxChars) break;
    const value = current[section.key];
    if (Array.isArray(value) && value.length > 0) {
      const kept =
        section.key === "selected_emails" || section.key === "selected_notes"
          ? value.slice(0, 1)
          : section.key === "commercial_timeline"
            ? value.filter((item) => typeof item === "object" && item && "kind" in item && item.kind === "operator_sales_event")
            : [];
      const dropped = Array.isArray(value) ? value.length - kept.length : 0;
      if (dropped <= 0) continue;
      (current as unknown as Record<string, unknown>)[section.key] = kept;
      omitted.push(`${section.label} (${dropped} omitted)`);
    } else if (section.key === "usage_state") {
      current.usage_state = {
        ...current.usage_state,
        profiles: current.usage_state.profiles.slice(0, 2),
      };
      omitted.push(section.label);
    }
  }
  current.budget.used_chars = size();
  current.omitted_due_to_budget = omitted;
  return current;
}
