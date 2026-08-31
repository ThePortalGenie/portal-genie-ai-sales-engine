import type { OperatorDecision } from "../../domain/operator-decision.js";
import type { SalesEvent } from "../../domain/sales-event.js";
import { listOperatorDecisions } from "../../intelligence/operator-decision-store.js";
import { listSalesEvents } from "../../intelligence/sales-event-store.js";
import { SALES_ENGINE_NOTE_TITLES } from "./constants.js";
import type { ZohoNoteWriter } from "./write-client.js";
import {
  parseZohoWriteContext,
  resolveContextContactTarget,
  resolveContextDealTarget,
  resolveZohoWriteTarget,
  type ZohoWriteContext,
} from "./write-target.js";

export type ZohoWriteAttempt = {
  attempted: boolean;
  ok: boolean;
  skipped?: boolean;
  noteId?: string;
  error?: string;
  target?: { module: string; recordId: string };
};

export type ContextZohoWriteResult = {
  attempted: boolean;
  ok: boolean;
  contact: ZohoWriteAttempt;
  deal: ZohoWriteAttempt;
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

function contextContactNoteId(decision: OperatorDecision): string | undefined {
  return decision.contact_zoho_note_id ?? decision.zoho_note_id;
}

export function salesEngineWrittenZohoNoteIds(): Set<string> {
  const ids = new Set<string>();
  for (const event of listSalesEvents()) {
    if (event.zoho_note_id) ids.add(event.zoho_note_id);
  }
  for (const decision of listOperatorDecisions()) {
    if (decision.contact_zoho_note_id) ids.add(decision.contact_zoho_note_id);
    if (decision.deal_zoho_note_id) ids.add(decision.deal_zoho_note_id);
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

function aggregateContextWrite(contact: ZohoWriteAttempt, deal: ZohoWriteAttempt): ContextZohoWriteResult {
  const attempted = contact.attempted || deal.attempted;
  const ok = (!contact.attempted || contact.ok) && (!deal.attempted || deal.ok);
  return { attempted, ok, contact, deal };
}

async function writeNoteToTarget(
  writer: ZohoNoteWriter,
  target: { module: string; recordId: string },
  title: string,
  content: string,
): Promise<ZohoWriteAttempt> {
  const result = await writer.createNote({
    parentModule: target.module,
    parentRecordId: target.recordId,
    title,
    content,
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

  return writeNoteToTarget(writer, target, SALES_ENGINE_NOTE_TITLES.interaction, formatInteractionNoteContent(event));
}

export async function writeContextNotesToZoho(
  decision: OperatorDecision,
  context: ZohoWriteContext | undefined,
  writer: ZohoNoteWriter | undefined,
): Promise<ContextZohoWriteResult> {
  const existingContact = contextContactNoteId(decision);
  const existingDeal = decision.deal_zoho_note_id;

  if (decision.decision_type !== "CONTEXT_ADDED") {
    return aggregateContextWrite(
      skippedAttempt("Only operator context is written to Zoho Notes."),
      skippedAttempt("Only operator context is written to Zoho Notes."),
    );
  }
  if (!zohoWriteEnabled()) {
    const skipped = skippedAttempt("Zoho write-back is disabled.");
    return aggregateContextWrite(skipped, skipped);
  }
  if (!writer) {
    const failed = { attempted: true, ok: false, error: "Zoho write client is unavailable." };
    return aggregateContextWrite(failed, failed);
  }
  if (!decision.operator_note?.trim()) {
    const failed = { attempted: true, ok: false, error: "Operator context note is empty." };
    return aggregateContextWrite(failed, failed);
  }

  const content = decision.operator_note.trim();
  const title = SALES_ENGINE_NOTE_TITLES.context;

  let contactAttempt: ZohoWriteAttempt;
  if (existingContact) {
    contactAttempt = { attempted: false, ok: true, noteId: existingContact };
  } else {
    const contactTarget = resolveContextContactTarget(
      decision.decision_context_snapshot,
      context,
      decision.organisation_key,
    );
    if (!contactTarget) {
      contactAttempt = {
        attempted: true,
        ok: false,
        error: "No exact Zoho Contact is available for this context note.",
      };
    } else {
      contactAttempt = await writeNoteToTarget(writer, contactTarget, title, content);
    }
  }

  let dealAttempt: ZohoWriteAttempt;
  if (existingDeal) {
    dealAttempt = { attempted: false, ok: true, noteId: existingDeal };
  } else {
    const dealResolution = resolveContextDealTarget(decision.decision_context_snapshot, context);
    if (dealResolution.skipped || !dealResolution.target) {
      dealAttempt = skippedAttempt(dealResolution.reason ?? "No exact deal id is available for this product.");
    } else {
      dealAttempt = await writeNoteToTarget(writer, dealResolution.target, title, content);
    }
  }

  return aggregateContextWrite(contactAttempt, dealAttempt);
}

/** @deprecated Use writeContextNotesToZoho for dual Contact + Deal writes. */
export async function writeContextNoteToZoho(
  decision: OperatorDecision,
  context: ZohoWriteContext | undefined,
  writer: ZohoNoteWriter | undefined,
): Promise<ZohoWriteAttempt> {
  const result = await writeContextNotesToZoho(decision, context, writer);
  if (result.contact.attempted) return result.contact;
  if (result.deal.attempted) return result.deal;
  return result.contact.skipped ? result.contact : result.deal;
}

export { parseZohoWriteContext };
