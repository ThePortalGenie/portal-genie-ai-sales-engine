import assert from "node:assert/strict";
import test from "node:test";
import {
  loadProductRegistrationStages,
  isRegisteredStage,
  isPreRegistrationStage,
} from "../src/config/product-registration-stages.js";
import {
  classifyProductRegistration,
  refineActionForRegistration,
  registrationAwareSummary,
} from "../src/intelligence/product-registration.js";
import { watchItemsFromAnalysis } from "../src/intelligence/watch-from-analysis.js";
import { validSampleProfile } from "../src/intelligence/profile-schema.js";
import type { StoredAnalysis } from "../src/intelligence/analysis-store.js";
import type { OrganisationGraph } from "../src/domain/organisation-graph.js";

const config = loadProductRegistrationStages();
const PG_REGISTERED = config.PORTAL_GENIE.registered_stages;
const PG_PRE_REGISTRATION = config.PORTAL_GENIE.pre_registration_stages;
const NP_REGISTERED = config.NAGGING_PANDA.registered_stages;
const NP_PRE_REGISTRATION = config.NAGGING_PANDA.pre_registration_stages;

function graph(overrides: Partial<OrganisationGraph> = {}): OrganisationGraph {
  return {
    selectedContactId: "c1",
    selectedContactName: "Jane",
    organisationName: "Acme",
    domains: ["acme.test"],
    certainty: "resolved",
    contacts: [
      {
        module: "Contacts",
        recordId: "c1",
        name: "Jane",
        email: "jane@acme.test",
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

function deal(
  overrides: {
    recordId?: string;
    name?: string;
    stage?: string;
    pipeline?: string;
    closedLost?: boolean;
    closedWon?: boolean;
  } = {},
) {
  return {
    recordId: overrides.recordId ?? "deal-1",
    name: overrides.name ?? "Portal Genie",
    stage: overrides.stage,
    pipeline: overrides.pipeline,
    product: undefined,
    closedLost: overrides.closedLost,
    closedWon: overrides.closedWon,
    provenance: "test",
  };
}

test("PG registered stages match exact Zoho values", () => {
  assert.deepEqual(PG_REGISTERED, [
    "Freemium",
    "In Trial - 30 Days",
    "Event Special 30 Days + 70% for 3 Months",
    "Event Special 60 Days +70% for 3 Months",
    "Firm Partner Deal - New",
  ]);
});

test("NP pre-registration stages match evidenced mapping", () => {
  assert.deepEqual(NP_PRE_REGISTRATION, ["Proposal Review"]);
});

for (const stage of PG_REGISTERED) {
  test(`Portal Genie stage ${stage} classifies as REGISTERED`, () => {
    const result = classifyProductRegistration("PORTAL_GENIE", [
      deal({ stage, pipeline: "The Portal Genie" }),
    ]);
    assert.equal(result.state, "REGISTERED");
    assert.equal(result.provenance.source, "CRM_DEAL_STAGE");
    assert.equal(result.provenance.stage, stage);
  });
}

for (const stage of NP_REGISTERED) {
  test(`Nagging Panda stage ${stage} classifies as REGISTERED`, () => {
    const result = classifyProductRegistration("NAGGING_PANDA", [
      deal({ stage, pipeline: "Nagging Panda", name: "NP subscription" }),
    ]);
    assert.equal(result.state, "REGISTERED");
    assert.equal(result.provenance.stage, stage);
  });
}

for (const stage of PG_PRE_REGISTRATION) {
  test(`Portal Genie pre-registration stage ${stage} classifies as NOT_REGISTERED`, () => {
    const result = classifyProductRegistration("PORTAL_GENIE", [
      deal({ stage, pipeline: "The Portal Genie" }),
    ]);
    assert.equal(result.state, "NOT_REGISTERED");
    assert.equal(result.provenance.stage, stage);
  });
}

test("NP Proposal Review classifies as NOT_REGISTERED", () => {
  const result = classifyProductRegistration("NAGGING_PANDA", [
    deal({ stage: "Proposal Review", pipeline: "Nagging Panda", name: "NP lead" }),
  ]);
  assert.equal(result.state, "NOT_REGISTERED");
});

test("unclassified active Portal Genie stage yields UNKNOWN", () => {
  const result = classifyProductRegistration("PORTAL_GENIE", [
    deal({ stage: "Stalled", pipeline: "The Portal Genie" }),
  ]);
  assert.equal(result.state, "UNKNOWN");
  assert.equal(result.provenance.stage, "Stalled");
});

test("absent-from-registered-list alone cannot produce NOT_REGISTERED", () => {
  const result = classifyProductRegistration("PORTAL_GENIE", [
    deal({ stage: "Partner Only", pipeline: "The Portal Genie" }),
  ]);
  assert.equal(result.state, "UNKNOWN");
  assert.notEqual(result.state, "NOT_REGISTERED");
});

test("missing stage yields UNKNOWN rather than inventing registration", () => {
  const result = classifyProductRegistration("PORTAL_GENIE", [
    deal({ pipeline: "The Portal Genie", stage: undefined }),
  ]);
  assert.equal(result.state, "UNKNOWN");
});

test("Closed Lost alone yields UNKNOWN", () => {
  const result = classifyProductRegistration("PORTAL_GENIE", [
    deal({ stage: "Closed Lost", pipeline: "The Portal Genie", closedLost: true }),
  ]);
  assert.equal(result.state, "UNKNOWN");
});

test("historical Closed Lost does not override current registered evidence", () => {
  const result = classifyProductRegistration("PORTAL_GENIE", [
    deal({ recordId: "d-lost", stage: "Closed Lost", pipeline: "The Portal Genie", closedLost: true }),
    deal({ recordId: "d-live", stage: "Freemium", pipeline: "The Portal Genie", closedLost: false }),
  ]);
  assert.equal(result.state, "REGISTERED");
  assert.equal(result.provenance.stage, "Freemium");
  assert.equal(result.provenance.deal_id, "d-live");
});

test("PG registration does not imply NP registration", () => {
  const pg = classifyProductRegistration("PORTAL_GENIE", [
    deal({ stage: "Freemium", pipeline: "The Portal Genie" }),
  ]);
  const np = classifyProductRegistration("NAGGING_PANDA", [
    deal({ stage: "Proposal Review", pipeline: "Nagging Panda", name: "NP lead" }),
  ]);
  assert.equal(pg.state, "REGISTERED");
  assert.equal(np.state, "NOT_REGISTERED");
});

test("NP registration does not imply PG registration", () => {
  const np = classifyProductRegistration("NAGGING_PANDA", [
    deal({ stage: "Awaiting Payment", pipeline: "Nagging Panda", name: "NP account" }),
  ]);
  const pg = classifyProductRegistration("PORTAL_GENIE", [
    deal({ stage: "Demo Stage", pipeline: "The Portal Genie" }),
  ]);
  assert.equal(np.state, "REGISTERED");
  assert.equal(pg.state, "NOT_REGISTERED");
});

test("registration does not imply paying customer relationship state", () => {
  const registration = classifyProductRegistration("PORTAL_GENIE", [
    deal({ stage: "Freemium", pipeline: "The Portal Genie" }),
  ]);
  assert.equal(registration.state, "REGISTERED");
  assert.notEqual(registration.state, "PAYING_CUSTOMER");
});

test("registration does not automatically imply Closed Won", () => {
  const registration = classifyProductRegistration("PORTAL_GENIE", [
    deal({ stage: "In Trial - 30 Days", pipeline: "The Portal Genie", closedWon: false }),
  ]);
  assert.equal(registration.state, "REGISTERED");
  assert.equal(registration.provenance.stage, "In Trial - 30 Days");
});

test("registered client keeps post-registration action refinement without inventing usage", () => {
  const refined = refineActionForRegistration("DEMO_INVITATION", {
    state: "REGISTERED",
    provenance: { source: "CRM_DEAL_STAGE", stage: "Freemium" },
  });
  assert.equal(refined, "FOLLOW_UP");
});

test("registration summary states registration is not paying or onboarded", () => {
  const summary = registrationAwareSummary("Acme · Portal Genie.", "PORTAL_GENIE", {
    state: "REGISTERED",
    provenance: { source: "CRM_DEAL_STAGE", stage: "Freemium" },
  });
  assert.match(summary, /registered account · Freemium/i);
  assert.match(summary, /Not assumed paying or fully onboarded/i);
});

test("watch item carries product-specific registration state from CRM deal stage", () => {
  const analysis: StoredAnalysis = {
    analysedAt: "2026-08-31T10:00:00.000Z",
    module: "Contacts",
    recordId: "c1",
    schemaVersion: "test",
    model: "test",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    latencyMs: 1,
    success: true,
    profile: validSampleProfile({ recommended_action: "DEMO_INVITATION" }),
    organisationGraph: graph({
      organisationId: "domain:acme.test",
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
          stage: "Proposal Review",
          pipeline: "Nagging Panda",
          product: "NAGGING_PANDA",
          closedLost: false,
          closedWon: false,
          provenance: "test",
        },
      ],
    }),
    productRelationships: [
      { product: "PORTAL_GENIE", relationship_state: "ENGAGED_PROSPECT", evidence_ids: [], summary: "pg", confidence: "MEDIUM" },
      { product: "NAGGING_PANDA", relationship_state: "ENGAGED_PROSPECT", evidence_ids: [], summary: "np", confidence: "MEDIUM" },
    ],
  };
  const items = watchItemsFromAnalysis(analysis, {
    organisationId: "domain:acme.test",
    organisationName: "Acme",
    reuse: "reused",
  });
  const pg = items.find((item) => item.product_scope === "PORTAL_GENIE");
  const np = items.find((item) => item.product_scope === "NAGGING_PANDA");
  assert.equal(pg?.product_registration_state, "REGISTERED");
  assert.equal(pg?.product_registration_provenance?.stage, "Freemium");
  assert.equal(np?.product_registration_state, "NOT_REGISTERED");
  assert.equal(np?.next_best_action, "DEMO_INVITATION");
  assert.equal(pg?.next_best_action, "FOLLOW_UP");
});

test("isRegisteredStage and isPreRegistrationStage use config without OpenAI", () => {
  assert.equal(isRegisteredStage("PORTAL_GENIE", "Freemium"), true);
  assert.equal(isRegisteredStage("PORTAL_GENIE", "Demo Stage"), false);
  assert.equal(isPreRegistrationStage("PORTAL_GENIE", "Demo Stage"), true);
  assert.equal(isPreRegistrationStage("PORTAL_GENIE", "Stalled"), false);
  assert.equal(isPreRegistrationStage("NAGGING_PANDA", "Proposal Review"), true);
});
