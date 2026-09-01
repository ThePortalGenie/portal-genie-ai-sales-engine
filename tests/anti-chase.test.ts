import assert from "node:assert/strict";
import test from "node:test";
import type { OrganisationGraph } from "../src/domain/organisation-graph.js";
import type { StoredAnalysis } from "../src/intelligence/analysis-store.js";
import { applyAntiChaseToAction, recentUnansweredWithinQuietWindow } from "../src/intelligence/anti-chase.js";
import { classifyStalled } from "../src/intelligence/stalled-engine.js";
import { validSampleProfile } from "../src/intelligence/profile-schema.js";
import { watchItemsFromAnalysis } from "../src/intelligence/watch-from-analysis.js";
import { ccPresentationBucket } from "../src/web/command-centre-presentation.js";
import type { WatchEvidenceInput } from "../src/intelligence/watch-signals.js";
import { DEFAULT_COMMAND_CENTRE_THRESHOLDS } from "../src/domain/commercial-watch.js";
import { enrichWatchItemsForOperatorControl } from "../src/intelligence/command-centre.js";
import { applyOperatorControlToWatchItems } from "../src/intelligence/watch-item-control.js";
import { createOperatorDecision } from "../src/intelligence/operator-decision-store.js";
import {
  decisionContextSnapshotFromWatchItem,
  recommendationFingerprintFromWatchItem,
} from "../src/domain/operator-decision.js";
import type { SalesEvent } from "../src/domain/sales-event.js";
import { parseSalesEventInput } from "../src/domain/sales-event.js";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AS_OF = "2026-08-28T08:00:00+02:00";

function graph(overrides: Partial<OrganisationGraph> = {}): OrganisationGraph {
  return {
    selectedContactId: "c1",
    selectedContactName: "Sarah",
    organisationName: "ABC Accounting",
    domains: ["abc.test"],
    certainty: "resolved",
    contacts: [
      {
        module: "Leads",
        recordId: "l1",
        name: "Sarah",
        email: "sarah@abc.test",
        association_reasons: ["SELECTED_CONTACT"],
        certainty: "associated",
        selected: true,
        commercial_role: { role: "SELECTED_CONTACT", layer: "crm_fact", evidence: "selected" },
      },
    ],
    accounts: [],
    possibleAccounts: [],
    deals: [],
    notes: [],
    emails: [],
    fragmentation: null,
    dataQualitySignals: [],
    productOpportunities: [],
    omissions: [],
    cache: { hits: 0, misses: 0 },
    salesEvents: [],
    zohoRecordsMerged: false,
    ...overrides,
  };
}

function stored(overrides: Partial<StoredAnalysis> = {}): StoredAnalysis {
  return {
    analysedAt: "2026-08-20T10:00:00Z",
    module: "Leads",
    recordId: "l1",
    schemaVersion: "test",
    model: "test",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    latencyMs: 5,
    success: true,
    profile: validSampleProfile({
      recommended_action: "PHONE_CALL",
      recommended_action_reason: "Call to qualify interest.",
      best_contact: "Sarah",
    }),
    organisationGraph: graph(),
    productRelationships: [
      {
        product: "PORTAL_GENIE",
        relationship_state: "ENGAGED_PROSPECT",
        evidence_ids: ["ev-1"],
        summary: "Lead prospect",
        confidence: "HIGH",
      },
    ],
    ...overrides,
  };
}

function outboundEmail(at: string, id: string) {
  return {
    messageId: id,
    threadId: null,
    at,
    direction: "outbound" as const,
    directionEvidence: "test",
    sender: { name: null, email: "geoff@test" },
    recipients: [],
    cc: [],
    subject: "Follow up",
    bodyText: "Checking in",
    currentMessageText: "Checking in",
    quoteStrippingConfidence: "HIGH" as const,
    strippedQuotedHistory: false,
    bodyTruncated: false,
    sourceType: "crm_email" as const,
    hasAttachment: false,
    ownerRecordId: "l1",
    ownerName: "Sarah",
  };
}

function evidence(overrides: Partial<WatchEvidenceInput> = {}): WatchEvidenceInput {
  return {
    asOf: AS_OF,
    unansweredOutboundAttempts: 0,
    liveDeal: false,
    historicalDealOnly: false,
    meetingMissedNoReschedule: false,
    usageUnknown: true,
    multipleContacts: false,
    fragmentation: false,
    inboundRecently: false,
    possibleMatchReview: false,
    thresholds: DEFAULT_COMMAND_CENTRE_THRESHOLDS,
    ...overrides,
  };
}

test("A: recent unanswered email blocks immediate repeat PERSONAL_EMAIL", () => {
  const input = evidence({
    unansweredOutboundAttempts: 1,
    lastMeaningfulActivityAt: "2026-08-25T10:00:00Z",
  });
  assert.ok(recentUnansweredWithinQuietWindow(input));
  const result = applyAntiChaseToAction("PERSONAL_EMAIL", input);
  assert.equal(result.action, "NO_ACTION");
  assert.match(result.reason ?? "", /Do not send another email/i);
});

test("B: recent unanswered email allows PHONE_CALL when AI proposes call", () => {
  const [item] = watchItemsFromAnalysis(
    stored({ organisationGraph: graph({ emails: [outboundEmail("2026-08-25T10:00:00Z", "m1")] }) }),
    { organisationId: "domain:abc.test", organisationName: "ABC Accounting", reuse: "reused", asOf: AS_OF },
  );
  assert.equal(item?.next_best_action, "PHONE_CALL");
  assert.equal(item?.executability, "EXECUTABLE_NOW");
  assert.notEqual(item?.stalled_state, "WAITING_ON_CUSTOMER");
});

test("C: single unanswered email allows FOLLOW_UP without forced WAIT", () => {
  const input = evidence({
    unansweredOutboundAttempts: 1,
    lastMeaningfulActivityAt: "2026-08-25T10:00:00Z",
  });
  const result = applyAntiChaseToAction("FOLLOW_UP", input);
  assert.equal(result.action, "FOLLOW_UP");
});

test("D: multiple unanswered attempts preserve MULTIPLE_OUTBOUND risk and stronger wait", () => {
  const input = evidence({
    unansweredOutboundAttempts: 2,
    lastMeaningfulActivityAt: "2026-08-25T10:00:00Z",
  });
  const stalled = classifyStalled(input);
  assert.equal(stalled.state, "WAITING_ON_CUSTOMER");
  const followUp = applyAntiChaseToAction("FOLLOW_UP", input);
  assert.equal(followUp.action, "WAIT");
  const phone = applyAntiChaseToAction("PHONE_CALL", input);
  assert.equal(phone.action, "PHONE_CALL");
});

test("E: explicit future commitment remains WAITING", () => {
  const event: SalesEvent = parseSalesEventInput({
    organisation_id: "domain:abc.test",
    contact_id: "l1",
    product_scope: "PORTAL_GENIE",
    event_type: "FOLLOW_UP",
    occurred_at: "2026-08-01T10:00:00Z",
    follow_up_date: "2026-09-15",
    outcome: "FOLLOW_UP_REQUESTED",
    summary: "Customer asked to follow up next month.",
  });
  const [item] = watchItemsFromAnalysis(
    stored({
      profile: validSampleProfile({ recommended_action: "PHONE_CALL", recommended_action_reason: "Call later." }),
      organisationGraph: graph({ salesEvents: [event] }),
    }),
    { organisationId: "domain:abc.test", organisationName: "ABC Accounting", reuse: "reused", asOf: AS_OF },
  );
  assert.equal(item?.next_best_action, "WAIT");
  assert.equal(item?.executability, "WAITING_FOR_TIME");
  assert.equal(ccPresentationBucket(item!), "waiting");
});

test("F: operator Snooze keeps WAITING regardless of AI", async () => {
  await withOperatorStore(async () => {
    const items = watchItemsFromAnalysis(
      stored({ organisationGraph: graph({ emails: [outboundEmail("2026-08-25T10:00:00Z", "m1")] }) }),
      { organisationId: "domain:abc.test", organisationName: "ABC Accounting", reuse: "reused", asOf: AS_OF },
    );
    const enriched = enrichWatchItemsForOperatorControl(items, new Map());
    const item = enriched[0]!;
    createOperatorDecision({
      watch_item_id: item.id,
      organisation_key: item.organisation_id,
      product_scope: item.product_scope,
      recommendation_fingerprint: recommendationFingerprintFromWatchItem(item),
      decision_context_snapshot: decisionContextSnapshotFromWatchItem(item),
      evidence_snapshot_ref: "fp-test",
      effective_from: "2026-01-01T00:00:00.000Z",
      decision_type: "SNOOZED",
      effective_until: "2026-09-14T00:00:00.000Z",
    });
    const controlled = applyOperatorControlToWatchItems(enriched, { asOf: AS_OF });
    assert.equal(controlled[0]?.effective_queue_state, "WAIT");
    assert.equal(controlled[0]?.operator_control?.primary_decision_type, "SNOOZED");
    assert.equal(controlled[0]?.operator_control?.actionable, false);
  });
});

test("G: future dated commitment via WAIT_UNTIL timing stays waiting", () => {
  const event: SalesEvent = parseSalesEventInput({
    organisation_id: "domain:abc.test",
    contact_id: "l1",
    product_scope: "PORTAL_GENIE",
    event_type: "FOLLOW_UP",
    occurred_at: "2026-08-01T10:00:00Z",
    follow_up_date: "2026-09-10",
    outcome: "FOLLOW_UP_REQUESTED",
    summary: "Follow up in September.",
  });
  const [item] = watchItemsFromAnalysis(
    stored({ organisationGraph: graph({ salesEvents: [event] }) }),
    { organisationId: "domain:abc.test", organisationName: "ABC Accounting", reuse: "reused", asOf: AS_OF },
  );
  assert.equal(item?.action_timing, "WAIT_UNTIL");
  assert.equal(ccPresentationBucket(item!), "waiting");
});

test("H: live deal with multiple unanswered and quiet period can still stall", () => {
  const stalled = classifyStalled(
    evidence({
      liveDeal: true,
      unansweredOutboundAttempts: 2,
      lastMeaningfulActivityAt: "2026-07-01T10:00:00Z",
    }),
  );
  assert.equal(stalled.state, "STALLED");
});

test("I: NO_ACTION/P5 are not promoted by anti-chase changes", () => {
  const [item] = watchItemsFromAnalysis(
    stored({
      profile: validSampleProfile({ recommended_action: "NO_ACTION", recommended_action_reason: "Nothing to do." }),
    }),
    { organisationId: "domain:abc.test", organisationName: "ABC Accounting", reuse: "reused", asOf: AS_OF },
  );
  assert.equal(item?.next_best_action, "NO_ACTION");
  assert.equal(item?.priority, "P5");
  assert.equal(ccPresentationBucket(item!), "excluded");
});

test("J: PG and NP product isolation unchanged", () => {
  const items = watchItemsFromAnalysis(
    stored({
      organisationGraph: graph({
        deals: [
          {
            recordId: "d-np",
            name: "Nagging Panda",
            product: "NAGGING_PANDA",
            closedLost: true,
            closedWon: false,
            provenance: "test",
          },
        ],
      }),
      productRelationships: [
        { product: "PORTAL_GENIE", relationship_state: "ENGAGED_PROSPECT", evidence_ids: [], summary: "PG", confidence: "HIGH" },
        { product: "NAGGING_PANDA", relationship_state: "UNKNOWN", evidence_ids: [], summary: "NP", confidence: "LOW" },
      ],
    }),
    { organisationId: "domain:abc.test", organisationName: "ABC Accounting", reuse: "reused", asOf: AS_OF },
  );
  assert.equal(items.length, 2);
  assert.ok(items.some((item) => item.product_scope === "PORTAL_GENIE"));
  assert.ok(items.some((item) => item.product_scope === "NAGGING_PANDA"));
});

async function withOperatorStore<T>(run: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pg-anti-chase-"));
  mkdirSync(join(dir, "diagnostics"), { recursive: true });
  const previous = {
    decisions: process.env.OPERATOR_DECISION_STORE,
    cc: process.env.COMMAND_CENTRE_STORE,
  };
  process.env.OPERATOR_DECISION_STORE = join(dir, "operator-decisions.json");
  process.env.COMMAND_CENTRE_STORE = join(dir, "command-centre.json");
  try {
    return await run();
  } finally {
    if (previous.decisions === undefined) delete process.env.OPERATOR_DECISION_STORE;
    else process.env.OPERATOR_DECISION_STORE = previous.decisions;
    if (previous.cc === undefined) delete process.env.COMMAND_CENTRE_STORE;
    else process.env.COMMAND_CENTRE_STORE = previous.cc;
  }
}
