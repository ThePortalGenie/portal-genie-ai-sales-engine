import { evidence, type EvidenceItem } from "../domain/evidence.js";
import type { EmailInteractionFacts, NormalizedEmail } from "../domain/normalized-email.js";
import { asJsonObject } from "../integrations/zoho/http.js";
import { findRelatedRetrieval, lookupName } from "../web/timeline.js";
import type { DiscoveryDiagnostic, JsonObject } from "../integrations/zoho/types.js";
import { organisationDomainFromEmail } from "./email-domains.js";

function text(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return lookupName(value);
}

function fieldText(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  if (value === null || value === undefined || value === "") return undefined;
  const object = asJsonObject(value);
  if (object && typeof object.name === "string") return object.name;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

export type ContactIdentity = {
  name: string;
  email?: string;
  jobTitle?: string;
  organisation?: string;
  country?: string;
  module: string;
  recordId: string;
  accountId?: string;
  source?: string;
  createdAt?: string;
  owner?: string;
};

export type DealSignals = {
  count: number;
  stages: string[];
  names: string[];
  closedWon: number;
  closedLost: number;
  latestName?: string;
  latestStage?: string;
  latestAt?: string;
  values: string[];
};

export type ContactIntelligence = {
  identity: ContactIdentity;
  importantFields: Array<{ label: string; apiName: string; value: string; custom: boolean }>;
  notes: Array<{ id?: string; title?: string; content?: string; at?: string }>;
  deals: DealSignals;
  emails: EmailInteractionFacts;
  emailSubjects: string[];
  tasks: number;
  calls: number;
  meetings: number;
  evidence: EvidenceItem[];
};

function related(diagnostic: DiscoveryDiagnostic, apiName: string): JsonObject[] {
  const retrieval = findRelatedRetrieval(diagnostic, apiName);
  if (!retrieval?.success) return [];
  return retrieval.records;
}

export function extractDealSignals(records: JsonObject[]): DealSignals {
  const stages = records
    .map((record) => text(record.Stage))
    .filter((item): item is string => Boolean(item));
  const closedWon = stages.filter((stage) => /won/i.test(stage)).length;
  const closedLost = stages.filter((stage) => /lost/i.test(stage)).length;
  const dated = records
    .map((record) => ({
      name: text(record.Deal_Name),
      stage: text(record.Stage),
      at: text(record.Modified_Time) ?? text(record.Created_Time),
    }))
    .filter((item) => item.at && !Number.isNaN(Date.parse(item.at)))
    .sort((left, right) => Date.parse(right.at!) - Date.parse(left.at!));
  const latest = dated[0];
  return {
    count: records.length,
    stages: [...new Set(stages)],
    names: [...new Set(records.map((record) => text(record.Deal_Name)).filter((item): item is string => Boolean(item)))],
    closedWon,
    closedLost,
    latestName: latest?.name,
    latestStage: latest?.stage,
    latestAt: latest?.at,
    values: records.map((record) => text(record.Amount)).filter((item): item is string => Boolean(item)),
  };
}

export function buildContactIntelligence(
  diagnostic: DiscoveryDiagnostic,
  publicDomains: Set<string>,
): ContactIntelligence {
  const record = diagnostic.primaryRecord.record ?? {};
  const evidenceItems: EvidenceItem[] = [];
  const name =
    text(record.Full_Name) ||
    [text(record.First_Name), text(record.Last_Name)].filter(Boolean).join(" ") ||
    text(record.Account_Name) ||
    "Unknown";
  const email = text(record.Email);
  const organisation = text(record.Account_Name) ?? text(record.Company);
  const accountLookup = asJsonObject(record.Account_Name);
  const accountId =
    (typeof accountLookup?.id === "string" ? accountLookup.id : undefined) ??
    diagnostic.primaryRecord.lookupFollowUps.find((item) => item.module === "Accounts" && item.retrieved)?.id;

  const identity: ContactIdentity = {
    name,
    email,
    jobTitle: text(record.Title) ?? text(record.Designation),
    organisation,
    country: text(record.Mailing_Country) ?? text(record.Billing_Country) ?? text(record.Country),
    module: diagnostic.primaryRecord.module ?? "Unknown",
    recordId: diagnostic.primaryRecord.id ?? "",
    accountId,
    source: fieldText(record, "Lead_Source"),
    createdAt: fieldText(record, "Created_Time"),
    owner: fieldText(record, "Owner"),
  };

  const pushFact = (claim: string, field?: string, recordId?: string) => {
    evidenceItems.push(
      evidence({
        type: "crm_fact",
        claim,
        source: field ? `Zoho ${identity.module} field ${field}` : `Zoho ${identity.module}`,
        recordId: recordId ?? identity.recordId,
        field,
      }),
    );
  };

  if (email) pushFact(`Email = ${email}`, "Email");
  if (organisation) pushFact(`Organisation = ${organisation}`, "Account_Name");
  if (identity.source) pushFact(`Lead Source = ${identity.source}`, "Lead_Source");
  if (identity.jobTitle) pushFact(`Title = ${identity.jobTitle}`, "Title");
  const industry = fieldText(record, "Industry");
  if (industry) pushFact(`Industry = ${industry}`, "Industry");
  const software = fieldText(record, "Accounting_Software") ?? fieldText(record, "Accounting_Software_Used");
  for (const field of diagnostic.fieldCatalog.customFields) {
    const value = fieldText(record, field.apiName);
    if (value) pushFact(`${field.label} = ${value}`, field.apiName);
  }
  if (software) pushFact(`Accounting software = ${software}`);

  const importantKeys = [
    "Email",
    "Phone",
    "Title",
    "Lead_Source",
    "Industry",
    "Account_Name",
    "Company",
    "Owner",
    "Created_Time",
    "Last_Activity_Time",
  ];
  const importantFields = [
    ...importantKeys
      .map((apiName) => {
        const value = fieldText(record, apiName);
        return value
          ? { label: apiName.replaceAll("_", " "), apiName, value, custom: false }
          : undefined;
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item)),
    ...diagnostic.fieldCatalog.customFields
      .map((field) => {
        const value = fieldText(record, field.apiName);
        return value ? { label: field.label, apiName: field.apiName, value, custom: true } : undefined;
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item)),
  ];

  const notes = related(diagnostic, "Notes").map((note) => ({
    id: text(note.id),
    title: text(note.Note_Title),
    content: text(note.Note_Content),
    at: text(note.Created_Time),
  }));
  if (notes.length > 0) {
    pushFact(`${notes.length} CRM note(s) retrieved`, undefined);
  }

  const deals = extractDealSignals(related(diagnostic, "Deals"));
  if (deals.count > 0) {
    evidenceItems.push(
      evidence({
        type: "crm_fact",
        claim: `${deals.count} Deal(s); stages: ${deals.stages.join(", ") || "unspecified"}`,
        source: "Zoho Deals related list",
        recordId: identity.recordId,
      }),
    );
  }
  if (deals.closedWon > 0) {
    evidenceItems.push(
      evidence({
        type: "crm_fact",
        claim: `${deals.closedWon} Deal(s) Closed Won`,
        source: "Zoho Deal",
        recordId: identity.recordId,
      }),
    );
  }

  const emails = diagnostic.emails.interactionFacts ?? {
    outboundCount: 0,
    inboundCount: 0,
    unknownDirectionCount: 0,
    lastAt: null,
    lastDirection: null,
    inboundAfterOutbound: false,
    consecutiveOutboundWithoutLaterInbound: 0,
  };
  if (diagnostic.emails.success && diagnostic.emails.count > 0) {
    evidenceItems.push(
      evidence({
        type: "derived_signal",
        claim: `Emails: ${emails.outboundCount} outbound, ${emails.inboundCount} inbound, last ${emails.lastDirection ?? "unknown"} at ${emails.lastAt ?? "unknown"}`,
        source: "Normalised Zoho email metadata",
        derivedFrom: ["emails"],
      }),
    );
  }
  if (emails.consecutiveOutboundWithoutLaterInbound > 0) {
    evidenceItems.push(
      evidence({
        type: "derived_signal",
        claim: `${emails.consecutiveOutboundWithoutLaterInbound} unanswered outbound follow-up(s)`,
        source: "Email direction timestamps",
        derivedFrom: ["emails"],
      }),
    );
  }
  if (emails.lastAt) {
    const days = Math.floor((Date.now() - Date.parse(emails.lastAt)) / 86_400_000);
    if (Number.isFinite(days)) {
      evidenceItems.push(
        evidence({
          type: "derived_signal",
          claim: `Last meaningful email interaction was ${days} days ago`,
          source: "Email timestamps",
          derivedFrom: ["emails.lastAt"],
        }),
      );
    }
  }

  const domain = email ? organisationDomainFromEmail(email, publicDomains) : undefined;
  if (domain) {
    evidenceItems.push(
      evidence({
        type: "derived_signal",
        claim: `Business email domain = ${domain}`,
        source: "Email domain extraction",
        derivedFrom: ["Email"],
      }),
    );
  }

  const calls = related(diagnostic, "Calls");
  const meetings = related(diagnostic, "Events");
  const callRetrieval = findRelatedRetrieval(diagnostic, "Calls");
  const meetingRetrieval = findRelatedRetrieval(diagnostic, "Events");
  if (callRetrieval?.success && calls.length === 0) {
    evidenceItems.push(
      evidence({
        type: "crm_fact",
        claim: "Zoho Calls related list contains zero records",
        source: "Zoho Calls",
        recordId: identity.recordId,
      }),
    );
  }
  if (meetingRetrieval?.success && meetings.length === 0) {
    evidenceItems.push(
      evidence({
        type: "crm_fact",
        claim: "Zoho Meetings related list contains zero records",
        source: "Zoho Meetings",
        recordId: identity.recordId,
      }),
    );
  }

  return {
    identity,
    importantFields,
    notes,
    deals,
    emails,
    emailSubjects: (diagnostic.emails.normalized ?? [])
      .map((item: NormalizedEmail) => item.subject)
      .filter((item): item is string => Boolean(item)),
    tasks: related(diagnostic, "Tasks").length,
    calls: calls.length,
    meetings: meetings.length,
    evidence: evidenceItems,
  };
}
