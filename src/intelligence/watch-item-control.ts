import type { CommercialWatchItem, EffectiveQueueState, WatchItemOperatorControl } from "../domain/commercial-watch.js";
import type { OperatorDecision } from "../domain/operator-decision.js";
import type { SalesEvent } from "../domain/sales-event.js";
import { listOperatorDecisions } from "./operator-decision-store.js";
import {
  evaluateWatchItemControl,
  type ReopenEvidenceContext,
  type SuppressionEffect,
  type WatchItemControlEvaluation,
} from "./operator-decision-control.js";

export type WatchItemEvidenceContext = {
  evidence_fingerprint?: string;
  sales_events?: SalesEvent[];
  deal_stages?: Record<string, string>;
  retrieval_ok?: boolean;
};

export function deriveEffectiveQueueState(
  item: CommercialWatchItem,
  evaluation: WatchItemControlEvaluation,
): EffectiveQueueState {
  if (!evaluation.active_decisions.length && !evaluation.reopened) {
    if (!item.customer_queue) return "SYSTEM_NO_ACTION";
    if (item.actionability_kind === "INTERNAL_RESEARCH" || item.actionability_kind === "DATA_REQUIRED") {
      return "RESEARCH";
    }
    if (
      item.executability === "WAITING_FOR_TIME" ||
      item.executability === "WAITING_FOR_CUSTOMER" ||
      item.next_best_action === "WAIT"
    ) {
      return "WAIT";
    }
    if (item.executability === "EXECUTABLE_NOW" && item.actionability_kind === "CUSTOMER_ACTION") {
      return "CUSTOMER_ACTION";
    }
    return "SYSTEM_NO_ACTION";
  }

  const primaryType = evaluation.active_decisions[0]?.decision_type;
  switch (evaluation.effect) {
    case "SUPPRESS_PRODUCT_OPPORTUNITY":
      return "NOT_AN_OPPORTUNITY";
    case "RESEARCH_ONLY":
      return "RESEARCH";
    case "SUPPRESS_CUSTOMER_ACTION":
      if (primaryType === "WAITING" || primaryType === "SNOOZED") return "WAIT";
      return "SUPPRESSED";
    case "SUPPRESS_RECOMMENDATION":
      if (primaryType === "WRONG_ACTION" || primaryType === "WRONG_PERSON") return "REVIEW_REQUIRED";
      return "SUPPRESSED";
    default:
      return evaluation.actionable ? "CUSTOMER_ACTION" : "SYSTEM_NO_ACTION";
  }
}

function toOperatorControl(evaluation: WatchItemControlEvaluation): WatchItemOperatorControl {
  if (!evaluation.active_decisions.length && !evaluation.reopened) {
    return {
      controlled: false,
      effect: "NONE",
      actionable: evaluation.actionable,
      in_customer_action_queue: evaluation.in_customer_action_queue,
      reopened: evaluation.reopened,
      reopen_explanation: evaluation.reopen_explanation,
    };
  }

  const primary = evaluation.active_decisions[0];
  return {
    controlled: true,
    effect: evaluation.effect,
    actionable: evaluation.actionable,
    in_customer_action_queue: evaluation.in_customer_action_queue,
    suppression_reason: evaluation.suppression_reason,
    operator_summary: evaluation.operator_summary,
    active_decision_ids: evaluation.active_decisions.map((decision) => decision.id),
    primary_decision_type: primary?.decision_type,
    effective_until: primary?.effective_until,
    reopened: evaluation.reopened,
    reopen_explanation: evaluation.reopen_explanation,
  };
}

function applyPresentationFields(
  item: CommercialWatchItem,
  evaluation: WatchItemControlEvaluation,
): CommercialWatchItem {
  const systemPriority = item.system_priority_band ?? item.priority;
  const effectiveState = deriveEffectiveQueueState(item, evaluation);
  const controlled = toOperatorControl(evaluation);
  let customerQueue = item.customer_queue;
  if (controlled.controlled && !controlled.in_customer_action_queue) {
    customerQueue = false;
  }
  if (effectiveState === "NOT_AN_OPPORTUNITY") {
    customerQueue = false;
  }

  return {
    ...item,
    system_priority_band: systemPriority,
    effective_queue_state: effectiveState,
    operator_control: controlled,
    customer_queue: customerQueue,
  };
}

export function reopenContextForWatchItem(
  item: CommercialWatchItem,
  asOf: string,
  evidence?: WatchItemEvidenceContext,
): ReopenEvidenceContext {
  return {
    asOf,
    evidence_fingerprint: evidence?.evidence_fingerprint,
    sales_events: evidence?.sales_events,
    deal_ids: item.deal_ids,
    deal_stages: evidence?.deal_stages,
    retrieval_ok: evidence?.retrieval_ok ?? true,
  };
}

export function applyOperatorControlToWatchItem(
  item: CommercialWatchItem,
  decisions: OperatorDecision[],
  context: ReopenEvidenceContext,
): CommercialWatchItem {
  const evaluation = evaluateWatchItemControl({
    watchItem: item,
    decisions,
    context,
  });
  return applyPresentationFields(item, evaluation);
}

export function applyOperatorControlToWatchItems(
  items: CommercialWatchItem[],
  options: {
    asOf: string;
    decisions?: OperatorDecision[];
    evidenceByOrganisation?: Map<string, WatchItemEvidenceContext>;
  },
): CommercialWatchItem[] {
  const decisions = options.decisions ?? listOperatorDecisions();
  const evidenceByOrganisation = options.evidenceByOrganisation ?? new Map();
  return items.map((item) => {
    const evidence = evidenceByOrganisation.get(item.organisation_id);
    return applyOperatorControlToWatchItem(
      item,
      decisions,
      reopenContextForWatchItem(item, options.asOf, evidence),
    );
  });
}

export function isEffectivelyCustomerExecutable(item: CommercialWatchItem): boolean {
  if (item.operator_control?.controlled) {
    if (!item.operator_control.actionable || !item.operator_control.in_customer_action_queue) {
      return false;
    }
  }
  if (item.effective_queue_state && item.effective_queue_state !== "CUSTOMER_ACTION") {
    return false;
  }
  return (
    (item.priority === "P0" || item.priority === "P1") &&
    item.executability === "EXECUTABLE_NOW" &&
    item.actionability_kind === "CUSTOMER_ACTION" &&
    item.customer_queue
  );
}

export function controlledWatchItemCount(items: CommercialWatchItem[]): number {
  return items.filter((item) => item.operator_control?.controlled).length;
}

export function suppressionEffectLabel(effect: SuppressionEffect): string {
  return effect;
}
