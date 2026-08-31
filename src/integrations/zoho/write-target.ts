import { PRIMARY_MODULES, type PrimaryModule } from "./constants.js";

export type ZohoWriteContext = {
  organisation_key?: string;
  contact_id?: string;
  source_record?: { module?: string; recordId?: string };
  contact_ids?: string[];
  lead_ids?: string[];
  account_id?: string;
};

export type ZohoWriteTarget = {
  module: PrimaryModule;
  recordId: string;
};

function isPrimaryModule(value: string): value is PrimaryModule {
  return (PRIMARY_MODULES as readonly string[]).includes(value);
}

function isZohoId(value: string): boolean {
  return /^\d{10,}$/.test(value);
}

export function resolveZohoWriteTarget(context: ZohoWriteContext): ZohoWriteTarget | null {
  const contactId = context.contact_id?.trim();

  if (contactId && isZohoId(contactId)) {
    if (context.lead_ids?.includes(contactId)) {
      return { module: "Leads", recordId: contactId };
    }
    if (context.contact_ids?.includes(contactId)) {
      return { module: "Contacts", recordId: contactId };
    }
    const source = context.source_record;
    if (source?.recordId === contactId && source.module && isPrimaryModule(source.module)) {
      return { module: source.module, recordId: contactId };
    }
    return null;
  }

  const source = context.source_record;
  if (source?.module && source.recordId && isPrimaryModule(source.module) && isZohoId(source.recordId)) {
    return { module: source.module, recordId: source.recordId };
  }

  const organisationKey = context.organisation_key ?? "";
  if (organisationKey.startsWith("zoho-account:")) {
    const recordId = organisationKey.slice("zoho-account:".length);
    if (isZohoId(recordId)) return { module: "Accounts", recordId };
  }

  const contactMatch = organisationKey.match(/^contact:(Contacts|Leads):(\d{10,})$/);
  if (contactMatch && isPrimaryModule(contactMatch[1]!)) {
    return { module: contactMatch[1]!, recordId: contactMatch[2]! };
  }

  if (context.account_id && isZohoId(context.account_id)) {
    return { module: "Accounts", recordId: context.account_id };
  }

  return null;
}

export function parseZohoWriteContext(value: unknown): ZohoWriteContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const source = record.source_record;
  const sourceRecord =
    source && typeof source === "object"
      ? {
          module:
            typeof (source as Record<string, unknown>).module === "string"
              ? ((source as Record<string, unknown>).module as string)
              : undefined,
          recordId:
            typeof (source as Record<string, unknown>).recordId === "string"
              ? ((source as Record<string, unknown>).recordId as string)
              : undefined,
        }
      : undefined;
  return {
    organisation_key: typeof record.organisation_key === "string" ? record.organisation_key : undefined,
    contact_id: typeof record.contact_id === "string" ? record.contact_id : undefined,
    source_record: sourceRecord,
    contact_ids: Array.isArray(record.contact_ids)
      ? record.contact_ids.filter((item): item is string => typeof item === "string")
      : undefined,
    lead_ids: Array.isArray(record.lead_ids)
      ? record.lead_ids.filter((item): item is string => typeof item === "string")
      : undefined,
    account_id: typeof record.account_id === "string" ? record.account_id : undefined,
  };
}
