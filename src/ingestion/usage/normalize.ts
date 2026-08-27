import { EXPECTED_USAGE_FIELDS, type NormalizedUsageProfile, type UsageFieldName, type UsageIngestionKind } from "../../domain/normalized-usage.js";
import { domainFromEmail, normalizeDomain, normalizeEmail } from "../../domain/normalize-identity.js";
import { mapHeader } from "./column-map.js";
import { parseBoolean, parseDate, parseNumber, parseText } from "./parse-values.js";

export type RawUsageRow = Record<string, string>;

export function rowsToRawRecords(headers: string[], rows: string[][]): RawUsageRow[] {
  return rows.map((row) => {
    const record: RawUsageRow = {};
    headers.forEach((header, index) => {
      record[header] = row[index] ?? "";
    });
    return record;
  });
}

export function normalizeUsageRecords(
  records: RawUsageRow[],
  source: { kind: UsageIngestionKind; fileName?: string; importedAt?: string },
): NormalizedUsageProfile[] {
  const importedAt = source.importedAt ?? new Date().toISOString();
  return records.map((record, index) => normalizeUsageRecord(record, {
    kind: source.kind,
    fileName: source.fileName,
    importedAt,
    rowNumber: index + 2,
  }));
}

export function normalizeUsageRecord(
  record: RawUsageRow,
  source: NormalizedUsageProfile["source"],
): NormalizedUsageProfile {
  const mapped: Partial<Record<(typeof EXPECTED_USAGE_FIELDS)[number], string>> = {};
  const extras: Record<string, string> = {};

  for (const [header, raw] of Object.entries(record)) {
    const field = mapHeader(header);
    const value = raw.trim();
    if (!field) {
      if (value) extras[header] = value;
      continue;
    }
    mapped[field] = value;
  }

  const primaryEmail = parseText(mapped.primaryEmail);
  const domain = parseText(mapped.domain) ?? (primaryEmail ? domainFromEmail(primaryEmail) : undefined);

  const profile: NormalizedUsageProfile = {
    source,
    identity: {
      portalGenieAccountId: parseText(mapped.portalGenieAccountId),
      zohoId: parseText(mapped.zohoId),
      company: parseText(mapped.company),
      primaryEmail: primaryEmail ? normalizeEmail(primaryEmail) : undefined,
      domain: domain ? normalizeDomain(domain) : undefined,
    },
    registrationDate: parseDate(mapped.registrationDate),
    country: parseText(mapped.country),
    industry: parseText(mapped.industry),
    accountingSoftware: parseText(mapped.accountingSoftware),
    accountingConnected: parseBoolean(mapped.accountingConnected),
    accountingConnectedAt: parseDate(mapped.accountingConnectedAt),
    lastVisitAt: parseDate(mapped.lastVisitAt),
    visitsLast7Days: parseNumber(mapped.visitsLast7Days),
    visitsLast30Days: parseNumber(mapped.visitsLast30Days),
    paymentsProcessed: parseNumber(mapped.paymentsProcessed),
    paymentsLast30Days: parseNumber(mapped.paymentsLast30Days),
    documentsViewed: parseNumber(mapped.documentsViewed),
    documentsViewedLast30Days: parseNumber(mapped.documentsViewedLast30Days),
    emailsSent: parseNumber(mapped.emailsSent),
    emailsSentLast30Days: parseNumber(mapped.emailsSentLast30Days),
    lastMeaningfulActivityAt: parseDate(mapped.lastMeaningfulActivityAt),
    payingStatus: parseBoolean(mapped.payingStatus),
    payingStatusRaw: parseText(mapped.payingStatus),
    partnerStatus: parseBoolean(mapped.partnerStatus),
    partnerStatusRaw: parseText(mapped.partnerStatus),
    referrals: parseNumber(mapped.referrals),
    missingFields: [],
    extras,
  };

  profile.missingFields = EXPECTED_USAGE_FIELDS.filter((field) => !hasUsageField(profile, field));

  return profile;
}

function hasUsageField(profile: NormalizedUsageProfile, field: UsageFieldName): boolean {
  switch (field) {
    case "portalGenieAccountId":
      return Boolean(profile.identity.portalGenieAccountId);
    case "zohoId":
      return Boolean(profile.identity.zohoId);
    case "company":
      return Boolean(profile.identity.company);
    case "primaryEmail":
      return Boolean(profile.identity.primaryEmail);
    case "domain":
      return Boolean(profile.identity.domain);
    case "payingStatus":
      return profile.payingStatus !== undefined || Boolean(profile.payingStatusRaw);
    case "partnerStatus":
      return profile.partnerStatus !== undefined || Boolean(profile.partnerStatusRaw);
    default:
      return profile[field] !== undefined;
  }
}
