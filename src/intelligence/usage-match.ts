import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RelationshipIdentity } from "../domain/identity.js";
import { matchUsageToCrm } from "../domain/identity-match.js";
import type { NormalizedUsageProfile } from "../domain/normalized-usage.js";
import { domainFromEmail } from "../domain/normalize-identity.js";
import type { OrgMember } from "./org-resolution.js";
import { usageFromProfiles, usageUnknown, type UsageMatchSummary } from "./org-intelligence.js";

export function loadImportedUsageProfiles(cwd = process.cwd()): NormalizedUsageProfile[] {
  const filePath = resolve(cwd, "diagnostics/usage-import.json");
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

export function identityFromMember(member: OrgMember): RelationshipIdentity {
  return {
    zoho: {
      contactId: member.module === "Contacts" ? member.recordId : undefined,
      leadId: member.module === "Leads" ? member.recordId : undefined,
      accountId: member.accountId ?? (member.module === "Accounts" ? member.recordId : undefined),
    },
    portalGenie: { accountId: member.portalGenieOrgId },
    emails: member.email ? [member.email] : [],
    domains: member.email ? [domainFromEmail(member.email) ?? ""].filter(Boolean) : [],
    companyName: member.company,
    source: "zoho",
  };
}

export function matchUsageForOrganisation(members: OrgMember[], profiles: NormalizedUsageProfile[]): UsageMatchSummary {
  if (profiles.length === 0) {
    return usageUnknown("No Portal Genie usage import is available. Usage is unknown, not zero.");
  }
  const identities = members.map(identityFromMember);
  const matches: Array<{ profile: NormalizedUsageProfile; method?: string; status: "matched" | "needs_review" }> = [];
  const seen = new Set<string>();
  for (const profile of profiles) {
    const match = matchUsageToCrm(profile, identities);
    if (match.status === "unmatched") continue;
    const key = profile.identity.portalGenieAccountId ?? profile.identity.primaryEmail ?? JSON.stringify(profile.identity);
    if (seen.has(key)) continue;
    seen.add(key);
    if (match.status === "matched" || match.status === "needs_review") {
      matches.push({ profile, method: match.method, status: match.status });
    }
  }
  if (matches.length === 0) {
    return usageUnknown("No deterministic usage match for this organisation. Usage is unknown, not zero.");
  }
  return usageFromProfiles(matches);
}
