/**
 * Stage 2 recovery: verify Zoho retrieval for the 8 Access Denied organisations.
 * Does not call OpenAI. Does not rebuild Command Centre.
 */
import { zohoRuntime } from "../src/services/zoho-runtime.js";
import { loadEnvFile } from "../src/config/load-env.js";
import { STAGE2_FAILED_ORGANISATIONS } from "./stage2-sample.js";

loadEnvFile();

function retrievalLabel(success: boolean, httpStatus?: number, error?: string): "RETRIEVED" | "EMPTY" | "UNAVAILABLE" | "ERROR" {
  if (error && /access denied/i.test(error)) return "ERROR";
  if (httpStatus === 204) return "UNAVAILABLE";
  if (!success && httpStatus && httpStatus >= 400) return "ERROR";
  if (success) return "RETRIEVED";
  return "UNAVAILABLE";
}

const connection = await zohoRuntime.connectionStatus();
if (connection.status !== "connected") {
  process.stdout.write(
    `${JSON.stringify({ connection, openai_called: false, stop: "Zoho is not connected." }, null, 2)}\n`,
  );
  process.stderr.write("\nSTOP: Zoho retrieval is not healthy. Do not rebuild Command Centre.\n");
  process.exit(1);
}
const { client } = zohoRuntime.getClient();

const listingProbes: Record<string, { ok: boolean; status: number; count: number; error?: string }> = {};
for (const moduleName of ["Contacts", "Leads", "Accounts", "Deals"] as const) {
  try {
    const result = await client.getRecords(moduleName, {
      fields: moduleName === "Deals" ? ["Deal_Name", "Stage"] : moduleName === "Accounts" ? ["Account_Name"] : ["Full_Name", "Email"],
      page: 1,
      perPage: 1,
    });
    const data = result.json && typeof result.json === "object" && "data" in result.json ? (result.json as { data?: unknown[] }).data : [];
    listingProbes[moduleName] = {
      ok: result.ok,
      status: result.status,
      count: Array.isArray(data) ? data.length : 0,
    };
  } catch (error) {
    listingProbes[moduleName] = {
      ok: false,
      status: 0,
      count: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const orgRetrieval = [];
let accessDenied = false;
for (const org of STAGE2_FAILED_ORGANISATIONS) {
  const started = Date.now();
  try {
    const diagnostic = await zohoRuntime.discover(org.module, org.recordId);
    const notes = diagnostic.relatedLists.retrievals.find((item) => item.apiName === "Notes");
    const deals = diagnostic.relatedLists.retrievals.find(
      (item) => item.apiName === "Deals" || item.apiName === "Potentials",
    );
    const attemptedRelated = diagnostic.relatedLists.retrievals.filter((item) => item.attempted);
    orgRetrieval.push({
      organisation: org.organisation_name,
      organisation_id: org.organisation_id,
      representative: { module: org.module, recordId: org.recordId, name: org.representative_name },
      duration_ms: Date.now() - started,
      primary_record: {
        retrieved: diagnostic.primaryRecord.retrieved,
        state: diagnostic.primaryRecord.retrieved ? "RETRIEVED" : "ERROR",
      },
      notes: {
        attempted: Boolean(notes?.attempted),
        success: Boolean(notes?.success),
        httpStatus: notes?.httpStatus,
        recordCount: notes?.recordCount ?? 0,
        state: notes
          ? retrievalLabel(notes.success, notes.httpStatus, notes.error)
          : "UNAVAILABLE",
      },
      deals: deals
        ? {
            attempted: deals.attempted,
            success: deals.success,
            httpStatus: deals.httpStatus,
            recordCount: deals.recordCount,
            state: retrievalLabel(deals.success, deals.httpStatus, deals.error),
          }
        : { attempted: false, state: "UNAVAILABLE" },
      emails: {
        attempted: diagnostic.emails.listAttempted,
        success: diagnostic.emails.success,
        httpStatus: diagnostic.emails.httpStatus,
        count: diagnostic.emails.count,
        state: diagnostic.emails.success
          ? "RETRIEVED"
          : retrievalLabel(false, diagnostic.emails.httpStatus, diagnostic.emails.error),
        error: diagnostic.emails.error,
      },
      related_attempted: attemptedRelated.map((item) => ({
        apiName: item.apiName,
        success: item.success,
        httpStatus: item.httpStatus,
        recordCount: item.recordCount,
        error: item.error,
      })),
      unavailable_capabilities: diagnostic.salesContextSummary.unavailableCapabilities,
      errors: diagnostic.errors,
      openai_called: false,
      analysis_attempted: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/access denied/i.test(message)) accessDenied = true;
    orgRetrieval.push({
      organisation: org.organisation_name,
      organisation_id: org.organisation_id,
      representative: { module: org.module, recordId: org.recordId, name: org.representative_name },
      duration_ms: Date.now() - started,
      failed_endpoint: "POST {ZOHO_ACCOUNTS_URL}/oauth/v2/token (grant_type=refresh_token)",
      http_error: message,
      retrieval_state: "ERROR",
      partial_evidence: false,
      openai_called: false,
      analysis_attempted: false,
    });
    break;
  }
}

const report = {
  connection: {
    status: connection.status,
    organisation: connection.organisation,
    apiDomain: connection.apiDomain,
    apiStatus: connection.apiStatus,
    scopes: connection.capabilities,
    error: connection.error,
    readOnly: connection.readOnly,
  },
  listing_probes: listingProbes,
  organisations: orgRetrieval,
  access_denied: accessDenied,
  openai_called: false,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (accessDenied || connection.status !== "connected") {
  process.stderr.write("\nSTOP: Zoho retrieval is not healthy. Do not rebuild Command Centre.\n");
  process.exit(1);
}
