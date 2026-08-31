import type { OperatorDecision } from "../../domain/operator-decision.js";
import type { SalesEvent } from "../../domain/sales-event.js";
import { listOperatorDecisions } from "../../intelligence/operator-decision-store.js";
import { listSalesEvents } from "../../intelligence/sales-event-store.js";
import { SALES_ENGINE_NOTE_TITLES } from "./constants.js";
import type { ZohoNoteWriter } from "./write-client.js";
import { parseZohoWriteContext, resolveZohoWriteTarget, type ZohoWriteContext } from "./write-target.js";

export type ZohoWriteAttempt = {
  attempted: boolean;
  ok: boolean;
  skipped?: boolean;
  noteId?: string;
  error?: string;
  target?: { module: string; recordId: string };
};

let testZohoNoteWriter: ZohoNoteWriter | undefined;

export function _testOnlySetZohoNoteWriter(writer: ZohoNoteWriter | undefined): void {
  testZohoNoteWriter = writer;
}

export function resolveZohoNoteWriter(production?: ZohoNoteWriter): ZohoNoteWriter | undefined {
  return testZohoNoteWriter ?? production;
}

export function zohoWriteEnabled(): boolean {
  return process.env.ZOHO_WRITE_ENABLED === "true";
}

export function salesEngineWrittenZohoNoteIds(): Set<string> {
  const ids = new Set<string>();
  for (const event of listSalesEvents()) {
    if (event.zoho_note_id) ids.add(event.zoho_note_id);
  }
  for (const decision of listOperatorDecisions()) {
    if (decision.zoho_note_id) ids.add(decision.zoho_note_id);
  }
  return ids;
}

export function formatInteractionNoteContent(event: SalesEvent): string {
  const lines = [
    `Product: ${event.product_scope.replaceAll("_", " ")}`,
    `Type: ${event.event_type.replaceAll("_", " ")}`,
    event.contact_name ? `Contact: ${event.contact_name}` : undefined,
    event.outcome ? `Outcome: ${event.outcome.replaceAll("_", " ")}` : undefined,
    `When: ${event.occurred_at}`,
    "",
    event.summary,
    event.next_step ? `\nNext step: ${event.next_step}` : undefined,
    event.follow_up_date ? `\nFollow-up date: ${event.follow_up_date}` : undefined,
  ].filter(Boolean);
  return lines.join("\n");
}

function skippedAttempt(reason: string): ZohoWriteAttempt {
  return { attempted: false, ok: false, skipped: true, error: reason };
}

export async function writeInteractionNoteToZoho(
  event: SalesEvent,
  context: ZohoWriteContext | undefined,
  writer: ZohoNoteWriter | undefined,
): Promise<ZohoWriteAttempt> {
  if (event.zoho_note_id) {
    return { attempted: false, ok: true, noteId: event.zoho_note_id };
  }
  if (!zohoWriteEnabled()) {
    return skippedAttempt("Zoho write-back is disabled.");
  }
  if (!writer) {
    return { attempted: true, ok: false, error: "Zoho write client is unavailable." };
  }

  const target = resolveZohoWriteTarget({
    organisation_key: event.organisation_id,
    contact_id: event.contact_id,
    ...context,
  });
  if (!target) {
    return {
      attempted: true,
      ok: false,
      error: "No exact Zoho parent record is available for this interaction.",
    };
  }

  const result = await writer.createNote({
    parentModule: target.module,
    parentRecordId: target.recordId,
    title: SALES_ENGINE_NOTE_TITLES.interaction,
    content: formatInteractionNoteContent(event),
  });

  if (!result.ok) {
    return {
      attempted: true,
      ok: false,
      error: result.error ?? "Zoho note write failed.",
      target,
    };
  }

  return {
    attempted: true,
    ok: true,
    noteId: result.noteId,
    target,
  };
}

export async function writeContextNoteToZoho(
  decision: OperatorDecision,
  context: ZohoWriteContext | undefined,
  writer: ZohoNoteWriter | undefined,
): Promise<ZohoWriteAttempt> {
  if (decision.zoho_note_id) {
    return { attempted: false, ok: true, noteId: decision.zoho_note_id };
  }
  if (decision.decision_type !== "CONTEXT_ADDED") {
    return skippedAttempt("Only operator context is written to Zoho Notes.");
  }
  if (!zohoWriteEnabled()) {
    return skippedAttempt("Zoho write-back is disabled.");
  }
  if (!writer) {
    return { attempted: true, ok: false, error: "Zoho write client is unavailable." };
  }
  if (!decision.operator_note?.trim()) {
    return { attempted: true, ok: false, error: "Operator context note is empty." };
  }

  const snapshot = decision.decision_context_snapshot;
  const target = resolveZohoWriteTarget({
    organisation_key: decision.organisation_key,
    contact_id: snapshot?.recommended_contact_id,
    source_record: context?.source_record,
    contact_ids: context?.contact_ids,
    lead_ids: context?.lead_ids,
    account_id: context?.account_id,
  });
  if (!target) {
    return {
      attempted: true,
      ok: false,
      error: "No exact Zoho parent record is available for this context note.",
    };
  }

  const result = await writer.createNote({
    parentModule: target.module,
    parentRecordId: target.recordId,
    title: SALES_ENGINE_NOTE_TITLES.context,
    content: decision.operator_note.trim(),
  });

  if (!result.ok) {
    return {
      attempted: true,
      ok: false,
      error: result.error ?? "Zoho note write failed.",
      target,
    };
  }

  return {
    attempted: true,
    ok: true,
    noteId: result.noteId,
    target,
  };
}

export { parseZohoWriteContext };
