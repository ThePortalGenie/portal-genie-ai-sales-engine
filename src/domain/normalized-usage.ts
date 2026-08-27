import type { AccountingPlatform } from "./usage.js";
import type { DocumentUploadUsage, UsageFieldQuality } from "./portal-genie-usage.js";

export const EXPECTED_USAGE_FIELDS = [
  "portalGenieAccountId",
  "zohoId",
  "company",
  "firstName",
  "surname",
  "primaryEmail",
  "domain",
  "registrationDate",
  "country",
  "industry",
  "accountingSoftware",
  "accountingConnected",
  "accountingConnectedAt",
  "lastLoginAt",
  "lastVisitAt",
  "portalVisitsCurrentMonth",
  "portalVisitsPreviousMonth",
  "portalVisitsTwoMonthsAgo",
  "documentUploadUsage",
  "visitsLast7Days",
  "visitsLast30Days",
  "paymentsProcessed",
  "paymentsLast30Days",
  "documentsViewed",
  "documentsViewedLast30Days",
  "emailsSent",
  "emailsSentLast30Days",
  "lastMeaningfulActivityAt",
  "payingStatus",
  "partnerStatus",
  "referrals",
] as const;

export type UsageFieldName = (typeof EXPECTED_USAGE_FIELDS)[number];

export type UsageIngestionKind = "csv" | "xlsx" | "scheduled_file" | "portal_genie_api" | "reporting_db";

export type NormalizedUsageProfile = {
  source: {
    kind: UsageIngestionKind;
    fileName?: string;
    importedAt: string;
    rowNumber: number;
  };
  identity: {
    portalGenieAccountId?: string;
    zohoId?: string;
    company?: string;
    firstName?: string;
    surname?: string;
    primaryEmail?: string;
    domain?: string;
  };
  registrationDate?: string;
  country?: string;
  industry?: string;
  accountingSoftware?: string;
  accountingPlatform?: AccountingPlatform;
  accountingConnected?: boolean;
  accountingConnectedAt?: string;
  lastLoginAt?: string;
  lastVisitAt?: string;
  portalVisitsCurrentMonth?: number;
  portalVisitsPreviousMonth?: number;
  portalVisitsTwoMonthsAgo?: number;
  documentUploadUsage?: DocumentUploadUsage;
  visitsLast7Days?: number;
  visitsLast30Days?: number;
  paymentsProcessed?: number;
  paymentsLast30Days?: number;
  documentsViewed?: number;
  documentsViewedLast30Days?: number;
  emailsSent?: number;
  emailsSentLast30Days?: number;
  lastMeaningfulActivityAt?: string;
  payingStatus?: boolean;
  payingStatusRaw?: string;
  partnerStatus?: boolean;
  partnerStatusRaw?: string;
  referrals?: number;
  missingFields: UsageFieldName[];
  extras: Record<string, string>;
  fieldQuality: UsageFieldQuality;
  warnings: string[];
  accepted: boolean;
  rejectionReason?: string;
};

export type ActivationThresholds = {
  calibrated: boolean;
  notes: string;
  dormantAfterDays: number;
  decliningVisitRatio: number;
  activeMinVisitsLast30Days: number;
  highlyActiveMinVisitsLast30Days: number;
  activatedRequiresAccountingConnection: boolean;
  activatedMinMeaningfulActions: number;
  /** Subscriber last-login within this many days is RECENT_LOGIN. Interim default. */
  recentLoginDays: number;
  /** Subscriber last-login older than this is LOGIN_STALE. Defaults to dormantAfterDays when omitted. */
  staleLoginDays: number;
  /** Ignore portal-visit trend changes smaller than this absolute count. */
  portalVisitTrendMinDelta: number;
  /** CRM inbound/activity older than this (or absent) can support CRM_QUIET signals. */
  crmQuietAfterDays: number;
};

export const DEFAULT_ACTIVATION_THRESHOLDS: ActivationThresholds = {
  calibrated: false,
  notes:
    "Interim defaults. Recalibrate after analysing real Portal Genie usage against paying conversion. recentLoginDays, staleLoginDays, portalVisitTrendMinDelta, and crmQuietAfterDays are judgement thresholds — not scores.",
  dormantAfterDays: 30,
  decliningVisitRatio: 0.5,
  activeMinVisitsLast30Days: 4,
  highlyActiveMinVisitsLast30Days: 12,
  activatedRequiresAccountingConnection: true,
  activatedMinMeaningfulActions: 1,
  recentLoginDays: 14,
  staleLoginDays: 30,
  portalVisitTrendMinDelta: 2,
  crmQuietAfterDays: 45,
};

export type InitialActivationState =
  | "registered"
  | "setup_started"
  | "accounting_connected"
  | "activated"
  | "active"
  | "highly_active"
  | "declining"
  | "dormant"
  | "never_activated"
  | "unknown";
