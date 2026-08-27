import { EXPECTED_USAGE_FIELDS, type NormalizedUsageProfile, type UsageFieldName, type UsageIngestionKind } from "../../domain/normalized-usage.js";
import type { AccountingPlatform } from "../../domain/usage.js";
import type { FieldPresence } from "../../domain/portal-genie-usage.js";
import { emptyFieldQuality } from "../../domain/portal-genie-usage.js";
import { domainFromEmail, normalizeDomain, normalizeEmail } from "../../domain/normalize-identity.js";
import { mapHeader } from "./column-map.js";
import {
  parseAccountingPlatform,
  parseBoolean,
  parseDate,
  parseDateField,
  parseNumber,
  parseNumericField,
  parseQuantityField,
  parseText,
} from "./parse-values.js";

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
  const warnings: string[] = [];
  const fieldQuality = emptyFieldQuality();

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
  const currentVisits = parseNumericField(mapped.portalVisitsCurrentMonth, "Portal Visits — Current Month");
  const previousVisits = parseNumericField(mapped.portalVisitsPreviousMonth, "Portal Visits — Previous Month");
  const twoMonthsVisits = parseNumericField(mapped.portalVisitsTwoMonthsAgo, "Portal Visits — Two Months Ago");
  const lastLogin = parseDateField(mapped.lastLoginAt, "Last Login Date");
  const documents = parseQuantityField(mapped.documentUploadUsage, "Data Used For Document Uploads");
  const platform = parseAccountingPlatform(mapped.accountingSoftware);
  const connected = parseBoolean(mapped.accountingConnected);
  const connectedRaw = mapped.accountingConnected?.trim() ?? "";

  if (currentVisits.warning) warnings.push(`Row ${source.rowNumber}: ${currentVisits.warning}`);
  if (previousVisits.warning) warnings.push(`Row ${source.rowNumber}: ${previousVisits.warning}`);
  if (twoMonthsVisits.warning) warnings.push(`Row ${source.rowNumber}: ${twoMonthsVisits.warning}`);
  if (lastLogin.warning) warnings.push(`Row ${source.rowNumber}: ${lastLogin.warning}`);
  if (documents.warning) warnings.push(`Row ${source.rowNumber}: ${documents.warning}`);

  fieldQuality.clientId = parseText(mapped.portalGenieAccountId) ? "present" : "unknown";
  fieldQuality.email = primaryEmail ? "present" : "unknown";
  fieldQuality.accountingConnected = connectedRaw
    ? connected === undefined
      ? /unknown|n\/a/i.test(connectedRaw)
        ? "unknown"
        : "invalid"
      : "present"
    : "unknown";
  if (fieldQuality.accountingConnected === "invalid") {
    warnings.push(`Row ${source.rowNumber}: Accounting Software Connected value "${connectedRaw}" is not YES/NO/UNKNOWN.`);
  }
  fieldQuality.accountingPlatform = platform.presence as FieldPresence;
  fieldQuality.lastLoginAt = lastLogin.presence;
  fieldQuality.portalVisitsCurrentMonth = currentVisits.presence;
  fieldQuality.portalVisitsPreviousMonth = previousVisits.presence;
  fieldQuality.portalVisitsTwoMonthsAgo = twoMonthsVisits.presence;
  fieldQuality.documentUploadUsage = documents.presence;

  const profile: NormalizedUsageProfile = {
    source,
    identity: {
      portalGenieAccountId: parseText(mapped.portalGenieAccountId),
      zohoId: parseText(mapped.zohoId),
      company: parseText(mapped.company),
      firstName: parseText(mapped.firstName),
      surname: parseText(mapped.surname),
      primaryEmail: primaryEmail ? normalizeEmail(primaryEmail) : undefined,
      domain: domain ? normalizeDomain(domain) : undefined,
    },
    registrationDate: parseDate(mapped.registrationDate),
    country: parseText(mapped.country),
    industry: parseText(mapped.industry),
    accountingSoftware: parseText(mapped.accountingSoftware),
    accountingPlatform: platform.value as AccountingPlatform | undefined,
    accountingConnected: connected,
    accountingConnectedAt: parseDate(mapped.accountingConnectedAt),
    lastLoginAt: lastLogin.value,
    lastVisitAt: parseDate(mapped.lastVisitAt),
    portalVisitsCurrentMonth: currentVisits.value,
    portalVisitsPreviousMonth: previousVisits.value,
    portalVisitsTwoMonthsAgo: twoMonthsVisits.value,
    documentUploadUsage: documents.value,
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
    fieldQuality,
    warnings,
    accepted: true,
  };

  if (!profile.identity.primaryEmail && !profile.identity.portalGenieAccountId && !profile.identity.zohoId) {
    profile.accepted = false;
    profile.rejectionReason = `Row ${source.rowNumber}: no Client ID, email, or Zoho ID — identity is required.`;
    warnings.push(profile.rejectionReason);
  }

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
    case "firstName":
      return Boolean(profile.identity.firstName);
    case "surname":
      return Boolean(profile.identity.surname);
    case "primaryEmail":
      return Boolean(profile.identity.primaryEmail);
    case "domain":
      return Boolean(profile.identity.domain);
    case "payingStatus":
      return profile.payingStatus !== undefined || Boolean(profile.payingStatusRaw);
    case "partnerStatus":
      return profile.partnerStatus !== undefined || Boolean(profile.partnerStatusRaw);
    case "documentUploadUsage":
      return profile.documentUploadUsage !== undefined;
    default:
      return profile[field] !== undefined;
  }
}
