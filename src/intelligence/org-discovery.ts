import { asJsonObject } from "../integrations/zoho/http.js";
import type { ZohoCrmReader } from "../integrations/zoho/client.js";
import { FALLBACK_RELATED_FIELDS } from "../integrations/zoho/constants.js";
import type { JsonObject } from "../integrations/zoho/types.js";
import type { CrmSearchHit } from "../services/crm-search.js";
import { searchCrmRecords } from "../services/crm-search.js";
import type { OrgCandidate } from "./org-resolution.js";
import { organisationDomainFromEmail } from "./email-domains.js";

function text(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const object = asJsonObject(value);
  if (object && typeof object.name === "string") return object.name;
  return undefined;
}

function recordsFrom(result: { ok: boolean; json: unknown }): JsonObject[] {
  if (!result.ok) return [];
  const json = asJsonObject(result.json);
  const data = json && Array.isArray(json.data) ? json.data : [];
  return data.map((item) => asJsonObject(item)).filter((item): item is JsonObject => Boolean(item && typeof item.id === "string"));
}

export function candidateFromRecord(moduleName: "Contacts" | "Leads" | "Accounts", record: JsonObject): OrgCandidate {
  const account = asJsonObject(record.Account_Name);
  return {
    module: moduleName,
    recordId: String(record.id),
    name: text(record.Full_Name) || text(record.Account_Name) || text(record.Last_Name) || "Unknown",
    email: text(record.Email),
    company: text(record.Account_Name) ?? text(record.Company),
    accountId: typeof account?.id === "string" ? account.id : moduleName === "Accounts" ? String(record.id) : undefined,
    lastActivity: text(record.Last_Activity_Time) ?? text(record.Created_Time),
    title: text(record.Title),
  };
}

export function candidateFromSearchHit(hit: CrmSearchHit): OrgCandidate {
  return {
    module: hit.module,
    recordId: hit.id,
    name: hit.name ?? "Unknown",
    email: hit.email ?? undefined,
    company: hit.company ?? undefined,
    accountId: hit.module === "Accounts" ? hit.id : undefined,
  };
}

export async function discoverOrgCandidates(options: {
  client: ZohoCrmReader;
  selected: OrgCandidate;
  publicDomains: Set<string>;
}): Promise<{ candidates: OrgCandidate[]; accountNotes: JsonObject[]; accountDeals: JsonObject[] }> {
  const { client, selected, publicDomains } = options;
  const candidates: OrgCandidate[] = [];
  let accountNotes: JsonObject[] = [];
  let accountDeals: JsonObject[] = [];

  if (selected.accountId) {
    const relatedContacts = await client.getRelatedRecords(
      "Accounts",
      selected.accountId,
      "Contacts",
      FALLBACK_RELATED_FIELDS.Contacts
        ? [...FALLBACK_RELATED_FIELDS.Contacts, "Title", "Last_Activity_Time"]
        : ["Full_Name", "Email", "Account_Name", "Title", "Last_Activity_Time", "Created_Time"],
      50,
    );
    for (const record of recordsFrom(relatedContacts)) {
      candidates.push(candidateFromRecord("Contacts", record));
    }
    const notes = await client.getRelatedRecords(
      "Accounts",
      selected.accountId,
      "Notes",
      FALLBACK_RELATED_FIELDS.Notes ?? ["Note_Title", "Note_Content", "Created_Time"],
      50,
    );
    accountNotes = recordsFrom(notes);
    const deals = await client.getRelatedRecords(
      "Accounts",
      selected.accountId,
      "Deals",
      FALLBACK_RELATED_FIELDS.Deals ?? ["Deal_Name", "Stage", "Amount", "Created_Time"],
      50,
    );
    accountDeals = recordsFrom(deals);
  }

  const domain = selected.email ? organisationDomainFromEmail(selected.email, publicDomains) : undefined;
  const queries = [domain, selected.company].filter((item): item is string => Boolean(item && item.length >= 4));
  const seenQueries = new Set<string>();
  for (const query of queries) {
    const key = query.toLowerCase();
    if (seenQueries.has(key)) continue;
    seenQueries.add(key);
    const search = await searchCrmRecords(client, query);
    for (const hit of search.hits) {
      candidates.push(candidateFromSearchHit(hit));
    }
  }

  return { candidates, accountNotes, accountDeals };
}
