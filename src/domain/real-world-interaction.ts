import type { ConfidenceLevel } from "./commercial-intelligence.js";

export const INTERACTION_TYPES = [
  "PHONE_CALL",
  "MEETING",
  "DEMO",
  "ROADSHOW_CONVERSATION",
  "EMAIL_EXCHANGE",
  "PARTNER_DISCUSSION",
  "PRICING_DISCUSSION",
  "IMPLEMENTATION_DISCUSSION",
  "SUPPORT_CONVERSATION",
  "OTHER",
  "POSSIBLE_INTERACTION",
  "UNKNOWN",
] as const;

export type InteractionType = (typeof INTERACTION_TYPES)[number];

export const INTERACTION_DIRECTIONS = ["INBOUND", "OUTBOUND", "BIDIRECTIONAL", "UNKNOWN"] as const;
export type InteractionDirection = (typeof INTERACTION_DIRECTIONS)[number];

export const INTERACTION_SOURCE_TYPES = [
  "ZOHO_CALL",
  "ZOHO_MEETING",
  "ZOHO_EMAIL",
  "ZOHO_NOTE",
  "ZOHO_DEAL",
  "ZOHO_TASK",
  "USAGE",
  "INFERRED_FROM_EMAIL",
  "INFERRED_FROM_NOTE",
] as const;

export type InteractionSourceType = (typeof INTERACTION_SOURCE_TYPES)[number];

export const COMMERCIAL_SIGNAL_TYPES = [
  "interest",
  "objection",
  "pain_point",
  "requested_feature",
  "accounting_software",
  "competitor",
  "pricing_discussion",
  "discount_discussion",
  "decision_maker_involvement",
  "management_approval_required",
  "buying_intent",
  "timing",
  "promised_follow_up",
  "next_step_commitment",
  "partner_interest",
  "referral_opportunity",
  "implementation_status",
  "registration_intent",
  "activation_issue",
  "reason_for_delay",
  "reason_for_loss",
  "relationship_sentiment",
] as const;

export type CommercialSignalType = (typeof COMMERCIAL_SIGNAL_TYPES)[number];

export type CommercialSignal = {
  type: CommercialSignalType;
  text: string;
  layer: "source_fact" | "interpretation";
  sourceEvidenceIds: string[];
};

export type CorroborationKind = "single" | "independent" | "repeated_reference";

export type RealWorldInteraction = {
  id: string;
  interaction_type: InteractionType;
  occurred_at?: string;
  approximate_date?: string;
  participants: string[];
  organisation?: string;
  direction: InteractionDirection;
  source_evidence_ids: string[];
  source_types: InteractionSourceType[];
  summary: string;
  outcome?: string;
  commercial_signals: CommercialSignal[];
  follow_up_commitment?: string;
  confidence: ConfidenceLevel;
  provenance: string;
  /** Distinct source evidence records supporting this event. Not the number of events. */
  supporting_evidence_count: number;
  /** Stable key for named historical events, e.g. roadshow:xero. */
  event_key?: string;
  corroboration: CorroborationKind;
};

export type ReconstructedTimelineEvent = {
  at?: string;
  approximate: boolean;
  kind: "confirmed_crm" | "inferred_real_world" | "usage" | "operator_sales_event";
  title: string;
  interactionId?: string;
  source: string;
};
