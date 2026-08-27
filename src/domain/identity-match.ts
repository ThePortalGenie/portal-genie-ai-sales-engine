import type { RelationshipIdentity } from "./identity.js";
import type { NormalizedUsageProfile } from "./normalized-usage.js";
import {
  levenshteinRatio,
  normalizeCompanyName,
  normalizeEmail,
} from "./normalize-identity.js";

export type MatchMethod =
  | "portal_genie_account_id"
  | "zoho_id"
  | "email"
  | "domain"
  | "company";

export type IdentityMatchStatus = "matched" | "unmatched" | "needs_review";

export type IdentityMatch = {
  status: IdentityMatchStatus;
  method?: MatchMethod;
  crm?: RelationshipIdentity;
  candidates: Array<{
    crm: RelationshipIdentity;
    reason: string;
    score?: number;
  }>;
};

function uniqueByKey(records: RelationshipIdentity[], keyOf: (record: RelationshipIdentity) => string | undefined): RelationshipIdentity[] {
  const seen = new Map<string, RelationshipIdentity>();
  for (const record of records) {
    const key = keyOf(record);
    if (key && !seen.has(key)) {
      seen.set(key, record);
    }
  }
  return [...seen.values()];
}

function emailsOf(record: RelationshipIdentity): string[] {
  return record.emails.map(normalizeEmail).filter(Boolean);
}

function zohoIdsOf(record: RelationshipIdentity): string[] {
  return [record.zoho.leadId, record.zoho.contactId, record.zoho.accountId].filter(
    (id): id is string => Boolean(id),
  );
}

/**
 * Deterministic matching first. Fuzzy company similarity only produces
 * needs_review candidates — it never auto-merges.
 */
export function matchUsageToCrm(
  usage: NormalizedUsageProfile,
  crmRecords: RelationshipIdentity[],
): IdentityMatch {
  if (usage.identity.portalGenieAccountId) {
    const hits = crmRecords.filter(
      (record) => record.portalGenie.accountId === usage.identity.portalGenieAccountId,
    );
    if (hits.length === 1 && hits[0]) {
      return { status: "matched", method: "portal_genie_account_id", crm: hits[0], candidates: [] };
    }
    if (hits.length > 1) {
      return {
        status: "needs_review",
        method: "portal_genie_account_id",
        candidates: hits.map((crm) => ({ crm, reason: "Multiple CRM records share this Portal Genie Account ID" })),
      };
    }
  }

  if (usage.identity.zohoId) {
    const hits = crmRecords.filter((record) => zohoIdsOf(record).includes(usage.identity.zohoId!));
    if (hits.length === 1 && hits[0]) {
      return { status: "matched", method: "zoho_id", crm: hits[0], candidates: [] };
    }
    if (hits.length > 1) {
      return {
        status: "needs_review",
        method: "zoho_id",
        candidates: hits.map((crm) => ({ crm, reason: "Multiple CRM records share this Zoho ID" })),
      };
    }
  }

  if (usage.identity.primaryEmail) {
    const email = normalizeEmail(usage.identity.primaryEmail);
    const hits = uniqueByKey(
      crmRecords.filter((record) => emailsOf(record).includes(email)),
      (record) => record.zoho.contactId ?? record.zoho.leadId ?? record.zoho.accountId,
    );
    if (hits.length === 1 && hits[0]) {
      return { status: "matched", method: "email", crm: hits[0], candidates: [] };
    }
    if (hits.length > 1) {
      return {
        status: "needs_review",
        method: "email",
        candidates: hits.map((crm) => ({ crm, reason: "Email matches more than one CRM record" })),
      };
    }
  }

  // Business domain and company name may discover organisation-level usage elsewhere.
  // They must not auto-assign one person's Portal Genie usage to another CRM Contact.

  if (usage.identity.company) {
    const company = normalizeCompanyName(usage.identity.company);
    const exact = crmRecords.filter(
      (record) => record.companyName && normalizeCompanyName(record.companyName) === company,
    );
    if (exact.length > 1) {
      return {
        status: "needs_review",
        method: "company",
        candidates: exact.map((crm) => ({ crm, reason: "Normalised company name matches multiple CRM records" })),
      };
    }

    const fuzzy = crmRecords
      .map((crm) => ({
        crm,
        score: crm.companyName ? levenshteinRatio(company, normalizeCompanyName(crm.companyName)) : 0,
      }))
      .filter((item) => item.score >= 0.85)
      .sort((left, right) => right.score - left.score);
    if (fuzzy.length > 0) {
      return {
        status: "needs_review",
        candidates: fuzzy.map((item) => ({
          crm: item.crm,
          reason: "Possible company name match; not merged",
          score: item.score,
        })),
      };
    }
  }

  return { status: "unmatched", candidates: [] };
}
