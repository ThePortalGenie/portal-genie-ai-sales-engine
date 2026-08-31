import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CommercialWatchItem } from "../src/domain/commercial-watch.js";
import {
  decisionContextSnapshotFromWatchItem,
  parseOperatorDecisionInput,
  recommendationFingerprintFromWatchItem,
} from "../src/domain/operator-decision.js";
import { parseSalesEventInput } from "../src/domain/sales-event.js";
import { NOTES_CREATE_SCOPE, SALES_ENGINE_NOTE_TITLES } from "../src/integrations/zoho/constants.js";
import { noteIdFromCreateResponse } from "../src/integrations/zoho/write-client.js";
import {
  resolveContextContactTarget,
  resolveContextDealTarget,
  resolveZohoWriteTarget,
} from "../src/integrations/zoho/write-target.js";
import {
  _testOnlySetZohoNoteWriter,
  formatInteractionNoteContent,
  salesEngineWrittenZohoNoteIds,
  writeContextNoteToZoho,
  writeContextNotesToZoho,
  writeInteractionNoteToZoho,
  zohoWriteEnabled,
} from "../src/integrations/zoho/write-back.js";
import { isCustomerExecutableBriefItem } from "../src/intelligence/daily-brief.js";
import {
  attachOperatorDecisionContextZohoNotes,
  attachOperatorDecisionZohoNote,
  createOperatorDecision,
  getOperatorDecision,
  listOperatorDecisions,
} from "../src/intelligence/operator-decision-store.js";
import { attachSalesEventZohoNote, createSalesEvent, getSalesEvent, listSalesEvents } from "../src/intelligence/sales-event-store.js";
import { applyOperatorControlToWatchItem } from "../src/intelligence/watch-item-control.js";
import { handleRequest } from "../src/server/app.js";
import type { ZohoNoteWriter } from "../src/integrations/zoho/write-client.js";

const AS_OF = "2026-08-28T12:00:00.000Z";
const PG_CONTACT = "5290417000031698001";
const PG_DEAL = "5290417000032000001";
const NP_DEAL = "5290417000032000002";
const RUSHAAN_CONTEXT =
  "Rushaan was needing to upload XLSX files. This is not yet implemented.\nI need to follow up internally and then let her know";
const ZOHO_WRITE = {
  contact_ids: [PG_CONTACT],
  source_record: { module: "Contacts", recordId: PG_CONTACT },
  deal_ids: [PG_DEAL],
};

function watchItem(): CommercialWatchItem {
  return {
    id: "domain:acme.test:PORTAL_GENIE",
    organisation_id: "domain:acme.test",
    organisation_name: "Acme Accounting",
    product_scope: "PORTAL_GENIE",
    relationship_state: "ENGAGED_PROSPECT",
    recommended_contact_id: PG_CONTACT,
    deal_ids: [PG_DEAL],
    lead_ids: [],
    contact_ids: ["5290417000031698001"],
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
    source_record: { module: "Contacts", recordId: "5290417000031698001" },
    priority: "P1",
    rank: 1,
    why_ranked: "",
    reuse: "reused",
  };
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

function withStores(run: () => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "pg-zoho-write-"));
  process.env.SALES_EVENTS_STORE = join(dir, "sales-events.json");
  process.env.OPERATOR_DECISIONS_STORE = join(dir, "operator-decisions.json");
  return run();
}

test("resolveZohoWriteTarget uses exact contact id from contact_ids", () => {
  const target = resolveZohoWriteTarget({
    organisation_key: "domain:acme.test",
    contact_id: "5290417000031698001",
    contact_ids: ["5290417000031698001"],
  });
  assert.deepEqual(target, { module: "Contacts", recordId: "5290417000031698001" });
});

test("resolveZohoWriteTarget rejects unknown contact id without exact membership", () => {
  assert.equal(
    resolveZohoWriteTarget({
      organisation_key: "domain:acme.test",
      contact_id: "5290417000031698001",
      contact_ids: ["5290417000031698999"],
    }),
    null,
  );
});

test("resolveZohoWriteTarget prefers zoho-account organisation key", () => {
  assert.deepEqual(resolveZohoWriteTarget({ organisation_key: "zoho-account:5290417000031000001" }), {
    module: "Accounts",
    recordId: "5290417000031000001",
  });
});

test("confirmed interaction writes once with mocked Zoho writer", async () => {
  await withStores(async () => {
    process.env.ZOHO_WRITE_ENABLED = "true";
    let calls = 0;
    const writer: ZohoNoteWriter = {
      async createNote(input) {
        calls += 1;
        assert.equal(input.title, SALES_ENGINE_NOTE_TITLES.interaction);
        assert.match(input.content, /What happened/);
        assert.equal(input.parentModule, "Contacts");
        return { ok: true, noteId: "note-interaction-1" };
      },
    };
    _testOnlySetZohoNoteWriter(writer);
    const event = createSalesEvent(
      parseSalesEventInput({
        organisation_id: "domain:acme.test",
        contact_id: "5290417000031698001",
        product_scope: "PORTAL_GENIE",
        event_type: "PHONE_CALL",
        occurred_at: "2026-08-28T10:00:00.000Z",
        summary: "What happened on the call",
      }),
    );
    const first = await writeInteractionNoteToZoho(
      event,
      { contact_ids: ["5290417000031698001"], source_record: { module: "Contacts", recordId: "5290417000031698001" } },
      writer,
    );
    attachSalesEventZohoNote(event.id, first.noteId!);
    const second = await writeInteractionNoteToZoho(
      attachSalesEventZohoNote(event.id, first.noteId!),
      { contact_ids: ["5290417000031698001"] },
      writer,
    );
    assert.equal(first.ok, true);
    assert.equal(second.attempted, false);
    assert.equal(calls, 1);
    _testOnlySetZohoNoteWriter(undefined);
    delete process.env.ZOHO_WRITE_ENABLED;
  });
});

test("failed Zoho write does not attach note id to local interaction", async () => {
  await withStores(async () => {
    process.env.ZOHO_WRITE_ENABLED = "true";
    const writer: ZohoNoteWriter = {
      async createNote() {
        return { ok: false, error: "Zoho unavailable" };
      },
    };
    const event = createSalesEvent(
      parseSalesEventInput({
        organisation_id: "domain:acme.test",
        contact_id: "5290417000031698001",
        product_scope: "PORTAL_GENIE",
        event_type: "PHONE_CALL",
        occurred_at: "2026-08-28T10:00:00.000Z",
        summary: "Call summary",
      }),
    );
    const attempt = await writeInteractionNoteToZoho(event, { contact_ids: ["5290417000031698001"] }, writer);
    assert.equal(attempt.ok, false);
    assert.equal(event.zoho_note_id, undefined);
    delete process.env.ZOHO_WRITE_ENABLED;
  });
});

test("Add Context creates a Zoho Note with operator text only", async () => {
  await withStores(async () => {
    process.env.ZOHO_WRITE_ENABLED = "true";
    const writer: ZohoNoteWriter = {
      async createNote(input) {
        assert.equal(input.title, SALES_ENGINE_NOTE_TITLES.context);
        assert.equal(input.content, "Sarah is the decision maker.");
        assert.equal(input.parentModule, "Contacts");
        return { ok: true, noteId: "note-context-1" };
      },
    };
    const decision = createOperatorDecision(
      parseOperatorDecisionInput({
        watch_item_id: "org:PORTAL_GENIE",
        organisation_key: "domain:acme.test",
        product_scope: "PORTAL_GENIE",
        recommendation_fingerprint: "fp-1",
        decision_type: "CONTEXT_ADDED",
        operator_note: "Sarah is the decision maker.",
        decision_context_snapshot: {
          recommended_contact_id: "5290417000031698001",
          deal_ids: [],
        },
      }),
    );
    const attempt = await writeContextNoteToZoho(
      decision,
      {
        contact_ids: ["5290417000031698001"],
        source_record: { module: "Contacts", recordId: "5290417000031698001" },
      },
      writer,
    );
    assert.equal(attempt.ok, true);
    assert.equal(attempt.noteId, "note-context-1");
    _testOnlySetZohoNoteWriter(undefined);
    delete process.env.ZOHO_WRITE_ENABLED;
  });
});

test("operator controls other than CONTEXT_ADDED do not write to Zoho", async () => {
  await withStores(async () => {
    process.env.ZOHO_WRITE_ENABLED = "true";
    let calls = 0;
    const writer: ZohoNoteWriter = {
      async createNote() {
        calls += 1;
        return { ok: true, noteId: "note-should-not-run" };
      },
    };
    const decision = createOperatorDecision(
      parseOperatorDecisionInput({
        watch_item_id: "org:PORTAL_GENIE",
        organisation_key: "domain:acme.test",
        product_scope: "PORTAL_GENIE",
        recommendation_fingerprint: "fp-1",
        decision_type: "DISMISSED",
        operator_note: "Not relevant now",
      }),
    );
    const attempt = await writeContextNoteToZoho(decision, { contact_ids: ["5290417000031698001"] }, writer);
    assert.equal(attempt.skipped, true);
    assert.equal(calls, 0);
    delete process.env.ZOHO_WRITE_ENABLED;
  });
});

test("formatInteractionNoteContent contains operator-entered facts only", () => {
  const content = formatInteractionNoteContent(
    parseSalesEventInput({
      organisation_id: "domain:acme.test",
      product_scope: "PORTAL_GENIE",
      event_type: "PHONE_CALL",
      occurred_at: "2026-08-28T10:00:00.000Z",
      summary: "Discussed trial setup",
      outcome: "CONNECTED",
    }),
  );
  assert.match(content, /Discussed trial setup/);
  assert.doesNotMatch(content, /recommended action/i);
});

test("note id parser reads Zoho success payload", () => {
  assert.equal(
    noteIdFromCreateResponse({
      data: [{ code: "SUCCESS", details: { id: "2423488000000496148" }, status: "success" }],
    }),
    "2423488000000496148",
  );
});

test("write-back stays disabled unless ZOHO_WRITE_ENABLED=true", () => {
  delete process.env.ZOHO_WRITE_ENABLED;
  assert.equal(zohoWriteEnabled(), false);
});

test("minimum write scope is notes CREATE only", () => {
  assert.equal(NOTES_CREATE_SCOPE, "ZohoCRM.modules.notes.CREATE");
});

test("attachOperatorDecisionZohoNote stores exact Zoho note id", () => {
  withStores(() => {
    const decision = createOperatorDecision(
      parseOperatorDecisionInput({
        watch_item_id: "org:PORTAL_GENIE",
        organisation_key: "domain:acme.test",
        product_scope: "PORTAL_GENIE",
        recommendation_fingerprint: "fp-1",
        decision_type: "CONTEXT_ADDED",
        operator_note: "Context",
      }),
    );
    const updated = attachOperatorDecisionZohoNote(decision.id, "note-context-99");
    assert.equal(updated.contact_zoho_note_id, "note-context-99");
    assert.equal(updated.zoho_note_id, "note-context-99");
  });
});

test("resolveContextContactTarget requires exact Contacts membership", () => {
  assert.deepEqual(
    resolveContextContactTarget(
      { recommended_contact_id: PG_CONTACT },
      { contact_ids: [PG_CONTACT] },
      "domain:acme.test",
    ),
    { module: "Contacts", recordId: PG_CONTACT },
  );
  assert.equal(
    resolveContextContactTarget(
      { recommended_contact_id: PG_CONTACT },
      { contact_ids: ["5290417000031698999"] },
      "domain:acme.test",
    ),
    null,
  );
});

test("resolveContextDealTarget selects one exact product deal", () => {
  assert.deepEqual(
    resolveContextDealTarget({ deal_ids: [PG_DEAL] }, { deal_ids: [PG_DEAL] }),
    { target: { module: "Deals", recordId: PG_DEAL }, skipped: false },
  );
});

test("resolveContextDealTarget rejects ambiguous deals", () => {
  const resolution = resolveContextDealTarget({ deal_ids: [PG_DEAL, NP_DEAL] }, { deal_ids: [PG_DEAL, NP_DEAL] });
  assert.equal(resolution.target, null);
  assert.equal(resolution.skipped, true);
  assert.match(resolution.reason ?? "", /Multiple deals/i);
});

test("resolveContextDealTarget rejects cross-product deal mismatch", () => {
  const resolution = resolveContextDealTarget({ deal_ids: [PG_DEAL] }, { deal_ids: [NP_DEAL] });
  assert.equal(resolution.target, null);
  assert.equal(resolution.skipped, true);
});

test("Add Context writes Contact and Deal notes with operator text only", async () => {
  await withStores(async () => {
    process.env.ZOHO_WRITE_ENABLED = "true";
    type CreateNoteInput = Parameters<ZohoNoteWriter["createNote"]>[0];
    const calls: CreateNoteInput[] = [];
    const writer: ZohoNoteWriter = {
      async createNote(input) {
        calls.push(input);
        return {
          ok: true,
          noteId: input.parentModule === "Contacts" ? "note-context-contact-1" : "note-context-deal-1",
        };
      },
    };
    const decision = createOperatorDecision(
      parseOperatorDecisionInput({
        watch_item_id: "org:PORTAL_GENIE",
        organisation_key: "domain:acme.test",
        product_scope: "PORTAL_GENIE",
        recommendation_fingerprint: "fp-1",
        decision_type: "CONTEXT_ADDED",
        operator_note: RUSHAAN_CONTEXT,
        decision_context_snapshot: {
          recommended_contact_id: PG_CONTACT,
          deal_ids: [PG_DEAL],
        },
      }),
    );
    const result = await writeContextNotesToZoho(decision, ZOHO_WRITE, writer);
    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.parentModule, "Contacts");
    assert.equal(calls[1]?.parentModule, "Deals");
    assert.equal(calls[0]?.content, RUSHAAN_CONTEXT);
    assert.equal(calls[1]?.content, RUSHAAN_CONTEXT);
    assert.doesNotMatch(calls[0]?.content ?? "", /confidence|fingerprint|recommended action/i);
    delete process.env.ZOHO_WRITE_ENABLED;
  });
});

test("PG context does not attach to NP deal when watch item deal_ids are PG-only", async () => {
  await withStores(async () => {
    process.env.ZOHO_WRITE_ENABLED = "true";
    type CreateNoteInput = Parameters<ZohoNoteWriter["createNote"]>[0];
    const calls: CreateNoteInput[] = [];
    const writer: ZohoNoteWriter = {
      async createNote(input) {
        calls.push(input);
        return { ok: true, noteId: `note-${input.parentModule}-1` };
      },
    };
    const decision = createOperatorDecision(
      parseOperatorDecisionInput({
        watch_item_id: "domain:acme.test:PORTAL_GENIE",
        organisation_key: "domain:acme.test",
        product_scope: "PORTAL_GENIE",
        recommendation_fingerprint: "fp-1",
        decision_type: "CONTEXT_ADDED",
        operator_note: RUSHAAN_CONTEXT,
        decision_context_snapshot: {
          recommended_contact_id: PG_CONTACT,
          deal_ids: [PG_DEAL],
        },
      }),
    );
    await writeContextNotesToZoho(
      decision,
      { contact_ids: [PG_CONTACT], deal_ids: [PG_DEAL, NP_DEAL] },
      writer,
    );
    const dealCall = calls.find((call) => call.parentModule === "Deals");
    assert.equal(dealCall?.parentRecordId, PG_DEAL);
    assert.notEqual(dealCall?.parentRecordId, NP_DEAL);
    delete process.env.ZOHO_WRITE_ENABLED;
  });
});

test("NP context snapshot does not write to PG deal", async () => {
  await withStores(async () => {
    process.env.ZOHO_WRITE_ENABLED = "true";
    let dealWritten = false;
    const writer: ZohoNoteWriter = {
      async createNote(input) {
        if (input.parentModule === "Deals") dealWritten = true;
        return { ok: true, noteId: "note-1" };
      },
    };
    const decision = createOperatorDecision(
      parseOperatorDecisionInput({
        watch_item_id: "domain:acme.test:NAGGING_PANDA",
        organisation_key: "domain:acme.test",
        product_scope: "NAGGING_PANDA",
        recommendation_fingerprint: "fp-np",
        decision_type: "CONTEXT_ADDED",
        operator_note: "NP-only context",
        decision_context_snapshot: {
          recommended_contact_id: PG_CONTACT,
          deal_ids: [PG_DEAL],
        },
      }),
    );
    const result = await writeContextNotesToZoho(
      decision,
      { contact_ids: [PG_CONTACT], deal_ids: [NP_DEAL] },
      writer,
    );
    assert.equal(result.contact.ok, true);
    assert.equal(result.deal.skipped, true);
    assert.equal(dealWritten, false);
    delete process.env.ZOHO_WRITE_ENABLED;
  });
});

test("missing deal does not prevent Contact Note", async () => {
  await withStores(async () => {
    process.env.ZOHO_WRITE_ENABLED = "true";
    const writer: ZohoNoteWriter = {
      async createNote(input) {
        assert.equal(input.parentModule, "Contacts");
        return { ok: true, noteId: "note-contact-only" };
      },
    };
    const decision = createOperatorDecision(
      parseOperatorDecisionInput({
        watch_item_id: "org:PORTAL_GENIE",
        organisation_key: "domain:acme.test",
        product_scope: "PORTAL_GENIE",
        recommendation_fingerprint: "fp-1",
        decision_type: "CONTEXT_ADDED",
        operator_note: RUSHAAN_CONTEXT,
        decision_context_snapshot: { recommended_contact_id: PG_CONTACT, deal_ids: [] },
      }),
    );
    const result = await writeContextNotesToZoho(decision, ZOHO_WRITE, writer);
    assert.equal(result.contact.ok, true);
    assert.equal(result.deal.skipped, true);
    assert.equal(result.ok, true);
    delete process.env.ZOHO_WRITE_ENABLED;
  });
});

test("missing Contact does not prevent exact Deal Note", async () => {
  await withStores(async () => {
    process.env.ZOHO_WRITE_ENABLED = "true";
    const writer: ZohoNoteWriter = {
      async createNote(input) {
        assert.equal(input.parentModule, "Deals");
        return { ok: true, noteId: "note-deal-only" };
      },
    };
    const decision = createOperatorDecision(
      parseOperatorDecisionInput({
        watch_item_id: "org:PORTAL_GENIE",
        organisation_key: "domain:acme.test",
        product_scope: "PORTAL_GENIE",
        recommendation_fingerprint: "fp-1",
        decision_type: "CONTEXT_ADDED",
        operator_note: RUSHAAN_CONTEXT,
        decision_context_snapshot: { deal_ids: [PG_DEAL] },
      }),
    );
    const result = await writeContextNotesToZoho(
      decision,
      { deal_ids: [PG_DEAL] },
      writer,
    );
    assert.equal(result.contact.ok, false);
    assert.equal(result.deal.ok, true);
    assert.equal(result.ok, false);
    delete process.env.ZOHO_WRITE_ENABLED;
  });
});

test("contact success with deal failure keeps partial success retriable", async () => {
  await withStores(async () => {
    process.env.ZOHO_WRITE_ENABLED = "true";
    const writer: ZohoNoteWriter = {
      async createNote(input) {
        if (input.parentModule === "Contacts") return { ok: true, noteId: "note-contact-partial" };
        return { ok: false, error: "Deal write failed" };
      },
    };
    const decision = createOperatorDecision(
      parseOperatorDecisionInput({
        watch_item_id: "org:PORTAL_GENIE",
        organisation_key: "domain:acme.test",
        product_scope: "PORTAL_GENIE",
        recommendation_fingerprint: "fp-1",
        decision_type: "CONTEXT_ADDED",
        operator_note: RUSHAAN_CONTEXT,
        decision_context_snapshot: { recommended_contact_id: PG_CONTACT, deal_ids: [PG_DEAL] },
      }),
    );
    const first = await writeContextNotesToZoho(decision, ZOHO_WRITE, writer);
    assert.equal(first.contact.ok, true);
    assert.equal(first.deal.ok, false);
    assert.equal(first.ok, false);

    const saved = attachOperatorDecisionContextZohoNotes(decision.id, {
      contact_zoho_note_id: first.contact.noteId,
    });
    let dealCalls = 0;
    const retryWriter: ZohoNoteWriter = {
      async createNote(input) {
        if (input.parentModule === "Contacts") throw new Error("Contact note must not be duplicated");
        dealCalls += 1;
        return { ok: true, noteId: "note-deal-retry" };
      },
    };
    const retried = await writeContextNotesToZoho(getOperatorDecision(saved.id)!, ZOHO_WRITE, retryWriter);
    assert.equal(dealCalls, 1);
    assert.equal(retried.contact.attempted, false);
    assert.equal(retried.deal.ok, true);
    assert.equal(retried.ok, true);
    delete process.env.ZOHO_WRITE_ENABLED;
  });
});

test("deal success with contact failure allows contact-only retry", async () => {
  await withStores(async () => {
    process.env.ZOHO_WRITE_ENABLED = "true";
    const writer: ZohoNoteWriter = {
      async createNote(input) {
        if (input.parentModule === "Contacts") return { ok: false, error: "Contact write failed" };
        return { ok: true, noteId: "note-deal-partial" };
      },
    };
    const decision = createOperatorDecision(
      parseOperatorDecisionInput({
        watch_item_id: "org:PORTAL_GENIE",
        organisation_key: "domain:acme.test",
        product_scope: "PORTAL_GENIE",
        recommendation_fingerprint: "fp-1",
        decision_type: "CONTEXT_ADDED",
        operator_note: RUSHAAN_CONTEXT,
        decision_context_snapshot: { recommended_contact_id: PG_CONTACT, deal_ids: [PG_DEAL] },
      }),
    );
    const first = await writeContextNotesToZoho(decision, ZOHO_WRITE, writer);
    assert.equal(first.contact.ok, false);
    assert.equal(first.deal.ok, true);
    assert.equal(first.ok, false);

    const saved = attachOperatorDecisionContextZohoNotes(decision.id, {
      deal_zoho_note_id: first.deal.noteId,
    });
    let contactCalls = 0;
    const retryWriter: ZohoNoteWriter = {
      async createNote(input) {
        if (input.parentModule === "Deals") throw new Error("Deal note must not be duplicated");
        contactCalls += 1;
        return { ok: true, noteId: "note-contact-retry" };
      },
    };
    const retried = await writeContextNotesToZoho(getOperatorDecision(saved.id)!, ZOHO_WRITE, retryWriter);
    assert.equal(contactCalls, 1);
    assert.equal(retried.deal.attempted, false);
    assert.equal(retried.contact.ok, true);
    assert.equal(retried.ok, true);
    delete process.env.ZOHO_WRITE_ENABLED;
  });
});

test("successful context notes are not duplicated on retry", async () => {
  await withStores(async () => {
    process.env.ZOHO_WRITE_ENABLED = "true";
    let calls = 0;
    const writer: ZohoNoteWriter = {
      async createNote() {
        calls += 1;
        return {
          ok: true,
          noteId: calls === 1 ? "note-context-contact-dup" : "note-context-deal-dup",
        };
      },
    };
    const decision = createOperatorDecision(
      parseOperatorDecisionInput({
        watch_item_id: "org:PORTAL_GENIE",
        organisation_key: "domain:acme.test",
        product_scope: "PORTAL_GENIE",
        recommendation_fingerprint: "fp-1",
        decision_type: "CONTEXT_ADDED",
        operator_note: RUSHAAN_CONTEXT,
        decision_context_snapshot: { recommended_contact_id: PG_CONTACT, deal_ids: [PG_DEAL] },
      }),
    );
    const first = await writeContextNotesToZoho(decision, ZOHO_WRITE, writer);
    assert.equal(calls, 2);
    const saved = attachOperatorDecisionContextZohoNotes(decision.id, {
      contact_zoho_note_id: first.contact.noteId,
      deal_zoho_note_id: first.deal.noteId,
    });
    const retried = await writeContextNotesToZoho(getOperatorDecision(saved.id)!, ZOHO_WRITE, writer);
    assert.equal(calls, 2);
    assert.equal(retried.contact.attempted, false);
    assert.equal(retried.deal.attempted, false);
    assert.equal(retried.ok, true);
    delete process.env.ZOHO_WRITE_ENABLED;
  });
});

test("salesEngineWrittenZohoNoteIds collects contact and deal context note ids", () => {
  withStores(() => {
    createOperatorDecision(
      parseOperatorDecisionInput({
        watch_item_id: "org:PORTAL_GENIE",
        organisation_key: "domain:acme.test",
        product_scope: "PORTAL_GENIE",
        recommendation_fingerprint: "fp-1",
        decision_type: "CONTEXT_ADDED",
        operator_note: RUSHAAN_CONTEXT,
      }),
    );
    const decision = createOperatorDecision(
      parseOperatorDecisionInput({
        watch_item_id: "org:PORTAL_GENIE",
        organisation_key: "domain:acme.test",
        product_scope: "PORTAL_GENIE",
        recommendation_fingerprint: "fp-2",
        decision_type: "CONTEXT_ADDED",
        operator_note: "Other context",
      }),
    );
    attachOperatorDecisionContextZohoNotes(decision.id, {
      contact_zoho_note_id: "note-contact-exclude",
      deal_zoho_note_id: "note-deal-exclude",
    });
    const ids = salesEngineWrittenZohoNoteIds();
    assert.equal(ids.has("note-contact-exclude"), true);
    assert.equal(ids.has("note-deal-exclude"), true);
  });
});

test("ambiguous deal in snapshot does not write deal note but contact still writes", async () => {
  await withStores(async () => {
    process.env.ZOHO_WRITE_ENABLED = "true";
    let dealCalls = 0;
    const writer: ZohoNoteWriter = {
      async createNote(input) {
        if (input.parentModule === "Deals") dealCalls += 1;
        return { ok: true, noteId: `note-${input.parentModule}-1` };
      },
    };
    const decision = createOperatorDecision(
      parseOperatorDecisionInput({
        watch_item_id: "org:PORTAL_GENIE",
        organisation_key: "domain:acme.test",
        product_scope: "PORTAL_GENIE",
        recommendation_fingerprint: "fp-1",
        decision_type: "CONTEXT_ADDED",
        operator_note: RUSHAAN_CONTEXT,
        decision_context_snapshot: {
          recommended_contact_id: PG_CONTACT,
          deal_ids: [PG_DEAL, NP_DEAL],
        },
      }),
    );
    const result = await writeContextNotesToZoho(
      decision,
      { contact_ids: [PG_CONTACT], deal_ids: [PG_DEAL, NP_DEAL] },
      writer,
    );
    assert.equal(result.contact.ok, true);
    assert.equal(result.deal.skipped, true);
    assert.equal(dealCalls, 0);
    assert.equal(result.ok, true);
    delete process.env.ZOHO_WRITE_ENABLED;
  });
});

test("interaction saved and COMPLETED locally even when Zoho write fails", async () => {
  await withStores(async () => {
    process.env.ZOHO_WRITE_ENABLED = "true";
    _testOnlySetZohoNoteWriter({
      async createNote() {
        return { ok: false, error: "Zoho unavailable" };
      },
    });
    const item = watchItem();
    const fingerprint = recommendationFingerprintFromWatchItem(item);
    await withServer(async (base) => {
      const eventResponse = await fetch(`${base}/api/sales-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organisation_id: item.organisation_id,
          contact_id: item.recommended_contact_id,
          product_scope: item.product_scope,
          event_type: "PHONE_CALL",
          occurred_at: "2026-08-28T10:00:00.000Z",
          summary: "Discussed trial setup",
          zoho_write: ZOHO_WRITE,
        }),
      });
      assert.equal(eventResponse.status, 201);
      const eventBody = (await eventResponse.json()) as { event: { id: string }; zohoWrite: { ok: boolean } };
      assert.equal(eventBody.zohoWrite.ok, false);
      assert.equal(listSalesEvents().length, 1);

      const decisionResponse = await fetch(`${base}/api/operator-decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          watch_item_id: item.id,
          organisation_key: item.organisation_id,
          product_scope: item.product_scope,
          recommendation_fingerprint: fingerprint,
          decision_context_snapshot: decisionContextSnapshotFromWatchItem(item),
          decision_type: "COMPLETED",
          linked_sales_event_id: eventBody.event.id,
        }),
      });
      assert.equal(decisionResponse.status, 201);
      const decisions = listOperatorDecisions({ watch_item_id: item.id });
      assert.equal(decisions.filter((row) => row.decision_type === "COMPLETED").length, 1);
      assert.equal(decisions[0]?.linked_sales_event_id, eventBody.event.id);
    });
    _testOnlySetZohoNoteWriter(undefined);
    delete process.env.ZOHO_WRITE_ENABLED;
  });
});

test("failed Zoho interaction write does not leave recommendation actionable", async () => {
  await withStores(async () => {
    process.env.ZOHO_WRITE_ENABLED = "true";
    _testOnlySetZohoNoteWriter({
      async createNote() {
        return { ok: false, error: "Zoho unavailable" };
      },
    });
    const item = watchItem();
    const event = createSalesEvent(
      parseSalesEventInput({
        organisation_id: item.organisation_id,
        contact_id: item.recommended_contact_id,
        product_scope: item.product_scope,
        event_type: "PHONE_CALL",
        occurred_at: "2026-08-28T10:00:00.000Z",
        summary: "Call summary",
      }),
    );
    const decision = createOperatorDecision(
      parseOperatorDecisionInput({
        watch_item_id: item.id,
        organisation_key: item.organisation_id,
        product_scope: item.product_scope,
        recommendation_fingerprint: recommendationFingerprintFromWatchItem(item),
        decision_context_snapshot: decisionContextSnapshotFromWatchItem(item),
        effective_from: "2026-01-01T00:00:00.000Z",
        decision_type: "COMPLETED",
        linked_sales_event_id: event.id,
      }),
    );
    const controlled = applyOperatorControlToWatchItem(item, [decision], {
      asOf: AS_OF,
      evidence_fingerprint: "fp-1",
      deal_ids: item.deal_ids,
      retrieval_ok: true,
    });
    assert.equal(isCustomerExecutableBriefItem(controlled), false);
    assert.equal(controlled.operator_control?.controlled, true);
    assert.equal(controlled.operator_control?.primary_decision_type, "COMPLETED");
    _testOnlySetZohoNoteWriter(undefined);
    delete process.env.ZOHO_WRITE_ENABLED;
  });
});

test("retry-zoho does not duplicate SalesEvent or COMPLETED decision", async () => {
  await withStores(async () => {
    process.env.ZOHO_WRITE_ENABLED = "true";
    let calls = 0;
    _testOnlySetZohoNoteWriter({
      async createNote() {
        calls += 1;
        if (calls === 1) return { ok: false, error: "Zoho unavailable" };
        return { ok: true, noteId: "note-interaction-retry-1" };
      },
    });
    const item = watchItem();
    const fingerprint = recommendationFingerprintFromWatchItem(item);
    await withServer(async (base) => {
      const eventResponse = await fetch(`${base}/api/sales-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organisation_id: item.organisation_id,
          contact_id: item.recommended_contact_id,
          product_scope: item.product_scope,
          event_type: "PHONE_CALL",
          occurred_at: "2026-08-28T10:00:00.000Z",
          summary: "Discussed trial setup",
          zoho_write: ZOHO_WRITE,
        }),
      });
      const eventBody = (await eventResponse.json()) as { event: { id: string } };
      await fetch(`${base}/api/operator-decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          watch_item_id: item.id,
          organisation_key: item.organisation_id,
          product_scope: item.product_scope,
          recommendation_fingerprint: fingerprint,
          decision_context_snapshot: decisionContextSnapshotFromWatchItem(item),
          decision_type: "COMPLETED",
          linked_sales_event_id: eventBody.event.id,
        }),
      });
      assert.equal(listSalesEvents().length, 1);
      assert.equal(listOperatorDecisions({ watch_item_id: item.id }).filter((row) => row.decision_type === "COMPLETED").length, 1);

      const retryResponse = await fetch(`${base}/api/sales-events/${encodeURIComponent(eventBody.event.id)}/retry-zoho`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zoho_write: ZOHO_WRITE }),
      });
      assert.equal(retryResponse.status, 200);
      const retried = (await retryResponse.json()) as { event: { id: string; zoho_note_id?: string } };
      assert.equal(listSalesEvents().length, 1);
      assert.equal(listOperatorDecisions({ watch_item_id: item.id }).filter((row) => row.decision_type === "COMPLETED").length, 1);
      assert.equal(retried.event.id, eventBody.event.id);
      assert.equal(retried.event.zoho_note_id, "note-interaction-retry-1");
      assert.equal(getSalesEvent(eventBody.event.id)?.zoho_note_id, "note-interaction-retry-1");
    });
    _testOnlySetZohoNoteWriter(undefined);
    delete process.env.ZOHO_WRITE_ENABLED;
  });
});

test("context remains available locally when Zoho write fails", async () => {
  await withStores(async () => {
    process.env.ZOHO_WRITE_ENABLED = "true";
    _testOnlySetZohoNoteWriter({
      async createNote() {
        return { ok: false, error: "Zoho unavailable" };
      },
    });
    const item = watchItem();
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/operator-decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          watch_item_id: item.id,
          organisation_key: item.organisation_id,
          product_scope: item.product_scope,
          recommendation_fingerprint: recommendationFingerprintFromWatchItem(item),
          decision_context_snapshot: decisionContextSnapshotFromWatchItem(item),
          decision_type: "CONTEXT_ADDED",
          operator_note: "Sarah is the decision maker.",
          zoho_write: ZOHO_WRITE,
        }),
      });
      assert.equal(response.status, 201);
      const body = (await response.json()) as {
        decision: { id: string; operator_note?: string; decision_type: string };
        zohoWrite: { ok: boolean };
      };
      assert.equal(body.zohoWrite.ok, false);
      assert.equal(body.decision.decision_type, "CONTEXT_ADDED");
      assert.equal(body.decision.operator_note, "Sarah is the decision maker.");
      const stored = listOperatorDecisions({ watch_item_id: item.id }).filter((row) => row.decision_type === "CONTEXT_ADDED");
      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.operator_note, "Sarah is the decision maker.");
    });
    _testOnlySetZohoNoteWriter(undefined);
    delete process.env.ZOHO_WRITE_ENABLED;
  });
});

test("successful context retry-zoho attaches Zoho note id without duplicating decision", async () => {
  await withStores(async () => {
    process.env.ZOHO_WRITE_ENABLED = "true";
    let calls = 0;
    _testOnlySetZohoNoteWriter({
      async createNote(input) {
        calls += 1;
        if (calls <= 2) return { ok: false, error: "Zoho unavailable" };
        return {
          ok: true,
          noteId: input.parentModule === "Contacts" ? "note-context-contact-retry" : "note-context-deal-retry",
        };
      },
    });
    const item = watchItem();
    await withServer(async (base) => {
      const createResponse = await fetch(`${base}/api/operator-decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          watch_item_id: item.id,
          organisation_key: item.organisation_id,
          product_scope: item.product_scope,
          recommendation_fingerprint: recommendationFingerprintFromWatchItem(item),
          decision_context_snapshot: decisionContextSnapshotFromWatchItem(item),
          decision_type: "CONTEXT_ADDED",
          operator_note: RUSHAAN_CONTEXT,
          zoho_write: ZOHO_WRITE,
        }),
      });
      const created = (await createResponse.json()) as { decision: { id: string }; zohoWrite: { ok: boolean } };
      assert.equal(created.zohoWrite.ok, false);
      assert.equal(listOperatorDecisions({ watch_item_id: item.id }).filter((row) => row.decision_type === "CONTEXT_ADDED").length, 1);
      assert.equal(getOperatorDecision(created.decision.id)?.operator_note, RUSHAAN_CONTEXT);

      const retryResponse = await fetch(`${base}/api/operator-decisions/${encodeURIComponent(created.decision.id)}/retry-zoho`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zoho_write: ZOHO_WRITE }),
      });
      assert.equal(retryResponse.status, 200);
      const retried = (await retryResponse.json()) as {
        decision: { id: string; contact_zoho_note_id?: string; deal_zoho_note_id?: string; zoho_note_id?: string };
        zohoWrite: { ok: boolean };
      };
      assert.equal(listOperatorDecisions({ watch_item_id: item.id }).filter((row) => row.decision_type === "CONTEXT_ADDED").length, 1);
      assert.equal(retried.decision.id, created.decision.id);
      assert.equal(retried.zohoWrite.ok, true);
      assert.equal(retried.decision.contact_zoho_note_id, "note-context-contact-retry");
      assert.equal(retried.decision.deal_zoho_note_id, "note-context-deal-retry");
      assert.equal(retried.decision.zoho_note_id, "note-context-contact-retry");
      assert.equal(calls, 4);
    });
    _testOnlySetZohoNoteWriter(undefined);
    delete process.env.ZOHO_WRITE_ENABLED;
  });
});
