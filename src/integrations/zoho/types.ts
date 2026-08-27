import type { EmailInteractionFacts, NormalizedEmail } from "../../domain/normalized-email.js";

export type JsonObject = Record<string, unknown>;

export type ZohoHttpResult = {
  ok: boolean;
  status: number;
  noContent: boolean;
  json: unknown;
};

export type ZohoFieldMeta = {
  apiName: string;
  label: string;
  dataType: string;
  customField: boolean;
};

export type ZohoRelatedListMeta = {
  apiName: string;
  displayLabel: string;
  href: string | null;
  status: string;
  type: string;
  relatedModuleApiName: string | null;
  fields: string[];
};

export type RetrievedRelatedList = {
  apiName: string;
  displayLabel: string;
  attempted: boolean;
  skippedReason?: string;
  skipCategory?: "dedicated-endpoint" | "unsupported-api" | "not-sales-relevant";
  success: boolean;
  httpStatus?: number;
  zohoCode?: string;
  error?: string;
  recordCount: number;
  moreRecords: boolean;
  fieldsUsed: string[];
  records: JsonObject[];
  documentationNote?: string;
};

export type EmailHeader = {
  messageId: string | null;
  threadId: string | null;
  subject: string | null;
  time: string | null;
  sent: boolean | null;
  from?: JsonObject | null;
  to?: unknown;
  cc?: unknown;
  ownerId?: string | null;
  hasAttachment: boolean | null;
  source?: string | null;
  listType?: string | "default";
  statusTypes?: string[];
};

export type EmailBodyPreview = {
  messageId: string;
  retrieved: boolean;
  error?: string;
  subject: string | null;
  contentPreview: string | null;
  truncated: boolean;
  contentLength: number | null;
  threadId?: string | null;
  rawContent?: string | null;
};

export type DiscoveryRequest = {
  module?: string;
  recordId?: string;
  email?: string;
  fetchEmailBodies: number;
  maxRelatedRecords: number;
};

export type SalesContextSummary = {
  hasPrimaryRecord: boolean;
  hasNotes: boolean;
  hasDeals: boolean;
  hasEmailHeaders: boolean;
  hasEmailBodies: boolean;
  hasOpenActivities: boolean;
  hasClosedActivities: boolean;
  hasAccount: boolean;
  hasTags: boolean;
  customFieldCount: number;
  salesRelevantCustomFields: string[];
  likelyUsefulForIntelligence: string[];
  unavailableCapabilities: Array<{ capability: string; reason: string }>;
};

export type DiscoveryDiagnostic = {
  generatedAt: string;
  connector: {
    name: "zoho-discovery";
    mode: "read-only";
    apiVersion: string;
    apiDomain: string;
    accountsUrl: string;
    documentation: typeof import("./constants.js").ZOHO_DOCS;
    scopesExpected: readonly string[];
  };
  request: DiscoveryRequest & { resolvedFrom?: "id" | "email_search" };
  primaryRecord: {
    module: string | null;
    id: string | null;
    retrieved: boolean;
    tags: unknown;
    lookupFollowUps: Array<{ field: string; module: string; id: string; retrieved: boolean; record?: JsonObject; error?: string }>;
    record: JsonObject | null;
  };
  fieldCatalog: {
    module: string | null;
    retrieved: boolean;
    totalFields: number;
    customFields: ZohoFieldMeta[];
    standardFields: ZohoFieldMeta[];
    error?: string;
  };
  moduleTags: {
    retrieved: boolean;
    tags: unknown[];
    error?: string;
  };
  relatedLists: {
    catalogRetrieved: boolean;
    available: ZohoRelatedListMeta[];
    retrievals: RetrievedRelatedList[];
    error?: string;
  };
  emails: {
    listAttempted: boolean;
    success: boolean;
    count: number;
    moreRecords: boolean;
    headers: EmailHeader[];
    bodies: EmailBodyPreview[];
    normalized: NormalizedEmail[];
    interactionFacts: EmailInteractionFacts;
    note: string;
    error?: string;
    zohoCode?: string;
    endpoint?: string;
    httpStatus?: number;
    typesAttempted: Array<string | "default">;
    calls: Array<{
      type: string | "default";
      index?: string;
      status: number;
      count: number;
      moreRecords?: boolean;
      error?: string;
      zohoCode?: string;
    }>;
  };
  salesContextSummary: SalesContextSummary;
  warnings: string[];
  errors: Array<{ stage: string; message: string; zohoCode?: string; httpStatus?: number }>;
};
