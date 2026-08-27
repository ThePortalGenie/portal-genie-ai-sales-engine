import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import test from "node:test";
import { parseCsv } from "../src/ingestion/usage/parse-csv.js";
import { normalizeUsageRecords, rowsToRawRecords } from "../src/ingestion/usage/normalize.js";
import { matchUsageToCrm } from "../src/domain/identity-match.js";
import { associateUsageWithOrganisation, matchUsageForOrganisation, usageImportIsNewerThan } from "../src/intelligence/usage-match.js";
import {
  contradictionsForOrganisation,
  portalVisitTrend,
  signalsForView,
  toSubscriberView,
  type CrmUsageContext,
} from "../src/intelligence/usage-signals.js";
import { DEFAULT_ACTIVATION_THRESHOLDS } from "../src/domain/normalized-usage.js";
import type { RelationshipIdentity } from "../src/domain/identity.js";
import type { OrgMember } from "../src/intelligence/org-resolution.js";
import { buildProductRelationships } from "../src/intelligence/product-relationships.js";
import { buildCommercialReasoningContext, SYSTEM_PROMPT } from "../src/intelligence/reasoning-context.js";
import { analyseRelationship } from "../src/intelligence/analyse.js";
import { validSampleProfile } from "../src/intelligence/profile-schema.js";
import { handleRequest } from "../src/server/app.js";
import { emptyFieldQuality } from "../src/domain/portal-genie-usage.js";
import type { DiscoveryDiagnostic } from "../src/integrations/zoho/types.js";

const NOW = new Date("2026-08-27T10:00:00Z");
const PUBLIC = new Set(["gmail.com", "hotmail.com"]);

const HEADER = "Client ID,First Name,Surname,Email Address,Accounting Software Connected,Accounting Platform,Last Login Date,Portal Visits — Current Month,Portal Visits — Previous Month,Portal Visits — Two Months Ago,Data Used For Document Uploads";

function profilesFromCsv(csv: string) {
  const parsed = parseCsv(csv);
  return normalizeUsageRecords(rowsToRawRecords(parsed.headers, parsed.rows), {
    kind: "csv",
    fileName: "test.csv",
    importedAt: NOW.toISOString(),
  });
}

function member(partial: Partial<OrgMember> & Pick<OrgMember, "recordId" | "name">): OrgMember {
  return {
    module: "Contacts",
    selected: false,
    genericMailbox: false,
    reasons: ["SAME_BUSINESS_DOMAIN"],
    certainty: "associated",
    ...partial,
  };
}

function crm(email: string, id = "111"): RelationshipIdentity {
  return { zoho: { contactId: id }, portalGenie: {}, emails: [email], source: "zoho" };
}

test("exact email usage match and email normalisation", () => {
  const [profile] = profilesFromCsv(`${HEADER}\nPG-1,Jane,Smith,Jane@ABCAccounting.COM,YES,XERO,2026-08-20,4,4,4,1 GB\n`);
  assert.ok(profile);
  const match = matchUsageToCrm(profile, [crm("jane@abcaccounting.com")]);
  assert.equal(match.status, "matched");
  assert.equal(match.method, "email");
  assert.equal(profile.identity.primaryEmail, "jane@abcaccounting.com");
});

test("Client ID matches only when a Portal Genie mapping already exists", () => {
  const [profile] = profilesFromCsv(`${HEADER}\nPG-77,Jane,Smith,jane@firm.test,YES,XERO,2026-08-20,4,3,2,\n`);
  assert.ok(profile);
  const mapped = member({ recordId: "c1", name: "Jane", email: "other@firm.test", portalGenieOrgId: "PG-77" });
  const unmapped = member({ recordId: "c1", name: "Jane", email: "other@firm.test" });
  const hit = associateUsageWithOrganisation([mapped], [profile], { publicDomains: PUBLIC });
  assert.equal(hit.contactProfiles[0]?.matchMethod, "portal_genie_org_mapping");
  const miss = associateUsageWithOrganisation([unmapped], [profile], { orgDomains: ["firm.test"], publicDomains: PUBLIC });
  assert.equal(miss.contactProfiles.length, 0);
  assert.equal(miss.organisationDiscoveredProfiles.length, 1);
});

test("public-domain exclusion does not create organisation matches", () => {
  const [profile] = profilesFromCsv(`${HEADER}\nPG-1,Pat,Gmail,pat@gmail.com,YES,XERO,2026-08-20,3,2,1,\n`);
  assert.ok(profile);
  const clarissa = member({ recordId: "c2", name: "Clarissa", email: "clarissa@gmail.com" });
  const layer = associateUsageWithOrganisation([clarissa], [profile], { orgDomains: ["gmail.com"], publicDomains: PUBLIC });
  assert.equal(layer.contactProfiles.length, 0);
  assert.equal(layer.organisationDiscoveredProfiles.length, 0);
  assert.equal(layer.summary.label, "USAGE UNKNOWN");
});

test("same business domain does not transfer personal usage", () => {
  const [sumere] = profilesFromCsv(`${HEADER}\nPG-S,Sumere,Van Staden,sumere@firm.co.za,YES,XERO,2026-08-01,17,12,9,800 MB\n`);
  assert.ok(sumere);
  const members = [
    member({ recordId: "s1", name: "Sumere", email: "sumere@firm.co.za", selected: true }),
    member({ recordId: "c1", name: "Clarissa", email: "clarissa@firm.co.za" }),
  ];
  const layer = associateUsageWithOrganisation(members, [sumere], { orgDomains: ["firm.co.za"], publicDomains: PUBLIC });
  assert.equal(layer.contactProfiles.length, 1);
  assert.equal(layer.contactProfiles[0]?.matchedContactName, "Sumere");
  assert.equal(layer.contactProfiles[0]?.lastLoginAt, "2026-08-01");
  assert.ok(layer.unmatchedContacts.some((item) => item.name === "Clarissa"));
  assert.equal(layer.unmatchedContacts.find((item) => item.name === "Clarissa")?.message, "No matching usage profile");
});

test("multiple usage profiles in one organisation stay separate", () => {
  const profiles = profilesFromCsv(
    `${HEADER}\nPG-S,Sumere,Van Staden,sumere@firm.co.za,YES,XERO,2026-08-20,17,12,9,1 GB\nPG-C,Clarissa,Van Heerden,clarissa@firm.co.za,NO,UNKNOWN,2026-07-01,2,2,2,\n`,
  );
  const members = [
    member({ recordId: "s1", name: "Sumere", email: "sumere@firm.co.za", selected: true }),
    member({ recordId: "c1", name: "Clarissa", email: "clarissa@firm.co.za" }),
  ];
  const layer = associateUsageWithOrganisation(members, profiles, { orgDomains: ["firm.co.za"], publicDomains: PUBLIC });
  assert.equal(layer.contactProfiles.length, 2);
  assert.equal(layer.summary.subscriberProfileCount, 2);
  assert.notEqual(layer.contactProfiles[0]?.lastLoginAt, layer.contactProfiles[1]?.lastLoginAt);
});

test("Portal Genie usage does not affect Nagging Panda directly", () => {
  const [profile] = profilesFromCsv(`${HEADER}\nPG-1,Jane,Smith,jane@firm.test,YES,XERO,2026-08-20,20,10,5,2 GB\n`);
  const members = [member({ recordId: "1", name: "Jane", email: "jane@firm.test", selected: true })];
  const usage = matchUsageForOrganisation(members, [profile!], { orgDomains: ["firm.test"], publicDomains: PUBLIC, now: NOW });
  const products = buildProductRelationships({
    organisation: {
      identity: { name: "Firm", domains: ["firm.test"], certainty: "resolved" },
      members,
      notes: [],
      deals: { count: 1, stages: ["Closed Lost"], names: ["Historic accounting deal"], closedWon: 0, closedLost: 1, values: [] },
      emailSummary: { selectedOutbound: 0, selectedInbound: 0, selectedLastAt: null, otherMembersDiscovered: 0 },
      timeline: [],
      usage,
      evidence: usage.evidence,
    },
    deals: { count: 1, stages: ["Closed Lost"], names: ["Historic accounting deal"], closedWon: 0, closedLost: 1, values: [] },
    emails: [],
    evidence: [],
  });
  const pg = products.products.find((item) => item.product === "PORTAL_GENIE");
  const np = products.products.find((item) => item.product === "NAGGING_PANDA");
  assert.ok(pg && pg.relationship_state !== "UNKNOWN");
  assert.equal(np?.relationship_state, "UNKNOWN");
});

test("zero vs blank vs invalid numeric and date values", () => {
  const [zero, blank, invalid] = profilesFromCsv(
    `${HEADER}\nPG-Z,Zero,Row,zero@firm.test,NO,UNKNOWN,2026-08-01,0,0,0,0\nPG-B,Blank,Row,blank@firm.test,UNKNOWN,UNKNOWN,,,,\nPG-I,Invalid,Row,invalid@firm.test,YES,XERO,not-a-date,abc,5,4,lots\n`,
  );
  assert.equal(zero?.fieldQuality.portalVisitsCurrentMonth, "zero");
  assert.equal(zero?.portalVisitsCurrentMonth, 0);
  assert.equal(blank?.fieldQuality.portalVisitsCurrentMonth, "unknown");
  assert.equal(blank?.portalVisitsCurrentMonth, undefined);
  assert.equal(blank?.accountingConnected, undefined);
  assert.equal(invalid?.fieldQuality.portalVisitsCurrentMonth, "invalid");
  assert.equal(invalid?.portalVisitsCurrentMonth, undefined);
  assert.equal(invalid?.fieldQuality.lastLoginAt, "invalid");
  assert.ok(invalid?.warnings.some((item) => /not a number/i.test(item)));
  assert.ok(invalid?.warnings.some((item) => /not a usable date/i.test(item)));
});

test("Xero, QuickBooks, Sage, and unknown accounting platforms", () => {
  const rows = profilesFromCsv(
    `${HEADER}\nA,A,A,a@firm.test,YES,XERO,2026-08-20,1,1,1,\nB,B,B,b@firm.test,YES,QUICKBOOKS,2026-08-20,1,1,1,\nC,C,C,c@firm.test,YES,SAGE,2026-08-20,1,1,1,\nD,D,D,d@firm.test,UNKNOWN,UNKNOWN,2026-08-20,1,1,1,\n`,
  );
  assert.equal(rows[0]?.accountingPlatform, "xero");
  assert.equal(rows[1]?.accountingPlatform, "quickbooks");
  assert.equal(rows[2]?.accountingPlatform, "sage_business_cloud");
  assert.equal(rows[3]?.accountingConnected, undefined);
  assert.equal(rows[3]?.fieldQuality.accountingPlatform, "unknown");
});

test("recent, stale, and missing subscriber login signals", () => {
  const [recent, stale, missing] = profilesFromCsv(
    `${HEADER}\nR,R,R,r@firm.test,YES,XERO,2026-08-20,1,1,1,\nS,S,S,s@firm.test,YES,XERO,2026-06-01,1,1,1,\nM,M,M,m@firm.test,YES,XERO,,1,1,1,\n`,
  );
  const recentView = toSubscriberView(recent!, { layer: "contact", matchMethod: "email", matchReason: "email", thresholds: DEFAULT_ACTIVATION_THRESHOLDS });
  const staleView = toSubscriberView(stale!, { layer: "contact", matchMethod: "email", matchReason: "email", thresholds: DEFAULT_ACTIVATION_THRESHOLDS });
  const missingView = toSubscriberView(missing!, { layer: "contact", matchMethod: "email", matchReason: "email", thresholds: DEFAULT_ACTIVATION_THRESHOLDS });
  assert.ok(signalsForView(recentView, NOW, DEFAULT_ACTIVATION_THRESHOLDS).some((item) => item.code === "RECENT_LOGIN"));
  assert.ok(signalsForView(staleView, NOW, DEFAULT_ACTIVATION_THRESHOLDS).some((item) => item.code === "LOGIN_STALE"));
  assert.equal(missingView.lastLoginPresence, "unknown");
  assert.ok(!signalsForView(missingView, NOW, DEFAULT_ACTIVATION_THRESHOLDS).some((item) => item.code === "RECENT_LOGIN" || item.code === "LOGIN_STALE"));
});

test("portal visit trend increasing, declining, stable, and insufficient", () => {
  assert.equal(portalVisitTrend(17, 12, 9), "INCREASING");
  assert.equal(portalVisitTrend(2, 9, 15), "DECLINING");
  assert.equal(portalVisitTrend(10, 10, 10), "STABLE");
  assert.equal(portalVisitTrend(10, 11, 10), "STABLE");
  assert.equal(portalVisitTrend(20, 5, 18), "MIXED");
  assert.equal(portalVisitTrend(undefined, undefined, 4), "INSUFFICIENT_DATA");
});

test("document usage present, zero, and usage unknown", () => {
  const [present, zero] = profilesFromCsv(
    `${HEADER}\nP,P,P,p@firm.test,YES,XERO,2026-08-20,4,4,4,450 MB\nZ,Z,Z,z@firm.test,YES,XERO,2026-08-20,4,4,4,0\n`,
  );
  assert.equal(present?.fieldQuality.documentUploadUsage, "present");
  assert.equal(present?.documentUploadUsage?.unit.toLowerCase(), "mb");
  assert.equal(zero?.fieldQuality.documentUploadUsage, "zero");
  const unknown = matchUsageForOrganisation(
    [member({ recordId: "1", name: "Jane", email: "jane@firm.test" })],
    [],
    { publicDomains: PUBLIC },
  );
  assert.equal(unknown.label, "USAGE UNKNOWN");
  assert.match(unknown.message, /unknown/i);
  assert.doesNotMatch(unknown.message, /no usage/i);
});

test("CRM engaged but product not activated", () => {
  const [profile] = profilesFromCsv(`${HEADER}\nPG-1,Pat,Unused,pat@firm.test,NO,UNKNOWN,,0,0,0,0\n`);
  const view = toSubscriberView(profile!, { layer: "contact", matchMethod: "email", matchReason: "email" });
  const engaged: CrmUsageContext = {
    inboundEmails: 4,
    outboundEmails: 6,
    calls: 1,
    meetings: 1,
    notesOrEmailsSuggestProductUse: true,
  };
  const contradictions = contradictionsForOrganisation({ views: [view], unmatchedContactCount: 0, crm: engaged, now: NOW });
  assert.ok(contradictions.some((item) => item.code === "CRM_ENGAGED_BUT_PRODUCT_NOT_ACTIVATED"));
});

test("CRM quiet / usage active and stale login with active client portal visits", () => {
  const [profile] = profilesFromCsv(`${HEADER}\nPG-1,Sumere,Van Staden,sumere@firm.test,YES,XERO,2026-06-01,17,12,9,1 GB\n`);
  const view = toSubscriberView(profile!, { layer: "contact", matchMethod: "email", matchReason: "email" });
  const quiet: CrmUsageContext = {
    inboundEmails: 0,
    outboundEmails: 1,
    calls: 0,
    meetings: 0,
    notesOrEmailsSuggestProductUse: false,
  };
  const contradictions = contradictionsForOrganisation({ views: [view], unmatchedContactCount: 0, crm: quiet, now: NOW });
  assert.ok(contradictions.some((item) => item.code === "CRM_QUIET_BUT_PRODUCT_ACTIVE"));
  assert.ok(contradictions.some((item) => item.code === "CUSTOMER_NOT_LOGGING_IN_BUT_CLIENT_PORTAL_ACTIVITY_EXISTS"));
  assert.ok(contradictions.some((item) => item.code === "USAGE_GROWING_DESPITE_LIMITED_SALES_ACTIVITY"));
});

test("digest contains only organisation usage and not the imported CSV wholesale", () => {
  const profiles = profilesFromCsv(
    `${HEADER}\nPG-S,Sumere,Van Staden,sumere@firm.test,YES,XERO,2026-08-20,17,12,9,1 GB\nPG-X,Other,Org,other@elsewhere.com,YES,XERO,2026-08-20,50,40,30,9 GB\n`,
  );
  const usage = matchUsageForOrganisation(
    [member({ recordId: "s1", name: "Sumere", email: "sumere@firm.test", selected: true })],
    profiles,
    { orgDomains: ["firm.test"], publicDomains: PUBLIC, now: NOW },
  );
  const context = buildCommercialReasoningContext({
    contact: {
      identity: { module: "Contacts", recordId: "s1", name: "Sumere", email: "sumere@firm.test", organisation: "Firm" },
      notes: [],
      deals: { count: 0, stages: [], names: [], closedWon: 0, closedLost: 0, values: [] },
      emails: { outboundCount: 0, inboundCount: 0, lastAt: null, lastDirection: null },
      calls: 0,
      meetings: 0,
      tasks: 0,
      evidence: [],
    } as never,
    organisation: {
      identity: { name: "Firm", domains: ["firm.test"], certainty: "resolved" },
      members: [member({ recordId: "s1", name: "Sumere", email: "sumere@firm.test", selected: true })],
      notes: [],
      deals: { count: 0, stages: [], names: [], closedWon: 0, closedLost: 0, values: [] },
      emailSummary: { selectedOutbound: 0, selectedInbound: 0, selectedLastAt: null, otherMembersDiscovered: 0 },
      timeline: [],
      usage,
      evidence: usage.evidence,
    },
    emails: [],
    evidence: usage.evidence,
  });
  const json = JSON.stringify(context);
  assert.match(json, /sumere@firm.test/);
  assert.doesNotMatch(json, /other@elsewhere.com/);
  assert.doesNotMatch(json, /PG-X/);
  assert.match(json, /Portal visits = visits by the subscriber's clients/);
  assert.ok(usage.evidence.some((item) => item.source === "USAGE"));
});

test("import does not trigger OpenAI automatically", async () => {
  const usagePath = resolve(process.cwd(), "diagnostics/usage-import.json");
  const previous = existsSync(usagePath) ? readFileSync(usagePath, "utf8") : null;
  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/usage/import-csv`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        csv: `${HEADER}\nPG-1,Jane,Smith,jane@abcaccounting.com,YES,XERO,2026-08-20,4,3,2,1 GB\n`,
        fileName: "m25.csv",
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.openaiTriggered, false);
    assert.equal(body.accepted, 1);
    assert.equal(body.analysis, undefined);
  } finally {
    if (previous) writeFileSync(usagePath, previous);
    else rmSync(usagePath, { force: true });
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("explicit re-analysis includes updated usage", async () => {
  const [profile] = profilesFromCsv(`${HEADER}\nPG-1,Roadshow,Lead,lead@firm.test,YES,XERO,2026-08-20,17,12,9,1 GB\n`);
  let captured = "";
  const result = await analyseRelationship({
    module: "Contacts",
    recordId: "1111111111111111111",
    diagnostic: {
      generatedAt: "2026-08-27T10:00:00Z",
      connector: { name: "zoho-discovery", mode: "read-only", apiVersion: "v8", apiDomain: "https://www.zohoapis.com", accountsUrl: "https://accounts.zoho.com", documentation: {}, scopesExpected: [] },
      request: { fetchEmailBodies: 0, maxRelatedRecords: 10 },
      primaryRecord: { module: "Contacts", id: "1111111111111111111", retrieved: true, tags: null, lookupFollowUps: [], record: { Full_Name: "Roadshow", Email: "lead@firm.test" } },
      fieldCatalog: { module: "Contacts", retrieved: true, totalFields: 0, customFields: [], standardFields: [] },
      moduleTags: { retrieved: false, tags: [] },
      relatedLists: { catalogRetrieved: true, available: [], retrievals: [] },
      emails: {
        listAttempted: true,
        success: true,
        count: 0,
        moreRecords: false,
        headers: [],
        bodies: [],
        normalized: [],
        interactionFacts: {
          outboundCount: 0,
          inboundCount: 0,
          unknownDirectionCount: 0,
          lastAt: null,
          lastDirection: null,
          inboundAfterOutbound: false,
          consecutiveOutboundWithoutLaterInbound: 0,
        },
        note: "",
        typesAttempted: [],
        calls: [],
      },
      salesContextSummary: {
        hasPrimaryRecord: true,
        hasNotes: false,
        hasDeals: false,
        hasEmailHeaders: false,
        hasEmailBodies: false,
        hasOpenActivities: false,
        hasClosedActivities: false,
        hasAccount: false,
        hasTags: false,
        customFieldCount: 0,
        salesRelevantCustomFields: [],
        likelyUsefulForIntelligence: [],
        unavailableCapabilities: [],
      },
      warnings: [],
      errors: [],
    } as unknown as DiscoveryDiagnostic,
    client: {
      async getRecord() { return { ok: true, status: 204, noContent: true, json: null }; },
      async searchByEmail() { return { ok: true, status: 204, noContent: true, json: null }; },
      async getFields() { return { ok: true, status: 204, noContent: true, json: null }; },
      async getRelatedLists() { return { ok: true, status: 204, noContent: true, json: null }; },
      async getRelatedRecords() { return { ok: true, status: 204, noContent: true, json: null }; },
      async getEmails() { return { ok: true, status: 204, noContent: true, json: null }; },
      async getEmail() { return { ok: true, status: 204, noContent: true, json: null }; },
      async getTags() { return { ok: true, status: 204, noContent: true, json: null }; },
      async searchByWord() { return { ok: true, status: 200, noContent: false, json: { data: [] } }; },
      async getOrg() { return { ok: true, status: 204, noContent: true, json: null }; },
    },
    model: "gpt-5.6",
    usageProfiles: [profile!],
    usageImportedAt: "2026-08-27T12:00:00Z",
    reasoner: {
      async reason(context) {
        captured = JSON.stringify(context);
        return {
          profile: validSampleProfile(),
          model: "gpt-5.6",
          usage: { totalTokens: 9 },
          latencyMs: 1,
          rawText: "{}",
        };
      },
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.organisation?.usage.label, "USAGE MATCHED");
  assert.match(captured, /lead@firm.test/);
  assert.match(captured, /17/);
  assert.ok(result.reconstructedTimeline?.some((item) => item.kind === "usage"));
});

test("usage staleness is detected without auto re-analysis", () => {
  assert.equal(usageImportIsNewerThan("2026-08-27T10:00:00Z", "2026-08-27T12:00:00Z"), true);
  assert.equal(usageImportIsNewerThan("2026-08-27T12:00:00Z", "2026-08-27T10:00:00Z"), false);
});

test("OpenAI instructions distinguish usage facts from inferences", () => {
  assert.match(SYSTEM_PROMPT, /Portal visits = visits by the subscriber's clients/i);
  assert.match(SYSTEM_PROMPT, /UNKNOWN is not ZERO/i);
  assert.match(SYSTEM_PROMPT, /Do not introduce numeric scores/i);
  assert.match(SYSTEM_PROMPT, /must not change the NAGGING_PANDA relationship/i);
});

test("emptyFieldQuality starts unknown, not zero", () => {
  const quality = emptyFieldQuality();
  assert.equal(quality.portalVisitsCurrentMonth, "unknown");
  assert.equal(quality.lastLoginAt, "unknown");
});
