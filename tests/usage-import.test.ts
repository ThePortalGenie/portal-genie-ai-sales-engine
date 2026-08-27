import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseCsv } from "../src/ingestion/usage/parse-csv.js";
import { normalizeUsageRecords, rowsToRawRecords } from "../src/ingestion/usage/normalize.js";
import { importUsageFile } from "../src/ingestion/usage/import-file.js";
import { matchUsageToCrm } from "../src/domain/identity-match.js";
import { classifyActivationState, usageStrengthFromActivation } from "../src/domain/leading-indicators.js";
import { DEFAULT_ACTIVATION_THRESHOLDS } from "../src/domain/normalized-usage.js";
import { combineAccountIntelligence } from "../src/domain/account-intelligence.js";
import type { RelationshipIdentity } from "../src/domain/identity.js";
import { ImportedUsageReader } from "../src/ingestion/usage/imported-reader.js";

const NOW = new Date("2026-08-27T10:00:00Z");

function profileFromCsv(csv: string) {
  const parsed = parseCsv(csv);
  return normalizeUsageRecords(rowsToRawRecords(parsed.headers, parsed.rows), {
    kind: "csv",
    fileName: "memory.csv",
    importedAt: NOW.toISOString(),
  })[0];
}

test("CSV parser keeps quoted commas", () => {
  const parsed = parseCsv('Company,Email\n"ABC Accounting, LLP",jane@abc.com\n');
  assert.deepEqual(parsed.headers, ["Company", "Email"]);
  assert.equal(parsed.rows[0]?.[0], "ABC Accounting, LLP");
});

test("missing usage fields are recorded rather than failing the import", () => {
  const profile = profileFromCsv("Company,Primary email\nABC Accounting,jane@abcaccounting.com\n");
  assert.ok(profile);
  assert.equal(profile.identity.company, "ABC Accounting");
  assert.ok(profile.missingFields.includes("visitsLast30Days"));
  assert.ok(profile.missingFields.includes("accountingConnected"));
});

test("email matching is deterministic and unique", () => {
  const profile = profileFromCsv("Primary email,Company\njane@abcaccounting.com,ABC Accounting\n");
  assert.ok(profile);
  const crm: RelationshipIdentity[] = [
    {
      zoho: { contactId: "111" },
      portalGenie: {},
      emails: ["Jane@ABCAccounting.com"],
      companyName: "ABC Accounting",
      source: "zoho",
    },
  ];
  const match = matchUsageToCrm(profile, crm);
  assert.equal(match.status, "matched");
  assert.equal(match.method, "email");
});

test("fuzzy company names are flagged and never auto-merged", () => {
  const profile = profileFromCsv("Company\nABC Accountng\n");
  assert.ok(profile);
  const crm: RelationshipIdentity[] = [
    {
      zoho: { accountId: "222" },
      portalGenie: {},
      emails: [],
      companyName: "ABC Accounting",
      source: "zoho",
    },
  ];
  const match = matchUsageToCrm(profile, crm);
  assert.equal(match.status, "needs_review");
  assert.equal(match.crm, undefined);
  assert.ok((match.candidates[0]?.score ?? 0) >= 0.85);
});

test("never-activated vs highly-active classifications use configurable thresholds", () => {
  const unused = profileFromCsv(
    "Portal Genie Account ID,Registration date,Accounting software connected,Visits last 30 days\nPG-1,2026-01-05,No,0\n",
  );
  const active = profileFromCsv(
    "Portal Genie Account ID,Accounting software connected,Visits last 30 days,Documents viewed,Last Portal Genie visit\nPG-2,Yes,14,38,2026-08-20\n",
  );
  assert.ok(unused && active);
  assert.equal(classifyActivationState(unused, NOW).state, "never_activated");
  assert.equal(classifyActivationState(active, NOW).state, "highly_active");
  assert.equal(usageStrengthFromActivation("highly_active"), "high");
  assert.equal(usageStrengthFromActivation("never_activated"), "low");
});

test("declining uses the configurable visit ratio", () => {
  const profile = profileFromCsv(
    "Portal Genie Account ID,Visits last 7 days,Visits last 30 days,Last Portal Genie visit\nPG-3,1,20,2026-08-25\n",
  );
  assert.ok(profile);
  assert.equal(
    classifyActivationState(profile, NOW, DEFAULT_ACTIVATION_THRESHOLDS).state,
    "declining",
  );
});

test("imported usage reader is interchangeable with the usage port", async () => {
  const profile = profileFromCsv("Primary email,Visits last 30 days\njane@abcaccounting.com,14\n");
  assert.ok(profile);
  const reader = new ImportedUsageReader([profile]);
  const usage = await reader.getUsageAggregates({ email: "jane@abcaccounting.com" });
  assert.equal(usage.availability, "available");
  assert.equal(usage.visits?.visitsLast30Days, 14);
});

test("sales intelligence combines CRM and usage without treating unknown CRM intent as a usage fact", () => {
  const profile = profileFromCsv(
    "Primary email,Accounting software connected,Visits last 30 days,Documents viewed,Last Portal Genie visit\njane@abcaccounting.com,Yes,14,38,2026-08-20\n",
  );
  assert.ok(profile);
  const combined = combineAccountIntelligence({
    usage: profile,
    crmIntent: "high",
    now: NOW,
    crmRecords: [
      {
        zoho: { contactId: "111" },
        portalGenie: {},
        emails: ["jane@abcaccounting.com"],
        source: "zoho",
      },
    ],
  });
  assert.equal(combined.crmIntelligence.match.status, "matched");
  assert.equal(combined.usageIntelligence.productUsage, "high");
  assert.equal(combined.salesIntelligence.interpretation, "High-priority conversion opportunity.");
});

test("usage-template.csv imports through the file adapter", async () => {
  const imported = await importUsageFile("data/usage-template.csv");
  assert.equal(imported.rowCount, 2);
  assert.ok(imported.mappedHeaders.includes("Company"));
  assert.equal(imported.profiles[0]?.identity.portalGenieAccountId, "PG-1001");
  assert.equal(imported.profiles[1]?.accountingConnected, false);
});

test("xlsx adapter produces the same normalised identity as CSV", async () => {
  const ExcelJS = (await import("exceljs")).default;
  const file = join(tmpdir(), `usage-${Date.now()}.xlsx`);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Usage");
  sheet.addRow(["Primary email", "Company", "Visits last 30 days"]);
  sheet.addRow(["jane@abcaccounting.com", "ABC Accounting", 14]);
  await workbook.xlsx.writeFile(file);
  const imported = await importUsageFile(file);
  assert.equal(imported.profiles[0]?.identity.primaryEmail, "jane@abcaccounting.com");
  assert.equal(imported.profiles[0]?.visitsLast30Days, 14);
});
