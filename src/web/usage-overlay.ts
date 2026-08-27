import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RelationshipIdentity } from "../domain/identity.js";
import { matchUsageToCrm } from "../domain/identity-match.js";
import { deriveLeadingIndicators } from "../domain/leading-indicators.js";
import type { NormalizedUsageProfile } from "../domain/normalized-usage.js";
import { domainFromEmail } from "../domain/normalize-identity.js";
import type { DiscoveryDiagnostic, JsonObject } from "../integrations/zoho/types.js";

export type UsageOverlay = {
  available: boolean;
  matchStatus?: "matched" | "unmatched" | "needs_review";
  registered?: boolean;
  accountingConnected?: string | boolean;
  activation?: string | null;
  lastActivity?: string;
  paying?: boolean | string;
  message?: string;
};

export function loadImportedProfiles(): NormalizedUsageProfile[] {
  const filePath = resolve(process.cwd(), "diagnostics/usage-import.json");
  if (!existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      accounts?: Array<{ usageIntelligence?: { profile?: NormalizedUsageProfile } }>;
    };
    return (parsed.accounts ?? [])
      .map((account) => account.usageIntelligence?.profile)
      .filter((profile): profile is NormalizedUsageProfile => Boolean(profile));
  } catch {
    return [];
  }
}

function crmIdentityFromRecord(diagnostic: DiscoveryDiagnostic): RelationshipIdentity {
  const record = diagnostic.primaryRecord.record ?? {};
  const email = typeof record.Email === "string" ? record.Email : undefined;
  const company =
    typeof record.Company === "string"
      ? record.Company
      : typeof (record.Account_Name as JsonObject | undefined)?.name === "string"
        ? String((record.Account_Name as JsonObject).name)
        : undefined;
  const id = diagnostic.primaryRecord.id ?? undefined;
  const module = diagnostic.primaryRecord.module;
  return {
    zoho: {
      contactId: module === "Contacts" ? id : undefined,
      leadId: module === "Leads" ? id : undefined,
      accountId: module === "Accounts" ? id : undefined,
    },
    portalGenie: {},
    emails: email ? [email] : [],
    domains: email ? [domainFromEmail(email) ?? ""].filter(Boolean) : [],
    companyName: company,
    source: "zoho",
  };
}

export function usageOverlayForDiagnostic(diagnostic: DiscoveryDiagnostic): UsageOverlay {
  const profiles = loadImportedProfiles();
  if (profiles.length === 0) {
    return { available: false, message: "No usage import found. Import a CSV/XLSX from Usage Data." };
  }

  const crm = crmIdentityFromRecord(diagnostic);
  for (const profile of profiles) {
    const match = matchUsageToCrm(profile, [crm]);
    if (match.status === "matched") {
      const indicators = deriveLeadingIndicators(profile);
      return {
        available: true,
        matchStatus: "matched",
        registered: Boolean(profile.registrationDate || profile.identity.portalGenieAccountId),
        accountingConnected: profile.accountingSoftware
          ? profile.accountingConnected
            ? profile.accountingSoftware
            : false
          : profile.accountingConnected,
        activation: indicators.activationState.value,
        lastActivity: profile.lastMeaningfulActivityAt ?? profile.lastVisitAt,
        paying: profile.payingStatus ?? profile.payingStatusRaw,
      };
    }
  }

  return { available: true, matchStatus: "unmatched", message: "No deterministic usage match for this Zoho record." };
}
