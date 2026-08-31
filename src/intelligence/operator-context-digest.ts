import type { OperatorDecision } from "../domain/operator-decision.js";
import { decisionAppliesToProduct } from "../domain/operator-decision.js";
import { evidence, type EvidenceItem } from "../domain/evidence.js";
import type { ProductId } from "../domain/product-relationship.js";

export type OperatorContextDigestEntry = {
  id: string;
  created_at: string;
  product_scope: ProductId;
  watch_item_id: string;
  note: string;
  provenance: "OPERATOR";
  layer: "operator_context";
};

export function contextAddedDecisionsForOrganisation(
  decisions: OperatorDecision[],
  organisationKey: string,
): OperatorDecision[] {
  const superseded = new Set(
    decisions.map((decision) => decision.supersedes_decision_id).filter((id): id is string => Boolean(id)),
  );
  return decisions
    .filter(
      (decision) =>
        decision.organisation_key === organisationKey &&
        decision.decision_type === "CONTEXT_ADDED" &&
        !superseded.has(decision.id) &&
        Boolean(decision.operator_note?.trim()),
    )
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
}

export function buildOperatorContextEvidence(decisions: OperatorDecision[]): EvidenceItem[] {
  return decisions.map((decision) =>
    evidence({
      type: "operator_context",
      claim: `Operator context (${decision.product_scope.replaceAll("_", " ")}): ${decision.operator_note!.trim()}. Operator knowledge — not a CRM fact, Sales Event, or AI inference.`,
      source: "OPERATOR",
      recordId: decision.id,
      observedAt: decision.created_at,
    }),
  );
}

export function buildOperatorContextDigest(decisions: OperatorDecision[]): OperatorContextDigestEntry[] {
  return decisions.map((decision) => ({
    id: decision.id,
    created_at: decision.created_at,
    product_scope: decision.product_scope,
    watch_item_id: decision.watch_item_id,
    note: decision.operator_note!.trim(),
    provenance: "OPERATOR",
    layer: "operator_context" as const,
  }));
}

export function contextAppliesToProduct(decision: OperatorDecision, product: ProductId): boolean {
  return decisionAppliesToProduct(decision, product);
}
