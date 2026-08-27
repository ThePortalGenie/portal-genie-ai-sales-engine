import { randomUUID } from "node:crypto";

export const SALES_EVENT_PRODUCT_SCOPES = [
  "PORTAL_GENIE",
  "NAGGING_PANDA",
  "ORGANISATION_GENERAL",
  "BOTH",
] as const;
export type SalesEventProductScope = (typeof SALES_EVENT_PRODUCT_SCOPES)[number];

export const SALES_EVENT_TYPES = [
  "PHONE_CALL",
  "EMAIL",
  "MEETING",
  "DEMO",
  "WHATSAPP",
  "IN_PERSON",
  "ROADSHOW",
  "FOLLOW_UP",
  "NO_SHOW",
  "INTERNAL_NOTE",
  "OTHER",
] as const;
export type SalesEventType = (typeof SALES_EVENT_TYPES)[number];

export const SALES_EVENT_OUTCOMES = [
  "CONNECTED",
  "NO_ANSWER",
  "VOICEMAIL",
  "REPLIED",
  "NO_REPLY",
  "MEETING_COMPLETED",
  "MEETING_NO_SHOW",
  "MEETING_RESCHEDULED",
  "INTERESTED",
  "DECISION_PENDING",
  "FOLLOW_UP_REQUESTED",
  "NOT_INTERESTED",
  "REGISTERED",
  "ACTIVATED",
  "CUSTOMER",
  "PARTNER_CONFIRMED",
  "LOST",
  "OTHER",
] as const;
export type SalesEventOutcome = (typeof SALES_EVENT_OUTCOMES)[number];

export const SALES_EVENT_SOURCE = "OPERATOR_ENTERED_SALES_EVENT" as const;

export type SalesEvent = {
  id: string;
  organisation_id: string;
  contact_id?: string;
  contact_name?: string;
  product_scope: SalesEventProductScope;
  event_type: SalesEventType;
  occurred_at: string;
  outcome?: SalesEventOutcome;
  summary: string;
  next_step?: string;
  follow_up_date?: string;
  created_at: string;
  updated_at?: string;
  source: typeof SALES_EVENT_SOURCE;
  confidence: "HIGH";
  provenance: "OPERATOR_ENTERED_SALES_EVENT";
};

export class SalesEventValidationError extends Error {
  readonly code = "SALES_EVENT_VALIDATION_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "SalesEventValidationError";
  }
}

function requireEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new SalesEventValidationError(`${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function optionalEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireEnum(value, field, allowed);
}

function requireIsoDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new SalesEventValidationError(`${field} must be a valid date/time`);
  }
  return new Date(value).toISOString();
}

function optionalIsoDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new SalesEventValidationError(`${field} must be a valid date`);
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const parsed = Date.parse(`${trimmed}T00:00:00Z`);
    if (Number.isNaN(parsed)) throw new SalesEventValidationError(`${field} must be a valid date`);
    return trimmed;
  }
  return requireIsoDate(trimmed, field);
}

function optionalString(value: unknown, max = 4000): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function clearableString(value: unknown, existing: string | undefined, max: number): string | undefined {
  if (value === "" || value === null) return undefined;
  if (value === undefined) return existing;
  return optionalString(value, max) ?? existing;
}

export type SalesEventInput = {
  organisation_id?: unknown;
  contact_id?: unknown;
  contact_name?: unknown;
  product_scope?: unknown;
  event_type?: unknown;
  occurred_at?: unknown;
  outcome?: unknown;
  summary?: unknown;
  next_step?: unknown;
  follow_up_date?: unknown;
  id?: unknown;
};

export function parseSalesEventInput(input: SalesEventInput, existing?: SalesEvent): SalesEvent {
  const organisation_id = optionalString(input.organisation_id, 200) ?? existing?.organisation_id;
  if (!organisation_id) throw new SalesEventValidationError("organisation_id is required");
  const summary = optionalString(input.summary, 4000) ?? existing?.summary;
  if (!summary) throw new SalesEventValidationError("summary is required");
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? (typeof input.id === "string" && input.id.trim() ? input.id.trim() : `se-${randomUUID()}`),
    organisation_id,
    contact_id: clearableString(input.contact_id, existing?.contact_id, 80),
    contact_name: clearableString(input.contact_name, existing?.contact_name, 200),
    product_scope: requireEnum(input.product_scope ?? existing?.product_scope, "product_scope", SALES_EVENT_PRODUCT_SCOPES),
    event_type: requireEnum(input.event_type ?? existing?.event_type, "event_type", SALES_EVENT_TYPES),
    occurred_at: requireIsoDate(input.occurred_at ?? existing?.occurred_at, "occurred_at"),
    outcome: optionalEnum(input.outcome !== undefined ? input.outcome : existing?.outcome, "outcome", SALES_EVENT_OUTCOMES),
    summary,
    next_step: optionalString(input.next_step, 500) ?? (input.next_step === "" ? undefined : existing?.next_step),
    follow_up_date:
      input.follow_up_date === "" ? undefined : optionalIsoDate(input.follow_up_date ?? existing?.follow_up_date, "follow_up_date"),
    created_at: existing?.created_at ?? now,
    updated_at: existing ? now : undefined,
    source: SALES_EVENT_SOURCE,
    confidence: "HIGH",
    provenance: "OPERATOR_ENTERED_SALES_EVENT",
  };
}

export function eventAppliesToProduct(event: SalesEvent, product: "PORTAL_GENIE" | "NAGGING_PANDA"): boolean {
  if (event.product_scope === "BOTH") return true;
  if (event.product_scope === "ORGANISATION_GENERAL") return false;
  return event.product_scope === product;
}

export function followUpDue(followUpDate: string | undefined, asOf: string): boolean | undefined {
  if (!followUpDate) return undefined;
  const due = Date.parse(followUpDate.length === 10 ? `${followUpDate}T00:00:00Z` : followUpDate);
  const now = Date.parse(asOf);
  if (Number.isNaN(due) || Number.isNaN(now)) return undefined;
  return now >= due;
}

export function organisationKey(options: {
  domains?: string[];
  zohoAccountId?: string;
  portalGenieOrgId?: string;
  selectedModule?: string;
  selectedRecordId?: string;
}): string {
  const domain = options.domains?.find((item) => item.trim());
  if (domain) return `domain:${domain.trim().toLowerCase()}`;
  if (options.zohoAccountId) return `zoho-account:${options.zohoAccountId}`;
  if (options.portalGenieOrgId) return `pg:${options.portalGenieOrgId}`;
  if (options.selectedModule && options.selectedRecordId) {
    return `contact:${options.selectedModule}:${options.selectedRecordId}`;
  }
  throw new SalesEventValidationError("Unable to derive organisation_id");
}
