import {
  DEFAULT_EMAIL_BODY_FETCH_LIMIT,
  DEFAULT_RELATED_PAGE_SIZE,
  EMAIL_LIST_TYPES,
  EMAIL_PREVIEW_CHARS,
  EMAIL_SEARCH_MODULES,
  MAX_EMAIL_LIST_PAGES,
  PRIMARY_MODULES,
  READ_ONLY_SCOPES,
  ZOHO_CRM_API_VERSION,
  ZOHO_DOCS,
} from "./constants.js";
import { htmlToPlainText } from "../../content/html-to-text.js";
import { fieldsForRelatedList } from "./fallback-fields.js";
import { asJsonObject, readZohoError } from "./http.js";
import {
  buildEmailInteractionFacts,
  normalizeRetrievedEmail,
  prospectEmailsFromRecord,
} from "./normalize-email.js";
import { classifyRelatedList } from "./related-list-policy.js";
import type { ZohoCrmReader } from "./client.js";
import type {
  DiscoveryDiagnostic,
  DiscoveryRequest,
  EmailBodyPreview,
  EmailHeader,
  JsonObject,
  RetrievedRelatedList,
  SalesContextSummary,
  ZohoFieldMeta,
  ZohoHttpResult,
  ZohoRelatedListMeta,
} from "./types.js";

const SALES_FIELD_HINT =
  /xero|quickbooks|sage|accounting|industry|country|partner|roadshow|event|webinar|source|campaign|practice|software/i;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstRecord(result: ZohoHttpResult): JsonObject | null {
  const json = asJsonObject(result.json);
  const data = json ? asArray(json.data) : [];
  const first = data[0];
  return asJsonObject(first);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function previewContent(value: unknown): { preview: string | null; length: number | null; truncated: boolean } {
  if (typeof value !== "string") {
    return { preview: null, length: null, truncated: false };
  }
  const cleaned = htmlToPlainText(value, EMAIL_PREVIEW_CHARS);
  return { preview: cleaned.text || null, length: value.length, truncated: cleaned.truncated };
}

function parseFields(result: ZohoHttpResult): ZohoFieldMeta[] {
  const json = asJsonObject(result.json);
  const fields = json ? asArray(json.fields) : [];
  const parsed: ZohoFieldMeta[] = [];
  for (const field of fields) {
    const object = asJsonObject(field);
    if (!object || typeof object.api_name !== "string") {
      continue;
    }
    parsed.push({
      apiName: object.api_name,
      label: typeof object.field_label === "string" ? object.field_label : object.api_name,
      dataType: typeof object.data_type === "string" ? object.data_type : "unknown",
      customField: object.custom_field === true,
    });
  }
  return parsed;
}

function parseRelatedLists(result: ZohoHttpResult): ZohoRelatedListMeta[] {
  const json = asJsonObject(result.json);
  const lists = json ? asArray(json.related_lists) : [];
  const parsed: ZohoRelatedListMeta[] = [];
  for (const list of lists) {
    const object = asJsonObject(list);
    if (!object || typeof object.api_name !== "string") {
      continue;
    }
    const module = asJsonObject(object.module);
    const fields = asArray(object.fields)
      .map((field) => asJsonObject(field)?.api_name)
      .filter((name): name is string => typeof name === "string");
    parsed.push({
      apiName: object.api_name,
      displayLabel: typeof object.display_label === "string" ? object.display_label : object.api_name,
      href: typeof object.href === "string" ? object.href : null,
      status: typeof object.status === "string" ? object.status : "unknown",
      type: typeof object.type === "string" ? object.type : "unknown",
      relatedModuleApiName: typeof module?.api_name === "string" ? module.api_name : null,
      fields,
    });
  }
  return parsed;
}

function lookupId(value: unknown): { id: string; name?: string } | null {
  const object = asJsonObject(value);
  if (object && typeof object.id === "string") {
    return { id: object.id, name: typeof object.name === "string" ? object.name : undefined };
  }
  return null;
}

function emptyDiagnostic(request: DiscoveryRequest, accountsUrl: string, apiDomain: string): DiscoveryDiagnostic {
  return {
    generatedAt: new Date().toISOString(),
    connector: {
      name: "zoho-discovery",
      mode: "read-only",
      apiVersion: ZOHO_CRM_API_VERSION,
      apiDomain,
      accountsUrl,
      documentation: ZOHO_DOCS,
      scopesExpected: READ_ONLY_SCOPES,
    },
    request,
    primaryRecord: {
      module: request.module ?? null,
      id: request.recordId ?? null,
      retrieved: false,
      tags: null,
      lookupFollowUps: [],
      record: null,
    },
    fieldCatalog: {
      module: request.module ?? null,
      retrieved: false,
      totalFields: 0,
      customFields: [],
      standardFields: [],
    },
    moduleTags: { retrieved: false, tags: [] },
    relatedLists: { catalogRetrieved: false, available: [], retrievals: [] },
    emails: {
      listAttempted: false,
      success: false,
      count: 0,
      moreRecords: false,
      headers: [],
      bodies: [],
      normalized: [],
      interactionFacts: {
        outboundCount: 0,
        inboundCount: 0,
        unknownDirectionCount: 0,
        lastAt: null,
        lastDirection: null,
        inboundAfterOutbound: false,
        consecutiveOutboundWithoutLaterInbound: 0,
      },
      note: "Email metadata comes from GET /crm/v8/{module}/{id}/Emails (10 per page, paginated with index). Bodies come from GET /crm/v8/{module}/{id}/Emails/{message_id}.",
      typesAttempted: [],
      calls: [],
    },
    salesContextSummary: {
      hasPrimaryRecord: false,
      hasNotes: false,
      hasDeals: false,
      hasEmailHeaders: false,
      hasEmailBodies: false,
      hasOpenActivities: false,
      hasClosedActivities: false,
      hasAccount: false,
      hasTags: false,
      customFieldCount: 0,
      salesRelevantCustomFields: [],
      likelyUsefulForIntelligence: [],
      unavailableCapabilities: [],
    },
    warnings: [],
    errors: [],
  };
}

function buildSummary(diagnostic: DiscoveryDiagnostic): SalesContextSummary {
  const retrievals = diagnostic.relatedLists.retrievals;
  const notes = retrievals.find((item) => item.apiName === "Notes");
  const deals = retrievals.find((item) => item.apiName === "Deals" || item.apiName === "Potentials");
  const activityLists = retrievals.filter((item) => ["Tasks", "Calls", "Events", "Meetings"].includes(item.apiName));
  const salesRelevantCustomFields = diagnostic.fieldCatalog.customFields
    .filter((field) => SALES_FIELD_HINT.test(field.apiName) || SALES_FIELD_HINT.test(field.label))
    .map((field) => field.apiName);

  const useful: string[] = [];
  if (diagnostic.primaryRecord.retrieved) useful.push("Primary CRM record retrieved");
  if ((notes?.recordCount ?? 0) > 0) useful.push("Notes available for relationship history");
  if ((deals?.recordCount ?? 0) > 0) useful.push("Deals available for commercial context");
  if (diagnostic.emails.count > 0) useful.push("Email headers available");
  if (diagnostic.emails.bodies.some((body) => body.retrieved)) useful.push("At least one email body retrievable");
  if (activityLists.some((item) => (item.recordCount ?? 0) > 0)) useful.push("Tasks, calls, or meetings available");
  if (diagnostic.primaryRecord.lookupFollowUps.some((item) => item.retrieved && item.module === "Accounts")) {
    useful.push("Related Account retrieved");
  }
  if (diagnostic.fieldCatalog.customFields.length > 0) useful.push("Custom fields catalogued");
  if (salesRelevantCustomFields.length > 0) useful.push("Sales-relevant custom fields present");

  const unavailable: Array<{ capability: string; reason: string }> = [];
  for (const retrieval of retrievals) {
    if (retrieval.skipCategory === "not-sales-relevant" || retrieval.skipCategory === "unsupported-api") {
      continue;
    }
    if (retrieval.attempted && !retrieval.success) {
      unavailable.push({
        capability: `Related list ${retrieval.apiName}`,
        reason: retrieval.error ?? "Request failed",
      });
    }
  }
  if (diagnostic.emails.listAttempted && !diagnostic.emails.success) {
    unavailable.push({
      capability: "Email history",
      reason: diagnostic.emails.error ?? "Email list request failed",
    });
  }

  return {
    hasPrimaryRecord: diagnostic.primaryRecord.retrieved,
    hasNotes: (notes?.recordCount ?? 0) > 0,
    hasDeals: (deals?.recordCount ?? 0) > 0,
    hasEmailHeaders: diagnostic.emails.count > 0,
    hasEmailBodies: diagnostic.emails.bodies.some((body) => body.retrieved),
    hasOpenActivities: activityLists.some((item) => (item.recordCount ?? 0) > 0),
    hasClosedActivities: false,
    hasAccount: diagnostic.primaryRecord.lookupFollowUps.some(
      (item) => item.retrieved && item.module === "Accounts",
    ),
    hasTags: Array.isArray(diagnostic.primaryRecord.tags) && diagnostic.primaryRecord.tags.length > 0,
    customFieldCount: diagnostic.fieldCatalog.customFields.length,
    salesRelevantCustomFields,
    likelyUsefulForIntelligence: useful,
    unavailableCapabilities: unavailable,
  };
}

export type DiscoveryRuntime = {
  client: ZohoCrmReader;
  accountsUrl: string;
  apiDomain: string;
  getFieldsForModule?: (moduleApiName: string) => Promise<ZohoHttpResult>;
};

export async function runDiscovery(
  runtime: DiscoveryRuntime,
  request: DiscoveryRequest,
): Promise<DiscoveryDiagnostic> {
  const diagnostic = emptyDiagnostic(
    {
      ...request,
      fetchEmailBodies: request.fetchEmailBodies ?? DEFAULT_EMAIL_BODY_FETCH_LIMIT,
      maxRelatedRecords: request.maxRelatedRecords ?? DEFAULT_RELATED_PAGE_SIZE,
    },
    runtime.accountsUrl,
    runtime.apiDomain,
  );

  const resolved = await resolvePrimaryRecord(runtime.client, request, diagnostic);
  if (!resolved) {
    diagnostic.salesContextSummary = buildSummary(diagnostic);
    return diagnostic;
  }

  diagnostic.request.resolvedFrom = resolved.resolvedFrom;
  diagnostic.primaryRecord.module = resolved.module;
  diagnostic.primaryRecord.id = resolved.id;
  diagnostic.primaryRecord.retrieved = true;
  diagnostic.primaryRecord.record = resolved.record;
  diagnostic.primaryRecord.tags = resolved.record.Tag ?? null;
  diagnostic.fieldCatalog.module = resolved.module;

  await Promise.all([
    loadFieldCatalog(runtime.client, resolved.module, diagnostic),
    loadModuleTags(runtime.client, resolved.module, diagnostic),
  ]);

  await Promise.all([
    loadRelatedContext(runtime, resolved.module, resolved.id, diagnostic),
    loadEmails(runtime.client, resolved.module, resolved.id, diagnostic),
  ]);

  await loadLookupFollowUps(runtime.client, resolved.record, diagnostic);

  diagnostic.salesContextSummary = buildSummary(diagnostic);
  return diagnostic;
}

async function resolvePrimaryRecord(
  client: ZohoCrmReader,
  request: DiscoveryRequest,
  diagnostic: DiscoveryDiagnostic,
): Promise<{ module: string; id: string; record: JsonObject; resolvedFrom: "id" | "email_search" } | null> {
  const modules = request.module
    ? [request.module]
    : request.email
      ? [...EMAIL_SEARCH_MODULES]
      : [...PRIMARY_MODULES];

  if (request.recordId) {
    for (const moduleApiName of modules) {
      const result = await client.getRecord(moduleApiName, request.recordId);
      const record = firstRecord(result);
      if (result.ok && record) {
        return { module: moduleApiName, id: request.recordId, record, resolvedFrom: "id" };
      }
      const error = readZohoError(result.json);
      diagnostic.warnings.push(
        `GET ${moduleApiName}/${request.recordId} returned HTTP ${result.status}${error.code ? ` (${error.code})` : ""}`,
      );
    }
    diagnostic.errors.push({
      stage: "resolve-record",
      message: `Could not retrieve record ${request.recordId} from ${modules.join(", ")}`,
    });
    return null;
  }

  if (request.email) {
    for (const moduleApiName of modules) {
      const result = await client.searchByEmail(moduleApiName, request.email);
      const record = firstRecord(result);
      const id = text(record?.id);
      if (result.ok && record && id) {
        return { module: moduleApiName, id, record, resolvedFrom: "email_search" };
      }
      const error = readZohoError(result.json);
      diagnostic.warnings.push(
        `Search ${moduleApiName} email=${request.email} returned HTTP ${result.status}${error.code ? ` (${error.code})` : ""}`,
      );
    }
    diagnostic.errors.push({
      stage: "resolve-record",
      message: `No Lead/Contact found for email ${request.email}`,
    });
    return null;
  }

  diagnostic.errors.push({
    stage: "resolve-record",
    message: "Provide --id or --email (and optionally --module Contacts|Leads|Accounts)",
  });
  return null;
}

async function loadFieldCatalog(
  client: ZohoCrmReader,
  moduleApiName: string,
  diagnostic: DiscoveryDiagnostic,
): Promise<void> {
  const result = await client.getFields(moduleApiName);
  if (!result.ok) {
    const error = readZohoError(result.json);
    diagnostic.fieldCatalog.error = error.message ?? `HTTP ${result.status}`;
    diagnostic.errors.push({
      stage: "fields",
      message: diagnostic.fieldCatalog.error,
      zohoCode: error.code,
      httpStatus: result.status,
    });
    return;
  }
  const fields = parseFields(result);
  diagnostic.fieldCatalog.retrieved = true;
  diagnostic.fieldCatalog.totalFields = fields.length;
  diagnostic.fieldCatalog.customFields = fields.filter((field) => field.customField);
  diagnostic.fieldCatalog.standardFields = fields.filter((field) => !field.customField);
}

async function loadModuleTags(
  client: ZohoCrmReader,
  moduleApiName: string,
  diagnostic: DiscoveryDiagnostic,
): Promise<void> {
  const result = await client.getTags(moduleApiName);
  if (!result.ok) {
    const error = readZohoError(result.json);
    diagnostic.moduleTags.error = error.message ?? `HTTP ${result.status}`;
    diagnostic.warnings.push(`Module tag list unavailable: ${diagnostic.moduleTags.error}`);
    return;
  }
  const json = asJsonObject(result.json);
  diagnostic.moduleTags.retrieved = true;
  diagnostic.moduleTags.tags = json ? asArray(json.tags) : [];
}

async function loadRelatedContext(
  runtime: DiscoveryRuntime,
  moduleApiName: string,
  recordId: string,
  diagnostic: DiscoveryDiagnostic,
): Promise<void> {
  const catalog = await runtime.client.getRelatedLists(moduleApiName);
  if (!catalog.ok) {
    const error = readZohoError(catalog.json);
    diagnostic.relatedLists.error = error.message ?? `HTTP ${catalog.status}`;
    diagnostic.errors.push({
      stage: "related-lists",
      message: diagnostic.relatedLists.error,
      zohoCode: error.code,
      httpStatus: catalog.status,
    });
    return;
  }

  const available = parseRelatedLists(catalog);
  diagnostic.relatedLists.catalogRetrieved = true;
  diagnostic.relatedLists.available = available;

  const fieldCache = new Map<string, string[]>();
  if (diagnostic.fieldCatalog.retrieved) {
    fieldCache.set(
      moduleApiName,
      [...diagnostic.fieldCatalog.standardFields, ...diagnostic.fieldCatalog.customFields].map(
        (field) => field.apiName,
      ),
    );
  }

  for (const related of available) {
    diagnostic.relatedLists.retrievals.push(
      await retrieveRelatedList(runtime, moduleApiName, recordId, related, fieldCache, diagnostic.request.maxRelatedRecords),
    );
  }
}

async function retrieveRelatedList(
  runtime: DiscoveryRuntime,
  moduleApiName: string,
  recordId: string,
  related: ZohoRelatedListMeta,
  fieldCache: Map<string, string[]>,
  maxRelatedRecords: number,
): Promise<RetrievedRelatedList> {
  const decision = classifyRelatedList(related);
  if (decision.action === "skip") {
    return {
      apiName: related.apiName,
      displayLabel: related.displayLabel,
      attempted: false,
      skippedReason: decision.reason,
      skipCategory: decision.category,
      success: false,
      recordCount: 0,
      moreRecords: false,
      fieldsUsed: [],
      records: [],
      documentationNote: decision.documentationNote,
    };
  }

  if (related.status === "scheduled_for_deletion") {
    return {
      apiName: related.apiName,
      displayLabel: related.displayLabel,
      attempted: false,
      skippedReason: "Related list is scheduled for deletion",
      success: false,
      recordCount: 0,
      moreRecords: false,
      fieldsUsed: [],
      records: [],
    };
  }

  if (related.relatedModuleApiName && !fieldCache.has(related.relatedModuleApiName) && runtime.getFieldsForModule) {
    const fieldsResult = await runtime.getFieldsForModule(related.relatedModuleApiName);
    if (fieldsResult.ok) {
      fieldCache.set(
        related.relatedModuleApiName,
        parseFields(fieldsResult).map((field) => field.apiName),
      );
    }
  }

  const fieldsUsed = fieldsForRelatedList({
    relatedListApiName: related.apiName,
    relatedModuleApiName: related.relatedModuleApiName,
    relatedListFields: related.fields,
    moduleFieldApiNames: fieldCache,
  });

  if (fieldsUsed.length === 0) {
    return {
      apiName: related.apiName,
      displayLabel: related.displayLabel,
      attempted: false,
      skippedReason: "Get Related Records requires the mandatory fields parameter and none could be resolved.",
      skipCategory: "unsupported-api",
      success: false,
      recordCount: 0,
      moreRecords: false,
      fieldsUsed: [],
      records: [],
      documentationNote: ZOHO_DOCS.relatedRecords,
    };
  }

  const result = await runtime.client.getRelatedRecords(
    moduleApiName,
    recordId,
    related.apiName,
    fieldsUsed,
    maxRelatedRecords,
  );

  if (result.noContent || result.status === 204) {
    return {
      apiName: related.apiName,
      displayLabel: related.displayLabel,
      attempted: true,
      success: true,
      httpStatus: result.status,
      recordCount: 0,
      moreRecords: false,
      fieldsUsed,
      records: [],
    };
  }

  if (!result.ok) {
    const error = readZohoError(result.json);
    return {
      apiName: related.apiName,
      displayLabel: related.displayLabel,
      attempted: true,
      success: false,
      httpStatus: result.status,
      zohoCode: error.code,
      error: error.message ?? `HTTP ${result.status}`,
      recordCount: 0,
      moreRecords: false,
      fieldsUsed,
      records: [],
    };
  }

  const json = asJsonObject(result.json);
  const records = (json ? asArray(json.data) : [])
    .map((item) => asJsonObject(item))
    .filter((item): item is JsonObject => item !== null);
  const info = json ? asJsonObject(json.info) : null;

  return {
    apiName: related.apiName,
    displayLabel: related.displayLabel,
    attempted: true,
    success: true,
    httpStatus: result.status,
    recordCount: records.length,
    moreRecords: info?.more_records === true,
    fieldsUsed,
    records,
  };
}

async function loadEmails(
  client: ZohoCrmReader,
  moduleApiName: string,
  recordId: string,
  diagnostic: DiscoveryDiagnostic,
): Promise<void> {
  diagnostic.emails.listAttempted = true;
  diagnostic.emails.endpoint = `/crm/${ZOHO_CRM_API_VERSION}/${moduleApiName}/${recordId}/Emails`;
  diagnostic.emails.typesAttempted = [];

  const headersById = new Map<string, EmailHeader>();
  let lastSuccessStatus: number | undefined;
  let accessFailure: { message: string; code?: string; status: number } | undefined;
  let moreRecords = false;

  for (const type of EMAIL_LIST_TYPES) {
    const typeLabel: string | "default" = type ?? "default";
    diagnostic.emails.typesAttempted.push(typeLabel);

    let index: string | undefined;
    for (let page = 0; page < MAX_EMAIL_LIST_PAGES; page += 1) {
      const result = await client.getEmails(moduleApiName, recordId, { type, index });
      const json = asJsonObject(result.json);
      const errorBody = json?.status === "error" && typeof json.code === "string";
      const failed = (!result.ok && !result.noContent) || errorBody;
      const error = readZohoError(result.json);
      const rows = failed ? [] : emailsFromResult(result);
      const info = asJsonObject(asJsonObject(result.json)?.info);
      const pageMore = info?.more_records === true;
      const nextIndex = typeof info?.next_index === "string" ? info.next_index : undefined;

      diagnostic.emails.calls.push({
        type: typeLabel,
        index,
        status: result.status,
        count: rows.length,
        moreRecords: pageMore,
        error: failed ? (error.message ?? `HTTP ${result.status}`) : undefined,
        zohoCode: error.code,
      });

      if (failed) {
        if (isEmailAccessFailure(result.status, error.code, error.message)) {
          accessFailure = {
            message: error.message ?? `HTTP ${result.status}`,
            code: error.code,
            status: result.status,
          };
        } else if (!accessFailure) {
          accessFailure = {
            message: error.message ?? `HTTP ${result.status}`,
            code: error.code,
            status: result.status,
          };
        }
        break;
      }

      lastSuccessStatus = result.status;
      for (const row of rows) {
        const header = toEmailHeader(row, typeLabel);
        const key = header.messageId ?? `${header.time ?? ""}:${header.subject ?? ""}:${headersById.size}`;
        if (!headersById.has(key)) {
          headersById.set(key, header);
        }
      }

      moreRecords = moreRecords || pageMore;
      if (!pageMore || !nextIndex) {
        break;
      }
      index = nextIndex;
    }

    if (headersById.size > 0) {
      break;
    }
  }

  diagnostic.emails.headers = [...headersById.values()];
  diagnostic.emails.count = diagnostic.emails.headers.length;
  diagnostic.emails.moreRecords = moreRecords;
  diagnostic.emails.httpStatus = lastSuccessStatus ?? accessFailure?.status;

  if (diagnostic.emails.count > 0) {
    diagnostic.emails.success = true;
  } else if (accessFailure) {
    diagnostic.emails.success = false;
    diagnostic.emails.error = accessFailure.message;
    diagnostic.emails.zohoCode = accessFailure.code;
    diagnostic.warnings.push(
      `Email list unavailable (${accessFailure.code ?? accessFailure.status}). This is not treated as empty history. Docs: ${ZOHO_DOCS.emails}`,
    );
    return;
  } else {
    diagnostic.emails.success = true;
  }

  const limit = diagnostic.request.fetchEmailBodies;
  const toFetch = diagnostic.emails.headers.filter((header) => header.messageId).slice(0, limit);

  for (const header of toFetch) {
    diagnostic.emails.bodies.push(await fetchEmailBody(client, moduleApiName, recordId, header));
  }

  const prospectEmails = prospectEmailsFromRecord(diagnostic.primaryRecord.record ?? undefined);
  diagnostic.emails.normalized = diagnostic.emails.headers.map((header) =>
    normalizeRetrievedEmail(
      header,
      diagnostic.emails.bodies.find((item) => item.messageId === header.messageId),
      prospectEmails,
    ),
  );
  diagnostic.emails.interactionFacts = buildEmailInteractionFacts(diagnostic.emails.normalized);
}

function emailsFromResult(result: ZohoHttpResult): unknown[] {
  if (result.noContent) return [];
  const json = asJsonObject(result.json);
  if (!json) return [];
  if (json.status === "error" && json.code) return [];
  if (Array.isArray(json.Emails)) return json.Emails;
  if (Array.isArray(json.emails)) return json.emails;
  return [];
}

function isEmailAccessFailure(status: number, code?: string, message?: string): boolean {
  if (status === 401 || status === 403) return true;
  const haystack = `${code ?? ""} ${message ?? ""}`.toLowerCase();
  return (
    haystack.includes("no_permission") ||
    haystack.includes("cannot_process") ||
    haystack.includes("oauth_scope") ||
    haystack.includes("permission") ||
    haystack.includes("mailbox") ||
    haystack.includes("imap") ||
    haystack.includes("authentication failed")
  );
}

function toEmailHeader(value: unknown, listType: string | "default"): EmailHeader {
  const object = asJsonObject(value) ?? {};
  const owner = asJsonObject(object.owner);
  const statusTypes = (Array.isArray(object.status) ? object.status : [])
    .map((item) => text(asJsonObject(item)?.type))
    .filter((item): item is string => Boolean(item));
  return {
    messageId: text(object.message_id),
    threadId: text(object.thread_id),
    subject: text(object.subject),
    time: text(object.time),
    sent: typeof object.sent === "boolean" ? object.sent : null,
    from: asJsonObject(object.from),
    to: object.to ?? null,
    cc: object.cc ?? null,
    ownerId: text(owner?.id),
    hasAttachment: typeof object.has_attachment === "boolean" ? object.has_attachment : null,
    source: text(object.source),
    listType,
    statusTypes,
  };
}

async function fetchEmailBody(
  client: ZohoCrmReader,
  moduleApiName: string,
  recordId: string,
  header: EmailHeader,
): Promise<EmailBodyPreview> {
  const messageId = header.messageId;
  if (!messageId) {
    return {
      messageId: "",
      retrieved: false,
      error: "message_id missing",
      subject: header.subject,
      contentPreview: null,
      truncated: false,
      contentLength: null,
      rawContent: null,
    };
  }

  const result = await client.getEmail(moduleApiName, recordId, messageId, header.ownerId ?? undefined);
  if (!result.ok) {
    const error = readZohoError(result.json);
    return {
      messageId,
      retrieved: false,
      error: error.message ?? `HTTP ${result.status}`,
      subject: header.subject,
      contentPreview: null,
      truncated: false,
      contentLength: null,
      rawContent: null,
    };
  }

  const json = asJsonObject(result.json);
  const email = asJsonObject(asArray(json?.Emails)[0]);
  const rawContent = typeof email?.content === "string" ? email.content : null;
  const preview = previewContent(rawContent);
  return {
    messageId,
    retrieved: true,
    subject: text(email?.subject) ?? header.subject,
    contentPreview: preview.preview,
    truncated: preview.truncated,
    contentLength: preview.length,
    threadId: text(email?.thread_id),
    rawContent,
  };
}

async function loadLookupFollowUps(
  client: ZohoCrmReader,
  record: JsonObject,
  diagnostic: DiscoveryDiagnostic,
): Promise<void> {
  const candidates: Array<{ field: string; module: string; value: unknown }> = [
    { field: "Account_Name", module: "Accounts", value: record.Account_Name },
    { field: "Parent_Account", module: "Accounts", value: record.Parent_Account },
  ];

  const converted = asJsonObject(record.$converted_detail) ?? asJsonObject(record.Converted_Detail);
  if (converted) {
    candidates.push(
      { field: "$converted_detail.Contact", module: "Contacts", value: converted.Contact },
      { field: "$converted_detail.Account", module: "Accounts", value: converted.Account },
      { field: "$converted_detail.Deal", module: "Deals", value: converted.Deal },
    );
  }

  for (const candidate of candidates) {
    const lookup = lookupId(candidate.value) ?? (typeof candidate.value === "string" ? { id: candidate.value } : null);
    if (!lookup) {
      continue;
    }
    const result = await client.getRecord(candidate.module, lookup.id);
    const related = firstRecord(result);
    diagnostic.primaryRecord.lookupFollowUps.push({
      field: candidate.field,
      module: candidate.module,
      id: lookup.id,
      retrieved: Boolean(result.ok && related),
      record: related ?? undefined,
      error: result.ok ? undefined : (readZohoError(result.json).message ?? `HTTP ${result.status}`),
    });
  }
}
