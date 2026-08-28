import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CommercialWatchItem } from "../src/domain/commercial-watch.js";
import {
  decisionContextSnapshotFromWatchItem,
  inferQualityFeedback,
  parseOperatorDecisionInput,
  recommendationFingerprint,
  recommendationFingerprintFromWatchItem,
  OperatorDecisionValidationError,
  type OperatorDecision,
} from "../src/domain/operator-decision.js";
import {
  activeOperatorDecisions,
  detectMaterialEvidence,
  evaluateWatchItemControl,
  productOpportunitySuppressed,
} from "../src/intelligence/operator-decision-control.js";
import {
  createOperatorDecision,
  listOperatorDecisions,
  replaceOperatorDecisionStore,
  revokeOperatorDecision,
  supersedeOperatorDecision,
} from "../src/intelligence/operator-decision-store.js";
import { listSalesEvents } from "../src/intelligence/sales-event-store.js";
import { parseSalesEventInput } from "../src/domain/sales-event.js";

function withDecisionStore<T>(run: () => T): T {
  const previous = process.env.OPERATOR_DECISIONS_STORE;
  process.env.OPERATOR_DECISIONS_STORE = join(mkdtempSync(join(tmpdir(), "pg-od-")), "operator-decisions.json");
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_DECISIONS_STORE;
    else process.env.OPERATOR_DECISIONS_STORE = previous;
  }
}

function sampleWatchItem(overrides: Partial<CommercialWatchItem> = {}): CommercialWatchItem {
  return {
    id: "domain:acme.test:PORTAL_GENIE",
    organisation_id: "domain:acme.test",
    organisation_name: "Acme Accounting",
    product_scope: "PORTAL_GENIE",
    relationship_state: "ENGAGED_PROSPECT",
    recommended_contact_id: "c-jane",
    recommended_contact_name: "Jane Smith",
    deal_ids: ["deal-1"],
    lead_ids: [],
    contact_ids: ["c-jane"],
    next_best_action: "PHONE_CALL",
    actionability_kind: "CUSTOMER_ACTION",
    customer_queue: true,
    executability: "EXECUTABLE_NOW",
    decision: "ENGAGED",
    action_timing: "ACT_NOW",
    confidence: "MEDIUM",
    why_this_action: "Follow up on recent interest.",
    commercial_summary: "Acme · Portal Genie engaged prospect.",
    stalled_state: "NOT_STALLED",
    stalled_reasons: [],
    urgency_signals: [],
    opportunity_signals: [],
    risk_signals: [],
    usage_signals: [],
    data_quality_signals: [],
    evidence_refs: ["ev-1"],
    source_record: { module: "Contacts", recordId: "c-jane" },
    priority: "P1",
    rank: 1,
    why_ranked: "Executable customer action.",
    reuse: "reused",
    ...overrides,
  };
}

const TEST_AS_OF = "2026-08-28T12:00:00.000Z";
const TEST_EFFECTIVE_FROM = "2026-01-01T00:00:00.000Z";

function decisionInput(overrides: Record<string, unknown> = {}) {
  const item = sampleWatchItem();
  return {
    watch_item_id: item.id,
    organisation_key: item.organisation_id,
    product_scope: item.product_scope,
    recommendation_fingerprint: recommendationFingerprintFromWatchItem(item),
    decision_context_snapshot: decisionContextSnapshotFromWatchItem(item),
    evidence_snapshot_ref: "fp-original",
    effective_from: TEST_EFFECTIVE_FROM,
    ...overrides,
  };
}

test("OperatorDecision validation requires core fields and snooze expiry", () => {
  assert.throws(() => parseOperatorDecisionInput({}), OperatorDecisionValidationError);
  assert.throws(
    () => parseOperatorDecisionInput(decisionInput({ decision_type: "SNOOZED" })),
    /effective_until/,
  );
  const parsed = parseOperatorDecisionInput(
    decisionInput({
      decision_type: "SNOOZED",
      effective_until: "2026-09-14T00:00:00.000Z",
    }),
  );
  assert.equal(parsed.provenance, "OPERATOR");
  assert.equal(parsed.product_scope, "PORTAL_GENIE");
});

test("recommendation fingerprint is stable and product-specific", () => {
  const item = sampleWatchItem();
  const fp1 = recommendationFingerprintFromWatchItem(item);
  const fp2 = recommendationFingerprintFromWatchItem({
    ...item,
    product_scope: "NAGGING_PANDA",
    id: "domain:acme.test:NAGGING_PANDA",
  });
  assert.notEqual(fp1, fp2);
  assert.equal(
    recommendationFingerprintFromWatchItem({ ...item, commercial_summary: "different wording" }),
    fp1,
  );
});

test("store persists decisions with superseding and revoke", () => {
  withDecisionStore(() => {
    const created = createOperatorDecision(decisionInput({ decision_type: "DISMISSED" }));
    const superseded = supersedeOperatorDecision(created.id, {
      decision_type: "WAITING",
      operator_note: "Waiting on board meeting.",
    });
    const listed = listOperatorDecisions({ organisation_key: "domain:acme.test", include_superseded: true });
    assert.equal(listed.length, 2);
    assert.equal(listed.filter((item) => item.decision_type === "DISMISSED").length, 1);
    const active = activeOperatorDecisions(listed, "domain:acme.test", "PORTAL_GENIE", TEST_AS_OF);
    assert.equal(active.length, 1);
    assert.equal(active[0]?.decision_type, "WAITING");
    revokeOperatorDecision(superseded.id);
    const afterRevoke = activeOperatorDecisions(
      listOperatorDecisions({ include_superseded: true }),
      "domain:acme.test",
      "PORTAL_GENIE",
      TEST_AS_OF,
    );
    assert.equal(afterRevoke.length, 0);
  });
});

test("dismiss suppresses unchanged recommendation", () => {
  withDecisionStore(() => {
    const item = sampleWatchItem();
    const decision = createOperatorDecision(decisionInput({ decision_type: "DISMISSED" }));
    const evaluation = evaluateWatchItemControl({
      watchItem: item,
      decisions: [decision],
      context: {
        asOf: TEST_AS_OF,
        evidence_fingerprint: "fp-original",
        deal_ids: ["deal-1"],
      },
    });
    assert.equal(evaluation.actionable, false);
    assert.equal(evaluation.reopened, false);
    assert.match(evaluation.suppression_reason ?? "", /DISMISSED/i);
  });
});

test("snooze hides until date and expires afterwards", () => {
  const item = sampleWatchItem();
  const decision = parseOperatorDecisionInput(
    decisionInput({
      decision_type: "SNOOZED",
      effective_until: "2026-09-01T00:00:00.000Z",
    }),
  );
  const during = evaluateWatchItemControl({
    watchItem: item,
    decisions: [decision],
    context: { asOf: TEST_AS_OF, evidence_fingerprint: "fp-original" },
  });
  assert.equal(during.actionable, false);
  const after = evaluateWatchItemControl({
    watchItem: item,
    decisions: [decision],
    context: { asOf: "2026-09-02T10:00:00.000Z", evidence_fingerprint: "fp-original" },
  });
  assert.equal(after.actionable, true);
});

test("waiting removes immediate action and respects do-not-chase", () => {
  const item = sampleWatchItem();
  const decision = parseOperatorDecisionInput(
    decisionInput({
      decision_type: "WAITING",
      reason_code: "DO_NOT_CHASE",
      operator_note: "Do not chase before board meeting.",
    }),
  );
  const evaluation = evaluateWatchItemControl({
    watchItem: item,
    decisions: [decision],
    context: { asOf: TEST_AS_OF, evidence_fingerprint: "fp-original" },
  });
  assert.equal(evaluation.actionable, false);
  assert.equal(evaluation.effect, "SUPPRESS_CUSTOMER_ACTION");
});

test("not-an-opportunity suppresses correct product only", () => {
  const pgItem = sampleWatchItem();
  const npItem = sampleWatchItem({
    id: "domain:acme.test:NAGGING_PANDA",
    product_scope: "NAGGING_PANDA",
    next_best_action: "PERSONAL_EMAIL",
  });
  const decision = parseOperatorDecisionInput(
    decisionInput({
      decision_type: "NOT_AN_OPPORTUNITY",
      product_scope: "PORTAL_GENIE",
    }),
  );
  const pgEval = evaluateWatchItemControl({
    watchItem: pgItem,
    decisions: [decision],
    context: { asOf: TEST_AS_OF, evidence_fingerprint: "fp-original" },
  });
  const npEval = evaluateWatchItemControl({
    watchItem: npItem,
    decisions: [decision],
    context: { asOf: TEST_AS_OF, evidence_fingerprint: "fp-original" },
  });
  assert.equal(pgEval.actionable, false);
  assert.equal(npEval.actionable, true);
  const scope = productOpportunitySuppressed(
    "domain:acme.test",
    "PORTAL_GENIE",
    [decision],
    TEST_AS_OF,
    "NAGGING_PANDA",
  );
  assert.equal(scope.target, true);
  assert.equal(scope.other, false);
});

test("wrong-action preserves opportunity when action changes", () => {
  const item = sampleWatchItem();
  const decision = parseOperatorDecisionInput(
    decisionInput({
      decision_type: "WRONG_ACTION",
      decision_context_snapshot: {
        deal_ids: ["deal-1"],
        next_best_action: "PHONE_CALL",
        recommended_contact_id: "c-jane",
      },
    }),
  );
  const sameAction = evaluateWatchItemControl({
    watchItem: item,
    decisions: [decision],
    context: { asOf: TEST_AS_OF, evidence_fingerprint: "fp-original" },
  });
  assert.equal(sameAction.actionable, false);
  const differentAction = evaluateWatchItemControl({
    watchItem: { ...item, next_best_action: "PERSONAL_EMAIL" },
    decisions: [decision],
    context: { asOf: TEST_AS_OF, evidence_fingerprint: "fp-original" },
  });
  assert.equal(differentAction.actionable, true);
});

test("wrong-person preserves opportunity when person changes", () => {
  const item = sampleWatchItem();
  const decision = parseOperatorDecisionInput(
    decisionInput({
      decision_type: "WRONG_PERSON",
      preferred_contact_id: "c-sarah",
      preferred_contact_name: "Sarah",
      decision_context_snapshot: {
        deal_ids: ["deal-1"],
        next_best_action: "PHONE_CALL",
        recommended_contact_id: "c-jane",
      },
    }),
  );
  const samePerson = evaluateWatchItemControl({
    watchItem: item,
    decisions: [decision],
    context: { asOf: TEST_AS_OF, evidence_fingerprint: "fp-original" },
  });
  assert.equal(samePerson.actionable, false);
  const differentPerson = evaluateWatchItemControl({
    watchItem: { ...item, recommended_contact_id: "c-sarah", recommended_contact_name: "Sarah" },
    decisions: [decision],
    context: { asOf: TEST_AS_OF, evidence_fingerprint: "fp-original" },
  });
  assert.equal(differentPerson.actionable, true);
});

test("unchanged evidence does not reopen dismissed recommendation", () => {
  const item = sampleWatchItem();
  const decision = parseOperatorDecisionInput(decisionInput({ decision_type: "DISMISSED" }));
  const evaluation = evaluateWatchItemControl({
    watchItem: item,
    decisions: [decision],
    context: {
      asOf: "2026-08-29T10:00:00Z",
      evidence_fingerprint: "fp-original",
      deal_ids: ["deal-1"],
    },
  });
  assert.equal(evaluation.reopened, false);
  assert.equal(evaluation.actionable, false);
});

test("material SalesEvent can reopen suppressed item with explanation", () => {
  const item = sampleWatchItem();
  const decision = parseOperatorDecisionInput(decisionInput({ decision_type: "DISMISSED" }));
  const evaluation = evaluateWatchItemControl({
    watchItem: item,
    decisions: [decision],
    context: {
      asOf: "2026-08-29T10:00:00Z",
      evidence_fingerprint: "fp-changed",
      deal_ids: ["deal-1"],
      sales_events: [
        {
          ...parseSalesEventInput({
            organisation_id: "domain:acme.test",
            product_scope: "PORTAL_GENIE",
            event_type: "EMAIL",
            occurred_at: "2026-08-29T09:00:00Z",
            summary: "Inbound enquiry",
          }),
          created_at: "2026-08-29T09:30:00.000Z",
        },
      ],
    },
  });
  assert.equal(evaluation.reopened, true);
  assert.equal(evaluation.actionable, true);
  assert.match(evaluation.reopen_explanation ?? "", /Reopened/i);
});

test("new deal evidence can reopen with explanation", () => {
  const item = sampleWatchItem();
  const decision = parseOperatorDecisionInput(decisionInput({ decision_type: "DISMISSED" }));
  const signals = detectMaterialEvidence(decision, {
    asOf: "2026-08-29T10:00:00Z",
    evidence_fingerprint: "fp-original",
    deal_ids: ["deal-1", "deal-2"],
  });
  assert.ok(signals.some((signal) => signal.kind === "DEAL_ADDED"));
});

test("retrieval ERROR cannot masquerade as new evidence", () => {
  const decision = parseOperatorDecisionInput(decisionInput({ decision_type: "DISMISSED" }));
  const signals = detectMaterialEvidence(decision, {
    asOf: "2026-08-29T10:00:00Z",
    evidence_fingerprint: "fp-changed",
    retrieval_ok: false,
  });
  assert.equal(signals.length, 0);
});

test("dismissal does not create SalesEvent", () => {
  withDecisionStore(() => {
    const previous = process.env.SALES_EVENTS_STORE;
    process.env.SALES_EVENTS_STORE = join(mkdtempSync(join(tmpdir(), "pg-se-")), "sales-events.json");
    try {
      createOperatorDecision(decisionInput({ decision_type: "DISMISSED" }));
      assert.equal(listSalesEvents().length, 0);
    } finally {
      if (previous === undefined) delete process.env.SALES_EVENTS_STORE;
      else process.env.SALES_EVENTS_STORE = previous;
    }
  });
});

test("quality feedback distinguishes explicit, inferred, and unreviewed", () => {
  const dismissed = parseOperatorDecisionInput(decisionInput({ decision_type: "DISMISSED" }));
  assert.equal(inferQualityFeedback(dismissed), undefined);
  const falseOpp = parseOperatorDecisionInput(decisionInput({ decision_type: "NOT_AN_OPPORTUNITY" }));
  assert.equal(inferQualityFeedback(falseOpp)?.kind, "FALSE_OPPORTUNITY");
  assert.equal(inferQualityFeedback(falseOpp)?.source, "INFERRED");
  const explicit = parseOperatorDecisionInput(
    decisionInput({ decision_type: "WRONG_ACTION", explicit_quality_feedback: "WRONG_ACTION" }),
  );
  assert.equal(inferQualityFeedback(explicit)?.source, "EXPLICIT");
});

test("operator decision store file path is gitignored pattern", () => {
  replaceOperatorDecisionStore([]);
  const listed = listOperatorDecisions();
  assert.deepEqual(listed, []);
});
