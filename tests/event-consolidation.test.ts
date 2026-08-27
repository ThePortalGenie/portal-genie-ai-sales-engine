import assert from "node:assert/strict";
import test from "node:test";
import { evidence, resetEvidenceIds } from "../src/domain/evidence.js";
import { canConsolidate, consolidateInteractions } from "../src/intelligence/event-consolidation.js";
import {
  buildCommercialEvidenceDigest,
  loadReasoningContextBudget,
  selectCommercialEmails,
  selectCommercialNotes,
} from "../src/intelligence/evidence-digest.js";
import { extractFromEmail, extractFromNote, reconstructFromSources, resetInteractionIds } from "../src/intelligence/interaction-extraction.js";
import { createUnimplementedPipelineStructureAdvisor } from "../src/intelligence/pipeline-structure-advisor.js";
import { buildProductRelationships, detectProductContradictions } from "../src/intelligence/product-relationships.js";
import type { RealWorldInteraction } from "../src/domain/real-world-interaction.js";
import type { ContactIntelligence } from "../src/intelligence/contact-intelligence.js";
import type { OrganisationEvidenceProfile } from "../src/intelligence/org-intelligence.js";

function baseInteraction(overrides: Partial<RealWorldInteraction>): RealWorldInteraction {
  return {
    id: "rw-x",
    interaction_type: "PHONE_CALL",
    participants: [],
    direction: "OUTBOUND",
    source_evidence_ids: ["ev-1"],
    source_types: ["INFERRED_FROM_EMAIL", "ZOHO_EMAIL"],
    summary: "Thank you for taking my call.",
    commercial_signals: [],
    confidence: "HIGH",
    provenance: "Inferred from email wording. not a Zoho Call record.",
    supporting_evidence_count: 1,
    corroboration: "single",
    ...overrides,
  };
}

function emptyOrg(overrides: Partial<OrganisationEvidenceProfile> = {}): OrganisationEvidenceProfile {
  return {
    identity: { domains: ["abc.co.uk"], certainty: "resolved", name: "ABC Accounting" },
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

function emptyContact(overrides: Partial<ContactIntelligence> = {}): ContactIntelligence {
  return {
    identity: { name: "Jane", module: "Contacts", recordId: "1", organisation: "ABC Accounting" },
    importantFields: [],
    notes: [],
    deals: { count: 0, stages: [], names: [], closedWon: 0, closedLost: 0, values: [] },
    emails: {
      outboundCount: 0,
      inboundCount: 0,
      unknownDirectionCount: 0,
      lastAt: null,
      lastDirection: null,
      inboundAfterOutbound: false,
      consecutiveOutboundWithoutLaterInbound: 0,
    },
    emailSubjects: [],
    tasks: 0,
    calls: 0,
    meetings: 0,
    evidence: [],
    ...overrides,
  };
}

test("repeated roadshow references become one event", () => {
  resetEvidenceIds();
  resetInteractionIds();
  const reconstructed = reconstructFromSources({
    notes: [],
    emails: [
      { direction: "outbound", at: "2026-04-17T09:00:00Z", currentMessageText: "It was great speaking with you at the Xero Roadshow in Johannesburg." },
      { direction: "outbound", at: "2026-04-22T13:00:00Z", currentMessageText: "It was great connecting at the Xero Roadshow last week." },
      { direction: "outbound", at: "2026-05-04T11:00:00Z", currentMessageText: "It was great meeting you at the Xero Roadshow!" },
      { direction: "outbound", at: "2026-05-13T15:00:00Z", currentMessageText: "We met at the Xero Roadshow a few weeks ago, and I’d love to set up a quick online meeting with you." },
    ],
    organisation: "FJM Accounting",
    zohoCalls: 0,
    zohoMeetings: 0,
    emailOutbound: 4,
    emailInbound: 0,
    crmEvents: [],
  });
  const roadshows = reconstructed.interactions.filter((item) => item.interaction_type === "ROADSHOW_CONVERSATION");
  assert.equal(roadshows.length, 1);
  assert.ok((roadshows[0]?.supporting_evidence_count ?? 0) >= 3);
  assert.ok((roadshows[0]?.source_evidence_ids.length ?? 0) > 1);
});

test("roadshow meeting you does not create MEETING", () => {
  const result = extractFromEmail({
    direction: "outbound",
    currentMessageText: "It was great meeting you at the Xero Roadshow!",
  });
  assert.equal(result.interactions.length, 1);
  assert.equal(result.interactions[0]?.interaction_type, "ROADSHOW_CONVERSATION");
});

test("roadshow speaking with you does not create PHONE_CALL", () => {
  const result = extractFromEmail({
    direction: "outbound",
    currentMessageText: "It was good speaking with you at the Xero Roadshow.",
  });
  assert.equal(result.interactions.some((item) => item.interaction_type === "PHONE_CALL"), false);
  assert.equal(result.interactions.some((item) => item.interaction_type === "POSSIBLE_INTERACTION"), false);
  assert.equal(result.interactions[0]?.interaction_type, "ROADSHOW_CONVERSATION");
});

test("explicit telephone reference creates PHONE_CALL", () => {
  const result = extractFromEmail({
    direction: "outbound",
    currentMessageText: "Thank you for taking my call earlier.",
  });
  assert.equal(result.interactions[0]?.interaction_type, "PHONE_CALL");
});

test("explicit meeting creates MEETING", () => {
  const result = extractFromEmail({
    direction: "outbound",
    currentMessageText: "Thank you for meeting with me this morning.",
  });
  assert.equal(result.interactions[0]?.interaction_type, "MEETING");
});

test("marketing book-a-meeting CTA is not a meeting event", () => {
  const result = extractFromEmail({
    direction: "outbound",
    currentMessageText: "I'm happy to jump on a quick call if you need a hand: [Book a meeting]",
  });
  assert.equal(result.interactions.some((item) => item.interaction_type === "MEETING"), false);
});

test("weak demo wording does not create DEMO", () => {
  const result = extractFromEmail({
    direction: "outbound",
    currentMessageText: "Thank you for your time this morning. It was great speaking with both of you. Here is the demo link.",
  });
  assert.equal(result.interactions.some((item) => item.interaction_type === "DEMO"), false);
  assert.equal(result.interactions[0]?.interaction_type, "POSSIBLE_INTERACTION");
});

test("strong demo wording creates DEMO", () => {
  const result = extractFromEmail({
    direction: "outbound",
    currentMessageText: "Thank you for attending the demo. Following today's Portal Genie demonstration I have attached the pack.",
  });
  assert.equal(result.interactions[0]?.interaction_type, "DEMO");
});

test("independent evidence corroborates one event", () => {
  resetEvidenceIds();
  resetInteractionIds();
  const reconstructed = reconstructFromSources({
    notes: [],
    emails: [
      { direction: "outbound", at: "2026-05-20T12:00:00Z", currentMessageText: "Thank you for taking my call." },
      { direction: "outbound", at: "2026-05-21T09:00:00Z", currentMessageText: "Following our telephone conversation yesterday, here is the overview." },
    ],
    zohoCalls: 0,
    zohoMeetings: 0,
    emailOutbound: 2,
    emailInbound: 0,
    crmEvents: [],
  });
  const calls = reconstructed.interactions.filter((item) => item.interaction_type === "PHONE_CALL");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.supporting_evidence_count, 2);
  assert.equal(calls[0]?.confidence, "HIGH");
  assert.equal(calls[0]?.corroboration, "independent");
});

test("two genuine separate calls remain separate", () => {
  resetEvidenceIds();
  resetInteractionIds();
  const reconstructed = reconstructFromSources({
    notes: [
      { content: "Called James. Left a voicemail.", at: "2026-05-03T10:00:00Z" },
      { content: "Called James. He likes the concept.", at: "2026-05-20T10:00:00Z" },
    ],
    emails: [],
    zohoCalls: 0,
    zohoMeetings: 0,
    emailOutbound: 0,
    emailInbound: 0,
    crmEvents: [],
  });
  const calls = reconstructed.interactions.filter((item) => item.interaction_type === "PHONE_CALL");
  assert.equal(calls.length, 2);
});

test("ambiguous events are not aggressively merged", () => {
  const left = baseInteraction({
    id: "rw-1",
    interaction_type: "POSSIBLE_INTERACTION",
    approximate_date: "2026-04-01T10:00:00Z",
    summary: "Great speaking with you this morning.",
  });
  const right = baseInteraction({
    id: "rw-2",
    interaction_type: "POSSIBLE_INTERACTION",
    approximate_date: "2026-05-20T10:00:00Z",
    summary: "It was nice talking with both of you today.",
    source_evidence_ids: ["ev-9"],
  });
  assert.equal(canConsolidate(left, right), false);
  assert.equal(consolidateInteractions([left, right]).length, 2);
});

test("supporting evidence IDs are preserved", () => {
  const merged = consolidateInteractions([
    baseInteraction({
      id: "rw-1",
      interaction_type: "ROADSHOW_CONVERSATION",
      summary: "Great speaking with you at the Xero Roadshow.",
      source_evidence_ids: ["ev-1", "ev-2"],
      approximate_date: "2026-04-17T09:00:00Z",
    }),
    baseInteraction({
      id: "rw-2",
      interaction_type: "ROADSHOW_CONVERSATION",
      summary: "Great meeting you at the Xero Roadshow last week.",
      source_evidence_ids: ["ev-5", "ev-6"],
      approximate_date: "2026-05-04T11:00:00Z",
    }),
  ]);
  assert.equal(merged.length, 1);
  assert.ok(merged[0]?.source_evidence_ids.includes("ev-1"));
  assert.ok(merged[0]?.source_evidence_ids.includes("ev-5"));
});

test("confidence is recalculated conservatively", () => {
  const merged = consolidateInteractions([
    baseInteraction({
      interaction_type: "ROADSHOW_CONVERSATION",
      confidence: "HIGH",
      summary: "Great speaking with you at the Xero Roadshow.",
      approximate_date: "2026-04-17T09:00:00Z",
    }),
    baseInteraction({
      id: "rw-2",
      interaction_type: "ROADSHOW_CONVERSATION",
      confidence: "HIGH",
      summary: "Great meeting you at the Xero Roadshow!",
      source_evidence_ids: ["ev-8"],
      approximate_date: "2026-05-04T11:00:00Z",
    }),
  ]);
  assert.equal(merged[0]?.corroboration, "repeated_reference");
  assert.equal(merged[0]?.confidence, "HIGH");
});

test("email commercial-selection priority", () => {
  const selected = selectCommercialEmails([
    { direction: "outbound", at: "2026-04-17T09:00:00Z", subject: "Special offer", currentMessageText: "Great meeting you at the Xero Roadshow. Exclusive offer attached." },
    { direction: "inbound", at: "2026-06-10T09:00:00Z", subject: "Re: Partner", currentMessageText: "I will take this to management for review next week." },
    { direction: "outbound", at: "2026-06-12T09:00:00Z", subject: "Just checking in", currentMessageText: "Just bumping this in case it was buried." },
  ]);
  assert.equal(selected[0]?.direction, "inbound");
  assert.match(selected[0]?.selectionReason ?? "", /management|inbound/i);
});

test("Note commercial-selection priority", () => {
  const selected = selectCommercialNotes([
    { content: "Updated phone number on the record.", at: "2026-01-01T00:00:00Z" },
    { content: "Called James. He likes the concept but wants to discuss it with his partner. Follow up next month.", at: "2026-05-20T10:00:00Z" },
  ]);
  assert.equal(selected.length, 1);
  assert.match(selected[0]?.content ?? "", /Called James/);
});

test("contradiction preservation", () => {
  const organisation = emptyOrg({
    usage: {
      status: "matched",
      label: "USAGE MATCHED",
      message: "matched",
      profiles: [{ registered: true, activationState: "never_activated", matchMethod: "email" }],
      evidence: [evidence({ type: "usage_fact", claim: "Registered, never activated", source: "usage" })],
    },
  });
  const deals = { count: 1, stages: ["Closed Won"], names: ["Portal Genie"], closedWon: 1, closedLost: 0, values: [], latestName: "Portal Genie" };
  const bundle = buildProductRelationships({
    organisation: { ...organisation, deals },
    deals,
    emails: [],
    evidence: [evidence({ type: "crm_fact", claim: "1 Deal(s) Closed Won", source: "Zoho Deal" })],
  });
  const contradictions = detectProductContradictions({
    products: bundle.products,
    deals,
    usage: organisation.usage,
  });
  assert.ok(contradictions.some((item) => /Closed Won/i.test(item) && /not activated/i.test(item)));
});

test("context-budget enforcement and omitted evidence is recorded", () => {
  const contact = emptyContact({
    emails: {
      outboundCount: 11,
      inboundCount: 3,
      unknownDirectionCount: 0,
      lastAt: "2026-06-12T00:00:00Z",
      lastDirection: "outbound",
      inboundAfterOutbound: false,
      consecutiveOutboundWithoutLaterInbound: 2,
    },
  });
  const organisation = emptyOrg({
    notes: [
      { content: "Called James. Follow up next month.", at: "2026-05-01T00:00:00Z", source: "Zoho Contact/Lead Notes" },
      { content: "Met with Jane to walk through pricing and the partner programme.", at: "2026-05-02T00:00:00Z", source: "Zoho Contact/Lead Notes" },
    ],
  });
  const digest = buildCommercialEvidenceDigest({
    contact,
    organisation,
    emails: [
      { at: "2026-06-10T00:00:00Z", direction: "inbound", subject: "Management", currentMessageText: "I will take this to management for review." },
      { at: "2026-06-11T00:00:00Z", direction: "outbound", subject: "Follow up", currentMessageText: "Just following up on the partner offer." },
      { at: "2026-06-12T00:00:00Z", direction: "outbound", subject: "Checking in", currentMessageText: "Checking in again regarding registration." },
    ],
    evidence: [evidence({ type: "unknown", claim: "USAGE UNKNOWN", source: "usage" })],
    reconstruction: {
      interactions: [
        baseInteraction({
          summary: "Thank you for taking my call.",
          approximate_date: "2026-05-20T12:00:00Z",
          source_evidence_ids: ["ev-1"],
        }),
      ],
      timeline: [{ at: "2026-05-20T12:00:00Z", approximate: true, kind: "inferred_real_world", title: "PHONE CALL — Thank you for taking my call.", source: "INFERRED_FROM_EMAIL" }],
      relationshipProgression: "Progressed relationship",
      confirmedCrmActivity: "Emails only",
      inferredRealWorldActivity: "Telephone interaction inferred",
    },
    products: [
      { product: "PORTAL_GENIE", relationship_state: "UNKNOWN", evidence_ids: [], summary: "unknown", confidence: "LOW" },
      { product: "NAGGING_PANDA", relationship_state: "UNKNOWN", evidence_ids: [], summary: "unknown", confidence: "LOW" },
    ],
    organisationRelationship: { characterisation: "Limited", summary: "Independent of product state", evidence_ids: [] },
    contradictions: ["Zoho Deal Closed Won, but Portal Genie usage evidence shows the account has not activated."],
    budget: { maxChars: 2800 },
  });
  assert.ok(digest.budget.used_chars <= 2800 || digest.omitted_due_to_budget.length > 0);
  assert.ok(digest.contradictions.length > 0);
  assert.equal(digest.email_metrics.outbound, 11);
  assert.equal(digest.email_metrics.inbound, 3);
  if (digest.budget.max_chars < JSON.stringify({ ...digest, omitted_due_to_budget: [] }).length) {
    assert.ok(digest.omitted_due_to_budget.length > 0);
  }
});

test("Portal Genie ProductRelationship", () => {
  const organisation = emptyOrg({
    usage: {
      status: "matched",
      label: "USAGE MATCHED",
      message: "matched",
      profiles: [{ registered: true, activationState: "never_activated", matchMethod: "email" }],
      evidence: [evidence({ type: "usage_fact", claim: "PG registered", source: "usage" })],
    },
  });
  const bundle = buildProductRelationships({
    organisation,
    deals: organisation.deals,
    emails: [{ subject: "Portal Genie", currentMessageText: "Welcome to Portal Genie" }],
    evidence: organisation.usage.evidence,
  });
  const pg = bundle.products.find((item) => item.product === "PORTAL_GENIE");
  assert.equal(pg?.relationship_state, "REGISTERED_NOT_ACTIVATED");
  assert.notEqual(pg?.relationship_state, "UNKNOWN");
});

test("Nagging Panda ProductRelationship", () => {
  const deals = { count: 1, stages: ["Proposal"], names: ["Nagging Panda annual"], closedWon: 0, closedLost: 0, values: [], latestName: "Nagging Panda annual" };
  const bundle = buildProductRelationships({
    organisation: emptyOrg({ deals }),
    deals,
    emails: [{ subject: "Nagging Panda", currentMessageText: "Thanks for using Nagging Panda" }],
    evidence: [evidence({ type: "crm_fact", claim: "Nagging Panda deal", source: "Zoho Deal" })],
  });
  const np = bundle.products.find((item) => item.product === "NAGGING_PANDA");
  assert.equal(np?.relationship_state, "ENGAGED_PROSPECT");
});

test("same organisation with both product relationships", () => {
  const deals = { count: 2, stages: ["Firm Partner Deal - New"], names: ["Nagging Panda plus Portal Genie"], closedWon: 0, closedLost: 0, values: [], latestName: "Nagging Panda plus Portal Genie" };
  const organisation = emptyOrg({
    deals,
    usage: {
      status: "matched",
      label: "USAGE MATCHED",
      message: "matched",
      profiles: [{ registered: true, paying: true, activationState: "active", matchMethod: "email" }],
      evidence: [evidence({ type: "usage_fact", claim: "PG paying", source: "usage" })],
    },
    emailSummary: { selectedOutbound: 5, selectedInbound: 2, selectedLastAt: "2026-06-01", otherMembersDiscovered: 0 },
  });
  const bundle = buildProductRelationships({
    organisation,
    deals,
    emails: [{ subject: "Both", currentMessageText: "Portal Genie partner pack and Nagging Panda invoice" }],
    evidence: organisation.usage.evidence,
    leadSource: "Xero Roadshow",
  });
  const pg = bundle.products.find((item) => item.product === "PORTAL_GENIE");
  const np = bundle.products.find((item) => item.product === "NAGGING_PANDA");
  assert.equal(pg?.relationship_state, "PAYING_CUSTOMER");
  assert.equal(np?.relationship_state, "ENGAGED_PROSPECT");
  assert.match(bundle.organisationRelationship.characterisation, /two-way|deal/i);
  assert.notEqual(bundle.organisationRelationship.characterisation, pg?.relationship_state);
});

test("unknown product relationship stays UNKNOWN", () => {
  const bundle = buildProductRelationships({
    organisation: emptyOrg(),
    deals: emptyOrg().deals,
    emails: [{ subject: "Hello", currentMessageText: "Nice to meet you" }],
    evidence: [],
  });
  const pg = bundle.products.find((item) => item.product === "PORTAL_GENIE");
  const np = bundle.products.find((item) => item.product === "NAGGING_PANDA");
  assert.equal(pg?.relationship_state, "UNKNOWN");
  assert.equal(np?.relationship_state, "UNKNOWN");
  assert.match(pg?.summary ?? "", /unknown, not an assumption of no relationship/i);
});

test("organisation state remains separate from product state", () => {
  const bundle = buildProductRelationships({
    organisation: emptyOrg({
      emailSummary: { selectedOutbound: 4, selectedInbound: 2, selectedLastAt: "2026-06-01", otherMembersDiscovered: 0 },
    }),
    deals: { count: 1, stages: ["Firm Partner Deal - New"], names: ["Firm Partner"], closedWon: 0, closedLost: 0, values: [], latestName: "Firm Partner" },
    emails: [{ subject: "Portal Genie", currentMessageText: "Partner programme discussion" }],
    evidence: [],
    leadSource: "Xero Roadshow",
  });
  const pg = bundle.products.find((item) => item.product === "PORTAL_GENIE");
  assert.equal(pg?.relationship_state, "PARTNER_PROSPECT");
  assert.notEqual(bundle.organisationRelationship.characterisation, "PARTNER_PROSPECT");
  assert.match(bundle.organisationRelationship.summary, /independent of product/i);
});

test("PipelineStructureAdvisor is a contract only", () => {
  const advisor = createUnimplementedPipelineStructureAdvisor();
  assert.throws(() => advisor.analyse({ product: "PORTAL_GENIE" }), /contract only/i);
});

test("reasoning context budget is configurable", () => {
  assert.equal(loadReasoningContextBudget({}).maxChars, 10000);
  assert.equal(loadReasoningContextBudget({ REASONING_CONTEXT_BUDGET_CHARS: "8000" }).maxChars, 8000);
});
