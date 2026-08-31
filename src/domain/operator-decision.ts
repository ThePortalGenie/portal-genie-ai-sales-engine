import { createHash, randomUUID } from "node:crypto";
import type { ProductId } from "./product-relationship.js";
import type {
  ActionTiming,
  CommercialWatchItem,
  PriorityBand,
  WatchAction,
} from "./commercial-watch.js";

export const OPERATOR_DECISION_PROVENANCE = "OPERATOR" as const;
export const OPERATOR_DECISION_SCHEMA_VERSION = 1 as const;

export const OPERATOR_DECISION_TYPES = [
  "COMPLETED",
  "DISMISSED",
  "SNOOZED",
  "WAITING",
  "NOT_AN_OPPORTUNITY",
  "RESEARCH_REQUIRED",
  "WRONG_ACTION",
  "WRONG_PERSON",
  "ALREADY_HANDLED",
  "CONTEXT_ADDED",
  "REVOKED",
] as const;
export type OperatorDecisionType = (typeof OPERATOR_DECISION_TYPES)[number];

export const OPERATOR_REASON_CODES = [
  "NOT_INTERESTED_THIS_YEAR",
  "WRONG_CONTACT",
  "BOARD_MEETING_PENDING",
  "EXISTING_CUSTOMER_NOT_OPPORTUNITY",
  "STALE_RECOMMENDATION",
  "DO_NOT_CHASE",
  "OTHER",
] as const;
export type OperatorReasonCode = (typeof OPERATOR_REASON_CODES)[number];

export const QUALITY_FEEDBACK_KINDS = [
  "CORRECT",
  "WRONG_PRIORITY",
  "WRONG_ACTION",
  "WRONG_PERSON",
  "FALSE_OPPORTUNITY",
  "STALE_RECOMMENDATION",
  "INSUFFICIENT_EVIDENCE",
] as const;
export type QualityFeedbackKind = (typeof QUALITY_FEEDBACK_KINDS)[number];

export type DecisionContextSnapshot = {
  deal_ids?: string[];
  deal_stages?: Record<string, string>;
  recommended_contact_id?: string;
  next_best_action?: WatchAction;
};

export type OperatorDecision = {
  id: string;
  watch_item_id: string;
  organisation_key: string;
  product_scope: ProductId;
  recommendation_fingerprint: string;
  decision_type: OperatorDecisionType;
  reason_code?: OperatorReasonCode;
  operator_note?: string;
  created_at: string;
  effective_from: string;
  effective_until?: string;
  supersedes_decision_id?: string;
  evidence_snapshot_ref?: string;
  decision_context_snapshot?: DecisionContextSnapshot;
  linked_sales_event_id?: string;
  preferred_contact_id?: string;
  preferred_contact_name?: string;
  provenance: typeof OPERATOR_DECISION_PROVENANCE;
  explicit_quality_feedback?: QualityFeedbackKind;
  /** @deprecated Use contact_zoho_note_id. Retained for earlier context write-back records. */
  zoho_note_id?: string;
  contact_zoho_note_id?: string;
  deal_zoho_note_id?: string;
  zoho_written_at?: string;
};

export type QualityFeedback = {
  kind: QualityFeedbackKind;
  source: "EXPLICIT" | "INFERRED";
  decision_id: string;
  decision_type: OperatorDecisionType;
  at: string;
};

export class OperatorDecisionValidationError extends Error {
  readonly code = "OPERATOR_DECISION_VALIDATION_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "OperatorDecisionValidationError";
  }
}

function requireEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new OperatorDecisionValidationError(`${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function optionalEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireEnum(value, field, allowed);
}

function requireIsoDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new OperatorDecisionValidationError(`${field} must be a valid date/time`);
  }
  return new Date(value).toISOString();
}

function optionalIsoDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireIsoDate(value, field);
}

function optionalString(value: unknown, max = 4000): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function parseContextSnapshot(value: unknown): DecisionContextSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const deal_ids = Array.isArray(record.deal_ids)
    ? record.deal_ids.filter((item): item is string => typeof item === "string")
    : undefined;
  const deal_stages =
    record.deal_stages && typeof record.deal_stages === "object" && !Array.isArray(record.deal_stages)
      ? Object.fromEntries(
          Object.entries(record.deal_stages as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
          ),
        )
      : undefined;
  return {
    deal_ids,
    deal_stages,
    recommended_contact_id: optionalString(record.recommended_contact_id, 80),
    next_best_action: optionalEnum(record.next_best_action, "next_best_action", [
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
    ] as const),
  };
}

export type OperatorDecisionInput = {
  id?: unknown;
  watch_item_id?: unknown;
  organisation_key?: unknown;
  product_scope?: unknown;
  recommendation_fingerprint?: unknown;
  decision_type?: unknown;
  reason_code?: unknown;
  operator_note?: unknown;
  effective_from?: unknown;
  effective_until?: unknown;
  supersedes_decision_id?: unknown;
  evidence_snapshot_ref?: unknown;
  decision_context_snapshot?: unknown;
  linked_sales_event_id?: unknown;
  preferred_contact_id?: unknown;
  preferred_contact_name?: unknown;
  explicit_quality_feedback?: unknown;
};

export function recommendationFingerprint(input: {
  organisation_key: string;
  product_scope: ProductId;
  next_best_action: WatchAction;
  recommended_contact_id?: string;
  action_timing: ActionTiming;
  priority: PriorityBand;
}): string {
  const hash = createHash("sha256");
  hash.update(
    [
      input.organisation_key,
      input.product_scope,
      input.next_best_action,
      input.recommended_contact_id ?? "",
      input.action_timing,
      input.priority,
    ].join("\n"),
  );
  return hash.digest("hex").slice(0, 32);
}

export function recommendationFingerprintFromWatchItem(item: CommercialWatchItem): string {
  return recommendationFingerprint({
    organisation_key: item.organisation_id,
    product_scope: item.product_scope,
    next_best_action: item.next_best_action,
    recommended_contact_id: item.recommended_contact_id,
    action_timing: item.action_timing,
    priority: item.priority,
  });
}

export function decisionContextSnapshotFromWatchItem(item: CommercialWatchItem): DecisionContextSnapshot {
  return {
    deal_ids: [...item.deal_ids],
    recommended_contact_id: item.recommended_contact_id,
    next_best_action: item.next_best_action,
  };
}

export function parseOperatorDecisionInput(input: OperatorDecisionInput, existing?: OperatorDecision): OperatorDecision {
  const organisation_key = optionalString(input.organisation_key, 200) ?? existing?.organisation_key;
  const watch_item_id = optionalString(input.watch_item_id, 200) ?? existing?.watch_item_id;
  const recommendation_fingerprint =
    optionalString(input.recommendation_fingerprint, 80) ?? existing?.recommendation_fingerprint;
  if (!organisation_key) throw new OperatorDecisionValidationError("organisation_key is required");
  if (!watch_item_id) throw new OperatorDecisionValidationError("watch_item_id is required");
  if (!recommendation_fingerprint) {
    throw new OperatorDecisionValidationError("recommendation_fingerprint is required");
  }

  const decision_type = requireEnum(
    input.decision_type ?? existing?.decision_type,
    "decision_type",
    OPERATOR_DECISION_TYPES,
  );
  const product_scope = requireEnum(
    input.product_scope ?? existing?.product_scope,
    "product_scope",
    ["PORTAL_GENIE", "NAGGING_PANDA"] as const,
  );

  if (decision_type === "SNOOZED" && !optionalIsoDate(input.effective_until ?? existing?.effective_until, "effective_until")) {
    throw new OperatorDecisionValidationError("SNOOZED requires effective_until");
  }

  const operatorNoteRaw = input.operator_note ?? existing?.operator_note;
  if (decision_type === "CONTEXT_ADDED" && !(typeof operatorNoteRaw === "string" && operatorNoteRaw.trim())) {
    throw new OperatorDecisionValidationError("CONTEXT_ADDED requires operator_note");
  }
  if (typeof operatorNoteRaw === "string" && operatorNoteRaw.trim().length > 4000) {
    throw new OperatorDecisionValidationError("operator_note must be 4000 characters or fewer");
  }

  const now = new Date().toISOString();
  return {
    id: existing?.id ?? (typeof input.id === "string" && input.id.trim() ? input.id.trim() : `od-${randomUUID()}`),
    watch_item_id,
    organisation_key,
    product_scope,
    recommendation_fingerprint,
    decision_type,
    reason_code: optionalEnum(input.reason_code ?? existing?.reason_code, "reason_code", OPERATOR_REASON_CODES),
    operator_note: optionalString(input.operator_note, 4000) ?? existing?.operator_note,
    created_at: existing?.created_at ?? now,
    effective_from: optionalIsoDate(input.effective_from ?? existing?.effective_from, "effective_from") ?? now,
    effective_until: optionalIsoDate(input.effective_until ?? existing?.effective_until, "effective_until"),
    supersedes_decision_id:
      optionalString(input.supersedes_decision_id, 80) ?? existing?.supersedes_decision_id,
    evidence_snapshot_ref:
      optionalString(input.evidence_snapshot_ref, 80) ?? existing?.evidence_snapshot_ref,
    decision_context_snapshot:
      parseContextSnapshot(input.decision_context_snapshot) ?? existing?.decision_context_snapshot,
    linked_sales_event_id:
      optionalString(input.linked_sales_event_id, 80) ?? existing?.linked_sales_event_id,
    preferred_contact_id:
      optionalString(input.preferred_contact_id, 80) ?? existing?.preferred_contact_id,
    preferred_contact_name:
      optionalString(input.preferred_contact_name, 200) ?? existing?.preferred_contact_name,
    provenance: OPERATOR_DECISION_PROVENANCE,
    explicit_quality_feedback: optionalEnum(
      input.explicit_quality_feedback ?? existing?.explicit_quality_feedback,
      "explicit_quality_feedback",
      QUALITY_FEEDBACK_KINDS,
    ),
    zoho_note_id: existing?.zoho_note_id,
    contact_zoho_note_id: existing?.contact_zoho_note_id,
    deal_zoho_note_id: existing?.deal_zoho_note_id,
    zoho_written_at: existing?.zoho_written_at,
  };
}

export function inferQualityFeedback(decision: OperatorDecision): QualityFeedback | undefined {
  if (decision.explicit_quality_feedback) {
    return {
      kind: decision.explicit_quality_feedback,
      source: "EXPLICIT",
      decision_id: decision.id,
      decision_type: decision.decision_type,
      at: decision.created_at,
    };
  }
  const inferred = inferredQualityFeedback(decision.decision_type, decision.reason_code);
  if (!inferred) return undefined;
  return {
    kind: inferred,
    source: "INFERRED",
    decision_id: decision.id,
    decision_type: decision.decision_type,
    at: decision.created_at,
  };
}

function inferredQualityFeedback(
  decisionType: OperatorDecisionType,
  reasonCode?: OperatorReasonCode,
): QualityFeedbackKind | undefined {
  switch (decisionType) {
    case "NOT_AN_OPPORTUNITY":
      return "FALSE_OPPORTUNITY";
    case "WRONG_ACTION":
      return "WRONG_ACTION";
    case "WRONG_PERSON":
      return "WRONG_PERSON";
    case "ALREADY_HANDLED":
      return "STALE_RECOMMENDATION";
    case "RESEARCH_REQUIRED":
      return "INSUFFICIENT_EVIDENCE";
    case "DISMISSED":
      return reasonCode === "STALE_RECOMMENDATION" ? "STALE_RECOMMENDATION" : undefined;
    default:
      return undefined;
  }
}

export function decisionAppliesToProduct(decision: OperatorDecision, product: ProductId): boolean {
  return decision.product_scope === product;
}
