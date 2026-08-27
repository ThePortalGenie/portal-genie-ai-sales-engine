import { asJsonObject } from "../integrations/zoho/http.js";
import type { DiscoveryDiagnostic, JsonObject } from "../integrations/zoho/types.js";

export type TimelineEventType =
  | "note"
  | "email_sent"
  | "email_received"
  | "email"
  | "call"
  | "meeting"
  | "task"
  | "deal"
  | "crm_event";

export type TimelineEvent = {
  id: string;
  at: string;
  type: TimelineEventType;
  title: string;
  preview?: string;
  sourceId?: string;
  direction?: "sent" | "received" | "unknown";
  moduleHint?: string;
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstDate(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() && !Number.isNaN(Date.parse(value))) {
      return value;
    }
  }
  return undefined;
}

function previewOf(value: unknown, max = 180): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const stripped = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return stripped.length > max ? `${stripped.slice(0, max)}…` : stripped;
}

const RELATED_ALIASES: Record<string, string[]> = {
  Notes: ["Notes"],
  Deals: ["Deals", "Potentials"],
  Tasks: ["Tasks"],
  Calls: ["Calls"],
  Events: ["Events", "Meetings"],
  Activities_Chronological_View: ["Activities_Chronological_View"],
  Activities_Chronological_View_History: ["Activities_Chronological_View_History"],
};

export function findRelatedRetrieval(diagnostic: DiscoveryDiagnostic, apiName: string) {
  const names = new Set([apiName, ...(RELATED_ALIASES[apiName] ?? [])]);
  const direct = diagnostic.relatedLists.retrievals.find((item) => names.has(item.apiName));
  if (direct) return direct;
  const meta = (diagnostic.relatedLists.available ?? []).find(
    (item) => names.has(item.apiName) || (item.relatedModuleApiName != null && names.has(item.relatedModuleApiName)),
  );
  if (!meta) return undefined;
  return diagnostic.relatedLists.retrievals.find((item) => item.apiName === meta.apiName);
}

function related(diagnostic: DiscoveryDiagnostic, apiName: string): JsonObject[] {
  const retrieval = findRelatedRetrieval(diagnostic, apiName);
  if (!retrieval?.success) return [];
  return retrieval.records;
}

export function buildTimeline(diagnostic: DiscoveryDiagnostic): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const record of related(diagnostic, "Notes")) {
    const at = firstDate(record.Created_Time, record.Modified_Time);
    if (!at) continue;
    events.push({
      id: `note-${String(record.id ?? at)}`,
      at,
      type: "note",
      title: text(record.Note_Title) ?? "Note",
      preview: previewOf(record.Note_Content),
      sourceId: text(record.id),
      moduleHint: "Notes",
    });
  }

  const emails = diagnostic.emails.normalized ?? [];
  if (emails.length > 0) {
    for (const email of emails) {
      if (!email.at || Number.isNaN(Date.parse(email.at))) continue;
      const type: TimelineEventType =
        email.direction === "inbound" ? "email_received" : email.direction === "outbound" ? "email_sent" : "email";
      events.push({
        id: `email-${email.messageId ?? email.at}`,
        at: email.at,
        type,
        title: email.subject ?? "Email",
        preview: email.bodyText ? previewOf(email.bodyText) : undefined,
        sourceId: email.messageId ?? undefined,
        direction:
          email.direction === "inbound" ? "received" : email.direction === "outbound" ? "sent" : "unknown",
        moduleHint: "Emails",
      });
    }
  } else {
    for (const header of diagnostic.emails.headers) {
      if (!header.time || Number.isNaN(Date.parse(header.time))) continue;
      const body = diagnostic.emails.bodies.find((item) => item.messageId === header.messageId);
      const type: TimelineEventType =
        header.sent === true ? "email_sent" : header.sent === false ? "email_received" : "email";
      events.push({
        id: `email-${header.messageId ?? header.time}`,
        at: header.time,
        type,
        title: header.subject ?? "Email",
        preview: body?.contentPreview ?? undefined,
        sourceId: header.messageId ?? undefined,
        direction: header.sent === true ? "sent" : header.sent === false ? "received" : "unknown",
        moduleHint: "Emails",
      });
    }
  }

  for (const record of related(diagnostic, "Calls")) {
    const at = firstDate(record.Call_Start_Time, record.Created_Time);
    if (!at) continue;
    events.push({
      id: `call-${String(record.id ?? at)}`,
      at,
      type: "call",
      title: text(record.Subject) ?? "Call",
      preview: previewOf(record.Description) ?? text(record.Call_Type),
      sourceId: text(record.id),
      moduleHint: "Calls",
    });
  }

  for (const record of related(diagnostic, "Events")) {
    const at = firstDate(record.Start_DateTime, record.Created_Time);
    if (!at) continue;
    events.push({
      id: `meeting-${String(record.id ?? at)}`,
      at,
      type: "meeting",
      title: text(record.Event_Title) ?? text(record.Subject) ?? "Meeting",
      preview: previewOf(record.Description),
      sourceId: text(record.id),
      moduleHint: "Events",
    });
  }

  for (const record of related(diagnostic, "Tasks")) {
    const at = firstDate(record.Created_Time, record.Due_Date);
    if (!at) continue;
    events.push({
      id: `task-${String(record.id ?? at)}`,
      at,
      type: "task",
      title: text(record.Subject) ?? "Task",
      preview: [text(record.Status), previewOf(record.Description)].filter(Boolean).join(" — ") || undefined,
      sourceId: text(record.id),
      moduleHint: "Tasks",
    });
  }

  for (const record of related(diagnostic, "Deals")) {
    const at = firstDate(record.Created_Time, record.Modified_Time);
    if (!at) continue;
    events.push({
      id: `deal-${String(record.id ?? at)}`,
      at,
      type: "deal",
      title: text(record.Deal_Name) ?? "Deal",
      preview: [text(record.Stage), text(record.Amount)].filter(Boolean).join(" · ") || undefined,
      sourceId: text(record.id),
      moduleHint: "Deals",
    });
  }

  for (const listName of ["Activities_Chronological_View", "Activities_Chronological_View_History"]) {
    for (const record of related(diagnostic, listName)) {
      const at = firstDate(record.Call_Start_Time, record.Start_DateTime, record.Created_Time, record.Due_Date);
      if (!at) continue;
      const moduleHint = text(record.$module) ?? "Activity";
      const type: TimelineEventType =
        moduleHint === "Calls" ? "call" : moduleHint === "Events" ? "meeting" : moduleHint === "Tasks" ? "task" : "crm_event";
      const id = `activity-${String(record.id ?? at)}`;
      if (events.some((event) => event.sourceId && event.sourceId === text(record.id))) continue;
      events.push({
        id,
        at,
        type,
        title: text(record.Subject) ?? text(record.Event_Title) ?? moduleHint,
        sourceId: text(record.id),
        moduleHint,
      });
    }
  }

  return events.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
}

export function lookupName(value: unknown): string | undefined {
  const object = asJsonObject(value);
  if (object && typeof object.name === "string") return object.name;
  return typeof value === "string" ? value : undefined;
}
