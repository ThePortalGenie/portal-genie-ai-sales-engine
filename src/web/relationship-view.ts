import type { EmailInteractionFacts, NormalizedEmail } from "../domain/normalized-email.js";
import { asJsonObject } from "../integrations/zoho/http.js";
import type { DiscoveryDiagnostic, JsonObject, ZohoFieldMeta } from "../integrations/zoho/types.js";
import { buildTimeline, findRelatedRetrieval, lookupName, type TimelineEvent } from "./timeline.js";

export type CapabilityStatus = {
  key: string;
  label: string;
  status: "retrieved" | "empty" | "unavailable" | "error";
  count?: number;
  message?: string;
};

export type DisplayField = {
  apiName: string;
  label: string;
  custom: boolean;
  value: unknown;
};

export type RelationshipView = {
  header: {
    name: string;
    company?: string;
    email?: string;
    country?: string;
    module: string;
    id: string;
  };
  overview: DisplayField[];
  capabilities: CapabilityStatus[];
  timeline: TimelineEvent[];
  notes: JsonObject[];
  emails: DiscoveryDiagnostic["emails"];
  normalizedEmails: NormalizedEmail[];
  emailFacts?: EmailInteractionFacts;
  deals: JsonObject[];
  tasks: JsonObject[];
  calls: JsonObject[];
  meetings: JsonObject[];
  tags: unknown;
  account?: JsonObject;
  relatedLists: CapabilityStatus[];
  standardFields: DisplayField[];
  customFields: DisplayField[];
  warnings: string[];
  errors: DiscoveryDiagnostic["errors"];
};

function text(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return lookupName(value);
}

function related(diagnostic: DiscoveryDiagnostic, apiName: string) {
  return findRelatedRetrieval(diagnostic, apiName);
}

function capabilityFromRelated(apiName: string, label: string, diagnostic: DiscoveryDiagnostic): CapabilityStatus {
  const item = related(diagnostic, apiName);
  if (!item) {
    return { key: apiName, label, status: "unavailable", message: `${label} related list was not present in metadata.` };
  }
  if (item.skippedReason) {
    return { key: apiName, label, status: "unavailable", message: item.skippedReason };
  }
  if (!item.attempted) {
    return { key: apiName, label, status: "unavailable", message: "Not attempted." };
  }
  if (!item.success) {
    return {
      key: apiName,
      label,
      status: item.zohoCode || item.httpStatus === 403 ? "unavailable" : "error",
      message: item.error ?? `HTTP ${item.httpStatus ?? "unknown"}`,
    };
  }
  if (item.recordCount === 0) {
    return { key: apiName, label, status: "empty", count: 0, message: `No ${label.toLowerCase()} on this record.` };
  }
  return { key: apiName, label, status: "retrieved", count: item.recordCount };
}

function emailsCapability(diagnostic: DiscoveryDiagnostic): CapabilityStatus {
  if (!diagnostic.emails.listAttempted) {
    return { key: "Emails", label: "Emails", status: "unavailable", message: "Email list was not attempted." };
  }
  if (!diagnostic.emails.success) {
    const status = diagnostic.emails.httpStatus ?? 0;
    return {
      key: "Emails",
      label: "Emails",
      status: status >= 500 ? "error" : "unavailable",
      message: diagnostic.emails.error ?? "Zoho API did not provide email access for this record/configuration.",
    };
  }
  if (diagnostic.emails.count === 0) {
    return { key: "Emails", label: "Emails", status: "empty", count: 0, message: "No emails returned for this record." };
  }
  return { key: "Emails", label: "Emails", status: "retrieved", count: diagnostic.emails.count };
}

function displayValue(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return null;
  const object = asJsonObject(value);
  if (object && typeof object.name === "string") return object.name;
  return value;
}

function fieldsFromRecord(
  record: JsonObject,
  catalog: ZohoFieldMeta[],
  custom: boolean,
): DisplayField[] {
  const known = catalog.filter((field) => field.customField === custom);
  if (known.length === 0) {
    return [];
  }
  return known
    .map((field) => ({
      apiName: field.apiName,
      label: field.label,
      custom,
      value: displayValue(record[field.apiName]),
    }))
    .filter((field) => field.value !== null && field.value !== undefined);
}

export function buildRelationshipView(diagnostic: DiscoveryDiagnostic): RelationshipView {
  const record = diagnostic.primaryRecord.record ?? {};
  const joinedName = [text(record.First_Name), text(record.Last_Name)].filter(Boolean).join(" ");
  const name =
    text(record.Full_Name) ??
    (joinedName || undefined) ??
    text(record.Account_Name) ??
    "Unknown record";
  const overviewKeys = [
    "Email",
    "Phone",
    "Account_Name",
    "Company",
    "Lead_Source",
    "Owner",
    "Created_Time",
    "Modified_Time",
    "Last_Activity_Time",
    "Industry",
    "Country",
    "Mailing_Country",
    "Billing_Country",
  ];

  const overview: DisplayField[] = overviewKeys
    .filter((key) => displayValue(record[key]) !== null)
    .map((key) => ({
      apiName: key,
      label: key.replaceAll("_", " "),
      custom: false,
      value: displayValue(record[key]),
    }));

  return {
    header: {
      name,
      company: text(record.Account_Name) ?? text(record.Company),
      email: text(record.Email),
      country:
        text(record.Mailing_Country) ?? text(record.Billing_Country) ?? text(record.Country),
      module: diagnostic.primaryRecord.module ?? "Unknown",
      id: diagnostic.primaryRecord.id ?? "",
    },
    overview,
    capabilities: [
      emailsCapability(diagnostic),
      capabilityFromRelated("Notes", "Notes", diagnostic),
      capabilityFromRelated("Deals", "Deals", diagnostic),
      capabilityFromRelated("Tasks", "Tasks", diagnostic),
      capabilityFromRelated("Calls", "Calls", diagnostic),
      capabilityFromRelated("Events", "Meetings", diagnostic),
    ],
    timeline: buildTimeline(diagnostic),
    notes: related(diagnostic, "Notes")?.records ?? [],
    emails: {
      ...diagnostic.emails,
      bodies: (diagnostic.emails.bodies ?? []).map((body) => ({
        ...body,
        rawContent: undefined,
      })),
    },
    normalizedEmails: diagnostic.emails.normalized ?? [],
    emailFacts: diagnostic.emails.interactionFacts,
    deals: related(diagnostic, "Deals")?.records ?? [],
    tasks: related(diagnostic, "Tasks")?.records ?? [],
    calls: related(diagnostic, "Calls")?.records ?? [],
    meetings: related(diagnostic, "Events")?.records ?? [],
    tags: diagnostic.primaryRecord.tags,
    account: diagnostic.primaryRecord.lookupFollowUps.find((item) => item.module === "Accounts" && item.retrieved)
      ?.record,
    relatedLists: diagnostic.relatedLists.retrievals
      .filter(
        (item) =>
          item.skipCategory !== "not-sales-relevant" &&
          item.skipCategory !== "unsupported-api" &&
          item.skipCategory !== "dedicated-endpoint",
      )
      .map((item) => capabilityFromRelated(item.apiName, item.displayLabel || item.apiName, diagnostic)),
    standardFields: fieldsFromRecord(record, diagnostic.fieldCatalog.standardFields, false),
    customFields: fieldsFromRecord(record, diagnostic.fieldCatalog.customFields, true),
    warnings: diagnostic.warnings,
    errors: diagnostic.errors,
  };
}
