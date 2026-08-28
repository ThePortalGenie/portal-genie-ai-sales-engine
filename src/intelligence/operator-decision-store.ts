import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  OPERATOR_DECISION_SCHEMA_VERSION,
  OperatorDecisionValidationError,
  parseOperatorDecisionInput,
  type OperatorDecision,
  type OperatorDecisionInput,
} from "../domain/operator-decision.js";
import type { ProductId } from "../domain/product-relationship.js";

const FILE = () =>
  resolve(
    process.env.OPERATOR_DECISIONS_STORE?.trim() ||
      resolve(process.cwd(), "diagnostics/operator-decisions.json"),
  );

type StoreShape = {
  schema_version: number;
  decisions: OperatorDecision[];
};

function readStore(): StoreShape {
  const filePath = FILE();
  if (!existsSync(filePath)) {
    return { schema_version: OPERATOR_DECISION_SCHEMA_VERSION, decisions: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as StoreShape;
    return {
      schema_version: parsed.schema_version ?? OPERATOR_DECISION_SCHEMA_VERSION,
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
    };
  } catch {
    return { schema_version: OPERATOR_DECISION_SCHEMA_VERSION, decisions: [] };
  }
}

function writeStore(store: StoreShape): void {
  const filePath = FILE();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify({ ...store, schema_version: OPERATOR_DECISION_SCHEMA_VERSION }, null, 2)}\n`,
    "utf8",
  );
}

function supersededIds(decisions: OperatorDecision[]): Set<string> {
  const ids = new Set<string>();
  for (const decision of decisions) {
    if (decision.supersedes_decision_id) ids.add(decision.supersedes_decision_id);
  }
  return ids;
}

export function listOperatorDecisions(filter: {
  organisation_key?: string;
  product_scope?: ProductId;
  watch_item_id?: string;
  include_superseded?: boolean;
} = {}): OperatorDecision[] {
  const superseded = supersededIds(readStore().decisions);
  return readStore()
    .decisions.filter((decision) => {
      if (!filter.include_superseded && superseded.has(decision.id)) return false;
      if (filter.organisation_key && decision.organisation_key !== filter.organisation_key) return false;
      if (filter.product_scope && decision.product_scope !== filter.product_scope) return false;
      if (filter.watch_item_id && decision.watch_item_id !== filter.watch_item_id) return false;
      return true;
    })
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
}

export function getOperatorDecision(id: string): OperatorDecision | undefined {
  return readStore().decisions.find((decision) => decision.id === id);
}

export function createOperatorDecision(input: OperatorDecisionInput): OperatorDecision {
  const decision = parseOperatorDecisionInput(input);
  const store = readStore();
  store.decisions.push(decision);
  writeStore(store);
  return decision;
}

export function supersedeOperatorDecision(
  id: string,
  input: OperatorDecisionInput,
): OperatorDecision {
  const existing = getOperatorDecision(id);
  if (!existing) throw new OperatorDecisionValidationError("Operator decision not found");
  const replacement = parseOperatorDecisionInput({
    watch_item_id: existing.watch_item_id,
    organisation_key: existing.organisation_key,
    product_scope: existing.product_scope,
    recommendation_fingerprint: existing.recommendation_fingerprint,
    evidence_snapshot_ref: existing.evidence_snapshot_ref,
    decision_context_snapshot: existing.decision_context_snapshot,
    effective_from: existing.effective_from,
    ...input,
    supersedes_decision_id: id,
  });
  const store = readStore();
  store.decisions.push(replacement);
  writeStore(store);
  return replacement;
}

export function revokeOperatorDecision(id: string, operator_note?: string): OperatorDecision {
  const existing = getOperatorDecision(id);
  if (!existing) throw new OperatorDecisionValidationError("Operator decision not found");
  return supersedeOperatorDecision(id, {
    decision_type: "REVOKED",
    operator_note: operator_note ?? "Decision revoked by operator.",
    effective_until: new Date().toISOString(),
  });
}

export function replaceOperatorDecisionStore(decisions: OperatorDecision[]): void {
  writeStore({ schema_version: OPERATOR_DECISION_SCHEMA_VERSION, decisions });
}
