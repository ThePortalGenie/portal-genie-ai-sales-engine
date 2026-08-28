import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CommercialWatchItem } from "../src/domain/commercial-watch.js";
import {
  decisionContextSnapshotFromWatchItem,
  recommendationFingerprintFromWatchItem,
} from "../src/domain/operator-decision.js";
import { parseSalesEventInput } from "../src/domain/sales-event.js";
import type { ZohoCrmReader } from "../src/integrations/zoho/client.js";
import type { ZohoHttpResult } from "../src/integrations/zoho/types.js";
import { writeStoredAnalysis, findStoredAnalysisForRecords, type StoredAnalysis } from "../src/intelligence/analysis-store.js";
import { buildCommandCentre, refreshSnapshotOperatorControl } from "../src/intelligence/command-centre.js";
import { deterministicDailyBrief, isCustomerExecutableBriefItem } from "../src/intelligence/daily-brief.js";
import {
  applyOperatorControlToWatchItem,
  applyOperatorControlToWatchItems,
} from "../src/intelligence/watch-item-control.js";
import {
  createOperatorDecision,
  revokeOperatorDecision,
} from "../src/intelligence/operator-decision-store.js";
import { parseOperatorDecisionInput } from "../src/domain/operator-decision.js";
import { validSampleProfile } from "../src/intelligence/profile-schema.js";
import { handleRequest } from "../src/server/app.js";
import { readPortfolioSnapshot, writePortfolioSnapshot } from "../src/intelligence/portfolio-store.js";
import { listSalesEvents } from "../src/intelligence/sales-event-store.js";
import type { PortfolioSnapshot } from "../src/domain/commercial-watch.js";

const AS_OF = "2026-08-28T12:00:00.000Z";
const EFFECTIVE_FROM = "2026-01-01T00:00:00.000Z";

function emptyResult(): ZohoHttpResult {
  return { ok: true, status: 204, noContent: true, json: null };
}

function listed(rows: unknown[]): ZohoHttpResult {
  return { ok: true, status: 200, noContent: false, json: { data: rows, info: { more_records: false } } };
}

function listingClient(): ZohoCrmReader {
  return {
    async getRecord() {
      return emptyResult();
    },
    async searchByEmail() {
      return emptyResult();
    },
    async getFields() {
      return emptyResult();
    },
    async getRelatedLists() {
      return emptyResult();
    },
    async getRelatedRecords() {
      return emptyResult();
    },
    async getEmails() {
      return emptyResult();
    },
    async getEmail() {
      return emptyResult();
    },
    async getTags() {
      return emptyResult();
    },
    async searchByWord() {
      return emptyResult();
    },
    async getOrg() {
      return emptyResult();
    },
    async getRecords(moduleApiName) {
      if (moduleApiName === "Contacts") {
        return listed([
          { id: "c1", Full_Name: "Jane", Email: "jane@acme.test", Account_Name: { id: "a1", name: "Acme" } },
        ]);
      }
      return emptyResult();
    },
  };
}

function watch(overrides: Partial<CommercialWatchItem> = {}): CommercialWatchItem {
  return {
    id: "domain:acme.test:PORTAL_GENIE",
    organisation_id: "domain:acme.test",
    organisation_name: "Acme Accounting",
    product_scope: "PORTAL_GENIE",
    relationship_state: "ENGAGED_PROSPECT",
    recommended_contact_id: "c-jane",
    deal_ids: ["deal-1"],
    lead_ids: [],
    contact_ids: ["c-jane"],
    next_best_action: "PHONE_CALL",
    actionability_kind: "CUSTOMER_ACTION",
    customer_queue: true,
    executability: "EXECUTABLE_NOW",
    decision: "act",
    action_timing: "ACT_NOW",
    confidence: "MEDIUM",
    why_this_action: "Follow up now.",
    commercial_summary: "Acme engaged.",
    stalled_state: "NOT_STALLED",
    stalled_reasons: [],
    urgency_signals: [],
    opportunity_signals: [],
    risk_signals: [],
    usage_signals: [],
    data_quality_signals: [],
    evidence_refs: [],
    source_record: { module: "Contacts", recordId: "c-jane" },
    priority: "P1",
    rank: 1,
    why_ranked: "",
    reuse: "reused",
    ...overrides,
  };
}

function decisionFor(item: CommercialWatchItem, type: string, extra: Record<string, unknown> = {}) {
  return parseOperatorDecisionInput({
    watch_item_id: item.id,
    organisation_key: item.organisation_id,
    product_scope: item.product_scope,
    recommendation_fingerprint: recommendationFingerprintFromWatchItem(item),
    decision_context_snapshot: decisionContextSnapshotFromWatchItem(item),
    evidence_snapshot_ref: "fp-1",
    effective_from: EFFECTIVE_FROM,
    decision_type: type,
    ...extra,
  });
}

function controlled(item: CommercialWatchItem, decision: ReturnType<typeof decisionFor>) {
  return applyOperatorControlToWatchItem(item, [decision], {
    asOf: AS_OF,
    evidence_fingerprint: "fp-1",
    deal_ids: item.deal_ids,
    retrieval_ok: true,
  });
}

async function withStores<T>(run: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pg-od-cc-"));
  const previous = {
    intel: process.env.INTELLIGENCE_STORE_DIR,
    cc: process.env.COMMAND_CENTRE_STORE,
    od: process.env.OPERATOR_DECISIONS_STORE,
  };
  process.env.INTELLIGENCE_STORE_DIR = join(dir, "intel");
  process.env.COMMAND_CENTRE_STORE = join(dir, "command-centre.json");
  process.env.OPERATOR_DECISIONS_STORE = join(dir, "operator-decisions.json");
  mkdirSync(process.env.INTELLIGENCE_STORE_DIR, { recursive: true });
  try {
    return await run();
  } finally {
    if (previous.intel === undefined) delete process.env.INTELLIGENCE_STORE_DIR;
    else process.env.INTELLIGENCE_STORE_DIR = previous.intel;
    if (previous.cc === undefined) delete process.env.COMMAND_CENTRE_STORE;
    else process.env.COMMAND_CENTRE_STORE = previous.cc;
    if (previous.od === undefined) delete process.env.OPERATOR_DECISIONS_STORE;
    else process.env.OPERATOR_DECISIONS_STORE = previous.od;
  }
}

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function stored(overrides: Partial<StoredAnalysis> = {}): StoredAnalysis {
  return {
    analysedAt: "2026-08-20T10:00:00Z",
    module: "Contacts",
    recordId: "c1",
    schemaVersion: "test",
    model: "test",
    usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
    latencyMs: 12,
    success: true,
    profile: validSampleProfile({
      recommended_action: "PHONE_CALL",
      recommended_action_reason: "Call Jane about the partner programme.",
      best_contact: "Jane",
      relationship_summary: "Live Portal Genie conversation.",
      confidence: "HIGH",
    }),
    evidenceFingerprint: "fp-build",
    ...overrides,
  };
}

test("P1 dismissed is absent from effective DO FIRST", () => {
  const item = watch();
  const dismissed = controlled(item, decisionFor(item, "DISMISSED"));
  const brief = deterministicDailyBrief([dismissed], [], AS_OF);
  assert.equal(isCustomerExecutableBriefItem(dismissed), false);
  assert.equal(brief.do_first_actions.length, 0);
  assert.equal(dismissed.system_priority_band, "P1");
  assert.equal(dismissed.priority, "P1");
});

test("snoozed future item is absent from DO FIRST and appears in wait", () => {
  const item = watch();
  const snoozed = controlled(
    item,
    decisionFor(item, "SNOOZED", { effective_until: "2026-09-14T00:00:00.000Z" }),
  );
  const brief = deterministicDailyBrief([snoozed], [], AS_OF);
  assert.equal(brief.do_first_actions.length, 0);
  assert.ok(brief.wait_items.some((row) => row.organisation_name === "Acme Accounting"));
});

test("expired snooze becomes eligible again", () => {
  const item = watch();
  const snoozed = decisionFor(item, "SNOOZED", { effective_until: "2026-08-01T00:00:00.000Z" });
  const eligible = applyOperatorControlToWatchItem(item, [snoozed], {
    asOf: AS_OF,
    evidence_fingerprint: "fp-1",
    deal_ids: item.deal_ids,
  });
  assert.equal(isCustomerExecutableBriefItem(eligible), true);
});

test("waiting removes immediate customer action", () => {
  const item = watch();
  const waiting = controlled(item, decisionFor(item, "WAITING"));
  assert.equal(isCustomerExecutableBriefItem(waiting), false);
  assert.equal(waiting.effective_queue_state, "WAIT");
});

test("not opportunity suppresses only correct product", () => {
  const pg = watch();
  const np = watch({
    id: "domain:acme.test:NAGGING_PANDA",
    product_scope: "NAGGING_PANDA",
    next_best_action: "PERSONAL_EMAIL",
  });
  const decision = decisionFor(pg, "NOT_AN_OPPORTUNITY");
  const pgControlled = applyOperatorControlToWatchItems([pg, np], {
    asOf: AS_OF,
    decisions: [decision],
    evidenceByOrganisation: new Map([
      ["domain:acme.test", { evidence_fingerprint: "fp-1", retrieval_ok: true }],
    ]),
  });
  assert.equal(isCustomerExecutableBriefItem(pgControlled[0]!), false);
  assert.equal(isCustomerExecutableBriefItem(pgControlled[1]!), true);
});

test("research required appears in research section", () => {
  const item = watch();
  const research = controlled(item, decisionFor(item, "RESEARCH_REQUIRED"));
  const brief = deterministicDailyBrief([research], [], AS_OF);
  assert.equal(brief.do_first_actions.length, 0);
  assert.ok(brief.research_items.some((row) => row.organisation_name === "Acme Accounting"));
});

test("wrong action preserves opportunity as review required", () => {
  const item = watch();
  const wrong = controlled(item, decisionFor(item, "WRONG_ACTION"));
  assert.equal(isCustomerExecutableBriefItem(wrong), false);
  assert.equal(wrong.effective_queue_state, "REVIEW_REQUIRED");
  assert.equal(wrong.priority, "P1");
});

test("wrong person preserves opportunity as review required", () => {
  const item = watch();
  const wrong = controlled(item, decisionFor(item, "WRONG_PERSON"));
  assert.equal(wrong.effective_queue_state, "REVIEW_REQUIRED");
});

test("reopened item can surface in DO FIRST with explanation", () => {
  const item = watch();
  const dismissed = decisionFor(item, "DISMISSED");
  const reopened = applyOperatorControlToWatchItem(item, [dismissed], {
    asOf: AS_OF,
    evidence_fingerprint: "fp-changed",
    deal_ids: item.deal_ids,
    sales_events: [
      {
        ...parseSalesEventInput({
          organisation_id: "domain:acme.test",
          product_scope: "PORTAL_GENIE",
          event_type: "EMAIL",
          occurred_at: "2026-08-28T11:00:00.000Z",
          summary: "Inbound enquiry",
        }),
        created_at: "2026-08-28T11:30:00.000Z",
      },
    ],
  });
  assert.equal(reopened.operator_control?.reopened, true);
  const brief = deterministicDailyBrief([reopened], [], AS_OF);
  assert.equal(brief.do_first_actions.length, 1);
  assert.match(brief.do_first_actions[0]?.reason ?? "", /Previously dismissed|Reopened/i);
});

test("refresh keeps dismissed recommendation suppressed without extra OpenAI", async () => {
  await withStores(async () => {
    let analyseCalls = 0;
    writeStoredAnalysis(
      stored({
        evidenceFingerprint: "fp-build",
        recordId: "c1",
      }),
    );
    const snapshot1 = await buildCommandCentre(
      {
        client: listingClient(),
        publicDomains: new Set(["gmail.com"]),
        analyse: async () => {
          analyseCalls += 1;
          return stored();
        },
        now: () => new Date(AS_OF),
      },
      { mode: "build_changed", confirm: true, includeBriefSynthesis: false },
    );
    const callsAfterFirst = analyseCalls;
    assert.ok(snapshot1.brief.do_first_actions.length > 0);
    const target = snapshot1.watch_items.find(
      (item) => item.id === snapshot1.brief.do_first_actions[0]!.watch_item_id,
    );
    assert.ok(target);
    const evidenceFingerprint =
      findStoredAnalysisForRecords([{ module: "Contacts", recordId: "c1" }])?.evidenceFingerprint ?? "fp-build";
    createOperatorDecision({
      watch_item_id: target.id,
      organisation_key: target.organisation_id,
      product_scope: target.product_scope,
      recommendation_fingerprint: recommendationFingerprintFromWatchItem(target),
      decision_context_snapshot: decisionContextSnapshotFromWatchItem(target),
      evidence_snapshot_ref: evidenceFingerprint,
      effective_from: EFFECTIVE_FROM,
      decision_type: "DISMISSED",
    });
    const snapshot2 = await buildCommandCentre(
      {
        client: listingClient(),
        publicDomains: new Set(["gmail.com"]),
        analyse: async () => {
          analyseCalls += 1;
          return stored();
        },
        now: () => new Date(AS_OF),
      },
      { mode: "build_changed", confirm: true, includeBriefSynthesis: false },
    );
    assert.equal(analyseCalls, callsAfterFirst);
    const controlledItem = snapshot2.watch_items.find((item) => item.id === target.id);
    assert.ok(controlledItem?.operator_control?.controlled);
    assert.equal(isCustomerExecutableBriefItem(controlledItem!), false);
    assert.equal(snapshot2.brief.do_first_actions.length, 0);
    assert.equal(snapshot2.tokens.openai_calls, 0);
  });
});

test("POST /api/operator-decisions creates valid decision without OpenAI", async () => {
  await withStores(async () => {
    await withServer(async (base) => {
      const item = watch();
      const response = await fetch(`${base}/api/operator-decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          watch_item_id: item.id,
          organisation_key: item.organisation_id,
          product_scope: item.product_scope,
          recommendation_fingerprint: recommendationFingerprintFromWatchItem(item),
          decision_type: "DISMISSED",
          effective_from: EFFECTIVE_FROM,
        }),
      });
      const body = await response.json();
      assert.equal(response.status, 201);
      assert.equal(body.openaiTriggered, false);
      assert.equal(body.writtenToZoho, false);
      assert.equal(body.decision.decision_type, "DISMISSED");
    });
  });
});

test("POST /api/operator-decisions rejects invalid product scope", async () => {
  await withStores(async () => {
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/operator-decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          watch_item_id: "x",
          organisation_key: "domain:acme.test",
          product_scope: "INVALID",
          recommendation_fingerprint: "abc",
          decision_type: "DISMISSED",
        }),
      });
      assert.equal(response.status, 400);
    });
  });
});

test("revoked decision no longer suppresses", async () => {
  await withStores(async () => {
    const item = watch();
    const created = createOperatorDecision({
      watch_item_id: item.id,
      organisation_key: item.organisation_id,
      product_scope: item.product_scope,
      recommendation_fingerprint: recommendationFingerprintFromWatchItem(item),
      decision_context_snapshot: decisionContextSnapshotFromWatchItem(item),
      evidence_snapshot_ref: "fp-1",
      effective_from: EFFECTIVE_FROM,
      decision_type: "DISMISSED",
    });
    const suppressed = controlled(item, created);
    assert.equal(isCustomerExecutableBriefItem(suppressed), false);
    revokeOperatorDecision(created.id);
    const restored = applyOperatorControlToWatchItems([item], {
      asOf: AS_OF,
      evidenceByOrganisation: new Map([
        ["domain:acme.test", { evidence_fingerprint: "fp-1", retrieval_ok: true }],
      ]),
    })[0]!;
    assert.equal(isCustomerExecutableBriefItem(restored), true);
  });
});

test("no operator-decisions send endpoint exists", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/operator-decisions/send`, { method: "POST", body: "{}" });
    assert.equal(response.status, 404);
  });
});

function minimalSnapshot(items: CommercialWatchItem[]): PortfolioSnapshot {
  const brief = deterministicDailyBrief(items, [], AS_OF);
  return {
    generated_at: AS_OF,
    run_id: "test-run",
    duration_ms: 1,
    mode: "build_changed",
    organisations_discovered: 1,
    watch_items: items,
    ranking_note: "test",
    stalled_count: 0,
    waiting_count: 0,
    needs_action_today: items.filter((item) => isCustomerExecutableBriefItem(item)).length,
    active_opportunities: 0,
    brief,
    failures: [],
    tokens: { openai_calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    analyses_reused: 0,
    analyses_refreshed: 0,
    analyses_failed: 0,
  };
}

function enrichedWatch(overrides: Partial<CommercialWatchItem> = {}): CommercialWatchItem {
  const base = watch(overrides);
  return {
    ...base,
    system_customer_queue: base.customer_queue,
    system_priority_band: base.priority,
    recommendation_fingerprint: recommendationFingerprintFromWatchItem(base),
    decision_context_snapshot: decisionContextSnapshotFromWatchItem(base),
    evidence_snapshot_ref: "fp-1",
    ...overrides,
  };
}

test("refresh-control reapplies decisions without OpenAI and preserves fingerprint context", async () => {
  await withStores(async () => {
    const item = enrichedWatch();
    writePortfolioSnapshot(minimalSnapshot([item]));
    createOperatorDecision({
      watch_item_id: item.id,
      organisation_key: item.organisation_id,
      product_scope: item.product_scope,
      recommendation_fingerprint: item.recommendation_fingerprint!,
      decision_context_snapshot: item.decision_context_snapshot,
      evidence_snapshot_ref: item.evidence_snapshot_ref,
      effective_from: EFFECTIVE_FROM,
      decision_type: "DISMISSED",
    });
    const refreshed = refreshSnapshotOperatorControl(readPortfolioSnapshot()!);
    assert.equal(refreshed.tokens.openai_calls, 0);
    assert.equal(refreshed.brief.do_first_actions.length, 0);
    assert.equal(refreshed.watch_items[0]?.operator_control?.controlled, true);
    assert.equal(refreshed.watch_items[0]?.recommendation_fingerprint, item.recommendation_fingerprint);
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/command-centre/refresh-control`, { method: "POST" });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.openaiTriggered, false);
      assert.equal(body.snapshot.brief.do_first_actions.length, 0);
    });
  });
});

test("POST refresh-control after snooze moves item to wait state", async () => {
  await withStores(async () => {
    const item = enrichedWatch();
    writePortfolioSnapshot(minimalSnapshot([item]));
    createOperatorDecision({
      watch_item_id: item.id,
      organisation_key: item.organisation_id,
      product_scope: item.product_scope,
      recommendation_fingerprint: item.recommendation_fingerprint!,
      decision_context_snapshot: item.decision_context_snapshot,
      evidence_snapshot_ref: item.evidence_snapshot_ref,
      effective_from: EFFECTIVE_FROM,
      effective_until: "2026-09-14",
      decision_type: "SNOOZED",
    });
    const refreshed = refreshSnapshotOperatorControl(readPortfolioSnapshot()!);
    assert.equal(refreshed.brief.do_first_actions.length, 0);
    assert.equal(refreshed.watch_items[0]?.effective_queue_state, "WAIT");
  });
});

test("POST refresh-control after research moves item to research brief", async () => {
  await withStores(async () => {
    const item = enrichedWatch();
    writePortfolioSnapshot(minimalSnapshot([item]));
    createOperatorDecision({
      watch_item_id: item.id,
      organisation_key: item.organisation_id,
      product_scope: item.product_scope,
      recommendation_fingerprint: item.recommendation_fingerprint!,
      decision_context_snapshot: item.decision_context_snapshot,
      evidence_snapshot_ref: item.evidence_snapshot_ref,
      effective_from: EFFECTIVE_FROM,
      decision_type: "RESEARCH_REQUIRED",
    });
    const refreshed = refreshSnapshotOperatorControl(readPortfolioSnapshot()!);
    assert.equal(refreshed.brief.do_first_actions.length, 0);
    assert.ok((refreshed.brief.research_items || []).some((row) => row.watch_item_id === item.id));
  });
});

test("wrong action leaves review required after refresh-control", async () => {
  await withStores(async () => {
    const item = enrichedWatch();
    writePortfolioSnapshot(minimalSnapshot([item]));
    createOperatorDecision({
      watch_item_id: item.id,
      organisation_key: item.organisation_id,
      product_scope: item.product_scope,
      recommendation_fingerprint: item.recommendation_fingerprint!,
      decision_context_snapshot: item.decision_context_snapshot,
      evidence_snapshot_ref: item.evidence_snapshot_ref,
      effective_from: EFFECTIVE_FROM,
      decision_type: "WRONG_ACTION",
    });
    const refreshed = refreshSnapshotOperatorControl(readPortfolioSnapshot()!);
    assert.equal(refreshed.watch_items[0]?.effective_queue_state, "REVIEW_REQUIRED");
  });
});

test("dismiss does not create SalesEvent", async () => {
  await withStores(async () => {
    const item = enrichedWatch();
    createOperatorDecision({
      watch_item_id: item.id,
      organisation_key: item.organisation_id,
      product_scope: item.product_scope,
      recommendation_fingerprint: item.recommendation_fingerprint!,
      decision_context_snapshot: item.decision_context_snapshot,
      evidence_snapshot_ref: item.evidence_snapshot_ref,
      effective_from: EFFECTIVE_FROM,
      decision_type: "DISMISSED",
    });
    assert.equal(listSalesEvents().length, 0);
  });
});

test("COMPLETED internal decision does not create SalesEvent", async () => {
  await withStores(async () => {
    const item = enrichedWatch();
    createOperatorDecision({
      watch_item_id: item.id,
      organisation_key: item.organisation_id,
      product_scope: item.product_scope,
      recommendation_fingerprint: item.recommendation_fingerprint!,
      decision_context_snapshot: item.decision_context_snapshot,
      evidence_snapshot_ref: item.evidence_snapshot_ref,
      effective_from: EFFECTIVE_FROM,
      decision_type: "COMPLETED",
      operator_note: "Reviewed website.",
    });
    assert.equal(listSalesEvents().length, 0);
  });
});

test("POST /api/operator-decisions rejects overlong operator note", async () => {
  await withStores(async () => {
    await withServer(async (base) => {
      const item = watch();
      const response = await fetch(`${base}/api/operator-decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          watch_item_id: item.id,
          organisation_key: item.organisation_id,
          product_scope: item.product_scope,
          recommendation_fingerprint: recommendationFingerprintFromWatchItem(item),
          decision_type: "DISMISSED",
          operator_note: "x".repeat(4001),
        }),
      });
      assert.equal(response.status, 400);
    });
  });
});

test("SNOOZED requires future effective_until date", async () => {
  await withStores(async () => {
    await withServer(async (base) => {
      const item = watch();
      const response = await fetch(`${base}/api/operator-decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          watch_item_id: item.id,
          organisation_key: item.organisation_id,
          product_scope: item.product_scope,
          recommendation_fingerprint: recommendationFingerprintFromWatchItem(item),
          decision_type: "SNOOZED",
        }),
      });
      assert.equal(response.status, 400);
    });
  });
});
