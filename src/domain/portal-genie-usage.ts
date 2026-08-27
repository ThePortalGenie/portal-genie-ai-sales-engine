/**
 * Portal Genie imported-usage layer. Product behaviour evidence, not CRM facts.
 * Portal visits = visits by the subscriber's clients, never subscriber logins.
 */

export const FIELD_PRESENCE = ["present", "zero", "unknown", "invalid"] as const;
export type FieldPresence = (typeof FIELD_PRESENCE)[number];

export const PORTAL_VISIT_TRENDS = [
  "INCREASING",
  "DECLINING",
  "STABLE",
  "MIXED",
  "INSUFFICIENT_DATA",
] as const;
export type PortalVisitTrend = (typeof PORTAL_VISIT_TRENDS)[number];

export const USAGE_SIGNAL_CODES = [
  "ACCOUNTING_SOFTWARE_CONNECTED",
  "ACCOUNTING_SOFTWARE_NOT_CONNECTED",
  "RECENT_LOGIN",
  "LOGIN_STALE",
  "PORTAL_CLIENT_ACTIVITY_PRESENT",
  "PORTAL_CLIENT_ACTIVITY_ZERO",
  "PORTAL_CLIENT_ACTIVITY_INCREASING",
  "PORTAL_CLIENT_ACTIVITY_DECLINING",
  "DOCUMENT_UPLOAD_USAGE_PRESENT",
  "DOCUMENT_UPLOAD_USAGE_ZERO",
  "USAGE_PRESENT",
  "USAGE_UNKNOWN",
] as const;
export type UsageSignalCode = (typeof USAGE_SIGNAL_CODES)[number];

export const USAGE_CONTRADICTION_CODES = [
  "CRM_QUIET_BUT_PRODUCT_ACTIVE",
  "CRM_ENGAGED_BUT_PRODUCT_NOT_ACTIVATED",
  "CUSTOMER_CONNECTED_ACCOUNTING_BUT_LOW_PORTAL_ACTIVITY",
  "CUSTOMER_NOT_LOGGING_IN_BUT_CLIENT_PORTAL_ACTIVITY_EXISTS",
  "CUSTOMER_COMMUNICATION_SAYS_ACTIVE_BUT_USAGE_UNKNOWN",
  "USAGE_GROWING_DESPITE_LIMITED_SALES_ACTIVITY",
] as const;
export type UsageContradictionCode = (typeof USAGE_CONTRADICTION_CODES)[number];

export const CONTACT_USAGE_MATCH_METHODS = [
  "client_id",
  "email",
  "portal_genie_org_mapping",
  "zoho_id",
] as const;
export type ContactUsageMatchMethod = (typeof CONTACT_USAGE_MATCH_METHODS)[number];

export const ORG_USAGE_DISCOVERY_METHODS = ["business_domain", "approved_portal_genie_org"] as const;
export type OrgUsageDiscoveryMethod = (typeof ORG_USAGE_DISCOVERY_METHODS)[number];

export type UsageMatchLayer = "contact" | "organisation";

export type DocumentUploadUsage = {
  value: number;
  unit: string;
  original: string;
  bytes?: number;
};

export type UsageFieldQuality = {
  clientId: FieldPresence;
  email: FieldPresence;
  accountingConnected: FieldPresence;
  accountingPlatform: FieldPresence;
  lastLoginAt: FieldPresence;
  portalVisitsCurrentMonth: FieldPresence;
  portalVisitsPreviousMonth: FieldPresence;
  portalVisitsTwoMonthsAgo: FieldPresence;
  documentUploadUsage: FieldPresence;
};

export type UsageSignal = {
  code: UsageSignalCode;
  layer: "contact" | "organisation";
  message: string;
  evidenceIds?: string[];
};

export type UsageContradiction = {
  code: UsageContradictionCode;
  message: string;
  evidenceIds?: string[];
};

export type SubscriberUsageView = {
  layer: UsageMatchLayer;
  matchMethod: ContactUsageMatchMethod | OrgUsageDiscoveryMethod;
  matchReason: string;
  matchedContactId?: string;
  matchedContactName?: string;
  firstName?: string;
  surname?: string;
  name?: string;
  email?: string;
  clientId?: string;
  accountingConnected: boolean | "unknown";
  accountingPlatform: string;
  lastLoginAt?: string;
  lastLoginPresence: FieldPresence;
  portalVisitsCurrentMonth?: number;
  portalVisitsPreviousMonth?: number;
  portalVisitsTwoMonthsAgo?: number;
  portalVisitTrend: PortalVisitTrend;
  documentUploadUsage?: DocumentUploadUsage;
  documentUploadPresence: FieldPresence;
  dataQuality: UsageFieldQuality;
  warnings: string[];
};

export type OrganisationUsageSummary = {
  product: "PORTAL_GENIE";
  label: "USAGE MATCHED" | "USAGE UNKNOWN";
  subscriberProfileCount: number;
  contactMatchedCount: number;
  organisationDiscoveredCount: number;
  contactsWithoutUsage: number;
  accountingConnectedCount: number;
  accountingNotConnectedCount: number;
  accountingUnknownCount: number;
  clientPortalActivityPresent: boolean;
  clientPortalActivityUnknown: boolean;
  latestLoginAt?: string;
  portalVisitTrend: PortalVisitTrend;
  documentUploadPresent: boolean;
  documentUploadZero: boolean;
  documentUploadUnknown: boolean;
  message: string;
};

export type OrganisationUsageLayer = {
  product: "PORTAL_GENIE";
  importedAt?: string;
  contactProfiles: SubscriberUsageView[];
  organisationDiscoveredProfiles: SubscriberUsageView[];
  unmatchedContacts: Array<{
    contactId: string;
    name: string;
    email?: string;
    message: "No matching usage profile";
  }>;
  summary: OrganisationUsageSummary;
  signals: UsageSignal[];
  contradictions: UsageContradiction[];
};

export function emptyFieldQuality(): UsageFieldQuality {
  return {
    clientId: "unknown",
    email: "unknown",
    accountingConnected: "unknown",
    accountingPlatform: "unknown",
    lastLoginAt: "unknown",
    portalVisitsCurrentMonth: "unknown",
    portalVisitsPreviousMonth: "unknown",
    portalVisitsTwoMonthsAgo: "unknown",
    documentUploadUsage: "unknown",
  };
}
