import assert from "node:assert/strict";
import test from "node:test";
import { htmlToPlainText } from "../src/content/html-to-text.js";
import {
  buildEmailInteractionFacts,
  normalizeRetrievedEmail,
  resolveEmailDirection,
} from "../src/integrations/zoho/normalize-email.js";
import { buildTimeline } from "../src/web/timeline.js";
import type { DiscoveryDiagnostic } from "../src/integrations/zoho/types.js";

const noisyHtml = `<html><head><style>
@media only screen and (max-width: 600px) { div.zm_foo { color: red; } }
</style></head><body>
<div class="zm_bar">Thanks for the Portal Genie demo.</div>
<script>alert(1)</script>
<img src="https://track.example/open.gif" />
<p>Can we book a follow-up next week?</p>
</body></html>`;

test("htmlToPlainText keeps commercial wording and drops CSS/script/tracking", () => {
  const { text } = htmlToPlainText(noisyHtml);
  assert.match(text, /Thanks for the Portal Genie demo/);
  assert.match(text, /follow-up next week/);
  assert.doesNotMatch(text, /@media/);
  assert.doesNotMatch(text, /div\.zm_/);
  assert.doesNotMatch(text, /alert\(1\)/);
  assert.doesNotMatch(text, /track\.example/);
});

test("direction uses Zoho sent flag, not email wording", () => {
  const outbound = resolveEmailDirection({
    sent: true,
    statusTypes: [],
    senderEmail: "sales@portalgenie.com",
    recipientEmails: ["jane@practice.com"],
    prospectEmails: ["jane@practice.com"],
  });
  const inbound = resolveEmailDirection({
    sent: false,
    statusTypes: [],
    senderEmail: "jane@practice.com",
    recipientEmails: ["sales@portalgenie.com"],
    prospectEmails: ["jane@practice.com"],
  });
  const unknown = resolveEmailDirection({
    sent: null,
    statusTypes: [],
    senderEmail: "unknown@example.com",
    recipientEmails: ["other@example.com"],
    prospectEmails: ["jane@practice.com"],
  });
  assert.equal(outbound.direction, "outbound");
  assert.equal(inbound.direction, "inbound");
  assert.equal(unknown.direction, "unknown");
});

test("address match is used only when sent flag is absent", () => {
  const inbound = resolveEmailDirection({
    sent: null,
    statusTypes: [],
    senderEmail: "jane@practice.com",
    recipientEmails: ["sales@portalgenie.com"],
    prospectEmails: ["jane@practice.com"],
  });
  assert.equal(inbound.direction, "inbound");
});

test("normalized body is cleaned and interaction facts stay metadata-only", () => {
  const outbound = normalizeRetrievedEmail(
    {
      messageId: "1",
      subject: "Demo follow-up",
      time: "2025-03-14T10:00:00Z",
      sent: true,
      from: { email: "sales@portalgenie.com", user_name: "Sales" },
      to: [{ email: "jane@practice.com", user_name: "Jane" }],
      hasAttachment: false,
      listType: "sent_from_crm",
    },
    { rawContent: noisyHtml, threadId: "thread-1" },
    ["jane@practice.com"],
  );
  const inbound = normalizeRetrievedEmail(
    {
      messageId: "2",
      subject: "Re: Demo follow-up",
      time: "2025-03-15T09:00:00Z",
      sent: false,
      from: { email: "jane@practice.com", user_name: "Jane" },
      to: [{ email: "sales@portalgenie.com" }],
      hasAttachment: false,
      listType: "user_emails",
    },
    { rawContent: "<p>Yes, Tuesday works.</p>", threadId: "thread-1" },
    ["jane@practice.com"],
  );
  assert.equal(outbound.direction, "outbound");
  assert.equal(outbound.sourceType, "crm_email");
  assert.match(outbound.bodyText ?? "", /Portal Genie demo/);
  assert.match(outbound.currentMessageText ?? "", /Portal Genie demo/);
  assert.equal(outbound.quoteStrippingConfidence, "LOW");
  assert.doesNotMatch(outbound.bodyText ?? "", /@media|div\.zm_/);
  assert.equal(inbound.direction, "inbound");
  const facts = buildEmailInteractionFacts([outbound, inbound]);
  assert.equal(facts.outboundCount, 1);
  assert.equal(facts.inboundCount, 1);
  assert.equal(facts.lastDirection, "inbound");
  assert.equal(facts.inboundAfterOutbound, true);
});

test("timeline does not treat unknown direction as sent", () => {
  const diagnostic = {
    emails: {
      headers: [],
      bodies: [],
      normalized: [
        {
          messageId: "u1",
          threadId: null,
          at: "2025-03-12T10:00:00Z",
          direction: "unknown",
          directionEvidence: "insufficient",
          sender: { name: null, email: "a@b.com" },
          recipients: [],
          cc: [],
          subject: "Maybe",
          bodyText: "Hello",
          bodyTruncated: false,
          sourceType: "other",
          hasAttachment: null,
        },
        {
          messageId: "s1",
          threadId: null,
          at: "2025-03-13T10:00:00Z",
          direction: "outbound",
          directionEvidence: "Zoho sent=true",
          sender: { name: null, email: "us@x.com" },
          recipients: [],
          cc: [],
          subject: "Sent",
          bodyText: "Hi",
          bodyTruncated: false,
          sourceType: "crm_email",
          hasAttachment: null,
        },
        {
          messageId: "r1",
          threadId: null,
          at: "2025-03-14T10:00:00Z",
          direction: "inbound",
          directionEvidence: "Zoho sent=false",
          sender: { name: null, email: "them@x.com" },
          recipients: [],
          cc: [],
          subject: "Received",
          bodyText: "Thanks",
          bodyTruncated: false,
          sourceType: "user_email",
          hasAttachment: null,
        },
      ],
    },
    relatedLists: { retrievals: [], available: [] },
  } as unknown as DiscoveryDiagnostic;
  const events = buildTimeline(diagnostic);
  assert.deepEqual(
    events.map((event) => event.type),
    ["email_received", "email_sent", "email"],
  );
  assert.equal(events.find((event) => event.type === "email")?.direction, "unknown");
});
