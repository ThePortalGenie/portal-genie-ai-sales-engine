import assert from "node:assert/strict";
import test from "node:test";
import type { DiscoveryDiagnostic } from "../src/integrations/zoho/types.js";
import type { ZohoCrmReader } from "../src/integrations/zoho/client.js";
import type { ZohoHttpResult } from "../src/integrations/zoho/types.js";
import type { AttributedEmail } from "../src/domain/organisation-graph.js";
import { evidence, resetEvidenceIds } from "../src/domain/evidence.js";
import { analyseRelationship } from "../src/intelligence/analyse.js";
import { loadPublicEmailDomains } from "../src/intelligence/email-domains.js";
import {
  applyOrganisationDealProducts,
  assembleOrganisationGraph,
  buildDataQualitySignals,
  classifyDealProduct,
  contactNodeFromMember,
  dealSignalsFromGraphDeals,
  detectFragmentation,
  orgEmailMetrics,
} from "../src/intelligence/org-graph.js";
import { expandOrganisationGraph } from "../src/intelligence/org-graph-expand.js";
import { DEFAULT_ORG_EXPANSION_LIMITS, loadOrgExpansionLimits } from "../src/intelligence/org-expansion-limits.js";
import { classifyOrgAssociation, resolveOrganisation, type OrgCandidate } from "../src/intelligence/org-resolution.js";
import { createRequestCachedClient } from "../src/intelligence/request-cache.js";
import { reconstructFromSources, resetInteractionIds } from "../src/intelligence/interaction-extraction.js";
import { buildCommercialEvidenceDigest } from "../src/intelligence/evidence-digest.js";
import { buildProductRelationships } from "../src/intelligence/product-relationships.js";
import { validSampleProfile } from "../src/intelligence/profile-schema.js";
import { SYSTEM_PROMPT } from "../src/intelligence/reasoning-context.js";
import type { CommercialEvidenceDigest } from "../src/intelligence/evidence-digest.js";
import type { ContactIntelligence } from "../src/intelligence/contact-intelligence.js";
import type { OrganisationEvidenceProfile } from "../src/intelligence/org-intelligence.js";
import type { OrganisationDealNode, OrganisationAccountNode } from "../src/domain/organisation-graph.js";

const PUBLIC = loadPublicEmailDomains();

function emptyResult(): ZohoHttpResult {
  return { ok: true, status: 204, noContent: true, json: null };
}

function ok(json: unknown): ZohoHttpResult {
  return { ok: true, status: 200, noContent: false, json };
}

function attributedEmail(partial: Partial<AttributedEmail> & Pick<AttributedEmail, "ownerRecordId">): AttributedEmail {
  return {
    messageId: partial.messageId ?? "m1",
    threadId: null,
    at: partial.at ?? "2026-06-01T10:00:00Z",
    direction: partial.direction ?? "inbound",
    directionEvidence: "test",
    sender: { name: null, email: null },
    recipients: [],
    cc: [],
    subject: partial.subject ?? "Hello",
    bodyText: partial.bodyText ?? null,
    currentMessageText: partial.currentMessageText ?? "Hello",
    quoteStrippingConfidence: "HIGH",
    strippedQuotedHistory: false,
    bodyTruncated: false,
    sourceType: "crm_email",
    hasAttachment: false,
    ownerName: partial.ownerName,
    ownerRecordId: partial.ownerRecordId,
  };
}

function emptyContact(overrides: Partial<ContactIntelligence> = {}): ContactIntelligence {
  return {
    identity: { name: "Alice", module: "Contacts", recordId: "c-alice", organisation: "Firm Accounting", email: "alice@firm.test" },
    importantFields: [],
    notes: [],
    deals: { count: 0, stages: [], names: [], closedWon: 0, closedLost: 0, values: [] },
    emails: {
      outboundCount: 2,
      inboundCount: 1,
      unknownDirectionCount: 0,
      lastAt: "2026-06-12T00:00:00Z",
      lastDirection: "outbound",
      inboundAfterOutbound: false,
      consecutiveOutboundWithoutLaterInbound: 1,
    },
    emailSubjects: [],
    tasks: 0,
    calls: 0,
    meetings: 0,
    evidence: [],
    ...overrides,
  };
}

function emptyOrg(overrides: Partial<OrganisationEvidenceProfile> = {}): OrganisationEvidenceProfile {
  return {
    identity: { domains: ["firm.test"], certainty: "resolved", name: "Firm Accounting" },
    members: [],
    notes: [],
    deals: { count: 0, stages: [], names: [], closedWon: 0, closedLost: 0, values: [] },
    emailSummary: { selectedOutbound: 0, selectedInbound: 0, selectedLastAt: null, otherMembersDiscovered: 0 },
    timeline: [],
    usage: { status: "unavailable", label: "USAGE UNKNOWN", message: "USAGE UNKNOWN", profiles: [], evidence: [] },
    evidence: [],
    ...overrides,
  };
}

function deal(partial: Partial<OrganisationDealNode> & Pick<OrganisationDealNode, "recordId">): OrganisationDealNode {
  return {
    name: "Portal Genie",
    product: "PORTAL_GENIE",
    closedLost: false,
    closedWon: false,
    provenance: "test",
    ...partial,
  };
}

function diagnostic(record: Record<string, unknown>, extras: Partial<DiscoveryDiagnostic> = {}): DiscoveryDiagnostic {
  return {
    generatedAt: "2026-08-27T10:00:00Z",
    connector: { name: "zoho-discovery", mode: "read-only", apiVersion: "v8", apiDomain: "https://www.zohoapis.com", accountsUrl: "https://accounts.zoho.com", documentation: {}, scopesExpected: [] },
    request: { fetchEmailBodies: 0, maxRelatedRecords: 10 },
    primaryRecord: {
      module: "Contacts",
      id: typeof record.id === "string" ? record.id : "c-alice",
      retrieved: true,
      tags: null,
      lookupFollowUps: [],
      record,
    },
    fieldCatalog: { module: "Contacts", retrieved: true, totalFields: 0, customFields: [], standardFields: [] },
    moduleTags: { retrieved: false, tags: [] },
    relatedLists: { catalogRetrieved: true, available: [], retrievals: extras.relatedLists?.retrievals ?? [] },
    emails: {
      listAttempted: true,
      success: true,
      count: 1,
      moreRecords: false,
      headers: [],
      bodies: [],
      normalized: extras.emails?.normalized ?? [
        {
          messageId: "sel-1",
          threadId: null,
          at: "2026-06-01T16:00:00Z",
          direction: "inbound",
          directionEvidence: "sent flag",
          sender: { name: "Alice", email: "alice@firm.test" },
          recipients: [],
          cc: [],
          subject: "Meeting",
          bodyText: "Thank you for meeting today.",
          currentMessageText: "Thank you for meeting today.",
          quoteStrippingConfidence: "HIGH",
          strippedQuotedHistory: false,
          bodyTruncated: false,
          sourceType: "crm_email",
          hasAttachment: false,
        },
      ],
      interactionFacts: {
        outboundCount: 1,
        inboundCount: 1,
        unknownDirectionCount: 0,
        lastAt: "2026-06-01T16:00:00Z",
        lastDirection: "inbound",
        inboundAfterOutbound: false,
        consecutiveOutboundWithoutLaterInbound: 0,
      },
      note: "",
      typesAttempted: [],
      calls: [],
      ...extras.emails,
    },
    salesContextSummary: {
      hasPrimaryRecord: true,
      hasNotes: false,
      hasDeals: false,
      hasEmailHeaders: true,
      hasEmailBodies: true,
      hasOpenActivities: false,
      hasClosedActivities: false,
      hasAccount: true,
      hasTags: false,
      customFieldCount: 0,
      salesRelevantCustomFields: [],
      likelyUsefulForIntelligence: [],
      unavailableCapabilities: [],
    },
    warnings: [],
    errors: [],
    ...extras,
  } as unknown as DiscoveryDiagnostic;
}

function orgFixtureClient(options: { extraContacts?: number } = {}): { client: ZohoCrmReader; calls: string[] } {
  const calls: string[] = [];
  const extras = Array.from({ length: options.extraContacts ?? 0 }, (_, index) => ({
    id: `c-extra-${index}`,
    Full_Name: `Extra ${index}`,
    Email: `extra${index}@firm.test`,
    Account_Name: { id: "a1", name: "Firm Accounting" },
  }));
  const alice = {
    id: "c-alice",
    Full_Name: "Alice Selected",
    Email: "alice@firm.test",
    Title: "Director",
    Account_Name: { id: "a1", name: "Firm Accounting" },
  };
  const bob = {
    id: "c-bob",
    Full_Name: "Bob Historic",
    Email: "bob@firm.test",
    Title: "Manager",
    Account_Name: { id: "a2", name: "Firm Services" },
  };
  const gmail = {
    id: "c-gmail",
    Full_Name: "Sam Public",
    Email: "sam@gmail.com",
    Account_Name: { id: "a9", name: "Unrelated Ltd" },
  };
  const currentDeal = {
    id: "d-current",
    Deal_Name: "Portal Genie Partner",
    Stage: "Proposal",
    Pipeline: "Standard",
    Amount: "12000",
    Closing_Date: "2026-09-01",
    Contact_Name: { id: "c-alice", name: "Alice Selected" },
    Account_Name: { id: "a1", name: "Firm Accounting" },
    Owner: { name: "Geoff" },
  };
  const lostDeal = {
    id: "d-lost",
    Deal_Name: "Portal Genie",
    Stage: "Closed Lost",
    Pipeline: "Standard",
    Amount: "4800",
    Closing_Date: "2025-03-01",
    Contact_Name: { id: "c-bob", name: "Bob Historic" },
    Account_Name: { id: "a2", name: "Firm Services" },
  };
  const client: ZohoCrmReader = {
    async getRecord(module, id) {
      calls.push(`getRecord:${module}:${id}`);
      if (module === "Contacts" && id === "c-alice") return ok({ data: [alice] });
      if (module === "Contacts" && id === "c-bob") return ok({ data: [bob] });
      if (module === "Accounts" && id === "a1") return ok({ data: [{ id: "a1", Account_Name: "Firm Accounting", Website: "https://firm.test" }] });
      if (module === "Accounts" && id === "a2") return ok({ data: [{ id: "a2", Account_Name: "Firm Services" }] });
      return emptyResult();
    },
    async searchByEmail() {
      calls.push("searchByEmail");
      return emptyResult();
    },
    async getFields() {
      return emptyResult();
    },
    async getRelatedLists() {
      return emptyResult();
    },
    async getRelatedRecords(module, id, related) {
      calls.push(`getRelatedRecords:${module}:${id}:${related}`);
      if (related === "Contacts" && id === "a1") return ok({ data: [alice, ...extras] });
      if (related === "Contacts" && id === "a2") return ok({ data: [bob] });
      if (related === "Deals" && (id === "a1" || id === "c-alice")) return ok({ data: [currentDeal] });
      if (related === "Deals" && (id === "a2" || id === "c-bob")) return ok({ data: [lostDeal] });
      if (related === "Notes" && id === "c-alice") {
        return ok({ data: [{ id: "n-alice", Note_Title: "Call", Note_Content: "Thank you for meeting today.", Created_Time: "2026-06-01T12:00:00Z" }] });
      }
      if (related === "Notes" && id === "c-bob") {
        return ok({ data: [{ id: "n-bob", Note_Title: "Meeting", Note_Content: "Met with Geoff and Alice.", Created_Time: "2026-06-01T12:30:00Z" }] });
      }
      return emptyResult();
    },
    async getEmails(module, id) {
      calls.push(`getEmails:${module}:${id}`);
      if (id === "c-bob") {
        return ok({
          Emails: [
            {
              message_id: "bob-in",
              subject: "Management review",
              time: "2026-05-20T10:00:00Z",
              sent: false,
              from: { email: "bob@firm.test", user_name: "Bob Historic" },
              content: "I will take Portal Genie to management for review.",
            },
          ],
        });
      }
      return emptyResult();
    },
    async getEmail(_module, _id, messageId) {
      calls.push(`getEmail:${messageId}`);
      return ok({
        Emails: [
          {
            message_id: messageId,
            subject: "Management review",
            time: "2026-05-20T10:00:00Z",
            sent: false,
            from: { email: "bob@firm.test", user_name: "Bob Historic" },
            content: "I will take Portal Genie to management for review.",
          },
        ],
      });
    },
    async getTags() {
      return emptyResult();
    },
    async searchByWord(module, word) {
      calls.push(`searchByWord:${module}:${word}`);
      if (module === "Contacts" && /firm\.test/i.test(word)) return ok({ data: [alice, bob, gmail] });
      if (module === "Accounts" && /firm accounting/i.test(word)) {
        return ok({ data: [{ id: "a-similar", Account_Name: "Firm Accountng" }] });
      }
      return emptyResult();
    },
    async getOrg() {
      return emptyResult();
    },
  };
  return { client, calls };
}

test("OpenAI instructions cover organisation-wide reasoning", () => {
  assert.match(SYSTEM_PROMPT, /selected Contact is the operator's entry point/i);
  assert.match(SYSTEM_PROMPT, /Do not invent relationships between records/i);
  assert.match(SYSTEM_PROMPT, /historical Closed Lost Deal does not mean the organisation is lost/i);
  assert.match(SYSTEM_PROMPT, /OPERATOR-ENTERED SALES EVENTS/i);
  assert.match(SYSTEM_PROMPT, /two unanswered outbound call attempts/i);
});

test("selected Contact is retained and association reasons are preserved", () => {
  const selected: OrgCandidate = { module: "Contacts", recordId: "c-alice", name: "Alice", email: "alice@firm.test", accountId: "a1" };
  const sameAccount: OrgCandidate = { module: "Contacts", recordId: "c-pat", name: "Pat", accountId: "a1" };
  const sameDomain: OrgCandidate = { module: "Contacts", recordId: "c-bob", name: "Bob", email: "bob@firm.test", accountId: "a2" };
  const resolved = resolveOrganisation(selected, [sameAccount, sameDomain], PUBLIC);
  const selectedMember = resolved.members.find((item) => item.selected);
  const accountMember = resolved.members.find((item) => item.recordId === "c-pat");
  const domainMember = resolved.members.find((item) => item.recordId === "c-bob");
  assert.equal(selectedMember?.recordId, "c-alice");
  assert.ok(selectedMember?.reasons.includes("SELECTED_CONTACT"));
  assert.ok(accountMember?.reasons.includes("SAME_ZOHO_ACCOUNT"));
  assert.equal(accountMember?.certainty, "associated");
  assert.ok(domainMember?.reasons.includes("SAME_BUSINESS_DOMAIN"));
  assert.equal(domainMember?.certainty, "associated");
});

test("public email domain does not join Contacts", () => {
  const selected: OrgCandidate = { module: "Contacts", recordId: "1", name: "Alice", email: "alice@firm.test" };
  const gmail: OrgCandidate = { module: "Contacts", recordId: "2", name: "Sam", email: "sam@gmail.com", company: "Firm Accounting" };
  const result = classifyOrgAssociation(selected, gmail, PUBLIC);
  assert.ok(!result?.reasons.includes("SAME_BUSINESS_DOMAIN"));
  assert.notEqual(result?.certainty, "associated");
});

test("same domain and different Account identifies possible fragmentation without merging", () => {
  const contacts = [
    contactNodeFromMember({
      module: "Contacts",
      recordId: "c-alice",
      name: "Alice",
      email: "alice@firm.test",
      accountId: "a1",
      selected: true,
      genericMailbox: false,
      reasons: ["SELECTED_CONTACT", "SAME_BUSINESS_DOMAIN"],
      certainty: "associated",
    }),
    contactNodeFromMember({
      module: "Contacts",
      recordId: "c-bob",
      name: "Bob",
      email: "bob@firm.test",
      accountId: "a2",
      selected: false,
      genericMailbox: false,
      reasons: ["SAME_BUSINESS_DOMAIN"],
      certainty: "associated",
    }),
  ];
  const accounts: OrganisationAccountNode[] = [
    { recordId: "a1", name: "Firm Accounting", association_reasons: ["SELECTED_CONTACT_ACCOUNT"], certainty: "associated" },
    { recordId: "a2", name: "Firm Services", association_reasons: ["CONTACT_ACCOUNT", "SAME_BUSINESS_DOMAIN"], certainty: "associated" },
  ];
  const fragmentation = detectFragmentation(accounts, ["firm.test"]);
  assert.equal(fragmentation?.possible_crm_fragmentation, true);
  assert.equal(fragmentation?.label, "POSSIBLY RELATED ACCOUNT RECORDS — REVIEW");
  assert.ok(fragmentation?.account_names.includes("Firm Accounting"));
  const graph = assembleOrganisationGraph({
    selectedContactId: "c-alice",
    selectedContactName: "Alice",
    organisationName: "Firm",
    domains: ["firm.test"],
    certainty: "resolved",
    contacts,
    accounts,
    deals: [
      deal({ recordId: "d-lost", stage: "Closed Lost", closedLost: true, associatedContactId: "c-bob", associatedAccountId: "a2" }),
      deal({ recordId: "d-now", name: "Portal Genie Partner", stage: "Proposal", associatedContactId: "c-alice", associatedAccountId: "a1" }),
    ],
    notes: [],
    emails: [],
  });
  assert.equal(graph.zohoRecordsMerged, false);
  assert.equal(graph.deals.length, 2);
  assert.ok(graph.dataQualitySignals.some((item) => item.code === "POSSIBLE_ACCOUNT_FRAGMENTATION"));
  assert.ok(graph.dataQualitySignals.some((item) => item.code === "MULTIPLE_ACCOUNTS_SAME_DOMAIN"));
  assert.ok(graph.dataQualitySignals.some((item) => item.code === "HISTORICAL_AND_CURRENT_OPPORTUNITIES"));
  assert.notEqual(graph.productOpportunities[0]?.deal_id, graph.productOpportunities[1]?.deal_id);
});

test("similar Account name alone does not auto-join the organisation graph", async () => {
  const selected: OrgCandidate = {
    module: "Contacts",
    recordId: "c-alice",
    name: "Alice Selected",
    email: "alice@firm.test",
    company: "Firm Accounting",
    accountId: "a1",
  };
  const similar: OrgCandidate = { module: "Accounts", recordId: "a-similar", name: "Firm Accountng", company: "Firm Accountng" };
  const classified = classifyOrgAssociation(selected, similar, PUBLIC);
  assert.equal(classified?.certainty, "possible");
  const resolution = resolveOrganisation(selected, [similar], PUBLIC);
  const { client } = orgFixtureClient();
  const graph = await expandOrganisationGraph({
    client,
    selected,
    resolution,
    selectedDiagnostic: diagnostic({
      id: "c-alice",
      Full_Name: "Alice Selected",
      Email: "alice@firm.test",
      Account_Name: { id: "a1", name: "Firm Accounting" },
    }),
    publicDomains: PUBLIC,
    limits: DEFAULT_ORG_EXPANSION_LIMITS,
    cacheStats: { hits: 0, misses: 0 },
  });
  assert.ok(!graph.accounts.some((item) => item.recordId === "a-similar"));
  assert.ok(graph.possibleAccounts.some((item) => item.recordId === "a-similar"));
  assert.equal(graph.zohoRecordsMerged, false);
});

test("organisation emails retain Contact attribution and Notes retain provenance", () => {
  const emails = [
    attributedEmail({ ownerRecordId: "c-alice", ownerName: "Alice Selected", direction: "outbound", currentMessageText: "Following up" }),
    attributedEmail({ ownerRecordId: "c-bob", ownerName: "Bob Historic", direction: "inbound", currentMessageText: "I will take this to management for review." }),
  ];
  const metrics = orgEmailMetrics(emails);
  assert.equal(metrics.by_contact.find((item) => item.contact_id === "c-bob")?.inbound, 1);
  assert.equal(metrics.by_contact.find((item) => item.contact_id === "c-alice")?.outbound, 1);
  const digest = buildCommercialEvidenceDigest({
    contact: emptyContact(),
    organisation: emptyOrg({
      notes: [{ id: "n-bob", content: "Met with Geoff and Alice. Too expensive last year.", at: "2026-06-01T12:00:00Z", source: "note" }],
    }),
    emails: emails.map((email) => ({
      at: email.at,
      direction: email.direction,
      subject: email.subject,
      currentMessageText: email.currentMessageText,
      ownerName: email.ownerName,
      ownerRecordId: email.ownerRecordId,
    })),
    evidence: [evidence({ type: "unknown", claim: "USAGE UNKNOWN", source: "usage" })],
    reconstruction: {
      interactions: [],
      timeline: [],
      relationshipProgression: "depth",
      confirmedCrmActivity: "emails",
      inferredRealWorldActivity: "none",
    },
    products: [
      { product: "PORTAL_GENIE", relationship_state: "PARTNER_PROSPECT", evidence_ids: [], summary: "pg", confidence: "MEDIUM" },
      { product: "NAGGING_PANDA", relationship_state: "UNKNOWN", evidence_ids: [], summary: "unknown", confidence: "LOW" },
    ],
    organisationRelationship: { characterisation: "CRM relationship", summary: "Independent", evidence_ids: [] },
    contradictions: ["Historical Closed Lost coexists with a current Partner Deal."],
    graph: assembleOrganisationGraph({
      selectedContactId: "c-alice",
      selectedContactName: "Alice Selected",
      organisationName: "Firm",
      domains: ["firm.test"],
      certainty: "resolved",
      contacts: [
        contactNodeFromMember({
          module: "Contacts",
          recordId: "c-alice",
          name: "Alice Selected",
          email: "alice@firm.test",
          selected: true,
          genericMailbox: false,
          reasons: ["SELECTED_CONTACT"],
          certainty: "associated",
        }),
        contactNodeFromMember({
          module: "Contacts",
          recordId: "c-bob",
          name: "Bob Historic",
          email: "bob@firm.test",
          selected: false,
          genericMailbox: false,
          reasons: ["SAME_BUSINESS_DOMAIN"],
          certainty: "associated",
        }),
      ],
      accounts: [
        { recordId: "a1", name: "Firm Accounting", association_reasons: ["SELECTED_CONTACT_ACCOUNT"], certainty: "associated" },
        { recordId: "a2", name: "Firm Services", association_reasons: ["CONTACT_ACCOUNT"], certainty: "associated" },
      ],
      deals: [
        deal({ recordId: "d-lost", stage: "Closed Lost", closedLost: true, associatedContactId: "c-bob", associatedContactName: "Bob Historic" }),
        deal({ recordId: "d-now", name: "Portal Genie Partner", stage: "Proposal", associatedContactId: "c-alice", associatedContactName: "Alice Selected" }),
      ],
      notes: [{ id: "n-bob", content: "Met with Geoff and Alice. Too expensive last year.", at: "2026-06-01T12:00:00Z", ownerModule: "Contacts", ownerRecordId: "c-bob", ownerName: "Bob Historic" }],
      emails,
    }),
  });
  assert.ok(digest.selected_emails.some((item) => item.contact_name === "Bob Historic") || digest.email_metrics.by_contact?.some((item) => item.name === "Bob Historic"));
  assert.ok(digest.selected_notes.some((item) => item.owner_name === "Bob Historic" && item.owner_record_id === "c-bob"));
  assert.equal(digest.selected_contact.record_id, "c-alice");
  assert.equal(digest.organisation_resolution.zoho_records_merged, false);
  assert.ok(digest.contradictions.some((item) => /Closed Lost/i.test(item)));
  assert.equal(digest.historical_losses.length, 1);
  assert.equal(digest.current_opportunities.length, 1);
  assert.notEqual(digest.historical_losses[0]?.deal_id, digest.current_opportunities[0]?.deal_id);
});

test("same real-world event referenced by two Contacts consolidates conservatively", () => {
  resetEvidenceIds();
  resetInteractionIds();
  const reconstructed = reconstructFromSources({
    notes: [
      { id: "n-bob", content: "Met with Geoff and Alice.", at: "2026-06-01T12:00:00Z", ownerName: "Bob Historic", ownerRecordId: "c-bob" },
    ],
    emails: [
      { direction: "inbound", at: "2026-06-01T16:00:00Z", currentMessageText: "Thank you for meeting today.", ownerName: "Alice Selected", ownerRecordId: "c-alice" },
    ],
    organisation: "Firm Accounting",
    zohoCalls: 0,
    zohoMeetings: 0,
    emailOutbound: 0,
    emailInbound: 1,
    crmEvents: [],
  });
  const meetings = reconstructed.interactions.filter((item) => item.interaction_type === "MEETING");
  assert.equal(meetings.length, 1);
  assert.ok((meetings[0]?.supporting_evidence_count ?? 0) >= 2);
  assert.ok(meetings[0]?.participants.includes("Alice Selected"));
  assert.ok(meetings[0]?.participants.includes("Bob Historic"));
});

test("separate events remain separate", () => {
  resetEvidenceIds();
  resetInteractionIds();
  const reconstructed = reconstructFromSources({
    notes: [
      { id: "n1", content: "Met with Geoff to discuss onboarding.", at: "2026-01-10T12:00:00Z", ownerName: "Alice" },
      { id: "n2", content: "Met with Geoff to discuss pricing for the annual software agreement.", at: "2026-04-20T12:00:00Z", ownerName: "Bob" },
    ],
    emails: [],
    organisation: "Firm Accounting",
    zohoCalls: 0,
    zohoMeetings: 0,
    emailOutbound: 0,
    emailInbound: 0,
    crmEvents: [],
  });
  assert.equal(reconstructed.interactions.filter((item) => item.interaction_type === "MEETING").length, 2);
});

test("Portal Genie is organisation-level, Nagging Panda stays independent, UNKNOWN remains UNKNOWN", () => {
  const deals = dealSignalsFromGraphDeals([
    deal({ recordId: "d-now", name: "Portal Genie Partner", stage: "Proposal" }),
    deal({ recordId: "d-lost", name: "Portal Genie", stage: "Closed Lost", closedLost: true }),
  ]);
  const bundle = buildProductRelationships({
    organisation: emptyOrg({ deals }),
    deals,
    emails: [{ subject: "Partner programme", currentMessageText: "Portal Genie firm partner discussion" }],
    evidence: [],
  });
  const pg = bundle.products.find((item) => item.product === "PORTAL_GENIE");
  const np = bundle.products.find((item) => item.product === "NAGGING_PANDA");
  assert.equal(pg?.relationship_state, "PARTNER_PROSPECT");
  assert.equal(np?.relationship_state, "UNKNOWN");
  assert.notEqual(pg?.relationship_state, np?.relationship_state);
  assert.equal(classifyDealProduct("Nagging Panda annual", "NP"), "NAGGING_PANDA");
  const withPanda = buildProductRelationships({
    organisation: emptyOrg({
      deals: dealSignalsFromGraphDeals([
        deal({ recordId: "d-now", name: "Portal Genie Partner", stage: "Proposal" }),
        deal({ recordId: "d-np", name: "Nagging Panda", stage: "Closed Won", product: "NAGGING_PANDA", closedWon: true }),
      ]),
    }),
    deals: dealSignalsFromGraphDeals([
      deal({ recordId: "d-now", name: "Portal Genie Partner", stage: "Proposal" }),
      deal({ recordId: "d-np", name: "Nagging Panda", stage: "Closed Won", product: "NAGGING_PANDA", closedWon: true }),
    ]),
    emails: [],
    evidence: [],
  });
  assert.equal(withPanda.products.find((item) => item.product === "PORTAL_GENIE")?.relationship_state, "PARTNER_PROSPECT");
  assert.equal(withPanda.products.find((item) => item.product === "NAGGING_PANDA")?.relationship_state, "PAYING_CUSTOMER");
  const overlay = applyOrganisationDealProducts(
    [
      { product: "PORTAL_GENIE", relationship_state: "PARTNER_PROSPECT", evidence_ids: [], summary: "pg", confidence: "MEDIUM" },
      { product: "NAGGING_PANDA", relationship_state: "UNKNOWN", evidence_ids: [], summary: "unknown", confidence: "LOW" },
    ],
    [
      deal({ recordId: "d-now", name: "Firm Partner Deal", stage: "Firm Partner Deal - New" }),
      deal({
        recordId: "d-lost",
        name: "Practice deal",
        stage: "Closed Lost",
        product: "NAGGING_PANDA",
        closedLost: true,
        associatedContactName: "Bob Historic",
      }),
    ],
  );
  assert.equal(overlay.find((item) => item.product === "PORTAL_GENIE")?.relationship_state, "PARTNER_PROSPECT");
  assert.equal(overlay.find((item) => item.product === "NAGGING_PANDA")?.relationship_state, "FORMER_CUSTOMER");
});

test("organisation digest respects budget and keeps contradictions, fragmentation, and opportunities", () => {
  const graph = assembleOrganisationGraph({
    selectedContactId: "c-alice",
    selectedContactName: "Alice Selected",
    organisationName: "Firm",
    domains: ["firm.test"],
    certainty: "resolved",
    contacts: [
      contactNodeFromMember({
        module: "Contacts",
        recordId: "c-alice",
        name: "Alice Selected",
        selected: true,
        genericMailbox: false,
        reasons: ["SELECTED_CONTACT"],
        certainty: "associated",
      }),
    ],
    accounts: [
      { recordId: "a1", name: "Firm Accounting", association_reasons: ["SELECTED_CONTACT_ACCOUNT"], certainty: "associated" },
      { recordId: "a2", name: "Firm Services", association_reasons: ["CONTACT_ACCOUNT"], certainty: "associated" },
    ],
    deals: [
      deal({ recordId: "d-lost", stage: "Closed Lost", closedLost: true }),
      deal({ recordId: "d-now", name: "Portal Genie Partner", stage: "Proposal" }),
    ],
    notes: Array.from({ length: 8 }, (_, index) => ({
      id: `n-${index}`,
      content: `Called James about the partner programme pricing follow-up ${index}`,
      at: "2026-05-01T00:00:00Z",
      ownerModule: "Contacts" as const,
      ownerRecordId: "c-alice",
      ownerName: "Alice Selected",
    })),
    emails: Array.from({ length: 8 }, (_, index) =>
      attributedEmail({
        messageId: `m-${index}`,
        ownerRecordId: "c-alice",
        ownerName: "Alice Selected",
        direction: index === 0 ? "inbound" : "outbound",
        subject: "Management review",
        currentMessageText: "I will take this to management for review of the partner programme.",
      }),
    ),
  });
  const digest = buildCommercialEvidenceDigest({
    contact: emptyContact(),
    organisation: emptyOrg(),
    emails: [],
    evidence: [evidence({ type: "unknown", claim: "USAGE UNKNOWN", source: "usage" })],
    reconstruction: {
      interactions: [],
      timeline: [],
      relationshipProgression: "progressed",
      confirmedCrmActivity: "emails",
      inferredRealWorldActivity: "meetings inferred",
    },
    products: [
      { product: "PORTAL_GENIE", relationship_state: "PARTNER_PROSPECT", evidence_ids: [], summary: "pg", confidence: "MEDIUM" },
      { product: "NAGGING_PANDA", relationship_state: "UNKNOWN", evidence_ids: [], summary: "unknown", confidence: "LOW" },
    ],
    organisationRelationship: { characterisation: "CRM", summary: "Independent", evidence_ids: [] },
    contradictions: ["Historical Closed Lost coexists with a current Partner Deal."],
    budget: { maxChars: 4200 },
    graph,
  });
  assert.ok(digest.budget.used_chars <= 4200 || digest.omitted_due_to_budget.length > 0);
  assert.ok(digest.contradictions.length > 0);
  assert.equal(digest.possible_crm_fragmentation && "possible_crm_fragmentation" in digest.possible_crm_fragmentation
    ? digest.possible_crm_fragmentation.possible_crm_fragmentation
    : false, true);
  assert.ok(digest.historical_losses.length >= 1);
  assert.ok(digest.current_opportunities.length >= 1);
  assert.equal(digest.selected_contact.name, "Alice");
});

test("API expansion limits are enforced and recorded", async () => {
  const selected: OrgCandidate = {
    module: "Contacts",
    recordId: "c-alice",
    name: "Alice Selected",
    email: "alice@firm.test",
    company: "Firm Accounting",
    accountId: "a1",
  };
  const extras: OrgCandidate[] = Array.from({ length: 4 }, (_, index) => ({
    module: "Contacts" as const,
    recordId: `c-extra-${index}`,
    name: `Extra ${index}`,
    email: `extra${index}@firm.test`,
    accountId: "a1",
  }));
  const resolution = resolveOrganisation(selected, extras, PUBLIC);
  const { client } = orgFixtureClient({ extraContacts: 4 });
  const graph = await expandOrganisationGraph({
    client,
    selected,
    resolution,
    selectedDiagnostic: diagnostic({
      id: "c-alice",
      Full_Name: "Alice Selected",
      Email: "alice@firm.test",
      Account_Name: { id: "a1", name: "Firm Accounting" },
    }),
    publicDomains: PUBLIC,
    limits: { ...DEFAULT_ORG_EXPANSION_LIMITS, maxContacts: 2, maxAccounts: 1, maxDeals: 1 },
    cacheStats: { hits: 0, misses: 0 },
  });
  assert.ok(graph.contacts.length <= 2);
  assert.ok(graph.contacts.some((item) => item.selected && item.recordId === "c-alice"));
  assert.ok(graph.accounts.length <= 1);
  assert.ok(graph.deals.length <= 1);
  assert.ok(graph.omissions.some((item) => item.kind === "contacts" || item.kind === "accounts" || item.kind === "deals"));
});

test("request-level cache prevents duplicate retrieval in one analysis", async () => {
  let getRecordCalls = 0;
  const inner: ZohoCrmReader = {
    async getRecord() {
      getRecordCalls += 1;
      return ok({ data: [{ id: "1", Full_Name: "Alice" }] });
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
  };
  const wrapped = createRequestCachedClient(inner);
  await wrapped.client.getRecord("Contacts", "1");
  await wrapped.client.getRecord("Contacts", "1");
  await wrapped.client.getRecord("Contacts", "2");
  assert.equal(getRecordCalls, 2);
  assert.equal(wrapped.stats.hits, 1);
  assert.equal(wrapped.stats.misses, 2);
  let relatedCalls = 0;
  const relatedInner: ZohoCrmReader = {
    ...inner,
    async getRelatedRecords() {
      relatedCalls += 1;
      return ok({ data: [] });
    },
  };
  const relatedWrapped = createRequestCachedClient(relatedInner);
  await relatedWrapped.client.getRelatedRecords("Accounts", "a1", "Contacts", ["Full_Name"], 8);
  await relatedWrapped.client.getRelatedRecords("Accounts", "a1", "Contacts", ["Full_Name", "Email"], 50);
  assert.equal(relatedCalls, 1);
  assert.equal(relatedWrapped.stats.hits, 1);
});

test("mocked OpenAI reasons over organisation evidence without live calls", async () => {
  const { client } = orgFixtureClient();
  let captured: CommercialEvidenceDigest | undefined;
  const result = await analyseRelationship({
    module: "Contacts",
    recordId: "c-alice",
    diagnostic: diagnostic({
      id: "c-alice",
      Full_Name: "Alice Selected",
      Email: "alice@firm.test",
      Title: "Director",
      Account_Name: { id: "a1", name: "Firm Accounting" },
    }),
    client,
    model: "mock",
    publicDomains: PUBLIC,
    reasoner: {
      async reason(context) {
        captured = context;
        return {
          profile: validSampleProfile({
            best_contact: "Bob Historic",
            reason_for_best_contact: "Most recent engaged decision-maker on the historical opportunity",
            relationship_summary: "Organisation has a current Partner Deal and a historical Closed Lost Portal Genie Deal.",
            recommended_action: "PHONE_CALL",
            decision_state: "ACT_NOW",
          }),
          model: "mock",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          latencyMs: 1,
          rawText: "{}",
        };
      },
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.organisationGraph?.selectedContactName, "Alice Selected");
  assert.equal(result.organisationGraph?.zohoRecordsMerged, false);
  assert.ok(result.organisationGraph?.contacts.some((item) => item.recordId === "c-alice" && item.selected));
  assert.ok(result.organisationGraph?.contacts.some((item) => item.recordId === "c-bob" && item.association_reasons.includes("SAME_BUSINESS_DOMAIN")));
  assert.ok(result.organisationGraph?.accounts.some((item) => item.recordId === "a1"));
  assert.ok(result.organisationGraph?.accounts.some((item) => item.recordId === "a2"));
  assert.ok(!result.organisationGraph?.accounts.some((item) => item.recordId === "a-similar"));
  assert.ok(result.organisationGraph?.deals.some((item) => item.recordId === "d-lost" && item.closedLost));
  assert.ok(result.organisationGraph?.deals.some((item) => item.recordId === "d-current" && !item.closedLost));
  assert.equal(result.organisationGraph?.deals.filter((item) => item.recordId === "d-lost" || item.recordId === "d-current").length, 2);
  assert.ok(result.organisationGraph?.emails.some((item) => item.ownerRecordId === "c-bob"));
  assert.ok(result.organisationGraph?.notes.some((item) => item.ownerRecordId === "c-bob" && item.id === "n-bob"));
  assert.equal(result.organisationGraph?.fragmentation?.possible_crm_fragmentation, true);
  assert.ok(result.organisationGraph?.dataQualitySignals.some((item) => item.code === "POSSIBLE_ACCOUNT_FRAGMENTATION"));
  assert.equal(result.profile?.best_contact, "Bob Historic");
  assert.notEqual(result.profile?.best_contact, result.organisationGraph?.selectedContactName);
  assert.equal(captured?.selected_contact.name, "Alice Selected");
  assert.ok((captured?.related_contacts.length ?? 0) >= 2);
  assert.ok((captured?.historical_losses.length ?? 0) >= 1);
  assert.ok((captured?.current_opportunities.length ?? 0) >= 1);
  assert.equal(captured?.organisation_resolution.zoho_records_merged, false);
  assert.ok(Array.isArray(captured?.operator_sales_events));
  assert.equal(typeof captured?.email_metrics.selected_contact_unanswered_sequence, "boolean");
  assert.equal(typeof captured?.email_metrics.organisation_unanswered_sequences, "number");
  assert.equal(typeof captured?.email_metrics.selected_contact_trailing_outbound_streak, "number");
  assert.ok(result.organisationGraph?.salesEvents);
  const pg = result.productRelationships?.find((item) => item.product === "PORTAL_GENIE");
  const np = result.productRelationships?.find((item) => item.product === "NAGGING_PANDA");
  assert.equal(pg?.relationship_state, "PARTNER_PROSPECT");
  assert.equal(np?.relationship_state, "UNKNOWN");
  const meetings = (result.interactions ?? []).filter((item) => item.interaction_type === "MEETING");
  assert.ok(meetings.length <= 1);
  assert.ok((result.organisationGraph?.cache.misses ?? 0) >= 1);
});

test("expansion limit configuration reads environment", () => {
  const limits = loadOrgExpansionLimits({
    ORG_MAX_CONTACTS: "3",
    ORG_MAX_ACCOUNTS: "2",
    ORG_MAX_DEALS: "4",
  });
  assert.equal(limits.maxContacts, 3);
  assert.equal(limits.maxAccounts, 2);
  assert.equal(limits.maxDeals, 4);
});

test("data-quality signals include deal/account mismatch", () => {
  const signals = buildDataQualitySignals({
    contacts: [
      contactNodeFromMember({
        module: "Contacts",
        recordId: "c1",
        name: "Alice",
        accountId: "a1",
        selected: true,
        genericMailbox: false,
        reasons: ["SELECTED_CONTACT"],
        certainty: "associated",
      }),
    ],
    accounts: [{ recordId: "a1", name: "A", association_reasons: ["SELECTED_CONTACT_ACCOUNT"], certainty: "associated" }],
    deals: [deal({ recordId: "d1", associatedContactId: "c1", associatedAccountId: "a2" })],
    domains: ["firm.test"],
    fragmentation: null,
  });
  assert.ok(signals.some((item) => item.code === "DEAL_ASSOCIATED_WITH_DIFFERENT_ACCOUNT"));
  assert.ok(signals.some((item) => item.code === "CONTACT_WITHOUT_ACCOUNT") === false);
});
