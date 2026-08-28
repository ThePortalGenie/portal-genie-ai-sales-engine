import { asJsonObject } from "../integrations/zoho/http.js";
import type { ZohoCrmReader } from "../integrations/zoho/client.js";
import type { JsonObject } from "../integrations/zoho/types.js";
import type { PortfolioFailure, UniverseRecord } from "../domain/commercial-watch.js";

function text(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const object = asJsonObject(value);
  if (object && typeof object.name === "string") return object.name;
  return undefined;
}

function lookupId(value: unknown): string | undefined {
  const object = asJsonObject(value);
  return typeof object?.id === "string" ? object.id : undefined;
}

function recordsFrom(result: { ok: boolean; json: unknown }): JsonObject[] {
  const json = asJsonObject(result.json);
  const data = json && Array.isArray(json.data) ? json.data : [];
  return data.map((item) => asJsonObject(item)).filter((item): item is JsonObject => Boolean(item && typeof item.id === "string"));
}

function moreRecords(result: { json: unknown }): boolean {
  const json = asJsonObject(result.json);
  const info = asJsonObject(json?.info);
  return info?.more_records === true;
}

export async function listModuleRecords(
  client: ZohoCrmReader,
  moduleApiName: "Leads" | "Contacts" | "Deals",
  options: { maxRecords: number },
): Promise<{ records: JsonObject[]; truncated: boolean; error?: PortfolioFailure }> {
  const fields =
    moduleApiName === "Deals"
      ? ["Deal_Name", "Stage", "Amount", "Closing_Date", "Account_Name", "Contact_Name", "Pipeline", "Modified_Time", "Created_Time"]
      : moduleApiName === "Leads"
        ? ["Full_Name", "Last_Name", "Email", "Company", "Last_Activity_Time", "Modified_Time", "Created_Time"]
        : ["Full_Name", "Email", "Account_Name", "Last_Activity_Time", "Modified_Time", "Created_Time"];
  const collected: JsonObject[] = [];
  let page = 1;
  let truncated = false;
  while (collected.length < options.maxRecords) {
    const remaining = options.maxRecords - collected.length;
    const result = await client.getRecords(moduleApiName, {
      fields,
      page,
      perPage: Math.min(200, remaining),
      sortBy: "Modified_Time",
      sortOrder: "desc",
      converted: moduleApiName === "Leads" ? "false" : undefined,
    });
    if (!result.ok) {
      return {
        records: collected,
        truncated: false,
        error: {
          stage: "discovery",
          state: result.status === 204 ? "UNAVAILABLE" : "ERROR",
          message: `${moduleApiName} listing failed (HTTP ${result.status}). This is not empty activity.`,
        },
      };
    }
    const rows = recordsFrom(result);
    collected.push(...rows);
    if (!moreRecords(result) || rows.length === 0) break;
    if (collected.length >= options.maxRecords && moreRecords(result)) truncated = true;
    page += 1;
    if (page > 10) {
      truncated = true;
      break;
    }
  }
  return { records: collected.slice(0, options.maxRecords), truncated };
}

export function universeFromListing(moduleApiName: "Leads" | "Contacts" | "Deals", records: JsonObject[]): UniverseRecord[] {
  return records.map((record) => {
    if (moduleApiName === "Deals") {
      return {
        module: "Deals",
        recordId: String(record.id),
        name: text(record.Deal_Name) ?? "Deal",
        company: text(record.Account_Name),
        accountId: lookupId(record.Account_Name),
        accountName: text(record.Account_Name),
        contactId: lookupId(record.Contact_Name),
        lastActivityAt: text(record.Modified_Time) ?? text(record.Created_Time),
        modifiedAt: text(record.Modified_Time),
        stage: text(record.Stage),
        pipeline: text(record.Pipeline),
        retrieval: "RETRIEVED",
      };
    }
    return {
      module: moduleApiName,
      recordId: String(record.id),
      name: text(record.Full_Name) ?? text(record.Last_Name) ?? "Unknown",
      email: text(record.Email),
      company: text(record.Account_Name) ?? text(record.Company),
      accountId: lookupId(record.Account_Name),
      accountName: text(record.Account_Name),
      lastActivityAt: text(record.Last_Activity_Time) ?? text(record.Modified_Time) ?? text(record.Created_Time),
      modifiedAt: text(record.Modified_Time),
      retrieval: "RETRIEVED",
    };
  });
}

export async function discoverUniverse(
  client: ZohoCrmReader,
  options: { maxRecordsPerModule: number },
): Promise<{ records: UniverseRecord[]; failures: PortfolioFailure[]; truncated: boolean }> {
  const failures: PortfolioFailure[] = [];
  const records: UniverseRecord[] = [];
  let truncated = false;
  for (const moduleApiName of ["Contacts", "Leads", "Deals"] as const) {
    const listed = await listModuleRecords(client, moduleApiName, { maxRecords: options.maxRecordsPerModule });
    if (listed.error) failures.push(listed.error);
    if (listed.truncated) truncated = true;
    records.push(...universeFromListing(moduleApiName, listed.records));
  }
  return { records, failures, truncated };
}
