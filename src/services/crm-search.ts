import { asJsonObject, readZohoError } from "../integrations/zoho/http.js";
import type { ZohoCrmReader } from "../integrations/zoho/client.js";
import { EMAIL_SEARCH_MODULES, PRIMARY_MODULES, type PrimaryModule } from "../integrations/zoho/constants.js";
import type { JsonObject } from "../integrations/zoho/types.js";

export type CrmSearchHit = {
  module: PrimaryModule;
  id: string;
  name: string | null;
  email: string | null;
  company: string | null;
  source: "id" | "email" | "word";
};

export type CrmSearchResponse = {
  query: string;
  hits: CrmSearchHit[];
  warnings: string[];
};

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  const object = asJsonObject(value);
  if (object && typeof object.name === "string") return object.name;
  return null;
}

function recordsFrom(result: { ok: boolean; json: unknown }): JsonObject[] {
  if (!result.ok) return [];
  const json = asJsonObject(result.json);
  return (json ? asArray(json.data) : [])
    .map((item) => asJsonObject(item))
    .filter((item): item is JsonObject => item !== null && typeof item.id === "string");
}

function toHit(module: PrimaryModule, record: JsonObject, source: CrmSearchHit["source"]): CrmSearchHit {
  return {
    module,
    id: String(record.id),
    name: text(record.Full_Name) ?? text(record.Last_Name) ?? text(record.Account_Name) ?? text(record.Deal_Name),
    email: text(record.Email),
    company: text(record.Account_Name) ?? text(record.Company),
    source,
  };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ZOHO_ID_PATTERN = /^\d{10,}$/;

function isExpectedUnsupportedSearch(
  module: PrimaryModule,
  result: { status: number; json: unknown },
  mode: "email" | "word",
): boolean {
  if (result.status === 204) return true;
  const error = readZohoError(result.json);
  const message = (error.message ?? "").toLowerCase();
  if (mode === "email" && module === "Accounts") return true;
  return (
    message.includes("this data type is not found") ||
    message.includes("the field is not available") ||
    error.code === "INVALID_QUERY"
  );
}

export async function searchCrmRecords(client: ZohoCrmReader, rawQuery: string): Promise<CrmSearchResponse> {
  const query = rawQuery.trim().slice(0, 200);
  if (!query) {
    return { query, hits: [], warnings: ["Enter an email, name, company, or Zoho record ID."] };
  }

  const warnings: string[] = [];
  const hits: CrmSearchHit[] = [];

  if (ZOHO_ID_PATTERN.test(query)) {
    for (const module of PRIMARY_MODULES) {
      const result = await client.getRecord(module, query);
      const record = recordsFrom(result)[0];
      if (record) {
        hits.push(toHit(module, record, "id"));
      } else if (result.status >= 500) {
        const error = readZohoError(result.json);
        warnings.push(`${module} ID lookup failed: ${error.message ?? `HTTP ${result.status}`}`);
      }
    }
    return { query, hits, warnings };
  }

  const useEmail = EMAIL_PATTERN.test(query);
  const modules: readonly PrimaryModule[] = useEmail ? EMAIL_SEARCH_MODULES : PRIMARY_MODULES;
  const mode = useEmail ? "email" : "word";

  for (const module of modules) {
    const result = useEmail ? await client.searchByEmail(module, query) : await client.searchByWord(module, query);
    if (!result.ok && !result.noContent) {
      if (!isExpectedUnsupportedSearch(module, result, mode)) {
        const error = readZohoError(result.json);
        warnings.push(`${module} search: ${error.message ?? error.code ?? `HTTP ${result.status}`}`);
      }
      continue;
    }
    for (const record of recordsFrom(result)) {
      hits.push(toHit(module, record, useEmail ? "email" : "word"));
    }
  }

  return { query, hits, warnings };
}
