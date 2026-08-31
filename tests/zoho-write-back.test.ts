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
import { resolveZohoWriteTarget } from "../src/integrations/zoho/write-target.js";
import {
  _testOnlySetZohoNoteWriter,
  formatInteractionNoteContent,
  writeContextNoteToZoho,
  writeInteractionNoteToZoho,
  zohoWriteEnabled,
} from "../src/integrations/zoho/write-back.js";
import { isCustomerExecutableBriefItem } from "../src/intelligence/daily-brief.js";
import { attachOperatorDecisionZohoNote, createOperatorDecision, listOperatorDecisions } from "../src/intelligence/operator-decision-store.js";
import { attachSalesEventZohoNote, createSalesEvent, getSalesEvent, listSalesEvents } from "../src/intelligence/sales-event-store.js";
import { applyOperatorControlToWatchItem } from "../src/intelligence/watch-item-control.js";
import { handleRequest } from "../src/server/app.js";
import type { ZohoNoteWriter } from "../src/integrations/zoho/write-client.js";

const AS_OF = "2026-08-28T12:00:00.000Z";
const ZOHO_WRITE = {
  contact_ids: ["5290417000031698001"],
  source_record: { module: "Contacts", recordId: "5290417000031698001" },
};

function watchItem(): CommercialWatchItem {
  return {
    id: "domain:acme.test:PORTAL_GENIE",
    organisation_id: "domain:acme.test",
    organisation_name: "Acme Accounting",
    product_scope: "PORTAL_GENIE",
    relationship_state: "ENGAGED_PROSPECT",
    recommended_contact_id: "5290417000031698001",
    deal_ids: ["deal-1"],
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
    assert.equal(updated.zoho_note_id, "note-context-99");
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
      async createNote() {
        calls += 1;
        if (calls === 1) return { ok: false, error: "Zoho unavailable" };
        return { ok: true, noteId: "note-context-retry-1" };
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
          operator_note: "Sarah is the decision maker.",
          zoho_write: ZOHO_WRITE,
        }),
      });
      const created = (await createResponse.json()) as { decision: { id: string } };
      assert.equal(listOperatorDecisions({ watch_item_id: item.id }).filter((row) => row.decision_type === "CONTEXT_ADDED").length, 1);

      const retryResponse = await fetch(`${base}/api/operator-decisions/${encodeURIComponent(created.decision.id)}/retry-zoho`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zoho_write: ZOHO_WRITE }),
      });
      assert.equal(retryResponse.status, 200);
      const retried = (await retryResponse.json()) as { decision: { id: string; zoho_note_id?: string } };
      assert.equal(listOperatorDecisions({ watch_item_id: item.id }).filter((row) => row.decision_type === "CONTEXT_ADDED").length, 1);
      assert.equal(retried.decision.id, created.decision.id);
      assert.equal(retried.decision.zoho_note_id, "note-context-retry-1");
    });
    _testOnlySetZohoNoteWriter(undefined);
    delete process.env.ZOHO_WRITE_ENABLED;
  });
});
