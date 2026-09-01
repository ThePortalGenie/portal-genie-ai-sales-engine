import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CommercialWatchItem, PortfolioSnapshot, UniverseRecord } from "../src/domain/commercial-watch.js";
import { DEFAULT_COMMAND_CENTRE_THRESHOLDS } from "../src/domain/commercial-watch.js";
import type { OrganisationGraph } from "../src/domain/organisation-graph.js";
import {
  decisionContextSnapshotFromWatchItem,
  recommendationFingerprintFromWatchItem,
} from "../src/domain/operator-decision.js";
import type { ZohoCrmReader } from "../src/integrations/zoho/client.js";
import type { ZohoHttpResult } from "../src/integrations/zoho/types.js";
import { loadCommandCentreThresholds } from "../src/config/command-centre.js";
import { writeStoredAnalysis, type StoredAnalysis } from "../src/intelligence/analysis-store.js";
import {
  buildCommandCentre,
  fingerprintForCluster,
  refreshSnapshotWithBackfill,
  scanCommandCentre,
  countBuildCandidatesAwaitingAnalysis,
  countScanCandidatesAwaitingAnalysis,
  _testOnlySelect,
  BACKFILL_MAX_ORGANISATIONS_EXAMINED_PER_VACANCY,
  BACKFILL_MAX_VACANCIES_PER_REFRESH,
  isWorthwhileBackfillReplacement,
  _testOnlyPartitionClustersForBuild,
} from "../src/intelligence/command-centre.js";
import { ccPresentationBucket } from "../src/web/command-centre-presentation.js";
import { createOperatorDecision } from "../src/intelligence/operator-decision-store.js";
import { discoverUniverse } from "../src/intelligence/universe-discovery.js";
import { validSampleProfile } from "../src/intelligence/profile-schema.js";
import { groupUniverseRecords } from "../src/intelligence/universe-group.js";
import { loadUsageImportMeta } from "../src/intelligence/usage-match.js";
import { watchItemsFromAnalysis } from "../src/intelligence/watch-from-analysis.js";
import {
  candidateSelectionScore,
  candidateSelectionScoreBreakdown,
  computeUniverseAuditStats,
  rankClustersForCandidateSelection,
  selectNextCandidatesForBackfill,
  selectOrganisationsForCommandCentre,
} from "../src/intelligence/universe-select.js";
import { isEffectivelyCustomerExecutable } from "../src/intelligence/watch-item-control.js";

const PUBLIC = new Set(["gmail.com", "hotmail.com"]);
const AS_OF = "2026-08-28T08:00:00+02:00";
const EFFECTIVE_FROM = "2026-01-01T00:00:00.000Z";

function emptyResult(): ZohoHttpResult {
  return { ok: true, status: 204, noContent: true, json: null };
}

function listed(rows: unknown[]): ZohoHttpResult {
  return { ok: true, status: 200, noContent: false, json: { data: rows, info: { more_records: false } } };
}

function listingClient(options: {
  contacts?: unknown[];
  leads?: unknown[];
  deals?: unknown[];
}): ZohoCrmReader {
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
      if (moduleApiName === "Contacts") return listed(options.contacts ?? []);
      if (moduleApiName === "Leads") return listed(options.leads ?? []);
      if (moduleApiName === "Deals") return listed(options.deals ?? []);
      return emptyResult();
    },
  };
}

function rec(overrides: Partial<UniverseRecord> & Pick<UniverseRecord, "module" | "recordId" | "name">): UniverseRecord {
  return { retrieval: "RETRIEVED", ...overrides };
}

function graph(overrides: Partial<OrganisationGraph> = {}): OrganisationGraph {
  return {
    selectedContactId: "c1",
    selectedContactName: "Sarah",
    organisationName: "ABC Accounting",
    domains: ["abc.test"],
    certainty: "resolved",
    contacts: [
      {
        module: "Contacts",
        recordId: "c1",
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
    module: "Contacts",
    recordId: "c1",
    schemaVersion: "test",
    model: "test",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    latencyMs: 5,
    success: true,
    profile: validSampleProfile({
      recommended_action: "PHONE_CALL",
      recommended_action_reason: "Follow up now.",
      best_contact: "Sarah",
      relationship_summary: "Engaged prospect.",
      confidence: "HIGH",
    }),
    organisationGraph: graph(),
    productRelationships: [
      {
        product: "PORTAL_GENIE",
        relationship_state: "ENGAGED_PROSPECT",
        evidence_ids: ["ev-1"],
        summary: "Engaged",
        confidence: "HIGH",
      },
    ],
    ...overrides,
  };
}

function leadStored(recordId: string, name: string, email: string): StoredAnalysis {
  return stored({
    module: "Leads",
    recordId,
    organisationGraph: graph({
      selectedContactId: recordId,
      selectedContactName: name,
      organisationName: name,
      domains: [email.split("@")[1] ?? "lead.test"],
      contacts: [
        {
          module: "Leads",
          recordId,
          name,
          email,
          association_reasons: ["SELECTED_CONTACT"],
          certainty: "associated",
          selected: true,
          commercial_role: { role: "SELECTED_CONTACT", layer: "crm_fact", evidence: "selected" },
        },
      ],
    }),
    profile: validSampleProfile({
      recommended_action: "PHONE_CALL",
      recommended_action_reason: "Strong lead follow-up.",
      best_contact: name,
      relationship_summary: "Active lead.",
      confidence: "HIGH",
    }),
  });
}

function watchItem(overrides: Partial<CommercialWatchItem> = {}): CommercialWatchItem {
  return {
    id: "domain:abc.test:PORTAL_GENIE",
    organisation_id: "domain:abc.test",
    organisation_name: "ABC",
    product_scope: "PORTAL_GENIE",
    relationship_state: "ENGAGED_PROSPECT",
    deal_ids: ["d1"],
    lead_ids: [],
    contact_ids: ["c1"],
    next_best_action: "PHONE_CALL",
    actionability_kind: "CUSTOMER_ACTION",
    customer_queue: true,
    system_customer_queue: true,
    executability: "EXECUTABLE_NOW",
    decision: "act",
    action_timing: "ACT_NOW",
    confidence: "MEDIUM",
    why_this_action: "Because.",
    commercial_summary: "Summary",
    stalled_state: "NOT_STALLED",
    stalled_reasons: [],
    urgency_signals: [],
    opportunity_signals: [],
    risk_signals: [],
    usage_signals: [],
    data_quality_signals: [],
    evidence_refs: [],
    source_record: { module: "Contacts", recordId: "c1" },
    priority: "P1",
    rank: 1,
    why_ranked: "",
    reuse: "reused",
    ...overrides,
  };
}

function snapshotFromItems(items: CommercialWatchItem[]): PortfolioSnapshot {
  return {
    generated_at: AS_OF,
    run_id: "cc-test",
    duration_ms: 1,
    mode: "build_changed",
    organisations_discovered: new Set(items.map((item) => item.organisation_id)).size,
    watch_items: items,
    ranking_note: "test",
    stalled_count: 0,
    waiting_count: 0,
    needs_action_today: items.filter((item) => isEffectivelyCustomerExecutable(item)).length,
    active_opportunities: 0,
    brief: {
      generated_at: AS_OF,
      mode: "deterministic",
      today_at_a_glance: "test",
      do_first_actions: [],
      wait_items: [],
      research_items: [],
      commercial_watch: [],
      do_first: [],
      follow_up_today: [],
      research_required: [],
      stalled: [],
      wait: [],
      reengage: [],
      recent_changes: [],
      warnings: [],
    },
    failures: [],
    tokens: { openai_calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    analyses_reused: 1,
    analyses_refreshed: 0,
    analyses_failed: 0,
  };
}

async function withStores<T>(run: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pg-cc-cov-"));
  mkdirSync(join(dir, "diagnostics"), { recursive: true });
  const previous = process.env.DIAGNOSTICS_DIR;
  process.env.DIAGNOSTICS_DIR = dir;
  const originalCwd = process.cwd;
  process.cwd = () => dir;
  try {
    return await run();
  } finally {
    process.cwd = originalCwd;
    if (previous === undefined) delete process.env.DIAGNOSTICS_DIR;
    else process.env.DIAGNOSTICS_DIR = previous;
  }
}

test("max candidate organisations defaults to 50 in config", () => {
  assert.equal(loadCommandCentreThresholds().maxCandidateOrganisations, 50);
  assert.equal(DEFAULT_COMMAND_CENTRE_THRESHOLDS.maxCandidateOrganisations, 50);
});

test("maxFreshOrganisationAnalysesPerBuild defaults to 10", () => {
  const thresholds = loadCommandCentreThresholds();
  assert.equal(thresholds.maxFreshOrganisationAnalysesPerBuild, 10);
});

test("universe audit counts lead-only and deal organisations separately", () => {
  const records = [
    rec({ module: "Leads", recordId: "l1", name: "Lead One", email: "one@leadonly.test", modifiedAt: "2026-08-27T10:00:00Z" }),
    rec({ module: "Contacts", recordId: "c1", name: "Contact", email: "c@dealco.test", modifiedAt: "2026-08-27T10:00:00Z" }),
    rec({
      module: "Deals",
      recordId: "d1",
      name: "Deal",
      contactId: "c1",
      email: "c@dealco.test",
      stage: "Qualification",
      modifiedAt: "2026-08-27T10:00:00Z",
    }),
  ];
  const clusters = groupUniverseRecords(records, PUBLIC);
  const audit = computeUniverseAuditStats(clusters, records);
  assert.equal(audit.reconstructed_organisations, 2);
  assert.equal(audit.organisations_with_leads, 1);
  assert.equal(audit.lead_only_organisations, 1);
  assert.equal(audit.organisations_with_deals, 1);
});

test("strong lead-only organisation can outrank stale deal organisation", () => {
  const records = [
    rec({
      module: "Leads",
      recordId: "l-hot",
      name: "Hot Lead",
      email: "hot@freshlead.test",
      lastActivityAt: "2026-08-27T10:00:00Z",
      modifiedAt: "2026-08-27T10:00:00Z",
    }),
    rec({ module: "Contacts", recordId: "c-old", name: "Old Deal Co", email: "old@staledeal.test", modifiedAt: "2026-01-01T10:00:00Z" }),
    rec({
      module: "Deals",
      recordId: "d-old",
      name: "Old Deal",
      contactId: "c-old",
      email: "old@staledeal.test",
      stage: "Qualification",
      modifiedAt: "2026-01-01T10:00:00Z",
    }),
  ];
  const clusters = groupUniverseRecords(records, PUBLIC);
  const ranked = rankClustersForCandidateSelection(clusters, AS_OF);
  assert.equal(ranked[0]?.records.some((item) => item.module === "Leads"), true);
});

test("lead-only organisation enters candidate pool without a deal", () => {
  const records = [
    rec({ module: "Leads", recordId: "l1", name: "Lead", email: "l@onlylead.test", modifiedAt: "2026-08-27T10:00:00Z" }),
  ];
  const clusters = groupUniverseRecords(records, PUBLIC);
  const selected = selectOrganisationsForCommandCentre(clusters, 50, AS_OF);
  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.records.some((item) => item.module === "Leads"), true);
});

test("more than 6 organisations can be selected up to configured capacity", () => {
  const records: UniverseRecord[] = [];
  for (let index = 0; index < 20; index += 1) {
    records.push(
      rec({
        module: "Contacts",
        recordId: `c${index}`,
        name: `Org ${index}`,
        email: `org${index}@wide${index}.test`,
        modifiedAt: `2026-08-${String(10 + (index % 10)).padStart(2, "0")}T10:00:00Z`,
      }),
    );
  }
  const clusters = groupUniverseRecords(records, PUBLIC);
  assert.equal(_testOnlySelect(clusters, 50, AS_OF).length, 20);
  assert.equal(_testOnlySelect(clusters, 12, AS_OF).length, 12);
});

test("scan reports full universe separately from candidate selection", async () => {
  await withStores(async () => {
    const contacts = Array.from({ length: 12 }, (_, index) => ({
      id: `c${index}`,
      Full_Name: `Org ${index}`,
      Email: `org${index}@wide${index}.test`,
      Modified_Time: "2026-08-20T10:00:00Z",
    }));
    const client = listingClient({ contacts });
    const scan = await scanCommandCentre(
      { client, publicDomains: PUBLIC, analyse: async () => stored() },
      { maxOrganisations: 6, persist: false },
    );
    assert.equal(scan.universe_size, 12);
    assert.equal(scan.organisations_discovered, 12);
    assert.equal(scan.organisations_selected, 6);
    assert.match(scan.truncated_reason ?? "", /6 of 12 discovered organisations selected for commercial analysis \(capacity 6\)/);
    assert.equal(scan.candidates_awaiting_analysis, 6);
    assert.equal(scan.build_projection?.would_defer, 0);
    assert.equal(scan.tokens.openai_calls, 0);
  });
});

test("unchanged evidence reuses analysis when candidate limit is larger", async () => {
  await withStores(async () => {
    const client = listingClient({
      contacts: [{ id: "c1", Full_Name: "Sarah", Email: "sarah@abc.test", Modified_Time: "2026-08-20T10:00:00Z" }],
    });
    const discovered = await discoverUniverse(client, { maxRecordsPerModule: 200 });
    const cluster = groupUniverseRecords(discovered.records, PUBLIC)[0]!;
    const fingerprint = fingerprintForCluster(cluster, loadUsageImportMeta().importedAt);
    writeStoredAnalysis({ ...stored({ recordId: "c1", evidenceFingerprint: fingerprint, analysedAt: "2099-01-01T00:00:00Z" }) });
    let analyseCalls = 0;
    const built = await buildCommandCentre(
      {
        client,
        publicDomains: PUBLIC,
        now: () => new Date(AS_OF),
        analyse: async () => {
          analyseCalls += 1;
          return stored({ recordId: "c1" });
        },
      },
      { mode: "build_changed", confirm: true, includeBriefSynthesis: false, maxOrganisations: 50 },
    );
    assert.equal(analyseCalls, 0);
    assert.equal(built.analyses_reused, 1);
    assert.equal(built.tokens.openai_calls, 0);
  });
});

test("lead-only cached analysis backfills snoozed deal recommendation without OpenAI", async () => {
  await withStores(async () => {
    const client = listingClient({
      contacts: [{ id: "c-deal", Full_Name: "Deal Co", Email: "x@dealbackfill.test", Modified_Time: "2026-08-20T10:00:00Z" }],
      leads: [{ id: "l-next", Full_Name: "Lead Next", Email: "next@leadbackfill.test", Modified_Time: "2026-08-27T10:00:00Z" }],
      deals: [
        {
          id: "d1",
          Deal_Name: "Live",
          Stage: "Qualification",
          Contact_Name: { id: "c-deal", name: "Deal Co" },
          Modified_Time: "2026-08-20T10:00:00Z",
        },
      ],
    });
    const discovered = await discoverUniverse(client, { maxRecordsPerModule: 200 });
    const clusters = groupUniverseRecords(discovered.records, PUBLIC);
    const dealCluster = clusters.find((item) => item.records.some((record) => record.module === "Deals"))!;
    const leadCluster = clusters.find((item) => item.records.some((record) => record.recordId === "l-next"))!;
    const dealFingerprint = fingerprintForCluster(dealCluster, loadUsageImportMeta().importedAt);
    const leadFingerprint = fingerprintForCluster(leadCluster, loadUsageImportMeta().importedAt);
    writeStoredAnalysis({ ...stored({ recordId: "c-deal", evidenceFingerprint: dealFingerprint }), analysedAt: "2099-01-01T00:00:00Z" });
    writeStoredAnalysis({ ...leadStored("l-next", "Lead Next", "next@leadbackfill.test"), evidenceFingerprint: leadFingerprint, analysedAt: "2099-01-01T00:00:00Z" });

    let analyseCalls = 0;
    const deps = {
      client,
      publicDomains: PUBLIC,
      now: () => new Date(AS_OF),
      analyse: async () => {
        analyseCalls += 1;
        return stored();
      },
    };

    const initial = await buildCommandCentre(deps, {
      mode: "selected",
      confirm: true,
      includeBriefSynthesis: false,
      organisationIds: [dealCluster.organisationId],
    });
    const snoozedItem = initial.watch_items[0]!;
    createOperatorDecision({
      watch_item_id: snoozedItem.id,
      organisation_key: snoozedItem.organisation_id,
      product_scope: snoozedItem.product_scope,
      recommendation_fingerprint: recommendationFingerprintFromWatchItem(snoozedItem),
      decision_context_snapshot: decisionContextSnapshotFromWatchItem(snoozedItem),
      evidence_snapshot_ref: "fp-deal",
      effective_from: EFFECTIVE_FROM,
      decision_type: "SNOOZED",
      effective_until: "2026-09-14T00:00:00.000Z",
    });

    const { snapshot: refreshed, openaiCalls } = await refreshSnapshotWithBackfill(deps, initial);
    assert.equal(openaiCalls, 0);
    assert.equal(analyseCalls, 0);
    assert.ok(refreshed.watch_items.some((item) => item.organisation_id === leadCluster.organisationId));
    assert.equal(isEffectivelyCustomerExecutable(refreshed.watch_items.find((item) => item.id === snoozedItem.id)!), false);
  });
});

test("NO_ACTION backfill candidate is stored but excluded from Command Centre buckets", async () => {
  await withStores(async () => {
    const client = listingClient({
      contacts: [{ id: "c1", Full_Name: "Active", Email: "a@active.test", Modified_Time: "2026-08-20T10:00:00Z" }],
      leads: [{ id: "l-weak", Full_Name: "Weak Lead", Email: "weak@stalelead.test", Modified_Time: "2025-01-01T10:00:00Z" }],
    });
    const discovered = await discoverUniverse(client, { maxRecordsPerModule: 200 });
    const clusters = groupUniverseRecords(discovered.records, PUBLIC);
    const activeCluster = clusters.find((item) => item.records.some((record) => record.recordId === "c1"))!;
    const weakCluster = clusters.find((item) => item.records.some((record) => record.recordId === "l-weak"))!;
    writeStoredAnalysis({
      ...stored({ recordId: "c1", evidenceFingerprint: fingerprintForCluster(activeCluster, loadUsageImportMeta().importedAt) }),
      analysedAt: "2099-01-01T00:00:00Z",
    });
    writeStoredAnalysis({
      ...leadStored("l-weak", "Weak Lead", "weak@stalelead.test"),
      profile: validSampleProfile({ recommended_action: "NO_ACTION", recommended_action_reason: "Stale lead." }),
      evidenceFingerprint: fingerprintForCluster(weakCluster, loadUsageImportMeta().importedAt),
      analysedAt: "2099-01-01T00:00:00Z",
    });

    let analyseCalls = 0;
    const deps = {
      client,
      publicDomains: PUBLIC,
      now: () => new Date(AS_OF),
      analyse: async () => {
        analyseCalls += 1;
        throw new Error("Backfill must reuse cached analysis");
      },
    };
    const initial = await buildCommandCentre(deps, {
      mode: "selected",
      confirm: true,
      includeBriefSynthesis: false,
      organisationIds: [activeCluster.organisationId],
    });
    const activeItem = initial.watch_items[0]!;
    createOperatorDecision({
      watch_item_id: activeItem.id,
      organisation_key: activeItem.organisation_id,
      product_scope: activeItem.product_scope,
      recommendation_fingerprint: recommendationFingerprintFromWatchItem(activeItem),
      decision_context_snapshot: decisionContextSnapshotFromWatchItem(activeItem),
      evidence_snapshot_ref: activeItem.evidence_snapshot_ref ?? "fp-active",
      effective_from: EFFECTIVE_FROM,
      decision_type: "SNOOZED",
      effective_until: "2026-09-14T00:00:00.000Z",
    });
    const { snapshot: refreshed } = await refreshSnapshotWithBackfill(deps, initial);
    assert.equal(analyseCalls, 0);
    const focusVisible = (items: CommercialWatchItem[]) =>
      items.filter((item) => {
        const bucket = ccPresentationBucket(item);
        return bucket === "focus_now" || bucket === "next";
      }).length;
    assert.equal(focusVisible(refreshed.watch_items), 0);
    const weakItem = refreshed.watch_items.find((item) => item.organisation_id === weakCluster.organisationId);
    if (weakItem) assert.equal(ccPresentationBucket(weakItem), "excluded");
  });
});

test("commercially strong lead-only watch item can present as focus now", () => {
  const [item] = watchItemsFromAnalysis(
    leadStored("l-strong", "Strong Lead", "strong@hotlead.test"),
    {
      organisationId: "domain:hotlead.test",
      organisationName: "Strong Lead Co",
      reuse: "reused",
      asOf: AS_OF,
      listingDeals: [],
    },
  );
  assert.ok(item);
  assert.equal(item.source_record?.module, "Leads");
  assert.ok(item.lead_ids.includes("l-strong"));
  assert.equal(item.deal_ids.length, 0);
  assert.equal(ccPresentationBucket(item), "focus_now");
});

test("same email lead and contact consolidate to one organisation cluster", () => {
  const records = [
    rec({ module: "Leads", recordId: "l1", name: "Sam Lead", email: "sam@sameco.test", modifiedAt: "2026-08-01T10:00:00Z" }),
    rec({ module: "Contacts", recordId: "c1", name: "Sam Contact", email: "sam@sameco.test", modifiedAt: "2026-08-20T10:00:00Z" }),
  ];
  const clusters = groupUniverseRecords(records, PUBLIC);
  assert.equal(clusters.length, 1);
  assert.ok(clusters[0]?.records.some((item) => item.module === "Leads"));
  assert.ok(clusters[0]?.records.some((item) => item.module === "Contacts"));
});

test("presentation buckets remain consistent for default focus now and next views", () => {
  const items = [
    watchItem({ id: "a:PORTAL_GENIE", priority: "P1", action_timing: "ACT_NOW" }),
    watchItem({ id: "b:PORTAL_GENIE", organisation_id: "domain:b.test", priority: "P2", action_timing: "TODAY" }),
    watchItem({ id: "c:PORTAL_GENIE", organisation_id: "domain:c.test", priority: "P5", next_best_action: "NO_ACTION", action_timing: "NO_ACTION_REQUIRED", actionability_kind: "NO_ACTION", executability: "NO_ACTION_REQUIRED" }),
  ];
  const visible = items.filter((item) => ccPresentationBucket(item) !== "excluded");
  assert.equal(visible.length, 2);
  assert.equal(items.filter((item) => ccPresentationBucket(item) === "focus_now").length, 1);
  assert.equal(items.filter((item) => ccPresentationBucket(item) === "next").length, 1);
});

test("selectNextCandidatesForBackfill skips organisations already in snapshot", () => {
  const records = [
    rec({ module: "Contacts", recordId: "c1", name: "One", email: "one@a.test", modifiedAt: "2026-08-27T10:00:00Z" }),
    rec({ module: "Contacts", recordId: "c2", name: "Two", email: "two@b.test", modifiedAt: "2026-08-26T10:00:00Z" }),
  ];
  const clusters = groupUniverseRecords(records, PUBLIC);
  const exclude = new Set([clusters[0]!.organisationId]);
  const next = selectNextCandidatesForBackfill(clusters, exclude, 1, AS_OF);
  assert.equal(next.length, 1);
  assert.equal(next[0]?.organisationId, clusters[1]?.organisationId);
});

test("deterministic selection limits expensive analysis when universe exceeds capacity", async () => {
  await withStores(async () => {
    const contacts = Array.from({ length: 80 }, (_, index) => ({
      id: `c${index}`,
      Full_Name: `Org ${index}`,
      Email: `org${index}@big${index}.test`,
      Modified_Time: "2026-08-20T10:00:00Z",
    }));
    const client = listingClient({ contacts });
    let analyseCalls = 0;
    const built = await buildCommandCentre(
      {
        client,
        publicDomains: PUBLIC,
        now: () => new Date(AS_OF),
        analyse: async (_module, recordId) => {
          analyseCalls += 1;
          return stored({ recordId });
        },
      },
      { mode: "build_changed", confirm: true, includeBriefSynthesis: false, maxOrganisations: 50 },
    );
    assert.equal(analyseCalls, 10);
    assert.equal(built.analyses_deferred, 40);
    assert.equal(built.universe_size, 80);
    assert.equal(built.candidates_selected, 50);
    assert.equal(built.organisations_analysed, 10);
    assert.equal(built.candidates_awaiting_analysis, 40);
    assert.equal(built.organisations_discovered, 10);
  });
});

test("first expanded build_changed reuses cached analyses and caps fresh OpenAI", async () => {
  await withStores(async () => {
    const contacts = Array.from({ length: 15 }, (_, index) => ({
      id: `c${index}`,
      Full_Name: `Org ${index}`,
      Email: `org${index}@expand${index}.test`,
      Modified_Time: "2026-08-20T10:00:00Z",
    }));
    const client = listingClient({ contacts });
    const discovered = await discoverUniverse(client, { maxRecordsPerModule: 200 });
    const clusters = groupUniverseRecords(discovered.records, PUBLIC);
    for (const cluster of clusters.slice(0, 5)) {
      const rep = cluster.representative;
      writeStoredAnalysis({
        ...stored({ recordId: rep.recordId, module: rep.module }),
        evidenceFingerprint: fingerprintForCluster(cluster, loadUsageImportMeta().importedAt),
        analysedAt: "2099-01-01T00:00:00Z",
      });
    }
    let analyseCalls = 0;
    const built = await buildCommandCentre(
      {
        client,
        publicDomains: PUBLIC,
        now: () => new Date(AS_OF),
        analyse: async (_module, recordId) => {
          analyseCalls += 1;
          return stored({ recordId });
        },
      },
      { mode: "build_changed", confirm: true, includeBriefSynthesis: false, maxOrganisations: 15 },
    );
    assert.equal(analyseCalls, 10);
    assert.equal(built.analyses_reused, 5);
    assert.equal(built.analyses_refreshed, 10);
    assert.equal(built.analyses_deferred ?? 0, 0);
    assert.equal(built.organisations_analysed, 15);
    assert.equal(built.candidates_awaiting_analysis, 0);
    assert.equal(built.candidates_selected, 15);
    assert.ok(built.watch_items.length >= 5);
  });
});

test("backfill searches past NO_ACTION candidate to surface worthwhile lead", async () => {
  await withStores(async () => {
    const client = listingClient({
      contacts: [{ id: "c-active", Full_Name: "Active", Email: "a@active2.test", Modified_Time: "2026-08-20T10:00:00Z" }],
      leads: [
        { id: "l-weak", Full_Name: "Weak", Email: "weak@stale2.test", Modified_Time: "2025-01-01T10:00:00Z" },
        { id: "l-good", Full_Name: "Good Lead", Email: "good@hot2.test", Modified_Time: "2026-08-27T10:00:00Z" },
      ],
    });
    const discovered = await discoverUniverse(client, { maxRecordsPerModule: 200 });
    const clusters = groupUniverseRecords(discovered.records, PUBLIC);
    const activeCluster = clusters.find((item) => item.records.some((record) => record.recordId === "c-active"))!;
    const weakCluster = clusters.find((item) => item.records.some((record) => record.recordId === "l-weak"))!;
    const goodCluster = clusters.find((item) => item.records.some((record) => record.recordId === "l-good"))!;
    writeStoredAnalysis({
      ...stored({ recordId: "c-active", evidenceFingerprint: fingerprintForCluster(activeCluster, loadUsageImportMeta().importedAt) }),
      analysedAt: "2099-01-01T00:00:00Z",
    });
    writeStoredAnalysis({
      ...leadStored("l-weak", "Weak", "weak@stale2.test"),
      profile: validSampleProfile({ recommended_action: "NO_ACTION", recommended_action_reason: "Stale." }),
      evidenceFingerprint: fingerprintForCluster(weakCluster, loadUsageImportMeta().importedAt),
      analysedAt: "2099-01-01T00:00:00Z",
    });
    writeStoredAnalysis({
      ...leadStored("l-good", "Good Lead", "good@hot2.test"),
      evidenceFingerprint: fingerprintForCluster(goodCluster, loadUsageImportMeta().importedAt),
      analysedAt: "2099-01-01T00:00:00Z",
    });

    let analyseCalls = 0;
    const deps = {
      client,
      publicDomains: PUBLIC,
      now: () => new Date(AS_OF),
      analyse: async () => {
        analyseCalls += 1;
        throw new Error("must reuse cache");
      },
    };
    const initial = await buildCommandCentre(deps, {
      mode: "selected",
      confirm: true,
      includeBriefSynthesis: false,
      organisationIds: [activeCluster.organisationId],
    });
    initial.universe_size = clusters.length;
    const activeItem = initial.watch_items[0]!;
    createOperatorDecision({
      watch_item_id: activeItem.id,
      organisation_key: activeItem.organisation_id,
      product_scope: activeItem.product_scope,
      recommendation_fingerprint: recommendationFingerprintFromWatchItem(activeItem),
      decision_context_snapshot: decisionContextSnapshotFromWatchItem(activeItem),
      evidence_snapshot_ref: activeItem.evidence_snapshot_ref ?? "fp-active",
      effective_from: EFFECTIVE_FROM,
      decision_type: "SNOOZED",
      effective_until: "2026-09-14T00:00:00.000Z",
    });
    const { snapshot: refreshed } = await refreshSnapshotWithBackfill(deps, initial);
    assert.equal(analyseCalls, 0);
    assert.ok(refreshed.watch_items.some((item) => item.organisation_id === goodCluster.organisationId));
    assert.ok(
      refreshed.watch_items.some(
        (item) =>
          item.organisation_id === goodCluster.organisationId &&
          (ccPresentationBucket(item) === "focus_now" || ccPresentationBucket(item) === "next"),
      ),
    );
  });
});

test("backfill examination is bounded per vacancy", () => {
  assert.equal(BACKFILL_MAX_ORGANISATIONS_EXAMINED_PER_VACANCY, 5);
  assert.equal(BACKFILL_MAX_VACANCIES_PER_REFRESH, 10);
});

test("three suppressed actives can backfill up to three worthwhile candidates", async () => {
  await withStores(async () => {
    const contacts = [
      { id: "c1", Full_Name: "One", Email: "one@org1multi.test", Modified_Time: "2026-08-20T10:00:00Z" },
      { id: "c2", Full_Name: "Two", Email: "two@org2multi.test", Modified_Time: "2026-08-20T10:00:00Z" },
      { id: "c3", Full_Name: "Three", Email: "three@org3multi.test", Modified_Time: "2026-08-20T10:00:00Z" },
      { id: "c4", Full_Name: "Four", Email: "four@org4multi.test", Modified_Time: "2026-08-27T10:00:00Z" },
      { id: "c5", Full_Name: "Five", Email: "five@org5multi.test", Modified_Time: "2026-08-27T10:00:00Z" },
      { id: "c6", Full_Name: "Six", Email: "six@org6multi.test", Modified_Time: "2026-08-27T10:00:00Z" },
    ];
    const client = listingClient({ contacts });
    const discovered = await discoverUniverse(client, { maxRecordsPerModule: 200 });
    const clusters = groupUniverseRecords(discovered.records, PUBLIC);
    for (const cluster of clusters) {
      const rep = cluster.representative;
      writeStoredAnalysis({
        ...stored({ recordId: rep.recordId, module: rep.module }),
        evidenceFingerprint: fingerprintForCluster(cluster, loadUsageImportMeta().importedAt),
        analysedAt: "2099-01-01T00:00:00Z",
      });
    }
    const deps = { client, publicDomains: PUBLIC, now: () => new Date(AS_OF), analyse: async () => stored() };
    const initial = await buildCommandCentre(deps, {
      mode: "selected",
      confirm: true,
      includeBriefSynthesis: false,
      organisationIds: clusters.slice(0, 3).map((item) => item.organisationId),
    });
    initial.universe_size = clusters.length;
    for (const item of initial.watch_items) {
      createOperatorDecision({
        watch_item_id: item.id,
        organisation_key: item.organisation_id,
        product_scope: item.product_scope,
        recommendation_fingerprint: recommendationFingerprintFromWatchItem(item),
        decision_context_snapshot: decisionContextSnapshotFromWatchItem(item),
        evidence_snapshot_ref: item.evidence_snapshot_ref ?? "fp",
        effective_from: EFFECTIVE_FROM,
        decision_type: "SNOOZED",
        effective_until: "2026-09-14T00:00:00.000Z",
      });
    }
    const before = initial.watch_items.filter((item) => isEffectivelyCustomerExecutable(item)).length;
    assert.equal(before, 3);
    const { snapshot: refreshed } = await refreshSnapshotWithBackfill(deps, initial);
    const after = refreshed.watch_items.filter((item) => isEffectivelyCustomerExecutable(item)).length;
    assert.equal(after, 3);
    assert.ok(new Set(refreshed.watch_items.map((item) => item.organisation_id)).size >= 6);
  });
});

test("candidateSelectionScoreBreakdown favours strong lead over stale live deal", () => {
  const records = [
    rec({
      module: "Leads",
      recordId: "l-hot",
      name: "Hot Lead",
      email: "hot@hotleadscore.test",
      lastActivityAt: "2026-08-27T10:00:00Z",
      modifiedAt: "2026-08-27T10:00:00Z",
    }),
    rec({ module: "Contacts", recordId: "c-old", name: "Old", email: "old@staledealscore.test", modifiedAt: "2026-01-01T10:00:00Z" }),
    rec({
      module: "Deals",
      recordId: "d-old",
      name: "Old Deal",
      contactId: "c-old",
      email: "old@staledealscore.test",
      stage: "Qualification",
      modifiedAt: "2026-01-01T10:00:00Z",
    }),
  ];
  const clusters = groupUniverseRecords(records, PUBLIC);
  const leadCluster = clusters.find((item) => item.records.some((record) => record.module === "Leads"))!;
  const dealCluster = clusters.find((item) => item.records.some((record) => record.module === "Deals"))!;
  const leadScore = candidateSelectionScoreBreakdown(leadCluster, AS_OF);
  const dealScore = candidateSelectionScoreBreakdown(dealCluster, AS_OF);
  assert.ok(leadScore.total > dealScore.total);
  assert.equal(leadScore.lead, 55);
  assert.equal(dealScore.live_deal, 25);
});

test("partitionClustersForBuild allocates fresh budget to never-analysed after refresh", async () => {
  await withStores(async () => {
    const contacts = Array.from({ length: 50 }, (_, index) => ({
      id: `c${index}`,
      Full_Name: `Org ${index}`,
      Email: `org${index}@part${index}.test`,
      Modified_Time: "2026-08-20T10:00:00Z",
    }));
    const client = listingClient({ contacts });
    const discovered = await discoverUniverse(client, { maxRecordsPerModule: 200 });
    const clusters = groupUniverseRecords(discovered.records, PUBLIC);
    for (const cluster of clusters.slice(0, 5)) {
      const rep = cluster.representative;
      writeStoredAnalysis({
        ...stored({ recordId: rep.recordId, module: rep.module }),
        evidenceFingerprint: fingerprintForCluster(cluster, loadUsageImportMeta().importedAt),
        analysedAt: "2099-01-01T00:00:00Z",
      });
    }
    const thresholds = { ...DEFAULT_COMMAND_CENTRE_THRESHOLDS, maxFreshOrganisationAnalysesPerBuild: 10 };
    const partition = _testOnlyPartitionClustersForBuild(
      clusters.slice(0, 50),
      "build_changed",
      thresholds,
      loadUsageImportMeta().importedAt,
      AS_OF,
    );
    assert.equal(partition.reusable, 5);
    assert.equal(partition.freshInitial, 10);
    assert.equal(partition.freshRefresh, 0);
    assert.equal(partition.process.length, 15);
    assert.equal(partition.deferred, 35);
  });
});

test("build_changed progressively grows analysed set from 5 toward 50", async () => {
  await withStores(async () => {
    const contacts = Array.from({ length: 60 }, (_, index) => ({
      id: `c${index}`,
      Full_Name: `Org ${index}`,
      Email: `org${index}@progressive${index}.test`,
      Modified_Time: "2026-08-20T10:00:00Z",
    }));
    const client = listingClient({ contacts });
    const discovered = await discoverUniverse(client, { maxRecordsPerModule: 200 });
    const clusters = groupUniverseRecords(discovered.records, PUBLIC);
    for (const cluster of clusters.slice(0, 5)) {
      const rep = cluster.representative;
      writeStoredAnalysis({
        ...stored({ recordId: rep.recordId, module: rep.module }),
        evidenceFingerprint: fingerprintForCluster(cluster, loadUsageImportMeta().importedAt),
        analysedAt: "2099-01-01T00:00:00Z",
      });
    }
    const deps = {
      client,
      publicDomains: PUBLIC,
      now: () => new Date(AS_OF),
      analyse: async (_module: string, recordId: string) => stored({ recordId }),
    };
    const expectedAnalysed = [15, 25, 35, 45, 50];
    let analysedBefore = 5;
    for (const expected of expectedAnalysed) {
      let freshCalls = 0;
      const built = await buildCommandCentre(
        {
          ...deps,
          analyse: async (_module, recordId) => {
            freshCalls += 1;
            return stored({ recordId });
          },
        },
        { mode: "build_changed", confirm: true, includeBriefSynthesis: false, maxOrganisations: 50 },
      );
      assert.equal(freshCalls, Math.min(10, expected - analysedBefore), `fresh calls reaching ${expected} analysed`);
      assert.equal(built.organisations_analysed, expected);
      assert.equal(built.candidates_awaiting_analysis, 50 - expected);
      assert.equal(built.universe_size, clusters.length);
      assert.equal(built.candidates_selected, 50);
      assert.equal(built.analyses_deferred ?? 0, 50 - expected);
      analysedBefore = expected;
    }
  });
});

test("unchanged cached candidates do not consume fresh budget on build_changed", async () => {
  await withStores(async () => {
    const contacts = Array.from({ length: 20 }, (_, index) => ({
      id: `c${index}`,
      Full_Name: `Org ${index}`,
      Email: `org${index}@reusebudget${index}.test`,
      Modified_Time: "2026-08-20T10:00:00Z",
    }));
    const client = listingClient({ contacts });
    const discovered = await discoverUniverse(client, { maxRecordsPerModule: 200 });
    const clusters = groupUniverseRecords(discovered.records, PUBLIC);
    for (const cluster of clusters) {
      const rep = cluster.representative;
      writeStoredAnalysis({
        ...stored({ recordId: rep.recordId, module: rep.module }),
        evidenceFingerprint: fingerprintForCluster(cluster, loadUsageImportMeta().importedAt),
        analysedAt: "2099-01-01T00:00:00Z",
      });
    }
    let freshCalls = 0;
    const built = await buildCommandCentre(
      {
        client,
        publicDomains: PUBLIC,
        now: () => new Date(AS_OF),
        analyse: async () => {
          freshCalls += 1;
          return stored();
        },
      },
      { mode: "build_changed", confirm: true, includeBriefSynthesis: false, maxOrganisations: 20 },
    );
    assert.equal(freshCalls, 0);
    assert.equal(built.analyses_reused, 20);
    assert.equal(built.organisations_analysed, 20);
  });
});

test("full_rebuild still analyses all selected candidates", async () => {
  await withStores(async () => {
    const contacts = Array.from({ length: 12 }, (_, index) => ({
      id: `c${index}`,
      Full_Name: `Org ${index}`,
      Email: `org${index}@fullrebuild${index}.test`,
      Modified_Time: "2026-08-20T10:00:00Z",
    }));
    const client = listingClient({ contacts });
    let freshCalls = 0;
    const built = await buildCommandCentre(
      {
        client,
        publicDomains: PUBLIC,
        now: () => new Date(AS_OF),
        analyse: async (_module, recordId) => {
          freshCalls += 1;
          return stored({ recordId });
        },
      },
      { mode: "full_rebuild", confirm: true, includeBriefSynthesis: false, maxOrganisations: 12 },
    );
    assert.equal(freshCalls, 12);
    assert.equal(built.organisations_analysed, 12);
    assert.equal(built.analyses_deferred ?? 0, 0);
  });
});

test("recommendation count is not forced to equal analysed organisation count", async () => {
  await withStores(async () => {
    const client = listingClient({
      contacts: Array.from({ length: 8 }, (_, index) => ({
        id: `c${index}`,
        Full_Name: `Org ${index}`,
        Email: `org${index}@noaction${index}.test`,
        Modified_Time: "2026-08-20T10:00:00Z",
      })),
    });
    const noActionProfile = validSampleProfile({
      recommended_action: "NO_ACTION",
      recommended_action_reason: "Nothing to do.",
    });
    let freshCalls = 0;
    const built = await buildCommandCentre(
      {
        client,
        publicDomains: PUBLIC,
        now: () => new Date(AS_OF),
        analyse: async (_module, recordId) => {
          freshCalls += 1;
          return { ...stored({ recordId }), profile: noActionProfile };
        },
      },
      { mode: "full_rebuild", confirm: true, includeBriefSynthesis: false, maxOrganisations: 8 },
    );
    assert.equal(freshCalls, 8);
    assert.equal(built.organisations_analysed, 8);
    const actionable = built.watch_items.filter(
      (item) => item.next_best_action !== "NO_ACTION" && item.priority !== "P5" && item.actionability_kind !== "NO_ACTION",
    );
    assert.ok(actionable.length < built.organisations_analysed);
  });
});

test("candidate accounting: selected=50 analysed=5 implies awaiting=45 on scan", async () => {
  await withStores(async () => {
    const contacts = Array.from({ length: 55 }, (_, index) => ({
      id: `c${index}`,
      Full_Name: `Org ${index}`,
      Email: `org${index}@acct${index}.test`,
      Modified_Time: "2026-08-20T10:00:00Z",
    }));
    const client = listingClient({ contacts });
    const discovered = await discoverUniverse(client, { maxRecordsPerModule: 200 });
    const clusters = groupUniverseRecords(discovered.records, PUBLIC);
    for (const cluster of clusters.slice(0, 5)) {
      const rep = cluster.representative;
      writeStoredAnalysis({
        ...stored({ recordId: rep.recordId, module: rep.module }),
        evidenceFingerprint: fingerprintForCluster(cluster, loadUsageImportMeta().importedAt),
        analysedAt: "2099-01-01T00:00:00Z",
      });
    }
    const scan = await scanCommandCentre(
      { client, publicDomains: PUBLIC, analyse: async () => stored() },
      { maxOrganisations: 50, persist: false },
    );
    assert.equal(scan.organisations_selected, 50);
    assert.equal(scan.candidate_capacity, 50);
    assert.equal(scan.analyses_reusable, 5);
    assert.equal(scan.candidates_awaiting_analysis, 45);
    assert.equal(scan.build_projection?.would_defer, 35);
    assert.notEqual(scan.candidates_awaiting_analysis, scan.build_projection?.would_defer);
    assert.equal(
      countScanCandidatesAwaitingAnalysis(scan.organisations),
      scan.candidates_awaiting_analysis,
    );
    assert.equal(countBuildCandidatesAwaitingAnalysis(50, 5), 45);
  });
});

test("build projection would_defer is not used as cumulative awaiting status", async () => {
  await withStores(async () => {
    const contacts = Array.from({ length: 55 }, (_, index) => ({
      id: `c${index}`,
      Full_Name: `Org ${index}`,
      Email: `org${index}@proj${index}.test`,
      Modified_Time: "2026-08-20T10:00:00Z",
    }));
    const client = listingClient({ contacts });
    const discovered = await discoverUniverse(client, { maxRecordsPerModule: 200 });
    const clusters = groupUniverseRecords(discovered.records, PUBLIC);
    for (const cluster of clusters.slice(0, 5)) {
      const rep = cluster.representative;
      writeStoredAnalysis({
        ...stored({ recordId: rep.recordId, module: rep.module }),
        evidenceFingerprint: fingerprintForCluster(cluster, loadUsageImportMeta().importedAt),
        analysedAt: "2099-01-01T00:00:00Z",
      });
    }
    let freshCalls = 0;
    const built = await buildCommandCentre(
      {
        client,
        publicDomains: PUBLIC,
        now: () => new Date(AS_OF),
        analyse: async (_module, recordId) => {
          freshCalls += 1;
          return stored({ recordId });
        },
      },
      { mode: "build_changed", confirm: true, includeBriefSynthesis: false, maxOrganisations: 50 },
    );
    assert.equal(freshCalls, 10);
    assert.equal(built.organisations_analysed, 15);
    assert.equal(built.candidates_awaiting_analysis, 35);
    assert.equal(built.analyses_deferred, 35);
    assert.equal(built.candidates_selected, 50);
  });
});

test("failed analysis remains awaiting and is not counted as analysed", async () => {
  await withStores(async () => {
    const contacts = Array.from({ length: 15 }, (_, index) => ({
      id: `c${index}`,
      Full_Name: `Org ${index}`,
      Email: `org${index}@fail${index}.test`,
      Modified_Time: "2026-08-20T10:00:00Z",
    }));
    const client = listingClient({ contacts });
    let freshCalls = 0;
    const built = await buildCommandCentre(
      {
        client,
        publicDomains: PUBLIC,
        now: () => new Date(AS_OF),
        analyse: async (_module, recordId) => {
          freshCalls += 1;
          if (freshCalls > 5) {
            return { ...stored({ recordId }), success: false, profile: undefined, error: "OpenAI failed." };
          }
          return stored({ recordId });
        },
      },
      { mode: "build_changed", confirm: true, includeBriefSynthesis: false, maxOrganisations: 15 },
    );
    assert.equal(freshCalls, 10);
    assert.equal(built.organisations_analysed, 5);
    assert.equal(built.candidates_awaiting_analysis, 10);
    assert.equal(built.analyses_failed, 5);
  });
});

test("selector returning fewer than capacity is represented accurately", async () => {
  await withStores(async () => {
    const contacts = Array.from({ length: 12 }, (_, index) => ({
      id: `c${index}`,
      Full_Name: `Org ${index}`,
      Email: `org${index}@small${index}.test`,
      Modified_Time: "2026-08-20T10:00:00Z",
    }));
    const client = listingClient({ contacts });
    const scan = await scanCommandCentre(
      { client, publicDomains: PUBLIC, analyse: async () => stored() },
      { maxOrganisations: 50, persist: false },
    );
    assert.equal(scan.organisations_selected, 12);
    assert.equal(scan.candidate_capacity, 50);
    assert.equal(scan.candidates_awaiting_analysis, 12);
    assert.match(scan.truncated_reason ?? "", /12 of 12 discovered organisations selected/);
  });
});
