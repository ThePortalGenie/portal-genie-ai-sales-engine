import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CommercialWatchItem, UniverseRecord } from "../src/domain/commercial-watch.js";
import type { OrganisationGraph } from "../src/domain/organisation-graph.js";
import type { SalesEvent } from "../src/domain/sales-event.js";
import { parseSalesEventInput } from "../src/domain/sales-event.js";
import type { ZohoCrmReader } from "../src/integrations/zoho/client.js";
import type { ZohoHttpResult } from "../src/integrations/zoho/types.js";
import { classifyActionabilityKind } from "../src/intelligence/actionability.js";
import { loadFirstPartyDomains, isFirstPartyDomain, isFirstPartyOrganisation } from "../src/config/first-party-domains.js";
import { analysisRootsForCluster, writeStoredAnalysis, type StoredAnalysis } from "../src/intelligence/analysis-store.js";
import { classifyFollowUpDate, classifyInstant } from "../src/intelligence/calendar-date.js";
import {
  buildCommandCentre,
  fingerprintForCluster,
  reuseDecision,
  scanCommandCentre,
  _testOnlySelect,
} from "../src/intelligence/command-centre.js";
import { deterministicDailyBrief, maybeSynthesizeBrief, isCustomerExecutableBriefItem } from "../src/intelligence/daily-brief.js";
import { writePortfolioSnapshot } from "../src/intelligence/portfolio-store.js";
import { PRIORITY_TIEBREAK, priorityBand, sortWatchItems, classifyExecutability } from "../src/intelligence/priority-rank.js";
import { validSampleProfile } from "../src/intelligence/profile-schema.js";
import { createSalesEvent } from "../src/intelligence/sales-event-store.js";
import { classifyStalled } from "../src/intelligence/stalled-engine.js";
import { discoverUniverse, universeFromListing } from "../src/intelligence/universe-discovery.js";
import { groupUniverseRecords } from "../src/intelligence/universe-group.js";
import { loadUsageImportMeta } from "../src/intelligence/usage-match.js";
import { watchItemsFromAnalysis } from "../src/intelligence/watch-from-analysis.js";
import type { WatchEvidenceInput } from "../src/intelligence/watch-signals.js";
import { handleRequest } from "../src/server/app.js";

const PUBLIC = new Set(["gmail.com", "hotmail.com", "outlook.com"]);
const AS_OF = "2026-08-28T08:00:00+02:00";

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
  fail?: Partial<Record<string, number>>;
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
      const status = options.fail?.[moduleApiName];
      if (status) return { ok: false, status, noContent: false, json: { message: "listing failed" } };
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
    ...overrides,
  };
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
    usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
    latencyMs: 12,
    success: true,
    profile: validSampleProfile({
      recommended_action: "PHONE_CALL",
      recommended_action_reason: "Call Sarah about the partner programme.",
      best_contact: "Sarah",
      relationship_summary: "Live Portal Genie conversation.",
      confidence: "HIGH",
    }),
    organisationGraph: graph(),
    productRelationships: [
      {
        product: "PORTAL_GENIE",
        relationship_state: "PARTNER_PROSPECT",
        evidence_ids: ["ev-1"],
        summary: "Partner conversation",
        confidence: "HIGH",
      },
    ],
    ...overrides,
  };
}

function watch(overrides: Partial<CommercialWatchItem> = {}): CommercialWatchItem {
  return {
    id: "o:PORTAL_GENIE",
    organisation_id: "o",
    organisation_name: "Org",
    product_scope: "PORTAL_GENIE",
    relationship_state: "ENGAGED_PROSPECT",
    deal_ids: [],
    lead_ids: [],
    contact_ids: [],
    next_best_action: "PHONE_CALL",
    actionability_kind: "CUSTOMER_ACTION",
    customer_queue: true,
    executability: "EXECUTABLE_NOW",
    decision: "act",
    action_timing: "ACT_NOW",
    confidence: "MEDIUM",
    why_this_action: "Because the evidence says so.",
    commercial_summary: "A live conversation.",
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
    rank: 0,
    why_ranked: "",
    reuse: "reused",
    ...overrides,
  };
}

async function withIsolatedStores<T>(run: () => Promise<T>): Promise<T> {
  const previous = {
    intel: process.env.INTELLIGENCE_STORE_DIR,
    cc: process.env.COMMAND_CENTRE_STORE,
    se: process.env.SALES_EVENTS_STORE,
  };
  const dir = mkdtempSync(join(tmpdir(), "pg-cc-"));
  process.env.INTELLIGENCE_STORE_DIR = join(dir, "intel");
  process.env.COMMAND_CENTRE_STORE = join(dir, "command-centre.json");
  process.env.SALES_EVENTS_STORE = join(dir, "sales-events.json");
  mkdirSync(process.env.INTELLIGENCE_STORE_DIR, { recursive: true });
  try {
    return await run();
  } finally {
    if (previous.intel === undefined) delete process.env.INTELLIGENCE_STORE_DIR;
    else process.env.INTELLIGENCE_STORE_DIR = previous.intel;
    if (previous.cc === undefined) delete process.env.COMMAND_CENTRE_STORE;
    else process.env.COMMAND_CENTRE_STORE = previous.cc;
    if (previous.se === undefined) delete process.env.SALES_EVENTS_STORE;
    else process.env.SALES_EVENTS_STORE = previous.se;
  }
}

test("Leads, Contacts and Deals are discovered from Zoho listings", async () => {
  const discovered = await discoverUniverse(
    listingClient({
      contacts: [{ id: "c1", Full_Name: "Sarah", Email: "sarah@abc.test", Account_Name: { id: "a1", name: "ABC" } }],
      leads: [{ id: "l1", Full_Name: "Pat Lead", Email: "pat@newfirm.test", Company: "New Firm" }],
      deals: [{ id: "d1", Deal_Name: "ABC Portal Genie", Stage: "Qualification", Account_Name: { id: "a1", name: "ABC" } }],
    }),
    { maxRecordsPerModule: 200 },
  );
  assert.equal(discovered.records.filter((item) => item.module === "Contacts").length, 1);
  assert.equal(discovered.records.filter((item) => item.module === "Leads").length, 1);
  assert.equal(discovered.records.filter((item) => item.module === "Deals").length, 1);
  assert.equal(discovered.failures.length, 0);
});

test("listing ERROR is a retrieval failure, not empty activity", async () => {
  const discovered = await discoverUniverse(listingClient({ fail: { Leads: 500 } }), { maxRecordsPerModule: 200 });
  assert.equal(discovered.failures.length, 1);
  assert.equal(discovered.failures[0]?.state, "ERROR");
  assert.match(discovered.failures[0]?.message ?? "", /not empty activity/i);
});

test("Deal listing fields become live opportunity context without assuming 1 deal = 1 organisation", () => {
  const [deal] = universeFromListing("Deals", [
    {
      id: "d1",
      Deal_Name: "Portal Genie partner",
      Stage: "Proposal",
      Account_Name: { id: "a1", name: "ABC" },
      Contact_Name: { id: "c1", name: "Sarah" },
    },
  ]);
  assert.equal(deal?.accountId, "a1");
  assert.equal(deal?.contactId, "c1");
  assert.equal(deal?.stage, "Proposal");
});

test("same Account and business domain group into one organisation; public domains do not", () => {
  const clusters = groupUniverseRecords(
    [
      rec({ module: "Contacts", recordId: "c1", name: "Sarah", email: "sarah@abc.test", accountId: "a1", accountName: "ABC" }),
      rec({ module: "Contacts", recordId: "c2", name: "Pat", email: "pat@abc.test", accountId: "a1", accountName: "ABC" }),
      rec({ module: "Leads", recordId: "l1", name: "Gmail person", email: "someone@gmail.com", company: "Solo" }),
      rec({ module: "Leads", recordId: "l2", name: "Other gmail", email: "other@gmail.com", company: "Other Solo" }),
    ],
    PUBLIC,
  );
  const abc = clusters.find((item) => item.records.some((record) => record.recordId === "c1"));
  assert.equal(abc?.records.filter((item) => item.module !== "Deals").length, 2);
  const gmailClusters = clusters.filter((item) => item.records.some((record) => record.email?.endsWith("@gmail.com")));
  assert.equal(gmailClusters.length, 2);
});

test("exact company name without a strong key is POSSIBLE_MATCH_REVIEW, not a merge", () => {
  const clusters = groupUniverseRecords(
    [
      rec({ module: "Leads", recordId: "l1", name: "Ann", email: "ann@alpha.test", company: "Twin Firm" }),
      rec({ module: "Leads", recordId: "l2", name: "Ben", email: "ben@beta.test", company: "Twin Firm" }),
    ],
    PUBLIC,
  );
  assert.equal(clusters.length, 2);
  assert.ok(clusters.every((item) => item.possibleMatchReviews.length >= 1));
  assert.match(clusters[0]?.possibleMatchReviews[0]?.reason ?? "", /POSSIBLE_MATCH_REVIEW/);
});

test("Deal -> Account joins the contact cluster; duplicate CRM people do not create duplicate organisations", () => {
  const clusters = groupUniverseRecords(
    [
      rec({ module: "Contacts", recordId: "c1", name: "Sarah", email: "sarah@abc.test", accountId: "a1", accountName: "ABC" }),
      rec({
        module: "Deals",
        recordId: "d1",
        name: "Portal Genie",
        accountId: "a1",
        accountName: "ABC",
        contactId: "c1",
      }),
    ],
    PUBLIC,
  );
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]?.records.length, 2);
});

test("Command Centre sample does not prefer stored analysis and stays within the cap", () => {
  const records: UniverseRecord[] = [];
  for (let i = 0; i < 8; i += 1) {
    records.push(
      rec({
        module: "Contacts",
        recordId: `recent-${i}`,
        name: `Recent ${i}`,
        email: `r${i}@recent${i}.test`,
        accountId: `ar${i}`,
        lastActivityAt: "2026-08-27T10:00:00Z",
      }),
    );
  }
  records.push(
    rec({
      module: "Leads",
      recordId: "lead-1",
      name: "Pat Lead",
      email: "pat@newlead.test",
      company: "New Lead Co",
      lastActivityAt: "2026-08-20T10:00:00Z",
    }),
    rec({
      module: "Leads",
      recordId: "lead-2",
      name: "Sam Lead",
      email: "sam@otherlead.test",
      company: "Other Lead Co",
      lastActivityAt: "2026-08-19T10:00:00Z",
    }),
    rec({
      module: "Contacts",
      recordId: "np-c",
      name: "NP Contact",
      email: "np@panda.test",
      accountId: "anp",
      lastActivityAt: "2026-08-10T10:00:00Z",
    }),
    rec({
      module: "Deals",
      recordId: "np-d",
      name: "Nagging Panda",
      accountId: "anp",
      stage: "Closed Lost",
      lastActivityAt: "2026-08-10T10:00:00Z",
    }),
    rec({
      module: "Contacts",
      recordId: "won-c",
      name: "Won Contact",
      email: "won@customer.test",
      accountId: "awon",
      lastActivityAt: "2026-08-15T10:00:00Z",
    }),
    rec({
      module: "Deals",
      recordId: "won-d",
      name: "Portal Genie license",
      accountId: "awon",
      stage: "Closed Won",
      lastActivityAt: "2026-08-15T10:00:00Z",
    }),
    rec({
      module: "Contacts",
      recordId: "quiet-c",
      name: "Quiet Contact",
      email: "quiet@old.test",
      accountId: "aq",
      lastActivityAt: "2026-06-01T10:00:00Z",
    }),
    rec({
      module: "Deals",
      recordId: "quiet-d",
      name: "Portal Genie partner",
      accountId: "aq",
      stage: "Proposal",
      lastActivityAt: "2026-06-01T10:00:00Z",
    }),
  );
  const universe = groupUniverseRecords(records, PUBLIC);
  const selected = _testOnlySelect(universe, 8, AS_OF);
  assert.equal(selected.length, 8);
  assert.ok(selected.some((item) => item.records.some((record) => record.module === "Leads")));
  assert.ok(selected.some((item) => item.records.some((record) => /nagging panda/i.test(record.name))));
  assert.ok(selected.some((item) => item.records.some((record) => /won/i.test(record.stage ?? ""))));
  const again = _testOnlySelect(universe, 8, AS_OF);
  assert.deepEqual(
    again.map((item) => item.organisationId),
    selected.map((item) => item.organisationId),
  );
  assert.equal(_testOnlySelect(universe, 20, AS_OF).length, Math.min(20, universe.length));
});

test("calendar code owns overdue / today / future, including Johannesburg timezone boundary", () => {
  assert.equal(classifyFollowUpDate("2026-08-27", AS_OF), "OVERDUE");
  assert.equal(classifyFollowUpDate("2026-08-28", AS_OF), "DUE_TODAY");
  assert.equal(classifyFollowUpDate("2026-08-29", AS_OF), "FUTURE");
  assert.equal(classifyFollowUpDate("2026-08-28", "2026-08-28T22:00:00Z", "Africa/Johannesburg"), "OVERDUE");
  assert.equal(classifyFollowUpDate("2026-08-29", "2026-08-28T22:00:00Z", "Africa/Johannesburg"), "DUE_TODAY");
  assert.equal(classifyFollowUpDate(undefined, AS_OF), "UNKNOWN");
});

test("classifyInstant uses date and time; later today is FUTURE not due today", () => {
  assert.equal(classifyInstant("2026-08-28T14:00:00+02:00", AS_OF), "FUTURE");
  assert.equal(classifyInstant("2026-08-28T07:00:00+02:00", AS_OF), "OVERDUE");
  assert.equal(classifyInstant("2026-08-28T08:07:00+02:00", AS_OF), "DUE_NOW");
  assert.equal(classifyInstant("2026-08-29T09:00:00+02:00", AS_OF), "FUTURE");
  assert.equal(classifyInstant("2026-09-15", AS_OF), "FUTURE");
  assert.equal(classifyInstant("2026-08-20T10:00:00+02:00", AS_OF), "OVERDUE");
  assert.equal(classifyInstant("2026-08-29T10:00:00+02:00", "2026-08-28T22:00:00Z"), "FUTURE");
  assert.equal(classifyInstant("2026-08-28T20:00:00+02:00", "2026-08-28T22:00:00Z"), "OVERDUE");
});

test("stalled engine: old deal alone is not stalled; unanswered + quiet + live is stalled", () => {
  const oldDealOnly = classifyStalled(
    evidence({ liveDeal: true, lastMeaningfulActivityAt: "2026-07-01T10:00:00Z", unansweredOutboundAttempts: 0 }),
  );
  assert.equal(oldDealOnly.state, "WATCH");
  assert.match(oldDealOnly.reasons.join(" "), /old deal age alone is not treated as stalled/i);

  const caseA = classifyStalled(
    evidence({
      liveDeal: true,
      lastMeaningfulActivityAt: "2026-07-09T10:00:00Z",
      unansweredOutboundAttempts: 2,
    }),
  );
  assert.equal(caseA.state, "STALLED");
});

test("stalled engine: customer future contact is scheduled, not stalled", () => {
  const caseB = classifyStalled(
    evidence({
      lastMeaningfulActivityAt: "2026-07-24T10:00:00Z",
      nextCommitmentAt: "2026-09-07",
      nextCommitmentKind: "customer",
      liveDeal: true,
    }),
  );
  assert.equal(caseB.state, "SCHEDULED_FOLLOW_UP");
});

test("stalled engine: usage-active CRM-quiet is WATCH, not dead", () => {
  const caseC = classifyStalled(
    evidence({
      lastMeaningfulActivityAt: "2026-06-01T10:00:00Z",
      usageUnknown: false,
      usageActive: true,
      usageGrowing: true,
      liveDeal: false,
    }),
  );
  assert.equal(caseC.state, "WATCH");
  assert.match(caseC.reasons.join(" "), /not classified as dead|Watch for expansion/i);
});

test("stalled engine: missed meeting and waiting on us", () => {
  const missed = classifyStalled(evidence({ liveDeal: true, meetingMissedNoReschedule: true, lastMeaningfulActivityAt: "2026-08-20T10:00:00Z" }));
  assert.ok(missed.state === "WATCH" || missed.state === "STALLED");
  const waitingOnUs = classifyStalled(
    evidence({ nextCommitmentAt: "2026-08-27", nextCommitmentKind: "operator", liveDeal: true }),
  );
  assert.equal(waitingOnUs.state, "WAITING_ON_US");
});

test("priority bands: overdue commitment outranks generic live opportunity; WAIT is P4", () => {
  assert.equal(
    priorityBand({
      action_timing: "OVERDUE",
      next_best_action: "FOLLOW_UP",
      stalled_state: "WAITING_ON_US",
      liveDeal: true,
      actionability_kind: "CUSTOMER_ACTION",
    }),
    "P0",
  );
  assert.equal(
    priorityBand({
      action_timing: "TODAY",
      next_best_action: "PHONE_CALL",
      stalled_state: "NOT_STALLED",
      liveDeal: false,
      actionability_kind: "CUSTOMER_ACTION",
    }),
    "P1",
  );
  assert.equal(
    priorityBand({
      action_timing: "ACT_NOW",
      next_best_action: "PHONE_CALL",
      stalled_state: "NOT_STALLED",
      liveDeal: true,
      actionability_kind: "CUSTOMER_ACTION",
    }),
    "P1",
  );
  assert.equal(priorityBand({ action_timing: "WAIT_UNTIL", next_best_action: "WAIT", stalled_state: "SCHEDULED_FOLLOW_UP", liveDeal: true }), "P4");
  assert.equal(priorityBand({ action_timing: "NO_ACTION_REQUIRED", next_best_action: "NO_ACTION", stalled_state: "NOT_STALLED", liveDeal: false }), "P5");
  assert.match(PRIORITY_TIEBREAK, /Overdue commitments/);
  assert.doesNotMatch(PRIORITY_TIEBREAK, /0-100|score from/i);
});

test("executability owns P0/P1: wait, customer, and data-required are not the action queue", () => {
  assert.equal(
    classifyExecutability({ action: "PHONE_CALL", timing: "ACT_NOW", stalledState: "NOT_STALLED" }),
    "EXECUTABLE_NOW",
  );
  assert.equal(
    classifyExecutability({ action: "WAIT", timing: "WAIT_UNTIL", stalledState: "SCHEDULED_FOLLOW_UP" }),
    "WAITING_FOR_TIME",
  );
  assert.equal(
    classifyExecutability({ action: "WAIT", timing: "NO_ACTION_REQUIRED", stalledState: "WAITING_ON_CUSTOMER" }),
    "WAITING_FOR_CUSTOMER",
  );
  assert.equal(
    classifyExecutability({
      action: "USAGE_CHECK",
      timing: "NO_ACTION_REQUIRED",
      stalledState: "NOT_STALLED",
      usageDatasetAvailable: false,
      usageUnknown: true,
    }),
    "NO_ACTION_REQUIRED",
  );
  assert.equal(
    priorityBand({
      action_timing: "ACT_NOW",
      next_best_action: "PHONE_CALL",
      stalled_state: "NOT_STALLED",
      liveDeal: true,
      executability: "EXECUTABLE_NOW",
      actionability_kind: "CUSTOMER_ACTION",
    }),
    "P1",
  );
  assert.equal(
    priorityBand({
      action_timing: "WAIT_UNTIL",
      next_best_action: "WAIT",
      stalled_state: "SCHEDULED_FOLLOW_UP",
      liveDeal: true,
      executability: "WAITING_FOR_TIME",
    }),
    "P4",
  );
  assert.equal(
    priorityBand({
      action_timing: "NO_ACTION_REQUIRED",
      next_best_action: "WAIT",
      stalled_state: "WAITING_ON_CUSTOMER",
      liveDeal: false,
      executability: "WAITING_FOR_CUSTOMER",
    }),
    "P4",
  );
  assert.equal(
    priorityBand({
      action_timing: "NO_ACTION_REQUIRED",
      next_best_action: "NO_ACTION",
      stalled_state: "NOT_STALLED",
      liveDeal: false,
      executability: "NO_ACTION_REQUIRED",
      actionability_kind: "NO_ACTION",
    }),
    "P5",
  );
});

test("sortWatchItems is deterministic and keeps WAIT below the action queue", () => {
  const sorted = sortWatchItems([
    watch({ id: "wait", organisation_name: "Zebra Wait", priority: "P4", next_best_action: "WAIT", action_timing: "WAIT_UNTIL" }),
    watch({ id: "live", organisation_name: "Live Co", priority: "P2", opportunity_signals: [{ code: "LIVE_DEAL_PRESENT", message: "live" }] }),
    watch({ id: "overdue", organisation_name: "Overdue Co", priority: "P0", action_timing: "OVERDUE", action_due_at: "2026-08-20" }),
    watch({ id: "today", organisation_name: "Today Co", priority: "P1", action_timing: "TODAY" }),
  ]);
  assert.deepEqual(
    sorted.map((item) => item.id),
    ["overdue", "today", "live", "wait"],
  );
  assert.deepEqual(
    sorted.map((item) => item.rank),
    [1, 2, 3, 4],
  );
});

test("Portal Genie and Nagging Panda stay independent watch items", () => {
  const items = watchItemsFromAnalysis(
    stored({
      productRelationships: [
        { product: "PORTAL_GENIE", relationship_state: "PARTNER_PROSPECT", evidence_ids: [], summary: "PG live", confidence: "HIGH" },
        { product: "NAGGING_PANDA", relationship_state: "FORMER_CUSTOMER", evidence_ids: [], summary: "NP lost", confidence: "HIGH" },
      ],
      organisationGraph: graph({
        deals: [
          {
            recordId: "d-pg",
            name: "Portal Genie partner",
            product: "PORTAL_GENIE",
            closedLost: false,
            closedWon: false,
            provenance: "test",
          },
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
    }),
    { organisationId: "domain:abc.test", organisationName: "ABC Accounting", reuse: "reused", asOf: AS_OF },
  );
  assert.equal(items.length, 2);
  const pg = items.find((item) => item.product_scope === "PORTAL_GENIE");
  const np = items.find((item) => item.product_scope === "NAGGING_PANDA");
  assert.ok(pg);
  assert.ok(np);
  assert.notEqual(pg?.next_best_action, "NO_ACTION");
  assert.equal(np?.next_best_action, "NO_ACTION");
  assert.equal(np?.priority, "P5");
  assert.equal(np?.recommended_contact_name, undefined);
  assert.match(np?.commercial_summary ?? "", /Closed Lost/);
  assert.match(np?.why_this_action ?? "", /Closed Lost/);
  assert.doesNotMatch(np?.why_this_action ?? "", /Call Sarah/);
});

test("recent unanswered email blocks repeat email but preserves phone call", () => {
  const outboundEmail = [
    {
      messageId: "m1",
      threadId: null,
      at: "2026-08-25T10:00:00Z",
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
      ownerRecordId: "c1",
      ownerName: "Sarah",
    },
  ];
  const [phoneItem] = watchItemsFromAnalysis(
    stored({ organisationGraph: graph({ emails: outboundEmail }) }),
    { organisationId: "domain:abc.test", organisationName: "ABC Accounting", reuse: "reused", asOf: AS_OF },
  );
  assert.equal(phoneItem?.next_best_action, "PHONE_CALL");
  assert.equal(phoneItem?.executability, "EXECUTABLE_NOW");
  assert.notEqual(phoneItem?.stalled_state, "WAITING_ON_CUSTOMER");
  assert.equal(phoneItem?.actionability_kind, "CUSTOMER_ACTION");

  const [emailItem] = watchItemsFromAnalysis(
    stored({
      profile: validSampleProfile({
        recommended_action: "PERSONAL_EMAIL",
        recommended_action_reason: "Send a follow-up email.",
        best_contact: "Sarah",
      }),
      organisationGraph: graph({ emails: outboundEmail }),
    }),
    { organisationId: "domain:abc.test", organisationName: "ABC Accounting", reuse: "reused", asOf: AS_OF },
  );
  assert.equal(emailItem?.next_best_action, "NO_ACTION");
  assert.match(emailItem?.why_this_action ?? "", /Do not send another email/i);
});

test("multiple unanswered outbound attempts preserve stronger wait behaviour", () => {
  const [item] = watchItemsFromAnalysis(
    stored({
      profile: {
        ...validSampleProfile({
          recommended_action_reason: "Follow up again.",
          best_contact: "Sarah",
        }),
        recommended_action: "FOLLOW_UP" as never,
      },
      organisationGraph: graph({
        emails: [
          {
            messageId: "m1",
            threadId: null,
            at: "2026-08-25T10:00:00Z",
            direction: "outbound",
            directionEvidence: "test",
            sender: { name: null, email: "geoff@test" },
            recipients: [],
            cc: [],
            subject: "One",
            bodyText: "One",
            currentMessageText: "One",
            quoteStrippingConfidence: "HIGH",
            strippedQuotedHistory: false,
            bodyTruncated: false,
            sourceType: "crm_email",
            hasAttachment: false,
            ownerRecordId: "c1",
            ownerName: "Sarah",
          },
          {
            messageId: "m2",
            threadId: null,
            at: "2026-08-20T10:00:00Z",
            direction: "outbound",
            directionEvidence: "test",
            sender: { name: null, email: "geoff@test" },
            recipients: [],
            cc: [],
            subject: "Two",
            bodyText: "Two",
            currentMessageText: "Two",
            quoteStrippingConfidence: "HIGH",
            strippedQuotedHistory: false,
            bodyTruncated: false,
            sourceType: "crm_email",
            hasAttachment: false,
            ownerRecordId: "c1",
            ownerName: "Sarah",
          },
        ],
      }),
    }),
    { organisationId: "domain:abc.test", organisationName: "ABC Accounting", reuse: "reused", asOf: AS_OF },
  );
  assert.equal(item?.stalled_state, "WAITING_ON_CUSTOMER");
  assert.equal(item?.next_best_action, "WAIT");
  assert.equal(item?.executability, "WAITING_FOR_CUSTOMER");
  assert.ok(item?.risk_signals.some((signal) => signal.code === "MULTIPLE_OUTBOUND_ATTEMPTS_UNANSWERED"));
});

test("historical Closed Won does not force NO_ACTION the way Closed Lost does", () => {
  const [item] = watchItemsFromAnalysis(
    stored({
      profile: validSampleProfile({
        recommended_action: "USAGE_CHECK",
        recommended_action_reason: "Confirm the paid account is activated.",
        best_contact: "Kirstin",
      }),
      productRelationships: [
        { product: "NAGGING_PANDA", relationship_state: "PAYING_CUSTOMER", evidence_ids: [], summary: "Paid", confidence: "HIGH" },
      ],
      organisationGraph: graph({
        deals: [
          {
            recordId: "d-won",
            name: "Nagging Panda",
            product: "NAGGING_PANDA",
            closedLost: false,
            closedWon: true,
            provenance: "test",
          },
        ],
      }),
    }),
    { organisationId: "domain:rslv.test", organisationName: "Kirstin Resolve", reuse: "reused", asOf: AS_OF },
  );
  assert.equal(item?.product_scope, "NAGGING_PANDA");
  assert.equal(item?.next_best_action, "NO_ACTION");
  assert.equal(item?.executability, "NO_ACTION_REQUIRED");
  assert.equal(item?.actionability_kind, "NO_ACTION");
  assert.equal(item?.priority, "P5");
  assert.doesNotMatch(item?.why_this_action ?? "", /Portal Genie/i);
  assert.ok(!item?.opportunity_signals.some((signal) => signal.code === "HISTORICAL_DEAL_ONLY"));
  assert.match(item?.commercial_summary ?? "", /current customer relationship/i);
  assert.doesNotMatch(item?.commercial_summary ?? "", /historical only/i);
});

test("customer future follow-up becomes WAIT UNTIL, not stalled call now", () => {
  const event: SalesEvent = parseSalesEventInput({
    organisation_id: "domain:abc.test",
    contact_id: "c1",
    product_scope: "PORTAL_GENIE",
    event_type: "PHONE_CALL",
    occurred_at: "2026-08-20T10:00:00Z",
    outcome: "FOLLOW_UP_REQUESTED",
    summary: "Call me on 15 September",
    follow_up_date: "2026-09-15",
  });
  const [item] = watchItemsFromAnalysis(
    stored({ organisationGraph: graph({ salesEvents: [event] }) }),
    { organisationId: "domain:abc.test", organisationName: "ABC Accounting", reuse: "reused", asOf: AS_OF },
  );
  assert.equal(item?.next_best_action, "WAIT");
  assert.equal(item?.action_timing, "WAIT_UNTIL");
  assert.equal(item?.executability, "WAITING_FOR_TIME");
  assert.equal(item?.stalled_state, "SCHEDULED_FOLLOW_UP");
  assert.equal(item?.priority, "P4");
  assert.match(item?.why_this_action ?? "", /Explicit commitment overrides generic urgency/);
});

test("operator overdue commitment is WAITING_ON_US / P0", () => {
  const event: SalesEvent = parseSalesEventInput({
    organisation_id: "domain:abc.test",
    contact_id: "c1",
    product_scope: "PORTAL_GENIE",
    event_type: "FOLLOW_UP",
    occurred_at: "2026-08-20T10:00:00Z",
    outcome: "CONNECTED",
    summary: "Geoff promised to send the pack yesterday",
    follow_up_date: "2026-08-27",
  });
  const [item] = watchItemsFromAnalysis(
    stored({ organisationGraph: graph({ salesEvents: [event] }) }),
    { organisationId: "domain:abc.test", organisationName: "ABC Accounting", reuse: "reused", asOf: AS_OF },
  );
  assert.equal(item?.stalled_state, "WAITING_ON_US");
  assert.equal(item?.priority, "P0");
  assert.equal(item?.executability, "EXECUTABLE_NOW");
  assert.equal(item?.action_timing, "OVERDUE");
});

test("duplicate CRM people on one analysis create one watch item per product, not per record", () => {
  const items = watchItemsFromAnalysis(
    stored({
      organisationGraph: graph({
        contacts: [
          {
            module: "Contacts",
            recordId: "c1",
            name: "Sarah",
            association_reasons: ["SELECTED_CONTACT"],
            certainty: "associated",
            selected: true,
            commercial_role: { role: "SELECTED_CONTACT", layer: "crm_fact", evidence: "selected" },
          },
          {
            module: "Contacts",
            recordId: "c2",
            name: "Pat",
            association_reasons: ["SAME_ZOHO_ACCOUNT"],
            certainty: "associated",
            selected: false,
            commercial_role: { role: "UNKNOWN", layer: "derived_signal", evidence: "same account" },
          },
        ],
      }),
    }),
    { organisationId: "domain:abc.test", organisationName: "ABC Accounting", reuse: "reused", asOf: AS_OF },
  );
  assert.equal(items.length, 1);
  assert.equal(items[0]?.contact_ids.length, 2);
});

test("usage unknown is labelled, not treated as zero usage", () => {
  const [item] = watchItemsFromAnalysis(stored(), {
    organisationId: "domain:abc.test",
    organisationName: "ABC Accounting",
    reuse: "reused",
    asOf: AS_OF,
  });
  assert.ok(item?.usage_signals.some((signal) => signal.code === "USAGE_UNKNOWN"));
  assert.match(item?.usage_signals.find((signal) => signal.code === "USAGE_UNKNOWN")?.message ?? "", /not zero/i);
});

test("USAGE_CHECK with no imported dataset becomes NO_ACTION, not sales work", () => {
  const [item] = watchItemsFromAnalysis(
    stored({
      profile: validSampleProfile({
        recommended_action: "USAGE_CHECK",
        recommended_action_reason: "Check whether they are using the product.",
      }),
    }),
    {
      organisationId: "domain:anth.test",
      organisationName: "Anthurico Accountants",
      reuse: "reused",
      asOf: AS_OF,
      usageDatasetAvailable: false,
    },
  );
  assert.equal(item?.next_best_action, "NO_ACTION");
  assert.equal(item?.executability, "NO_ACTION_REQUIRED");
  assert.equal(item?.actionability_kind, "NO_ACTION");
  assert.equal(item?.priority, "P5");
  assert.ok(item?.usage_signals.some((signal) => signal.code === "USAGE_UNKNOWN"));
  assert.ok(item?.data_quality_signals.some((signal) => signal.code === "USAGE_DATASET_UNAVAILABLE"));
  assert.match(item?.why_this_action ?? "", /not a customer action/i);
});

test("USAGE_CHECK with unknown org usage becomes NO_ACTION even if a file exists", () => {
  const [item] = watchItemsFromAnalysis(
    stored({
      profile: validSampleProfile({ recommended_action: "USAGE_CHECK" }),
    }),
    {
      organisationId: "domain:anth.test",
      organisationName: "Anthurico Accountants",
      reuse: "reused",
      asOf: AS_OF,
      usageDatasetAvailable: true,
    },
  );
  assert.equal(item?.next_best_action, "NO_ACTION");
  assert.equal(item?.executability, "NO_ACTION_REQUIRED");
  assert.equal(item?.actionability_kind, "NO_ACTION");
  assert.equal(item?.priority, "P5");
  assert.ok(item?.usage_signals.some((signal) => signal.code === "USAGE_UNKNOWN"));
});

test("unavailable usage is not replaced with an invented chase action", () => {
  const [item] = watchItemsFromAnalysis(
    stored({
      profile: validSampleProfile({ recommended_action: "USAGE_CHECK" }),
      organisationGraph: graph({ deals: [] }),
    }),
    { organisationId: "domain:anth.test", organisationName: "Anthurico Accountants", reuse: "reused", asOf: AS_OF },
  );
  assert.equal(item?.next_best_action, "NO_ACTION");
  assert.notEqual(item?.next_best_action, "PHONE_CALL");
  assert.notEqual(item?.next_best_action, "PERSONAL_EMAIL");
});

test("executable commercial action outranks a usage data requirement", () => {
  const [item] = watchItemsFromAnalysis(
    stored({
      profile: validSampleProfile({
        recommended_action: "PHONE_CALL",
        recommended_action_reason: "Call about the live partner deal.",
      }),
      organisationGraph: graph({
        deals: [
          {
            recordId: "d-live",
            name: "Portal Genie partner",
            product: "PORTAL_GENIE",
            closedLost: false,
            closedWon: false,
            provenance: "test",
          },
        ],
      }),
    }),
    {
      organisationId: "domain:fjm.test",
      organisationName: "FJM Accounting",
      reuse: "reused",
      asOf: AS_OF,
      usageDatasetAvailable: false,
    },
  );
  assert.equal(item?.next_best_action, "PHONE_CALL");
  assert.equal(item?.executability, "EXECUTABLE_NOW");
  assert.ok(item?.priority === "P0" || item?.priority === "P1" || item?.priority === "P2");
  assert.notEqual(item?.executability, "DATA_REQUIRED");
});

test("event later today is WAIT UNTIL that time, not ACT NOW", () => {
  const event: SalesEvent = parseSalesEventInput({
    organisation_id: "domain:kirstin.test",
    contact_id: "c1",
    product_scope: "NAGGING_PANDA",
    event_type: "MEETING",
    occurred_at: "2026-08-28T14:00:00+02:00",
    outcome: "MEETING_RESCHEDULED",
    summary: "Training at 14:00",
  });
  const [item] = watchItemsFromAnalysis(
    stored({
      profile: validSampleProfile({ recommended_action: "USAGE_CHECK" }),
      productRelationships: [
        { product: "NAGGING_PANDA", relationship_state: "PAYING_CUSTOMER", evidence_ids: [], summary: "Paid", confidence: "HIGH" },
      ],
      organisationGraph: graph({ salesEvents: [event] }),
      reconstructedTimeline: [{ at: "2026-08-28T14:00:00+02:00", approximate: false, kind: "operator_sales_event", title: "Training", source: "sales_event" }],
    }),
    { organisationId: "domain:kirstin.test", organisationName: "Kirstin Resolve", reuse: "reused", asOf: AS_OF },
  );
  assert.equal(item?.next_best_action, "WAIT");
  assert.equal(item?.action_timing, "WAIT_UNTIL");
  assert.equal(item?.executability, "WAITING_FOR_TIME");
  assert.notEqual(item?.priority, "P0");
  assert.notEqual(item?.priority, "P1");
  assert.match(item?.why_this_action ?? "", /14:00|Wait until/i);
});

test("event earlier today is overdue, not a wait-until later", () => {
  const event: SalesEvent = parseSalesEventInput({
    organisation_id: "domain:abc.test",
    contact_id: "c1",
    product_scope: "PORTAL_GENIE",
    event_type: "FOLLOW_UP",
    occurred_at: "2026-08-20T10:00:00Z",
    outcome: "CONNECTED",
    summary: "Promised a morning pack",
    follow_up_date: "2026-08-28T07:00:00+02:00",
  });
  const [item] = watchItemsFromAnalysis(
    stored({ organisationGraph: graph({ salesEvents: [event] }) }),
    { organisationId: "domain:abc.test", organisationName: "ABC Accounting", reuse: "reused", asOf: AS_OF },
  );
  assert.equal(item?.action_timing, "OVERDUE");
  assert.equal(item?.stalled_state, "WAITING_ON_US");
  assert.notEqual(item?.next_best_action, "WAIT");
});

test("event approximately now is due now, not future wait", () => {
  const event: SalesEvent = parseSalesEventInput({
    organisation_id: "domain:abc.test",
    contact_id: "c1",
    product_scope: "PORTAL_GENIE",
    event_type: "FOLLOW_UP",
    occurred_at: "2026-08-20T10:00:00Z",
    outcome: "CONNECTED",
    summary: "Call window now",
    follow_up_date: "2026-08-28T08:07:00+02:00",
  });
  const [item] = watchItemsFromAnalysis(
    stored({ organisationGraph: graph({ salesEvents: [event] }) }),
    { organisationId: "domain:abc.test", organisationName: "ABC Accounting", reuse: "reused", asOf: AS_OF },
  );
  assert.notEqual(item?.action_timing, "WAIT_UNTIL");
  assert.notEqual(item?.executability, "WAITING_FOR_TIME");
});

test("event tomorrow and a later future date are WAIT UNTIL", () => {
  const tomorrow: SalesEvent = parseSalesEventInput({
    organisation_id: "domain:abc.test",
    contact_id: "c1",
    product_scope: "PORTAL_GENIE",
    event_type: "MEETING",
    occurred_at: "2026-08-29T09:00:00+02:00",
    summary: "Demo tomorrow",
  });
  const [item] = watchItemsFromAnalysis(
    stored({ organisationGraph: graph({ salesEvents: [tomorrow] }) }),
    { organisationId: "domain:abc.test", organisationName: "ABC Accounting", reuse: "reused", asOf: AS_OF },
  );
  assert.equal(item?.next_best_action, "WAIT");
  assert.equal(item?.action_timing, "WAIT_UNTIL");
});

test("product-specific recommended contact is organisation × product, not the selected fallback", () => {
  const items = watchItemsFromAnalysis(
    stored({
      profile: validSampleProfile({ best_contact: "Sumere van Staden" }),
      productRelationships: [
        { product: "PORTAL_GENIE", relationship_state: "PARTNER_PROSPECT", evidence_ids: [], summary: "PG live", confidence: "HIGH" },
        { product: "NAGGING_PANDA", relationship_state: "ENGAGED_PROSPECT", evidence_ids: [], summary: "NP live", confidence: "HIGH" },
      ],
      organisationGraph: graph({
        selectedContactName: "Sumere van Staden",
        contacts: [
          {
            module: "Contacts",
            recordId: "sumere",
            name: "Sumere van Staden",
            association_reasons: ["SELECTED_CONTACT"],
            certainty: "associated",
            selected: true,
            commercial_role: { role: "SELECTED_CONTACT", layer: "crm_fact", evidence: "selected" },
          },
          {
            module: "Contacts",
            recordId: "clarissa",
            name: "Clarissa Van Heerden",
            association_reasons: ["SAME_ZOHO_ACCOUNT"],
            certainty: "associated",
            selected: false,
            commercial_role: { role: "UNKNOWN", layer: "derived_signal", evidence: "deal contact" },
          },
        ],
        deals: [
          {
            recordId: "d-pg",
            name: "Portal Genie partner",
            product: "PORTAL_GENIE",
            associatedContactId: "sumere",
            associatedContactName: "Sumere van Staden",
            closedLost: false,
            closedWon: false,
            provenance: "test",
          },
          {
            recordId: "d-np",
            name: "Nagging Panda",
            product: "NAGGING_PANDA",
            associatedContactId: "clarissa",
            associatedContactName: "Clarissa Van Heerden",
            closedLost: false,
            closedWon: false,
            provenance: "test",
          },
        ],
      }),
    }),
    { organisationId: "domain:fjm.test", organisationName: "FJM Accounting", reuse: "reused", asOf: AS_OF },
  );
  const pg = items.find((item) => item.product_scope === "PORTAL_GENIE");
  const np = items.find((item) => item.product_scope === "NAGGING_PANDA");
  assert.equal(pg?.recommended_contact_name, "Sumere van Staden");
  assert.match(pg?.recommended_contact_reason ?? "", /Product Deal associated contact/i);
  assert.equal(np?.recommended_contact_name, "Clarissa Van Heerden");
  assert.match(np?.recommended_contact_reason ?? "", /Product Deal associated contact/i);
  assert.notEqual(np?.recommended_contact_name, pg?.recommended_contact_name);
});

test("historical no-action item does not require a recommended contact", () => {
  const items = watchItemsFromAnalysis(
    stored({
      profile: validSampleProfile({ best_contact: "Sumere van Staden" }),
      productRelationships: [
        { product: "PORTAL_GENIE", relationship_state: "PARTNER_PROSPECT", evidence_ids: [], summary: "PG live", confidence: "HIGH" },
        { product: "NAGGING_PANDA", relationship_state: "FORMER_CUSTOMER", evidence_ids: [], summary: "NP lost", confidence: "HIGH" },
      ],
      organisationGraph: graph({
        selectedContactName: "Sumere van Staden",
        contacts: [
          {
            module: "Contacts",
            recordId: "sumere",
            name: "Sumere van Staden",
            association_reasons: ["SELECTED_CONTACT"],
            certainty: "associated",
            selected: true,
            commercial_role: { role: "SELECTED_CONTACT", layer: "crm_fact", evidence: "selected" },
          },
          {
            module: "Contacts",
            recordId: "clarissa",
            name: "Clarissa Van Heerden",
            association_reasons: ["SAME_ZOHO_ACCOUNT"],
            certainty: "associated",
            selected: false,
            commercial_role: { role: "UNKNOWN", layer: "derived_signal", evidence: "deal contact" },
          },
        ],
        deals: [
          {
            recordId: "d-pg",
            name: "Portal Genie partner",
            product: "PORTAL_GENIE",
            associatedContactId: "sumere",
            associatedContactName: "Sumere van Staden",
            closedLost: false,
            closedWon: false,
            provenance: "test",
          },
          {
            recordId: "d-np",
            name: "Nagging Panda",
            product: "NAGGING_PANDA",
            associatedContactId: "clarissa",
            associatedContactName: "Clarissa Van Heerden",
            closedLost: true,
            closedWon: false,
            provenance: "test",
          },
        ],
      }),
    }),
    { organisationId: "domain:fjm.test", organisationName: "FJM Accounting", reuse: "reused", asOf: AS_OF },
  );
  const np = items.find((item) => item.product_scope === "NAGGING_PANDA");
  assert.equal(np?.next_best_action, "NO_ACTION");
  assert.equal(np?.recommended_contact_name, undefined);
  assert.equal(np?.recommended_contact_reason, undefined);
});

test("Closed Won paying customer is a current relationship, not historical-only", () => {
  const [item] = watchItemsFromAnalysis(
    stored({
      profile: validSampleProfile({ recommended_action: "PHONE_CALL" }),
      productRelationships: [
        { product: "NAGGING_PANDA", relationship_state: "PAYING_CUSTOMER", evidence_ids: [], summary: "Paid", confidence: "HIGH" },
      ],
      organisationGraph: graph({
        deals: [
          {
            recordId: "d-won",
            name: "Nagging Panda",
            product: "NAGGING_PANDA",
            closedLost: false,
            closedWon: true,
            provenance: "test",
          },
        ],
      }),
    }),
    { organisationId: "domain:np.test", organisationName: "Paying NP Co", reuse: "reused", asOf: AS_OF },
  );
  assert.equal(item?.relationship_state, "PAYING_CUSTOMER");
  assert.ok(!item?.opportunity_signals.some((signal) => signal.code === "HISTORICAL_DEAL_ONLY"));
  assert.match(item?.commercial_summary ?? "", /current customer relationship/i);
});

test("daily brief excludes impossible USAGE_CHECK and future-wait from Do first", () => {
  const brief = deterministicDailyBrief(
    [
      watch({
        id: "usage",
        organisation_name: "Anthurico Accountants",
        priority: "P4",
        next_best_action: "USAGE_CHECK",
        actionability_kind: "DATA_REQUIRED",
        executability: "DATA_REQUIRED",
        action_timing: "NO_ACTION_REQUIRED",
      }),
      watch({
        id: "later",
        organisation_name: "Kirstin Resolve",
        priority: "P4",
        next_best_action: "WAIT",
        executability: "WAITING_FOR_TIME",
        action_timing: "WAIT_UNTIL",
        action_due_at: "2026-08-28T14:00:00+02:00",
        why_this_action: "Wait until 14:00. Training is later today.",
      }),
      watch({
        id: "call",
        organisation_name: "FJM Accounting",
        priority: "P1",
        next_best_action: "PHONE_CALL",
        executability: "EXECUTABLE_NOW",
      }),
    ],
    [],
    AS_OF,
  );
  assert.equal(brief.do_first_actions.length, 1);
  assert.match(brief.follow_up_today[0] ?? "", /FJM Accounting/);
  assert.ok(brief.research_items.some((item) => item.organisation_name === "Anthurico Accountants"));
  assert.ok(brief.wait_items.some((item) => item.organisation_name === "Kirstin Resolve"));
  assert.doesNotMatch(brief.do_first_actions.map((item) => item.organisation_name).join(" "), /Anthurico|Kirstin/i);
});

test("deterministic brief falls back with warnings that are not empty activity", () => {
  const brief = deterministicDailyBrief(
    [
      watch({ id: "p0", organisation_name: "ABC Accounting", priority: "P0", next_best_action: "FOLLOW_UP" }),
      watch({ id: "p1", organisation_name: "Today Co", priority: "P1" }),
      watch({
        id: "stalled",
        organisation_name: "Quiet Co",
        priority: "P2",
        stalled_state: "STALLED",
        stalled_reasons: ["No meaningful interaction for 47 days."],
        next_best_action: "CONTACT_ALTERNATIVE_PERSON",
      }),
      watch({
        id: "wait",
        organisation_name: "XYZ Accounting",
        priority: "P4",
        next_best_action: "WAIT",
        action_due_at: "2026-09-15",
        why_this_action: "They asked to reconnect on 15 September.",
      }),
    ],
    [{ stage: "analysis", state: "UNAVAILABLE", message: "Email retrieval was unavailable.", organisation_name: "Sparse Co" }],
    AS_OF,
  );
  assert.equal(brief.mode, "deterministic");
  assert.match(brief.today_at_a_glance, /customer action/);
  assert.equal(brief.do_first.length, 1);
  assert.equal(brief.follow_up_today.length, 1);
  assert.equal(brief.do_first_actions.length, 2);
  assert.equal(brief.do_first_actions[0]?.priority, "P0");
  assert.match(brief.stalled[0] ?? "", /Quiet Co/);
  assert.ok(brief.wait.some((line) => /WAIT UNTIL 2026-09-15/.test(line)));
  assert.match(brief.warnings.join(" "), /could not be fully assessed|UNAVAILABLE/);
  assert.doesNotMatch(brief.warnings.join(" "), /no email activity/i);
});

test("brief synthesis only updates commercial watch bullets", async () => {
  const base = deterministicDailyBrief([watch({ priority: "P0", organisation_name: "ABC Accounting" })], [], AS_OF);
  const result = await maybeSynthesizeBrief(base, async () => ({
    text: JSON.stringify([
      "ABC Accounting is the priority customer action today.",
      "No organisations are waiting on customers.",
    ]),
    inputTokens: 12,
    outputTokens: 8,
  }));
  assert.equal(result.brief.mode, "openai_synthesis");
  assert.equal(result.brief.do_first_actions.length, base.do_first_actions.length);
  assert.equal(result.brief.commercial_watch.length, 2);
  assert.equal(result.brief.narrative, undefined);
});

test("brief synthesis failure keeps the deterministic brief", async () => {
  const base = deterministicDailyBrief([watch({ priority: "P0", organisation_name: "ABC Accounting" })], [], AS_OF);
  const result = await maybeSynthesizeBrief(base, async () => {
    throw new Error("OpenAI synthesis failed");
  });
  assert.equal(result.brief.mode, "deterministic");
  assert.equal(result.brief.do_first.length, 1);
  assert.equal(result.tokens.calls, 1);
});

test("scan does not call analyse / OpenAI; unchanged fingerprint reuses analysis", async () => {
  await withIsolatedStores(async () => {
    const client = listingClient({
      contacts: [
        {
          id: "c1",
          Full_Name: "Sarah",
          Email: "sarah@abc.test",
          Account_Name: { id: "a1", name: "ABC Accounting" },
          Modified_Time: "2026-08-20T10:00:00Z",
        },
      ],
    });
    const scan0 = await scanCommandCentre(
      {
        client,
        publicDomains: PUBLIC,
        analyse: async () => {
          throw new Error("analyse must not run during scan");
        },
      },
      { maxOrganisations: 5, persist: true },
    );
    assert.equal(scan0.tokens.openai_calls, 0);
    const cluster = groupUniverseRecords(
      (await discoverUniverse(client, { maxRecordsPerModule: 200 })).records,
      PUBLIC,
    )[0]!;
    const fingerprint = fingerprintForCluster(cluster, loadUsageImportMeta().importedAt);
    writeStoredAnalysis({ ...stored({ recordId: "c1", evidenceFingerprint: fingerprint, analysedAt: "2099-01-01T00:00:00Z" }) });
    let analyseCalls = 0;
    const scan1 = await scanCommandCentre(
      {
        client,
        publicDomains: PUBLIC,
        analyse: async () => {
          analyseCalls += 1;
          throw new Error("should reuse");
        },
      },
      { persist: false },
    );
    assert.equal(analyseCalls, 0);
    assert.equal(scan1.analyses_reusable, 1);
    assert.equal(scan1.openai_would_be_called, 0);
    assert.equal(scan1.organisations[0]?.reuse, "reuse");
  });
});

test("changed CRM listing, Sales Event, and usage import invalidate reuse", async () => {
  await withIsolatedStores(async () => {
    const client = listingClient({
      contacts: [
        {
          id: "c1",
          Full_Name: "Sarah",
          Email: "sarah@abc.test",
          Account_Name: { id: "a1", name: "ABC Accounting" },
          Modified_Time: "2026-08-20T10:00:00Z",
        },
      ],
    });
    const cluster = groupUniverseRecords(
      (await discoverUniverse(client, { maxRecordsPerModule: 200 })).records,
      PUBLIC,
    )[0]!;
    writeStoredAnalysis(stored({ recordId: "c1", analysedAt: "2026-08-01T00:00:00Z" }));
    const changed = reuseDecision(cluster, "new-fingerprint");
    assert.equal(changed.reuse, "refresh");
    assert.match(changed.reason, /fingerprint changed|No successful stored|CRM listing|current/i);

    writeStoredAnalysis(stored({ recordId: "c1", analysedAt: "2026-08-01T00:00:00Z" }));
    const usage = reuseDecision(cluster, "stale-without-usage", "2026-08-15T00:00:00Z");
    assert.equal(usage.reuse, "refresh");
    assert.match(usage.reason, /usage import/i);

    createSalesEvent({
      organisation_id: cluster.organisationId,
      contact_id: "c1",
      product_scope: "PORTAL_GENIE",
      event_type: "PHONE_CALL",
      occurred_at: "2026-08-27T10:00:00Z",
      outcome: "NO_ANSWER",
      summary: "Called — no answer",
    });
    const afterEvent = reuseDecision(cluster, fingerprintForCluster(cluster, loadUsageImportMeta().importedAt));
    assert.equal(afterEvent.reuse, "refresh");
    assert.match(afterEvent.reason, /Sales Event/i);
  });
});

test("build isolates a failed organisation and records token totals", async () => {
  await withIsolatedStores(async () => {
    const client = listingClient({
      contacts: [
        { id: "good-a", Full_Name: "Ann", Email: "ann@a.test", Modified_Time: "2026-08-20T10:00:00Z" },
        { id: "broken", Full_Name: "Bo", Email: "bo@b.test", Modified_Time: "2026-08-20T10:00:00Z" },
        { id: "good-c", Full_Name: "Cy", Email: "cy@c.test", Modified_Time: "2026-08-20T10:00:00Z" },
      ],
    });
    const snapshot = await buildCommandCentre(
      {
        client,
        publicDomains: PUBLIC,
        now: () => new Date("2026-08-28T08:00:00+02:00"),
        analyse: async (_module, recordId) => {
          if (recordId === "broken") throw new Error("OpenAI exploded for Bo");
          return stored({
            recordId,
            usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
            organisationGraph: graph({
              selectedContactId: recordId,
              contacts: [
                {
                  module: "Contacts",
                  recordId,
                  name: recordId,
                  association_reasons: ["SELECTED_CONTACT"],
                  certainty: "associated",
                  selected: true,
                  commercial_role: { role: "SELECTED_CONTACT", layer: "crm_fact", evidence: "selected" },
                },
              ],
            }),
          });
        },
      },
      { mode: "build_changed", confirm: true, includeBriefSynthesis: false, maxOrganisations: 5 },
    );
    assert.equal(snapshot.analyses_failed, 1);
    assert.equal(snapshot.analyses_refreshed, 2);
    assert.ok(snapshot.watch_items.length >= 2);
    assert.ok(snapshot.failures.some((item) => /OpenAI exploded/.test(item.message)));
    assert.equal(snapshot.tokens.openai_calls, 2);
    assert.equal(snapshot.tokens.input_tokens, 22);
    assert.equal(snapshot.tokens.output_tokens, 14);
    assert.equal(snapshot.tokens.total_tokens, 36);
    assert.doesNotMatch(JSON.stringify(snapshot.failures), /no activity|no emails/i);
  });
});

test("build requires confirm; full rebuild re-analyses even when fingerprint matches", async () => {
  await withIsolatedStores(async () => {
    const client = listingClient({
      contacts: [{ id: "c1", Full_Name: "Sarah", Email: "sarah@abc.test", Modified_Time: "2026-08-20T10:00:00Z" }],
    });
    await assert.rejects(
      () =>
        buildCommandCentre(
          { client, publicDomains: PUBLIC, analyse: async () => stored() },
          { mode: "build_changed", confirm: false, includeBriefSynthesis: false },
        ),
      /explicit operator confirmation/,
    );
    const cluster = groupUniverseRecords(
      (await discoverUniverse(client, { maxRecordsPerModule: 200 })).records,
      PUBLIC,
    )[0]!;
    const fingerprint = fingerprintForCluster(cluster, loadUsageImportMeta().importedAt);
    writeStoredAnalysis(stored({ recordId: "c1", evidenceFingerprint: fingerprint, analysedAt: "2099-01-01T00:00:00Z" }));
    let calls = 0;
    await buildCommandCentre(
      {
        client,
        publicDomains: PUBLIC,
        analyse: async () => {
          calls += 1;
          return stored({ recordId: "c1", usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } });
        },
      },
      { mode: "full_rebuild", confirm: true, includeBriefSynthesis: false },
    );
    assert.equal(calls, 1);
    calls = 0;
    const reused = await buildCommandCentre(
      {
        client,
        publicDomains: PUBLIC,
        analyse: async () => {
          calls += 1;
          return stored({ recordId: "c1" });
        },
      },
      { mode: "build_changed", confirm: true, includeBriefSynthesis: false },
    );
    assert.equal(calls, 0);
    assert.equal(reused.analyses_reused, 1);
    assert.equal(reused.tokens.openai_calls, 0);
  });
});

test("brief synthesis is one extra call and does not re-analyse organisations", async () => {
  await withIsolatedStores(async () => {
    const client = listingClient({
      contacts: [{ id: "c1", Full_Name: "Sarah", Email: "sarah@abc.test", Modified_Time: "2026-08-20T10:00:00Z" }],
    });
    const cluster = groupUniverseRecords(
      (await discoverUniverse(client, { maxRecordsPerModule: 200 })).records,
      PUBLIC,
    )[0]!;
    writeStoredAnalysis(
      stored({
        recordId: "c1",
        evidenceFingerprint: fingerprintForCluster(cluster, loadUsageImportMeta().importedAt),
        analysedAt: "2099-01-01T00:00:00Z",
      }),
    );
    let analyseCalls = 0;
    let synthCalls = 0;
    const snapshot = await buildCommandCentre(
      {
        client,
        publicDomains: PUBLIC,
        analyse: async () => {
          analyseCalls += 1;
          return stored();
        },
        synthesizer: async () => {
          synthCalls += 1;
          return {
            text: JSON.stringify(["Start with the highest-priority customer action."]),
            inputTokens: 20,
            outputTokens: 8,
          };
        },
      },
      { mode: "build_changed", confirm: true, includeBriefSynthesis: true },
    );
    assert.equal(analyseCalls, 0);
    assert.equal(synthCalls, 1);
    assert.equal(snapshot.brief.mode, "openai_synthesis");
    assert.ok(snapshot.brief.commercial_watch.length >= 1);
    assert.equal(snapshot.tokens.openai_calls, 1);
    assert.equal(snapshot.tokens.input_tokens, 20);
  });
});

test("GET snapshot without a stored file is 200 with null snapshot, not 404", async () => {
  await withIsolatedStores(async () => {
    const server = createServer((req, res) => {
      void handleRequest(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/command-centre/snapshot`);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.openaiTriggered, false);
      assert.equal(body.snapshot, null);
      assert.equal(body.lastScan, null);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

test("HUMAN_REVIEW is classified as internal research and does not become customer P0/P1", () => {
  const kind = classifyActionabilityKind({
    action: "HUMAN_REVIEW",
    executability: "EXECUTABLE_NOW",
    stalledState: "NOT_STALLED",
  });
  assert.equal(kind, "INTERNAL_RESEARCH");
  const band = priorityBand({
    action_timing: "ACT_NOW",
    next_best_action: "HUMAN_REVIEW",
    stalled_state: "NOT_STALLED",
    liveDeal: false,
    executability: "EXECUTABLE_NOW",
    actionability_kind: "INTERNAL_RESEARCH",
  });
  assert.notEqual(band, "P0");
  assert.notEqual(band, "P1");
});

test("EXTERNAL_ENRICHMENT is classified as internal research and does not become customer P0/P1", () => {
  const kind = classifyActionabilityKind({
    action: "EXTERNAL_ENRICHMENT",
    executability: "EXECUTABLE_NOW",
    stalledState: "NOT_STALLED",
  });
  assert.equal(kind, "INTERNAL_RESEARCH");
  const band = priorityBand({
    action_timing: "TODAY",
    next_best_action: "EXTERNAL_ENRICHMENT",
    stalled_state: "NOT_STALLED",
    liveDeal: false,
    executability: "EXECUTABLE_NOW",
    actionability_kind: "INTERNAL_RESEARCH",
  });
  assert.equal(band, "P3");
});

test("executable genuine customer action can remain P1", () => {
  const band = priorityBand({
    action_timing: "ACT_NOW",
    next_best_action: "PHONE_CALL",
    stalled_state: "NOT_STALLED",
    liveDeal: true,
    executability: "EXECUTABLE_NOW",
    actionability_kind: "CUSTOMER_ACTION",
    customer_queue: true,
  });
  assert.equal(band, "P1");
});

test("structured daily brief separates customer actions, wait, research, and commercial watch", () => {
  const brief = deterministicDailyBrief(
    [
      watch({
        organisation_name: "Customer Co",
        priority: "P1",
        actionability_kind: "CUSTOMER_ACTION",
        customer_queue: true,
        next_best_action: "PHONE_CALL",
        recommended_contact_name: "Sam",
      }),
      watch({
        id: "acticem:PORTAL_GENIE",
        organisation_name: "Acticem",
        priority: "P3",
        actionability_kind: "INTERNAL_RESEARCH",
        next_best_action: "HUMAN_REVIEW",
        action_timing: "ACT_NOW",
      }),
      watch({
        id: "kirstin:NAGGING_PANDA",
        organisation_name: "Kirstin Resolve",
        product_scope: "NAGGING_PANDA",
        priority: "P5",
        actionability_kind: "NO_ACTION",
        next_best_action: "NO_ACTION",
        executability: "NO_ACTION_REQUIRED",
      }),
      watch({
        id: "rae:PORTAL_GENIE",
        organisation_name: "Rae Accounting",
        priority: "P4",
        next_best_action: "WAIT",
        executability: "WAITING_FOR_CUSTOMER",
        stalled_state: "WAITING_ON_CUSTOMER",
      }),
    ],
    [],
    AS_OF,
  );
  assert.equal(brief.do_first_actions.length, 1);
  assert.equal(brief.do_first_actions[0]?.organisation_name, "Customer Co");
  assert.ok(brief.research_items.some((item) => item.organisation_name === "Acticem"));
  assert.ok(!brief.research_items.some((item) => item.organisation_name === "Kirstin Resolve"));
  assert.ok(brief.wait_items.some((item) => item.organisation_name === "Rae Accounting"));
  assert.ok(brief.commercial_watch.length >= 1 && brief.commercial_watch.length <= 5);
  assert.doesNotMatch(brief.do_first_actions.map((item) => item.organisation_name).join(" "), /Acticem|Kirstin/i);
  assert.doesNotMatch(brief.wait.join(" "), /Acticem|Kirstin Resolve/i);
});

test("daily brief separates internal research from customer follow-up", () => {
  const brief = deterministicDailyBrief(
    [
      watch({
        organisation_name: "Customer Co",
        priority: "P1",
        actionability_kind: "CUSTOMER_ACTION",
        customer_queue: true,
        next_best_action: "PHONE_CALL",
      }),
      watch({
        organisation_name: "Acticem",
        priority: "P3",
        actionability_kind: "INTERNAL_RESEARCH",
        next_best_action: "HUMAN_REVIEW",
        action_timing: "ACT_NOW",
      }),
    ],
    [],
    AS_OF,
  );
  assert.equal(brief.follow_up_today.length, 1);
  assert.equal(brief.research_required.length, 1);
  assert.match(brief.research_required[0] ?? "", /Acticem/);
  assert.doesNotMatch(brief.follow_up_today.join(" "), /Acticem|HUMAN_REVIEW/i);
});

test("first-party domain configuration excludes internal organisations from customer queue", () => {
  const firstParty = loadFirstPartyDomains();
  assert.ok(isFirstPartyDomain("theportalgenie.com", firstParty));
  assert.ok(isFirstPartyDomain("naggingpanda.com", firstParty));
  assert.equal(isFirstPartyDomain("abc.test", firstParty), false);
  const [cluster] = groupUniverseRecords(
    [rec({ module: "Contacts", recordId: "c1", name: "Geoff", email: "geoff@theportalgenie.com" })],
    PUBLIC,
  );
  assert.equal(isFirstPartyOrganisation(cluster!, firstParty, PUBLIC), true);
  const [item] = watchItemsFromAnalysis(stored(), {
    organisationId: cluster!.organisationId,
    organisationName: cluster!.organisationName,
    reuse: "reused",
    customerQueue: false,
    asOf: AS_OF,
  });
  assert.ok(item);
  assert.equal(item.customer_queue, false);
  assert.equal(item.priority, "P5");
  assert.ok(item.evidence_refs.length >= 0);
});

test("Account-rooted stored analysis reuses when fingerprint matches", async () => {
  await withIsolatedStores(async () => {
    const records = [
      rec({
        module: "Accounts",
        recordId: "a-acticem",
        name: "Acticem",
        accountId: "a-acticem",
        accountName: "Acticem",
        modifiedAt: "2026-08-20T10:00:00Z",
      }),
    ];
    const [cluster] = groupUniverseRecords(records, PUBLIC);
    assert.equal(cluster!.representative.module, "Accounts");
    const fingerprint = fingerprintForCluster(cluster!, loadUsageImportMeta().importedAt);
    writeStoredAnalysis(
      stored({
        module: "Accounts",
        recordId: "a-acticem",
        evidenceFingerprint: fingerprint,
        analysedAt: "2099-01-01T00:00:00Z",
      }),
    );
    const decision = reuseDecision(cluster!, fingerprint);
    assert.equal(decision.reuse, "reuse");
    assert.match(decision.reason, /fingerprint unchanged/i);
    assert.deepEqual(analysisRootsForCluster(cluster!)[0], { module: "Accounts", recordId: "a-acticem" });
  });
});

test("Account-rooted fingerprint still invalidates when CRM listing changes", async () => {
  await withIsolatedStores(async () => {
    const records = [
      rec({
        module: "Accounts",
        recordId: "a-acticem",
        name: "Acticem",
        accountId: "a-acticem",
        accountName: "Acticem",
        modifiedAt: "2026-08-20T10:00:00Z",
      }),
    ];
    const [cluster] = groupUniverseRecords(records, PUBLIC);
    writeStoredAnalysis(
      stored({
        module: "Accounts",
        recordId: "a-acticem",
        analysedAt: "2026-08-01T00:00:00Z",
      }),
    );
    const changed = reuseDecision(cluster!, "new-fingerprint");
    assert.equal(changed.reuse, "refresh");
  });
});

test("listing Deals merge into WatchItem deal_ids when organisation graph omits them", () => {
  const [item] = watchItemsFromAnalysis(
    stored({
      organisationGraph: graph({ deals: [] }),
      productRelationships: [
        {
          product: "PORTAL_GENIE",
          relationship_state: "PARTNER_PROSPECT",
          evidence_ids: ["ev-1"],
          summary: "Partner conversation",
          confidence: "HIGH",
        },
      ],
    }),
    {
      organisationId: "domain:partner.test",
      organisationName: "Partner Co",
      reuse: "reused",
      asOf: AS_OF,
      listingDeals: [
        rec({
          module: "Deals",
          recordId: "d-partner",
          name: "Firm Partner",
          stage: "Qualification",
          pipeline: "Partner",
        }),
      ],
    },
  );
  assert.ok(item);
  assert.ok(item.deal_ids.includes("d-partner"));
});

test("listing Nagging Panda deal does not suppress Portal Genie watch when PG relationship row exists", () => {
  const items = watchItemsFromAnalysis(
    stored({
      profile: validSampleProfile({ recommended_action: "HUMAN_REVIEW" }),
      organisationGraph: graph({ deals: [] }),
      productRelationships: [
        {
          product: "PORTAL_GENIE",
          relationship_state: "UNKNOWN",
          evidence_ids: ["ev-1"],
          summary: "Unknown Portal Genie relationship",
          confidence: "LOW",
        },
        {
          product: "NAGGING_PANDA",
          relationship_state: "UNKNOWN",
          evidence_ids: [],
          summary: "Unknown Nagging Panda relationship",
          confidence: "LOW",
        },
      ],
    }),
    {
      organisationId: "zoho-account:a1",
      organisationName: "Acticem",
      reuse: "reused",
      asOf: AS_OF,
      listingDeals: [
        rec({
          module: "Deals",
          recordId: "d-np-lost",
          name: "NP Closed Lost",
          stage: "Closed Lost",
          pipeline: "Nagging Panda",
        }),
      ],
    },
  );
  const pg = items.find((item) => item.product_scope === "PORTAL_GENIE");
  const np = items.find((item) => item.product_scope === "NAGGING_PANDA");
  assert.ok(pg);
  assert.equal(pg.next_best_action, "HUMAN_REVIEW");
  assert.equal(pg.actionability_kind, "INTERNAL_RESEARCH");
  assert.notEqual(pg.priority, "P1");
  assert.ok(np);
  assert.equal(np.next_best_action, "NO_ACTION");
});

test("WAIT and do-not-chase behaviour remains intact after actionability hardening", () => {
  const [item] = watchItemsFromAnalysis(
    stored({
      profile: validSampleProfile({ recommended_action: "WAIT", recommended_action_reason: "Customer asked to wait." }),
      organisationGraph: graph({
        salesEvents: [
          parseSalesEventInput({
            organisation_id: "domain:abc.test",
            contact_id: "c1",
            product_scope: "PORTAL_GENIE",
            event_type: "FOLLOW_UP",
            occurred_at: "2026-08-01T10:00:00Z",
            follow_up_date: "2026-09-15",
            outcome: "FOLLOW_UP_REQUESTED",
            summary: "Reconnect mid September",
          }) as SalesEvent,
        ],
      }),
    }),
    { organisationId: "domain:abc.test", organisationName: "Wait Co", reuse: "reused", asOf: AS_OF },
  );
  assert.ok(item);
  assert.equal(item.next_best_action, "WAIT");
  assert.equal(item.actionability_kind, "WAIT");
  assert.equal(item.priority, "P4");
  assert.equal(item.executability, "WAITING_FOR_TIME");
});

test("GET snapshot does not trigger OpenAI; POST build without confirm is rejected", async () => {
  await withIsolatedStores(async () => {
    writePortfolioSnapshot({
      generated_at: AS_OF,
      run_id: "cc-test",
      duration_ms: 12,
      mode: "build_changed",
      organisations_discovered: 1,
      watch_items: [watch({ organisation_name: "ABC Accounting" })],
      ranking_note: PRIORITY_TIEBREAK,
      stalled_count: 0,
      waiting_count: 0,
      needs_action_today: 1,
      active_opportunities: 1,
      brief: deterministicDailyBrief([watch({ organisation_name: "ABC Accounting" })], [], AS_OF),
      failures: [],
      tokens: { openai_calls: 4, input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      analyses_reused: 1,
      analyses_refreshed: 0,
      analyses_failed: 0,
    });
    const server = createServer((req, res) => {
      void handleRequest(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const snapshot = await fetch(`http://127.0.0.1:${port}/api/command-centre/snapshot`);
      const body = await snapshot.json();
      assert.equal(snapshot.status, 200);
      assert.equal(body.openaiTriggered, false);
      assert.equal(body.snapshot.watch_items[0].organisation_name, "ABC Accounting");
      const denied = await fetch(`http://127.0.0.1:${port}/api/command-centre/build`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "full_rebuild" }),
      });
      assert.equal(denied.status, 400);
      const deniedBody = await denied.json();
      assert.match(deniedBody.error, /confirm=true/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
