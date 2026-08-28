import type { ConfidenceLevel, NextAction, SalesMotion } from "./commercial-intelligence.js";
import type { ProductId, ProductRelationshipState } from "./product-relationship.js";

export const ACTION_TIMINGS = [
  "ACT_NOW",
  "TODAY",
  "OVERDUE",
  "SCHEDULED_DATE",
  "WAIT_UNTIL",
  "NO_ACTION_REQUIRED",
] as const;
export type ActionTiming = (typeof ACTION_TIMINGS)[number];

export const STALLED_STATES = [
  "NOT_STALLED",
  "WATCH",
  "STALLED",
  "WAITING_ON_CUSTOMER",
  "WAITING_ON_US",
  "SCHEDULED_FOLLOW_UP",
  "INSUFFICIENT_EVIDENCE",
] as const;
export type StalledState = (typeof STALLED_STATES)[number];

export const ACTION_EXECUTABILITIES = [
  "EXECUTABLE_NOW",
  "WAITING_FOR_TIME",
  "WAITING_FOR_CUSTOMER",
  "DATA_REQUIRED",
  "NO_ACTION_REQUIRED",
] as const;
export type ActionExecutability = (typeof ACTION_EXECUTABILITIES)[number];

export const PRIORITY_BANDS = ["P0", "P1", "P2", "P3", "P4", "P5"] as const;
export type PriorityBand = (typeof PRIORITY_BANDS)[number];

export const WATCH_ACTIONS = [
  "PERSONAL_EMAIL",
  "PHONE_CALL",
  "PARTNER_INVITATION",
  "PRODUCT_ACTIVATION_EMAIL",
  "DEMO_INVITATION",
  "REACTIVATION_EMAIL",
  "USAGE_CHECK",
  "EXTERNAL_ENRICHMENT",
  "HUMAN_REVIEW",
  "NURTURE",
  "WAIT",
  "RESCHEDULE",
  "CONTACT_ALTERNATIVE_PERSON",
  "NO_ACTION",
  "FOLLOW_UP",
] as const;
export type WatchAction = (typeof WATCH_ACTIONS)[number];

export const WATCH_SIGNAL_CODES = [
  "FOLLOW_UP_OVERDUE",
  "FOLLOW_UP_DUE_TODAY",
  "FOLLOW_UP_DUE_SOON",
  "CUSTOMER_COMMITMENT_PENDING",
  "OPERATOR_COMMITMENT_OVERDUE",
  "RECENT_OUTBOUND_UNANSWERED",
  "MULTIPLE_OUTBOUND_ATTEMPTS_UNANSWERED",
  "MEETING_AGREED",
  "MEETING_MISSED",
  "RESCHEDULE_REQUIRED",
  "NO_RECENT_MEANINGFUL_ACTIVITY",
  "LIVE_DEAL_PRESENT",
  "HISTORICAL_DEAL_ONLY",
  "ACTIVE_PRODUCT_USAGE",
  "USAGE_GROWING",
  "USAGE_UNKNOWN",
  "ACCOUNTING_CONNECTION_PRESENT",
  "MULTIPLE_RELEVANT_CONTACTS",
  "CRM_FRAGMENTATION_PRESENT",
  "RECENT_MEANINGFUL_ENGAGEMENT",
  "POSSIBLE_MATCH_REVIEW",
  "USAGE_DATASET_UNAVAILABLE",
] as const;
export type WatchSignalCode = (typeof WATCH_SIGNAL_CODES)[number];

export type WatchSignal = {
  code: WatchSignalCode;
  message: string;
};

export type CommandCentreThresholds = {
  timeZone: string;
  quietDaysWatch: number;
  quietDaysStalled: number;
  unansweredAttemptsForStall: number;
  maxRecordsPerModule: number;
  analyseConcurrency: number;
  notes: string;
};

export const DEFAULT_COMMAND_CENTRE_THRESHOLDS: CommandCentreThresholds = {
  timeZone: "Africa/Johannesburg",
  quietDaysWatch: 21,
  quietDaysStalled: 45,
  unansweredAttemptsForStall: 2,
  maxRecordsPerModule: 200,
  analyseConcurrency: 2,
  notes:
    "Interim V1 thresholds. An old deal alone is not stalled. overdue commitments outrank generic live opportunities.",
};

export type UniverseRecord = {
  module: "Leads" | "Contacts" | "Accounts" | "Deals";
  recordId: string;
  name: string;
  email?: string;
  company?: string;
  accountId?: string;
  accountName?: string;
  contactId?: string;
  lastActivityAt?: string;
  modifiedAt?: string;
  stage?: string;
  pipeline?: string;
  retrieval: "RETRIEVED" | "EMPTY" | "UNAVAILABLE" | "ERROR";
};

export type OrganisationCluster = {
  organisationId: string;
  organisationName: string;
  domains: string[];
  accountIds: string[];
  records: UniverseRecord[];
  possibleMatchReviews: Array<{ recordId: string; name: string; reason: string }>;
  representative: { module: "Leads" | "Contacts" | "Accounts"; recordId: string; name: string };
  lastActivityAt?: string;
  lastModifiedAt?: string;
};

export type CommercialWatchItem = {
  id: string;
  organisation_id: string;
  organisation_name: string;
  product_scope: ProductId;
  relationship_state: ProductRelationshipState | "UNCLEAR";
  primary_contact_id?: string;
  primary_contact_name?: string;
  recommended_contact_id?: string;
  recommended_contact_name?: string;
  recommended_contact_reason?: string;
  deal_ids: string[];
  lead_ids: string[];
  contact_ids: string[];
  primary_motion?: SalesMotion;
  next_best_action: WatchAction;
  executability: ActionExecutability;
  decision: string;
  action_timing: ActionTiming;
  action_due_at?: string;
  confidence: ConfidenceLevel;
  why_this_action: string;
  commercial_summary: string;
  last_meaningful_activity_at?: string;
  next_commitment_at?: string;
  stalled_state: StalledState;
  stalled_reasons: string[];
  urgency_signals: WatchSignal[];
  opportunity_signals: WatchSignal[];
  risk_signals: WatchSignal[];
  usage_signals: WatchSignal[];
  data_quality_signals: WatchSignal[];
  evidence_refs: string[];
  analysis_generated_at?: string;
  source_analysis_id?: string;
  source_record: { module: string; recordId: string };
  priority: PriorityBand;
  rank: number;
  why_ranked: string;
  reuse: "reused" | "refreshed" | "failed" | "insufficient";
};

export type PortfolioFailure = {
  organisation_id?: string;
  organisation_name?: string;
  stage: "discovery" | "analysis" | "openai" | "brief" | "grouping";
  state: "ERROR" | "UNAVAILABLE";
  message: string;
};

export type PortfolioTokenUsage = {
  openai_calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

export type DailySalesBrief = {
  generated_at: string;
  mode: "deterministic" | "openai_synthesis";
  today_at_a_glance: string;
  do_first: string[];
  follow_up_today: string[];
  stalled: string[];
  wait: string[];
  reengage: string[];
  recent_changes: string[];
  warnings: string[];
  narrative?: string;
};

export type PortfolioSnapshot = {
  generated_at: string;
  run_id: string;
  duration_ms: number;
  mode: "scan" | "build_changed" | "full_rebuild" | "selected";
  organisations_discovered: number;
  watch_items: CommercialWatchItem[];
  ranking_note: string;
  stalled_count: number;
  waiting_count: number;
  needs_action_today: number;
  active_opportunities: number;
  brief: DailySalesBrief;
  failures: PortfolioFailure[];
  tokens: PortfolioTokenUsage;
  analyses_reused: number;
  analyses_refreshed: number;
  analyses_failed: number;
  truncated?: boolean;
  truncated_reason?: string;
};

export type ScanEstimate = {
  generated_at: string;
  organisations_discovered: number;
  universe_size?: number;
  analyses_reusable: number;
  analyses_require_refresh: number;
  retrieval_warnings: string[];
  truncated?: boolean;
  truncated_reason?: string;
  records_by_module?: { Contacts: number; Leads: number; Deals: number };
  selection_method?: string;
  organisations_selected?: number;
  organisations: Array<{
    organisation_id: string;
    organisation_name: string;
    representative: OrganisationCluster["representative"];
    reuse: "reuse" | "refresh" | "missing";
    reuse_reason: string;
    fingerprint: string;
    contact_count: number;
    lead_count: number;
    deal_count: number;
    possible_match_reviews: number;
    listing_tags?: string[];
  }>;
  tokens: PortfolioTokenUsage;
  openai_would_be_called: number;
};

export function asWatchAction(value: NextAction | WatchAction | string | undefined): WatchAction {
  if (value && (WATCH_ACTIONS as readonly string[]).includes(value)) return value as WatchAction;
  return "HUMAN_REVIEW";
}
