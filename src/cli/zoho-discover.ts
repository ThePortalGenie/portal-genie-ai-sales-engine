import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "../config/load-env.js";
import { loadZohoEnv } from "../config/env.js";
import { createLogger } from "../logging/logger.js";
import { parseArgs, printDiscoveryHelp } from "./args.js";
import { ZohoOAuth } from "../integrations/zoho/oauth.js";
import { ZohoHttp } from "../integrations/zoho/http.js";
import { ZohoCrmReadClient } from "../integrations/zoho/client.js";
import { runDiscovery } from "../integrations/zoho/discovery.js";
import {
  DEFAULT_EMAIL_BODY_FETCH_LIMIT,
  DEFAULT_RELATED_PAGE_SIZE,
} from "../integrations/zoho/constants.js";
import type { DiscoveryDiagnostic } from "../integrations/zoho/types.js";

loadEnvFile();

function defaultOutPath(diagnostic: DiscoveryDiagnostic): string {
  const moduleApiName = diagnostic.primaryRecord.module ?? "unknown";
  const id = diagnostic.primaryRecord.id ?? "unresolved";
  return resolve(process.cwd(), "diagnostics", `zoho-discovery-${moduleApiName}-${id}.json`);
}

function printSummary(diagnostic: DiscoveryDiagnostic, outPath: string): void {
  const summary = diagnostic.salesContextSummary;
  const lines = [
    "Zoho Discovery Connector — read-only diagnostic",
    `API: CRM ${diagnostic.connector.apiVersion} @ ${diagnostic.connector.apiDomain}`,
    `Record: ${diagnostic.primaryRecord.module ?? "-"} / ${diagnostic.primaryRecord.id ?? "-"} (retrieved: ${summary.hasPrimaryRecord})`,
    `Fields: ${diagnostic.fieldCatalog.totalFields} total, ${summary.customFieldCount} custom`,
    `Related lists available: ${diagnostic.relatedLists.available.length}`,
    `Related lists retrieved: ${diagnostic.relatedLists.retrievals.filter((item) => item.success).length}`,
    `Notes: ${summary.hasNotes} | Deals: ${summary.hasDeals} | Account: ${summary.hasAccount} | Tags: ${summary.hasTags}`,
    `Emails headers: ${diagnostic.emails.count} | bodies retrieved: ${diagnostic.emails.bodies.filter((item) => item.retrieved).length}`,
    `Open activities: ${summary.hasOpenActivities} | Closed activities: ${summary.hasClosedActivities}`,
    "",
    "Likely useful for sales intelligence:",
    ...summary.likelyUsefulForIntelligence.map((item) => `  - ${item}`),
    "",
    "Unavailable / failed:",
    ...(summary.unavailableCapabilities.length > 0
      ? summary.unavailableCapabilities.map((item) => `  - ${item.capability}: ${item.reason}`)
      : ["  - none"]),
    "",
    `Full diagnostic JSON: ${outPath}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${printDiscoveryHelp()}\n`);
    return;
  }

  const env = loadZohoEnv();
  const logger = createLogger();
  const oauth = new ZohoOAuth(env, logger);
  const http = new ZohoHttp({
    getAccessToken: () => oauth.getAccessToken(),
    getApiDomain: () => oauth.getApiDomain(),
    logger,
  });
  const client = new ZohoCrmReadClient(http);

  const diagnostic = await runDiscovery(
    {
      client,
      accountsUrl: env.accountsUrl,
      apiDomain: await oauth.getApiDomain(),
      getFieldsForModule: (moduleApiName) => client.getFields(moduleApiName),
    },
    {
      module: args.module,
      recordId: args.id,
      email: args.email,
      fetchEmailBodies: Number.isFinite(args.fetchEmailBodies)
        ? Number(args.fetchEmailBodies)
        : DEFAULT_EMAIL_BODY_FETCH_LIMIT,
      maxRelatedRecords: Number.isFinite(args.maxRelatedRecords)
        ? Number(args.maxRelatedRecords)
        : DEFAULT_RELATED_PAGE_SIZE,
    },
  );

  const outPath = args.out ? resolve(process.cwd(), args.out) : defaultOutPath(diagnostic);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8");

  if (args.json) {
    process.stdout.write(`${JSON.stringify(diagnostic, null, 2)}\n`);
  } else {
    printSummary(diagnostic, outPath);
  }

  if (diagnostic.errors.length > 0 && !diagnostic.primaryRecord.retrieved) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
