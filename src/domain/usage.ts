/**
 * Sales Engine usage signal shapes. These are aggregates, not a copy of the
 * Portal Genie operational schema. Field names here are Sales Engine names.
 */

export type SignalAvailability = "available" | "unavailable" | "not_yet_integrated";

export type AccountingPlatform = "xero" | "quickbooks" | "sage_business_cloud" | "other" | "none" | "unknown";

export type UsageAggregates = {
  availability: SignalAvailability;
  registration?: {
    registeredAt?: string;
    accountStatus?: string;
    country?: string;
    industry?: string;
    accountType?: string;
  };
  accounting?: {
    platform: AccountingPlatform;
    connected: boolean | "unknown";
    connectedAt?: string;
    connectionStatus?: string;
    lastSuccessfulSyncAt?: string;
    disconnectedAt?: string;
  };
  visits?: {
    firstVisitAt?: string;
    lastVisitAt?: string;
    visitsLast7Days?: number;
    visitsLast30Days?: number;
    activeDaysLast30Days?: number;
    daysSinceLastVisit?: number;
  };
  payments?: {
    firstPaymentAt?: string;
    lastPaymentAt?: string;
    paymentsLast7Days?: number;
    paymentsLast30Days?: number;
    paymentsLast90Days?: number;
    paymentCount?: number;
  };
  documents?: {
    firstDocumentActivityAt?: string;
    lastDocumentActivityAt?: string;
    documentsViewedLast30Days?: number;
    documentsViewed?: number;
  };
  emails?: {
    firstEmailSentAt?: string;
    lastEmailSentAt?: string;
    emailsSent?: number;
    emailsSentLast30Days?: number;
  };
};

export function unavailableUsageAggregates(): UsageAggregates {
  return { availability: "not_yet_integrated" };
}
