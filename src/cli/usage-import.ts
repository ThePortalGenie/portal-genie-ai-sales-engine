import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs, printUsageImportHelp } from "./args.js";
import { loadActivationThresholds } from "../config/activation-thresholds.js";
import { combineAccountIntelligence } from "../domain/account-intelligence.js";
import type { RelationshipIdentity } from "../domain/identity.js";
import { importUsageFile } from "../ingestion/usage/import-file.js";

function loadCrmIdentities(filePath: string): RelationshipIdentity[] {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("--match-crm must be a JSON array of CRM identity objects");
  }
  return parsed as RelationshipIdentity[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.file) {
    process.stdout.write(`${printUsageImportHelp()}\n`);
    if (!args.file && !args.help) {
      process.exitCode = 1;
    }
    return;
  }

  const imported = await importUsageFile(resolve(process.cwd(), args.file));
  const thresholds = loadActivationThresholds(
    args.thresholds ? resolve(process.cwd(), args.thresholds) : undefined,
  );
  const crmRecords = args.matchCrm ? loadCrmIdentities(resolve(process.cwd(), args.matchCrm)) : [];
  const now = new Date();
  const accounts = imported.profiles.map((profile) =>
    combineAccountIntelligence({ usage: profile, crmRecords, now, thresholds }),
  );

  const counts = {
    rows: imported.rowCount,
    matched: accounts.filter((item) => item.crmIntelligence.match.status === "matched").length,
    needsReview: accounts.filter((item) => item.crmIntelligence.match.status === "needs_review").length,
    unmatched: accounts.filter((item) => item.crmIntelligence.match.status === "unmatched").length,
    activation: {} as Record<string, number>,
  };
  for (const account of accounts) {
    const state = account.usageIntelligence.leadingIndicators?.activationState.value ?? "unknown";
    counts.activation[state] = (counts.activation[state] ?? 0) + 1;
  }

  const payload = {
    source: args.file,
    importedAt: new Date().toISOString(),
    thresholds: { ...thresholds },
    mappedHeaders: imported.mappedHeaders,
    unmappedHeaders: imported.unmappedHeaders,
    counts,
    accounts,
  };

  const outPath = args.out
    ? resolve(process.cwd(), args.out)
    : resolve(process.cwd(), "diagnostics", "usage-import.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  if (args.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    [
      "Usage import — normalised profiles (file adapter)",
      `Rows: ${counts.rows}`,
      `Mapped columns: ${imported.mappedHeaders.join(", ") || "(none)"}`,
      `Unmapped columns: ${imported.unmappedHeaders.join(", ") || "(none)"}`,
      `CRM matches: ${counts.matched} | needs review: ${counts.needsReview} | unmatched: ${counts.unmatched}`,
      `Activation: ${JSON.stringify(counts.activation)}`,
      `Thresholds calibrated: ${thresholds.calibrated}`,
      `JSON: ${outPath}`,
    ].join("\n") + "\n",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
