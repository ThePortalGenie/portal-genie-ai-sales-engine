import type { AccountingPlatform, UsageAggregates } from "../../domain/usage.js";
import type { NormalizedUsageProfile } from "../../domain/normalized-usage.js";
import type { PortalGenieUsageReader } from "../../integrations/portal-genie/reader.js";
import { normalizeEmail } from "../../domain/normalize-identity.js";

export function profileToUsageAggregates(profile: NormalizedUsageProfile): UsageAggregates {
  return {
    availability: "available",
    registration: {
      registeredAt: profile.registrationDate,
      country: profile.country,
      industry: profile.industry,
    },
    accounting: {
      platform: inferPlatform(profile.accountingSoftware),
      connected: profile.accountingConnected ?? "unknown",
      connectedAt: profile.accountingConnectedAt,
    },
    visits: {
      lastVisitAt: profile.lastVisitAt,
      visitsLast7Days: profile.visitsLast7Days,
      visitsLast30Days: profile.visitsLast30Days,
    },
    payments: {
      paymentCount: profile.paymentsProcessed,
      paymentsLast30Days: profile.paymentsLast30Days,
    },
    documents: {
      lastDocumentActivityAt: profile.lastMeaningfulActivityAt,
      documentsViewed: profile.documentsViewed,
      documentsViewedLast30Days: profile.documentsViewedLast30Days,
    },
    emails: {
      emailsSent: profile.emailsSent,
      emailsSentLast30Days: profile.emailsSentLast30Days,
    },
  };
}

function inferPlatform(value: string | undefined): AccountingPlatform {
  if (!value) return "unknown";
  const normalised = value.toLowerCase();
  if (normalised.includes("xero")) return "xero";
  if (normalised.includes("quick")) return "quickbooks";
  if (normalised.includes("sage")) return "sage_business_cloud";
  if (normalised.includes("none") || normalised.includes("not")) return "none";
  return "other";
}

export class ImportedUsageReader implements PortalGenieUsageReader {
  constructor(private readonly profiles: NormalizedUsageProfile[]) {}

  async getUsageAggregates(identity: {
    email?: string;
    accountId?: string;
    zohoId?: string;
  }): Promise<UsageAggregates> {
    const profile = this.find(identity);
    if (!profile) {
      return { availability: "unavailable" };
    }
    return profileToUsageAggregates(profile);
  }

  find(identity: { email?: string; accountId?: string; zohoId?: string }): NormalizedUsageProfile | undefined {
    if (identity.accountId) {
      const hit = this.profiles.find((profile) => profile.identity.portalGenieAccountId === identity.accountId);
      if (hit) return hit;
    }
    if (identity.zohoId) {
      const hit = this.profiles.find((profile) => profile.identity.zohoId === identity.zohoId);
      if (hit) return hit;
    }
    if (identity.email) {
      const email = normalizeEmail(identity.email);
      const hit = this.profiles.find((profile) => profile.identity.primaryEmail === email);
      if (hit) return hit;
    }
    return undefined;
  }
}
