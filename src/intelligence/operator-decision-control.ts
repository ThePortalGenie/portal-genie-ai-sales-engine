import type { CommercialWatchItem } from "../domain/commercial-watch.js";
import type { ProductId } from "../domain/product-relationship.js";
import type { SalesEvent } from "../domain/sales-event.js";
import { eventAppliesToProduct } from "../domain/sales-event.js";
import {
  decisionAppliesToProduct,
  recommendationFingerprintFromWatchItem,
  type OperatorDecision,
  type OperatorDecisionType,
} from "../domain/operator-decision.js";

export const MATERIAL_EVIDENCE_KINDS = [
  "SALES_EVENT",
  "DEAL_ADDED",
  "DEAL_STAGE_CHANGED",
  "EVIDENCE_FINGERPRINT_CHANGED",
  "OPERATOR_CONTEXT",
] as const;
export type MaterialEvidenceKind = (typeof MATERIAL_EVIDENCE_KINDS)[number];

export type MaterialEvidenceSignal = {
  kind: MaterialEvidenceKind;
  description: string;
  occurred_at?: string;
};

export type ReopenEvidenceContext = {
  asOf: string;
  evidence_fingerprint?: string;
  sales_events?: SalesEvent[];
  deal_ids?: string[];
  deal_stages?: Record<string, string>;
  /** When false, missing/errored retrieval must not reopen or reinterpret suppression. */
  retrieval_ok?: boolean;
};

export type SuppressionEffect =
  | "NONE"
  | "SUPPRESS_RECOMMENDATION"
  | "SUPPRESS_CUSTOMER_ACTION"
  | "SUPPRESS_PRODUCT_OPPORTUNITY"
  | "RESEARCH_ONLY";

export type WatchItemControlEvaluation = {
  actionable: boolean;
  in_customer_action_queue: boolean;
  effect: SuppressionEffect;
  active_decisions: OperatorDecision[];
  suppression_reason?: string;
  operator_summary?: string;
  reopened: boolean;
  reopen_explanation?: string;
  previous_decision_at?: string;
  material_evidence: MaterialEvidenceSignal[];
  recommendation_fingerprint: string;
};

function parseMs(value: string): number {
  return Date.parse(value);
}

function isEffective(decision: OperatorDecision, asOf: string): boolean {
  if (decision.decision_type === "REVOKED") return false;
  if (parseMs(asOf) < parseMs(decision.effective_from)) return false;
  if (decision.effective_until && parseMs(asOf) >= parseMs(decision.effective_until)) return false;
  return true;
}

export function activeOperatorDecisions(
  decisions: OperatorDecision[],
  organisationKey: string,
  productScope: ProductId,
  asOf: string,
): OperatorDecision[] {
  const superseded = new Set(
    decisions.map((decision) => decision.supersedes_decision_id).filter((id): id is string => Boolean(id)),
  );
  return decisions
    .filter(
      (decision) =>
        decision.organisation_key === organisationKey &&
        decisionAppliesToProduct(decision, productScope) &&
        !superseded.has(decision.id) &&
        isEffective(decision, asOf),
    )
    .sort((left, right) => parseMs(right.created_at) - parseMs(left.created_at));
}

export function detectMaterialEvidence(
  decision: OperatorDecision,
  context: ReopenEvidenceContext,
): MaterialEvidenceSignal[] {
  if (context.retrieval_ok === false) return [];

  const signals: MaterialEvidenceSignal[] = [];
  const snapshot = decision.decision_context_snapshot;

  if (
    decision.evidence_snapshot_ref &&
    context.evidence_fingerprint &&
    decision.evidence_snapshot_ref !== context.evidence_fingerprint
  ) {
    signals.push({
      kind: "EVIDENCE_FINGERPRINT_CHANGED",
      description: "Underlying CRM, usage, or Sales Event evidence changed since the operator decision.",
    });
  }

  for (const event of context.sales_events ?? []) {
    if (!eventAppliesToProduct(event, decision.product_scope) && event.product_scope !== "ORGANISATION_GENERAL") {
      continue;
    }
    if (event.organisation_id !== decision.organisation_key) continue;
    if (parseMs(event.created_at) > parseMs(decision.created_at)) {
      signals.push({
        kind: "SALES_EVENT",
        description: `New Sales Event recorded (${event.event_type}).`,
        occurred_at: event.occurred_at,
      });
    }
  }

  if (context.deal_ids !== undefined) {
    const currentDealIds = new Set(context.deal_ids);
    for (const dealId of snapshot?.deal_ids ?? []) {
      if (!currentDealIds.has(dealId)) {
        signals.push({
          kind: "DEAL_STAGE_CHANGED",
          description: `Deal context changed for ${dealId}.`,
        });
      }
    }
    for (const dealId of currentDealIds) {
      if (!(snapshot?.deal_ids ?? []).includes(dealId)) {
        signals.push({
          kind: "DEAL_ADDED",
          description: `New Deal detected (${dealId}).`,
        });
      }
    }
  }

  if (context.deal_stages !== undefined) {
    const priorStages = snapshot?.deal_stages ?? {};
    for (const [dealId, stage] of Object.entries(context.deal_stages)) {
      if (priorStages[dealId] && priorStages[dealId] !== stage) {
        signals.push({
          kind: "DEAL_STAGE_CHANGED",
          description: `Deal stage changed for ${dealId}: ${priorStages[dealId]} → ${stage}.`,
        });
      }
    }
  }

  return dedupeSignals(signals);
}

function dedupeSignals(signals: MaterialEvidenceSignal[]): MaterialEvidenceSignal[] {
  const seen = new Set<string>();
  const output: MaterialEvidenceSignal[] = [];
  for (const signal of signals) {
    const key = `${signal.kind}:${signal.description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(signal);
  }
  return output;
}

function hasMaterialEvidence(signals: MaterialEvidenceSignal[]): boolean {
  return signals.length > 0;
}

function sameRecommendationFingerprint(decision: OperatorDecision, currentFingerprint: string): boolean {
  return decision.recommendation_fingerprint === currentFingerprint;
}

function decisionBlocksRecommendation(
  decision: OperatorDecision,
  watchItem: CommercialWatchItem,
  currentFingerprint: string,
  materialSignals: MaterialEvidenceSignal[],
): { blocked: boolean; reopened: boolean; reopenExplanation?: string } {
  const material = hasMaterialEvidence(materialSignals);
  const sameFingerprint = sameRecommendationFingerprint(decision, currentFingerprint);
  const evidenceUnchanged =
    !decision.evidence_snapshot_ref ||
    !materialSignals.some((signal) => signal.kind === "EVIDENCE_FINGERPRINT_CHANGED");

  switch (decision.decision_type) {
    case "NOT_AN_OPPORTUNITY":
      if (material) {
        return {
          blocked: false,
          reopened: true,
          reopenExplanation: formatReopen(decision, materialSignals),
        };
      }
      return { blocked: true, reopened: false };

    case "SNOOZED":
      return { blocked: true, reopened: false };

    case "WAITING":
      if (material) {
        return {
          blocked: false,
          reopened: true,
          reopenExplanation: formatReopen(decision, materialSignals),
        };
      }
      return { blocked: true, reopened: false };

    case "RESEARCH_REQUIRED":
      if (material && !sameFingerprint) {
        return {
          blocked: false,
          reopened: true,
          reopenExplanation: formatReopen(decision, materialSignals),
        };
      }
      return { blocked: true, reopened: false };

    case "DISMISSED":
    case "ALREADY_HANDLED":
    case "COMPLETED":
      if (sameFingerprint && evidenceUnchanged) return { blocked: true, reopened: false };
      if (material || !sameFingerprint) {
        return {
          blocked: false,
          reopened: true,
          reopenExplanation: formatReopen(decision, materialSignals, !sameFingerprint),
        };
      }
      return { blocked: true, reopened: false };

    case "WRONG_ACTION": {
      const sameAction =
        decision.decision_context_snapshot?.next_best_action === watchItem.next_best_action;
      if (sameFingerprint && sameAction && evidenceUnchanged) return { blocked: true, reopened: false };
      if (material || !sameFingerprint || !sameAction) {
        return {
          blocked: false,
          reopened: Boolean(material || !sameFingerprint),
          reopenExplanation: material || !sameFingerprint ? formatReopen(decision, materialSignals, !sameFingerprint) : undefined,
        };
      }
      return { blocked: false, reopened: false };
    }

    case "WRONG_PERSON": {
      const samePerson =
        decision.decision_context_snapshot?.recommended_contact_id === watchItem.recommended_contact_id;
      if (sameFingerprint && samePerson && evidenceUnchanged) return { blocked: true, reopened: false };
      if (!samePerson || material) {
        return {
          blocked: false,
          reopened: Boolean(material || !samePerson),
          reopenExplanation: material || !samePerson ? formatReopen(decision, materialSignals, !samePerson) : undefined,
        };
      }
      return { blocked: false, reopened: false };
    }

    case "REVOKED":
      return { blocked: false, reopened: false };

    default:
      return { blocked: false, reopened: false };
  }
}

function formatReopen(
  decision: OperatorDecision,
  signals: MaterialEvidenceSignal[],
  fingerprintChanged = false,
): string {
  const date = decision.created_at.slice(0, 10);
  const parts = [`Previously ${decisionLabel(decision.decision_type)}: ${date}.`];
  if (fingerprintChanged && signals.length === 0) {
    parts.push("Recommendation changed.");
  }
  for (const signal of signals.slice(0, 3)) {
    parts.push(`Reopened: ${signal.description}`);
  }
  return parts.join(" ");
}

function decisionLabel(type: OperatorDecisionType): string {
  return type.toLowerCase().replaceAll("_", " ");
}

function effectForDecision(type: OperatorDecisionType): SuppressionEffect {
  switch (type) {
    case "NOT_AN_OPPORTUNITY":
      return "SUPPRESS_PRODUCT_OPPORTUNITY";
    case "RESEARCH_REQUIRED":
      return "RESEARCH_ONLY";
    case "DISMISSED":
    case "SNOOZED":
    case "WAITING":
    case "COMPLETED":
    case "ALREADY_HANDLED":
      return "SUPPRESS_CUSTOMER_ACTION";
    case "WRONG_ACTION":
    case "WRONG_PERSON":
      return "SUPPRESS_RECOMMENDATION";
    default:
      return "NONE";
  }
}

function operatorSummary(decisions: OperatorDecision[]): string | undefined {
  if (!decisions.length) return undefined;
  const primary = decisions[0]!;
  const note = primary.operator_note ? ` — ${primary.operator_note}` : "";
  if (primary.effective_until) {
    return `${primary.decision_type.replaceAll("_", " ")} until ${primary.effective_until.slice(0, 10)}${note}`;
  }
  return `${primary.decision_type.replaceAll("_", " ")}${note}`;
}

export function evaluateWatchItemControl(input: {
  watchItem: CommercialWatchItem;
  decisions: OperatorDecision[];
  context: ReopenEvidenceContext;
}): WatchItemControlEvaluation {
  const { watchItem, decisions, context } = input;
  const currentFingerprint = recommendationFingerprintFromWatchItem(watchItem);
  const active = activeOperatorDecisions(
    decisions,
    watchItem.organisation_id,
    watchItem.product_scope,
    context.asOf,
  );

  let effect: SuppressionEffect = "NONE";
  let actionable = true;
  let inCustomerQueue = watchItem.customer_queue;
  let suppressionReason: string | undefined;
  let reopened = false;
  let reopenExplanation: string | undefined;
  let previousDecisionAt: string | undefined;
  const materialEvidence: MaterialEvidenceSignal[] = [];
  const blocking: OperatorDecision[] = [];

  for (const decision of active) {
    const signals = detectMaterialEvidence(decision, context);
    materialEvidence.push(...signals);
    const outcome = decisionBlocksRecommendation(decision, watchItem, currentFingerprint, signals);
    if (outcome.reopened) {
      reopened = true;
      reopenExplanation = outcome.reopenExplanation;
      previousDecisionAt = decision.created_at;
      continue;
    }
    if (!outcome.blocked) continue;

    blocking.push(decision);
    effect = strongestEffect(effect, effectForDecision(decision.decision_type));
    suppressionReason = `${decision.decision_type.replaceAll("_", " ")} by operator on ${decision.created_at.slice(0, 10)}.`;
    if (decision.decision_type === "NOT_AN_OPPORTUNITY") {
      inCustomerQueue = false;
    }
  }

  if (effect === "SUPPRESS_PRODUCT_OPPORTUNITY") {
    actionable = false;
    inCustomerQueue = false;
  } else if (effect === "SUPPRESS_CUSTOMER_ACTION" || effect === "SUPPRESS_RECOMMENDATION") {
    actionable = false;
  } else if (effect === "RESEARCH_ONLY") {
    actionable = false;
    inCustomerQueue = false;
  }

  return {
    actionable,
    in_customer_action_queue: inCustomerQueue && actionable,
    effect,
    active_decisions: blocking,
    suppression_reason: suppressionReason,
    operator_summary: operatorSummary(blocking),
    reopened,
    reopen_explanation: reopenExplanation,
    previous_decision_at: previousDecisionAt,
    material_evidence: dedupeSignals(materialEvidence),
    recommendation_fingerprint: currentFingerprint,
  };
}

function strongestEffect(current: SuppressionEffect, next: SuppressionEffect): SuppressionEffect {
  const rank: Record<SuppressionEffect, number> = {
    NONE: 0,
    SUPPRESS_RECOMMENDATION: 1,
    RESEARCH_ONLY: 2,
    SUPPRESS_CUSTOMER_ACTION: 3,
    SUPPRESS_PRODUCT_OPPORTUNITY: 4,
  };
  return rank[next] > rank[current] ? next : current;
}

export function productOpportunitySuppressed(
  organisationKey: string,
  productScope: ProductId,
  decisions: OperatorDecision[],
  asOf: string,
  otherProduct?: ProductId,
): { target: boolean; other: boolean } {
  const active = activeOperatorDecisions(decisions, organisationKey, productScope, asOf);
  const target = active.some((decision) => decision.decision_type === "NOT_AN_OPPORTUNITY");
  const otherActive =
    otherProduct !== undefined
      ? activeOperatorDecisions(decisions, organisationKey, otherProduct, asOf).some(
          (decision) => decision.decision_type === "NOT_AN_OPPORTUNITY",
        )
      : false;
  return { target, other: otherActive };
}
