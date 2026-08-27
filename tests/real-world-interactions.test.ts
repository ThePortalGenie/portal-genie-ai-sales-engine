import assert from "node:assert/strict";
import test from "node:test";
import { splitCurrentEmailMessage } from "../src/content/email-current-message.js";
import { resetEvidenceIds } from "../src/domain/evidence.js";
import { buildContactIntelligence } from "../src/intelligence/contact-intelligence.js";
import { loadPublicEmailDomains } from "../src/intelligence/email-domains.js";
import {
  dedupeEmailCurrentMessages,
  extractFromEmail,
  extractFromNote,
  reconstructFromSources,
  resetInteractionIds,
} from "../src/intelligence/interaction-extraction.js";
import type { DiscoveryDiagnostic } from "../src/integrations/zoho/types.js";

const PUBLIC = loadPublicEmailDomains();

function emptyRelated(apiName: string) {
  return {
    apiName,
    displayLabel: apiName,
    attempted: true,
    success: true,
    recordCount: 0,
    moreRecords: false,
    fieldsUsed: [],
    records: [],
  };
}

test("note clearly documents outbound call", () => {
  resetEvidenceIds();
  resetInteractionIds();
  const result = extractFromNote({
    content: "Called James. He likes the concept but wants to discuss it with his partner. Follow up next month.",
    at: "2026-05-20T10:00:00Z",
  });
  assert.equal(result.interactions[0]?.interaction_type, "PHONE_CALL");
  assert.equal(result.interactions[0]?.direction, "OUTBOUND");
  assert.equal(result.interactions[0]?.confidence, "HIGH");
  assert.match(result.interactions[0]?.follow_up_commitment ?? "", /next month/i);
  assert.ok(result.interactions[0]?.source_types.includes("ZOHO_NOTE"));
  assert.ok(result.interactions[0]?.source_types.includes("INFERRED_FROM_NOTE"));
});

test("note clearly documents inbound call", () => {
  const result = extractFromNote({ content: "The customer called back and left a voicemail." });
  assert.equal(result.interactions[0]?.interaction_type, "PHONE_CALL");
  assert.equal(result.interactions[0]?.direction, "INBOUND");
});

test("note documents meeting", () => {
  const result = extractFromNote({ content: "Met with Jane at their office to walk through Portal Genie." });
  assert.equal(result.interactions[0]?.interaction_type, "MEETING");
  assert.equal(result.interactions[0]?.confidence, "HIGH");
});

test("note documents demo", () => {
  const result = extractFromNote({ content: "We ran a demo this morning for the practice manager." });
  assert.equal(result.interactions[0]?.interaction_type, "DEMO");
});

test("note merely contains word call but no call occurred", () => {
  const result = extractFromNote({ content: "They asked what we call the Partner programme." });
  assert.equal(result.interactions.filter((item) => item.interaction_type === "PHONE_CALL").length, 0);
});

test("email says thank you for taking my call", () => {
  const result = extractFromEmail({
    direction: "outbound",
    at: "2026-05-20T12:00:00Z",
    currentMessageText: "Thank you for taking my call.",
  });
  assert.equal(result.interactions[0]?.interaction_type, "PHONE_CALL");
  assert.equal(result.interactions[0]?.direction, "OUTBOUND");
  assert.ok(result.interactions[0]?.provenance.includes("not a Zoho"));
});

test("email says following our meeting", () => {
  const result = extractFromEmail({
    direction: "outbound",
    currentMessageText: "Following our meeting, I have attached the Partner overview.",
  });
  assert.equal(result.interactions[0]?.interaction_type, "MEETING");
});

test("email says great speaking with you but interaction type is ambiguous", () => {
  const result = extractFromEmail({
    direction: "outbound",
    currentMessageText: "Thank you for your time this morning. It was great speaking with both of you.",
  });
  assert.equal(result.interactions[0]?.interaction_type, "POSSIBLE_INTERACTION");
  assert.notEqual(result.interactions[0]?.interaction_type, "PHONE_CALL");
});

test("roadshow conversation referenced in email", () => {
  const result = extractFromEmail({
    direction: "outbound",
    currentMessageText: "Following our conversation at the Xero Roadshow, I wanted to share a few resources.",
  });
  assert.equal(result.interactions[0]?.interaction_type, "ROADSHOW_CONVERSATION");
});

test("management approval mentioned", () => {
  const result = extractFromEmail({
    direction: "inbound",
    currentMessageText: "I will take this to management for review next week.",
  });
  assert.ok(result.signals.some((item) => item.type === "management_approval_required"));
});

test("follow-up commitment", () => {
  const result = extractFromNote({
    content: "Called James. Follow up next month once he has spoken to his partner.",
  });
  assert.match(result.interactions[0]?.follow_up_commitment ?? "", /next month/i);
});

test("pricing objection", () => {
  const result = extractFromEmail({
    direction: "inbound",
    currentMessageText: "It looks useful but it is too expensive for us right now.",
  });
  assert.ok(result.signals.some((item) => item.type === "objection" || item.type === "pricing_discussion"));
});

test("partner interest", () => {
  const result = extractFromEmail({
    direction: "inbound",
    currentMessageText: "We discussed the Partner programme and they are interested in partnering.",
  });
  assert.ok(result.signals.some((item) => item.type === "partner_interest"));
});

test("referral opportunity", () => {
  const result = extractFromNote({
    content: "Jane said she may refer two clients if the Partner agreement is agreed.",
  });
  assert.ok(result.signals.some((item) => item.type === "referral_opportunity"));
});

test("Outlook quoted reply removal", () => {
  const split = splitCurrentEmailMessage(
    "Thanks Jane, see you Thursday.\n\n-----Original Message-----\nFrom: Jane\nSent: Monday\nTo: Geoff\nSubject: Re: Meeting\nWe would like a demo.",
  );
  assert.match(split.currentMessageText, /see you Thursday/);
  assert.doesNotMatch(split.currentMessageText, /We would like a demo/);
  assert.equal(split.strippedQuotedHistory, true);
  assert.equal(split.quoteStrippingConfidence, "HIGH");
  assert.match(split.fullCleanedBody, /We would like a demo/);
});

test("Gmail quoted reply removal", () => {
  const split = splitCurrentEmailMessage(
    "Confirmed for 10am.\n\nOn Tue, 20 May 2026 at 09:00 Jane Smith <jane@abc.com> wrote:\nPlease send a calendar invite.",
  );
  assert.match(split.currentMessageText, /Confirmed for 10am/);
  assert.doesNotMatch(split.currentMessageText, /calendar invite/);
  assert.equal(split.strippedQuotedHistory, true);
});

test("forwarded message handling", () => {
  const intro = splitCurrentEmailMessage(
    "See below from Jane.\n\n-----Forwarded message-----\nFrom: Jane\nThank you for taking my call.",
  );
  assert.match(intro.currentMessageText, /See below from Jane/);
  assert.doesNotMatch(intro.currentMessageText, /taking my call/);

  const onlyForward = splitCurrentEmailMessage("-----Forwarded message-----\nFrom: Jane\nThank you for taking my call.");
  assert.match(onlyForward.currentMessageText, /taking my call/);
  assert.equal(onlyForward.strippedQuotedHistory, false);
  assert.equal(onlyForward.quoteStrippingConfidence, "LOW");
});

test("signature removal", () => {
  const split = splitCurrentEmailMessage("Please find the overview attached.\n\n-- \nGeoff Ferrier\nThe Portal Genie");
  assert.match(split.currentMessageText, /overview attached/);
  assert.doesNotMatch(split.currentMessageText, /Geoff Ferrier/);
  assert.equal(split.strippedSignatureOrDisclaimer, true);
});

test("disclaimer removal", () => {
  const split = splitCurrentEmailMessage(
    "Happy to jump on a call next week.\n\nThis email and any attachments are confidential and intended solely for the addressee.",
  );
  assert.match(split.currentMessageText, /jump on a call next week/);
  assert.doesNotMatch(split.currentMessageText, /intended solely/);
});

test("unsafe or ambiguous quote stripping preserves content", () => {
  const split = splitCurrentEmailMessage("From our side the next step is a demo, not a contract.\nJane mentioned From: accounting in passing.");
  assert.match(split.currentMessageText, /next step is a demo/);
  assert.match(split.currentMessageText, /From: accounting/);
  assert.equal(split.strippedQuotedHistory, false);
});

test("FJM-style Outlook quote boundary with wrapped From/Sent/To headers", () => {
  const split = splitCurrentEmailMessage(
    [
      "Following up on the proposal we discussed.",
      "",
      "Kind regards,",
      "From: Sumeré",
      "van Staden < sumere@fjmaccounts.co.za >",
      "Sent: Monday, June 22, 2026 2:58 PM",
      "To: Geoff Ferrier < geoff@theportalgenie.com >",
      "Subject: Re: Portal Genie",
      "Hi Geoff, I will take this to management for review.",
    ].join("\n"),
  );
  assert.match(split.currentMessageText, /Following up on the proposal/);
  assert.doesNotMatch(split.currentMessageText, /management for review/);
  assert.equal(split.strippedQuotedHistory, true);
  assert.ok(split.quoteStrippingConfidence === "HIGH" || split.quoteStrippingConfidence === "MEDIUM");
  assert.match(split.fullCleanedBody, /management for review/);
});

test("wrapped Gmail On ... wrote quote boundary", () => {
  const split = splitCurrentEmailMessage(
    "Confirmed for 10am.\n\nOn Tue, 20 May 2026 at 09:00 Jane Smith\n<jane@abc.com> wrote:\nPlease send a calendar invite.",
  );
  assert.match(split.currentMessageText, /Confirmed for 10am/);
  assert.doesNotMatch(split.currentMessageText, /calendar invite/);
  assert.equal(split.strippedQuotedHistory, true);
});

test("same historical email quoted multiple times is not treated as multiple evidence", () => {
  const emails = [
    { messageId: "a", currentMessageText: "We would like a demo." },
    { messageId: "b", currentMessageText: "We would like a demo." },
    { messageId: "c", currentMessageText: "Thanks, Thursday works." },
  ];
  const unique = dedupeEmailCurrentMessages(emails);
  assert.equal(unique.length, 2);
  const reconstructed = reconstructFromSources({
    notes: [],
    emails: unique.map((item) => ({ ...item, direction: "inbound" })),
    zohoCalls: 0,
    zohoMeetings: 0,
    emailOutbound: 0,
    emailInbound: 2,
    crmEvents: [],
  });
  const demoInterest = reconstructed.signals.filter((item) => item.type === "requested_feature" || /demo/i.test(item.text));
  assert.ok(demoInterest.length <= 1);
});

test("empty Zoho Calls plus email evidence of a call", () => {
  const diagnostic = {
    primaryRecord: {
      module: "Contacts",
      id: "1111111111111111111",
      retrieved: true,
      tags: null,
      lookupFollowUps: [],
      record: { Full_Name: "Jane", Email: "jane@abcaccounting.co.uk" },
    },
    fieldCatalog: { customFields: [], standardFields: [], retrieved: true, totalFields: 0, module: "Contacts" },
    relatedLists: { catalogRetrieved: true, available: [], retrievals: [emptyRelated("Calls"), emptyRelated("Events")] },
    emails: {
      success: true,
      count: 1,
      normalized: [
        {
          messageId: "m1",
          at: "2026-05-20T12:00:00Z",
          direction: "outbound",
          subject: "Thanks",
          bodyText: "Thank you for taking my call.",
          currentMessageText: "Thank you for taking my call.",
        },
      ],
      interactionFacts: {
        outboundCount: 1,
        inboundCount: 0,
        unknownDirectionCount: 0,
        lastAt: "2026-05-20T12:00:00Z",
        lastDirection: "outbound",
        inboundAfterOutbound: false,
        consecutiveOutboundWithoutLaterInbound: 1,
      },
    },
  } as unknown as DiscoveryDiagnostic;
  const contact = buildContactIntelligence(diagnostic, PUBLIC);
  assert.equal(contact.calls, 0);
  assert.ok(contact.evidence.some((item) => item.type === "crm_fact" && /Calls related list contains zero/.test(item.claim)));
  const reconstructed = reconstructFromSources({
    notes: [],
    emails: [{ direction: "outbound", at: "2026-05-20T12:00:00Z", currentMessageText: "Thank you for taking my call." }],
    zohoCalls: 0,
    zohoMeetings: 0,
    emailOutbound: 1,
    emailInbound: 0,
    crmEvents: [],
  });
  assert.ok(reconstructed.interactions.some((item) => item.interaction_type === "PHONE_CALL"));
  assert.ok(reconstructed.evidence.some((item) => /No formal Zoho Call records were found/.test(item.claim)));
});

test("empty Zoho Meetings plus evidence of a meeting", () => {
  const diagnostic = {
    primaryRecord: {
      module: "Contacts",
      id: "1111111111111111111",
      retrieved: true,
      tags: null,
      lookupFollowUps: [],
      record: { Full_Name: "Jane" },
    },
    fieldCatalog: { customFields: [], standardFields: [], retrieved: true, totalFields: 0, module: "Contacts" },
    relatedLists: { catalogRetrieved: true, available: [], retrievals: [emptyRelated("Events")] },
    emails: { success: true, count: 0, normalized: [], interactionFacts: { outboundCount: 0, inboundCount: 0, unknownDirectionCount: 0, lastAt: null, lastDirection: null, inboundAfterOutbound: false, consecutiveOutboundWithoutLaterInbound: 0 } },
  } as unknown as DiscoveryDiagnostic;
  const contact = buildContactIntelligence(diagnostic, PUBLIC);
  assert.equal(contact.meetings, 0);
  assert.ok(contact.evidence.some((item) => /Meetings related list contains zero/.test(item.claim)));
  const reconstructed = reconstructFromSources({
    notes: [],
    emails: [{ direction: "outbound", currentMessageText: "Following our meeting I have sent the pack." }],
    zohoCalls: 0,
    zohoMeetings: 0,
    emailOutbound: 1,
    emailInbound: 0,
    crmEvents: [],
  });
  assert.ok(reconstructed.interactions.some((item) => item.interaction_type === "MEETING"));
});

test("provenance remains attached to inferred interaction", () => {
  const result = extractFromEmail({
    messageId: "abc",
    direction: "outbound",
    at: "2026-05-20T12:00:00Z",
    currentMessageText: "Thank you for taking my call.",
  });
  const item = result.interactions[0];
  assert.ok(item);
  assert.ok(item.source_evidence_ids.length > 0);
  assert.ok(item.source_types.includes("INFERRED_FROM_EMAIL"));
  assert.ok(!item.source_types.includes("ZOHO_CALL"));
  assert.match(item.provenance, /not a Zoho/i);
  assert.ok(result.evidence.some((entry) => entry.type === "crm_fact"));
  assert.ok(result.evidence.some((entry) => entry.type === "derived_signal"));
});
