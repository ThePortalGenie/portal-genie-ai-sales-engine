import assert from "node:assert/strict";
import test from "node:test";
import type { OrganisationGraph } from "../src/domain/organisation-graph.js";
import type { StoredAnalysis } from "../src/intelligence/analysis-store.js";
import { deterministicDailyBrief, isCustomerExecutableBriefItem } from "../src/intelligence/daily-brief.js";
import { validSampleProfile } from "../src/intelligence/profile-schema.js";
import { applyOperatorControlToWatchItems } from "../src/intelligence/watch-item-control.js";
import { watchItemsFromAnalysis } from "../src/intelligence/watch-from-analysis.js";

const AS_OF = "2026-08-28T08:00:00+02:00";

function graph(overrides: Partial<OrganisationGraph> = {}): OrganisationGraph {
  return {
    selectedContactId: "c1",
    selectedContactName: "Kirstin",
    organisationName: "Kirstin Resolve",
    domains: ["resolve.test"],
    certainty: "resolved",
    contacts: [
      {
        module: "Contacts",
        recordId: "c1",
        name: "Kirstin",
        email: "kirstin@resolve.test",
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
    analysedAt: "2026-08-28T07:00:00.000Z",
    module: "Contacts",
    recordId: "c1",
    schemaVersion: "test",
    model: "test",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    latencyMs: 1,
    success: true,
    profile: validSampleProfile(),
    organisationGraph: graph(),
    ...overrides,
  };
}

function kirstinNpAnalysis(overrides: Partial<StoredAnalysis> = {}): StoredAnalysis {
  return stored({
    profile: validSampleProfile({
      recommended_action: "USAGE_CHECK",
      recommended_action_reason: "Check whether the paid account is activated.",
      best_contact: "Kirstin",
    }),
    productRelationships: [
      {
        product: "NAGGING_PANDA",
        relationship_state: "PAYING_CUSTOMER",
        evidence_ids: [],
        summary: "Current Nagging Panda customer.",
        confidence: "HIGH",
      },
    ],
    organisationGraph: graph({
      deals: [
        {
          recordId: "d-np",
          name: "Nagging Panda",
          stage: "Closed Won - Single License",
          pipeline: "Nagging Panda",
          product: "NAGGING_PANDA",
          closedLost: false,
          closedWon: true,
          provenance: "test",
        },
      ],
    }),
    ...overrides,
  });
}

test("Kirstin Resolve NP current customer with unavailable usage is not sales work", () => {
  const items = watchItemsFromAnalysis(kirstinNpAnalysis(), {
    organisationId: "domain:rslv.test",
    organisationName: "Kirstin Resolve",
    reuse: "reused",
    asOf: AS_OF,
    usageDatasetAvailable: false,
  });
  const np = items.find((item) => item.product_scope === "NAGGING_PANDA");
  assert.ok(np);
  assert.equal(np.relationship_state, "PAYING_CUSTOMER");
  assert.equal(np.next_best_action, "NO_ACTION");
  assert.equal(np.executability, "NO_ACTION_REQUIRED");
  assert.equal(np.actionability_kind, "NO_ACTION");
  assert.equal(np.priority, "P5");
  assert.doesNotMatch(np.why_this_action ?? "", /Portal Genie/i);
  assert.match(np.why_this_action ?? "", /Nagging Panda usage telemetry is not integrated/i);
  assert.ok(np.usage_signals.some((signal) => signal.code === "USAGE_UNAVAILABLE"));
  assert.ok(!np.data_quality_signals.some((signal) => signal.code === "USAGE_DATASET_UNAVAILABLE"));

  const enriched = applyOperatorControlToWatchItems(items, { asOf: AS_OF });
  const controlled = enriched.find((item) => item.product_scope === "NAGGING_PANDA");
  assert.equal(controlled?.effective_queue_state, "SYSTEM_NO_ACTION");
  assert.equal(isCustomerExecutableBriefItem(controlled!), false);

  const brief = deterministicDailyBrief(enriched, [], AS_OF);
  assert.ok(!brief.research_items.some((item) => item.organisation_name === "Kirstin Resolve"));
  assert.ok(!brief.do_first_actions.some((item) => item.organisation_name === "Kirstin Resolve"));
});

test("PG usage unknown does not create NP action", () => {
  const items = watchItemsFromAnalysis(
    stored({
      profile: validSampleProfile({ recommended_action: "USAGE_CHECK" }),
      productRelationships: [
        { product: "PORTAL_GENIE", relationship_state: "ENGAGED_PROSPECT", evidence_ids: [], summary: "pg", confidence: "MEDIUM" },
        { product: "NAGGING_PANDA", relationship_state: "PAYING_CUSTOMER", evidence_ids: [], summary: "np", confidence: "HIGH" },
      ],
      organisationGraph: graph({
        deals: [
          {
            recordId: "d-pg",
            name: "Portal Genie",
            stage: "Demo Stage",
            pipeline: "The Portal Genie",
            product: "PORTAL_GENIE",
            closedLost: false,
            closedWon: false,
            provenance: "test",
          },
          {
            recordId: "d-np",
            name: "Nagging Panda",
            stage: "Closed Won - Single License",
            pipeline: "Nagging Panda",
            product: "NAGGING_PANDA",
            closedLost: false,
            closedWon: true,
            provenance: "test",
          },
        ],
      }),
    }),
    {
      organisationId: "domain:rslv.test",
      organisationName: "Kirstin Resolve",
      reuse: "reused",
      asOf: AS_OF,
      usageDatasetAvailable: false,
    },
  );
  const pg = items.find((item) => item.product_scope === "PORTAL_GENIE");
  const np = items.find((item) => item.product_scope === "NAGGING_PANDA");
  assert.equal(pg?.next_best_action, "NO_ACTION");
  assert.match(pg?.why_this_action ?? "", /Portal Genie usage dataset/i);
  assert.equal(np?.next_best_action, "NO_ACTION");
  assert.doesNotMatch(np?.why_this_action ?? "", /Portal Genie/i);
});

test("NP usage unavailable does not create PG action", () => {
  const items = watchItemsFromAnalysis(
    stored({
      profile: validSampleProfile({ recommended_action: "USAGE_CHECK" }),
      productRelationships: [
        { product: "PORTAL_GENIE", relationship_state: "PAYING_CUSTOMER", evidence_ids: [], summary: "pg", confidence: "HIGH" },
        { product: "NAGGING_PANDA", relationship_state: "PAYING_CUSTOMER", evidence_ids: [], summary: "np", confidence: "HIGH" },
      ],
      organisationGraph: graph({
        deals: [
          {
            recordId: "d-pg",
            name: "Portal Genie",
            stage: "Freemium",
            pipeline: "The Portal Genie",
            product: "PORTAL_GENIE",
            closedLost: false,
            closedWon: false,
            provenance: "test",
          },
          {
            recordId: "d-np",
            name: "Nagging Panda",
            stage: "Closed Won - Single License",
            pipeline: "Nagging Panda",
            product: "NAGGING_PANDA",
            closedLost: false,
            closedWon: true,
            provenance: "test",
          },
        ],
      }),
    }),
    {
      organisationId: "domain:rslv.test",
      organisationName: "Kirstin Resolve",
      reuse: "reused",
      asOf: AS_OF,
      usageDatasetAvailable: false,
    },
  );
  const pg = items.find((item) => item.product_scope === "PORTAL_GENIE");
  const np = items.find((item) => item.product_scope === "NAGGING_PANDA");
  assert.equal(np?.next_best_action, "NO_ACTION");
  assert.match(np?.why_this_action ?? "", /Nagging Panda usage telemetry/i);
  assert.equal(pg?.next_best_action, "NO_ACTION");
  assert.match(pg?.why_this_action ?? "", /Portal Genie usage dataset/i);
  assert.doesNotMatch(np?.why_this_action ?? "", /Portal Genie usage dataset/i);
});
