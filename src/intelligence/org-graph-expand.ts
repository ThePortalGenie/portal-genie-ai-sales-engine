import { asJsonObject } from "../integrations/zoho/http.js";
import type { ZohoCrmReader } from "../integrations/zoho/client.js";
import { EMAIL_LIST_TYPES, FALLBACK_RELATED_FIELDS } from "../integrations/zoho/constants.js";
import type { DiscoveryDiagnostic, JsonObject, ZohoHttpResult } from "../integrations/zoho/types.js";
import { normalizeZohoEmail } from "../integrations/zoho/normalize-email.js";
import type {
  AttributedEmail,
  AttributedNote,
  ExpansionOmission,
  OrganisationAccountNode,
  OrganisationContactNode,
  OrganisationDealNode,
  OrganisationGraph,
} from "../domain/organisation-graph.js";
import type { OrgAssociationReason } from "../domain/commercial-intelligence.js";
import { assembleOrganisationGraph, classifyDealProduct, contactNodeFromMember } from "./org-graph.js";
import type { OrgExpansionLimits } from "./org-expansion-limits.js";
import { classifyOrgAssociation, type OrganisationResolution, type OrgCandidate, type OrgMember } from "./org-resolution.js";
import { candidateFromRecord } from "./org-discovery.js";
import type { RequestCacheStats } from "./request-cache.js";

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

function recordsFrom(result: ZohoHttpResult): JsonObject[] {
  if (!result.ok) return [];
  const json = asJsonObject(result.json);
  const data = json && Array.isArray(json.data) ? json.data : [];
  return data.map((item) => asJsonObject(item)).filter((item): item is JsonObject => Boolean(item && typeof item.id === "string"));
}

function firstRecord(result: ZohoHttpResult): JsonObject | undefined {
  const json = asJsonObject(result.json);
  const data = json && Array.isArray(json.data) ? json.data : [];
  return asJsonObject(data[0]) ?? undefined;
}

function emailsFromResult(result: ZohoHttpResult): unknown[] {
  if (result.noContent) return [];
  const json = asJsonObject(result.json);
  if (!json || json.status === "error") return [];
  if (Array.isArray(json.Emails)) return json.Emails;
  if (Array.isArray(json.emails)) return json.emails;
  return [];
}

export function dealNodeFromRecord(record: JsonObject, provenance: string): OrganisationDealNode {
  const stage = text(record.Stage);
  const contact = asJsonObject(record.Contact_Name);
  const account = asJsonObject(record.Account_Name);
  return {
    recordId: String(record.id),
    name: text(record.Deal_Name),
    stage,
    pipeline: text(record.Pipeline),
    amount: text(record.Amount),
    closingDate: text(record.Closing_Date),
    product: classifyDealProduct(text(record.Deal_Name), text(record.Pipeline)),
    associatedContactId: typeof contact?.id === "string" ? contact.id : undefined,
    associatedContactName: text(record.Contact_Name),
    associatedAccountId: typeof account?.id === "string" ? account.id : undefined,
    associatedAccountName: text(record.Account_Name),
    owner: text(record.Owner),
    closedLost: Boolean(stage && /lost/i.test(stage)),
    closedWon: Boolean(stage && /won/i.test(stage)),
    provenance,
  };
}

function noteFromRecord(record: JsonObject, ownerModule: AttributedNote["ownerModule"], ownerRecordId: string, ownerName?: string): AttributedNote {
  return {
    id: typeof record.id === "string" ? record.id : undefined,
    title: text(record.Note_Title),
    content: text(record.Note_Content),
    at: text(record.Created_Time),
    author: text(record.Owner) ?? text(record.Created_By),
    ownerModule,
    ownerRecordId,
    ownerName,
  };
}

async function listRelated(
  client: ZohoCrmReader,
  moduleName: string,
  recordId: string,
  related: string,
  fields: string[],
  perPage: number,
): Promise<JsonObject[]> {
  const result = await client.getRelatedRecords(moduleName, recordId, related, fields, perPage);
  return recordsFrom(result);
}

async function hydrateAccountId(client: ZohoCrmReader, member: OrgMember): Promise<OrgMember> {
  if (member.accountId || member.module === "Accounts") return member;
  const result = await client.getRecord(member.module, member.recordId);
  const record = firstRecord(result);
  if (!record) return member;
  const account = asJsonObject(record.Account_Name);
  return {
    ...member,
    accountId: typeof account?.id === "string" ? account.id : member.accountId,
    company: text(record.Account_Name) ?? member.company,
    title: text(record.Title) ?? member.title,
    email: text(record.Email) ?? member.email,
  };
}

async function retrieveContactEmails(options: {
  client: ZohoCrmReader;
  module: string;
  recordId: string;
  ownerName?: string;
  prospectEmail?: string;
  headerLimit: number;
  bodyLimit: number;
}): Promise<{ emails: AttributedEmail[]; omittedHeaders: number }> {
  const headers: Array<{ messageId: string | null; raw: Record<string, unknown>; listType: string | "default" }> = [];
  for (const type of EMAIL_LIST_TYPES) {
    const result = await options.client.getEmails(options.module, options.recordId, { type });
    const rows = emailsFromResult(result);
    for (const row of rows) {
      const object = asJsonObject(row);
      if (!object) continue;
      const messageId = typeof object.message_id === "string" ? object.message_id : null;
      headers.push({ messageId, raw: object, listType: type ?? "default" });
    }
    if (headers.length > 0) break;
  }
  const omittedHeaders = Math.max(0, headers.length - options.headerLimit);
  const limited = headers.slice(0, options.headerLimit);
  const withBodies = limited.slice(0, options.bodyLimit);
  const emails: AttributedEmail[] = [];
  for (const header of limited) {
    let bodyItem: Record<string, unknown> | null = null;
    if (header.messageId && withBodies.includes(header)) {
      const body = await options.client.getEmail(options.module, options.recordId, header.messageId);
      const json = asJsonObject(body.json);
      const email = asJsonObject(Array.isArray(json?.Emails) ? json.Emails[0] : json?.Emails);
      if (email) bodyItem = email;
    }
    const normalized = normalizeZohoEmail({
      listItem: header.raw,
      bodyItem,
      listType: header.listType,
      prospectEmails: options.prospectEmail ? [options.prospectEmail] : [],
    });
    emails.push({
      ...normalized,
      ownerRecordId: options.recordId,
      ownerName: options.ownerName,
    });
  }
  return { emails, omittedHeaders };
}

export async function expandOrganisationGraph(options: {
  client: ZohoCrmReader;
  selected: OrgCandidate;
  resolution: OrganisationResolution;
  selectedDiagnostic: DiscoveryDiagnostic;
  publicDomains: Set<string>;
  limits: OrgExpansionLimits;
  cacheStats: RequestCacheStats;
}): Promise<OrganisationGraph> {
  const omissions: ExpansionOmission[] = [];
  const members = [...options.resolution.members];
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index]!;
    if (member.certainty !== "associated") continue;
    members[index] = await hydrateAccountId(options.client, member);
  }

  const associated = members.filter((item) => item.certainty === "associated" && item.module !== "Accounts");
  const possible = members.filter((item) => item.certainty === "possible");

  const accountIds: string[] = [];
  for (const member of associated) {
    if (member.accountId && !accountIds.includes(member.accountId)) accountIds.push(member.accountId);
  }
  const accountCap = options.limits.maxAccounts;
  if (accountIds.length > accountCap) {
    omissions.push({ kind: "accounts", omitted: accountIds.length - accountCap, reason: `ORG_MAX_ACCOUNTS=${accountCap}` });
  }
  const usedAccountIds = accountIds.slice(0, accountCap);

  const accounts: OrganisationAccountNode[] = [];
  const possibleAccounts: OrganisationAccountNode[] = [];
  const notes: AttributedNote[] = [];
  const dealsById = new Map<string, OrganisationDealNode>();
  const contactById = new Map<string, OrganisationContactNode>();

  for (const member of associated) {
    contactById.set(member.recordId, contactNodeFromMember(member, member.accountId && member.accountId !== options.selected.accountId ? ["RELATED_ACCOUNT"] : []));
  }

  for (const accountId of usedAccountIds) {
    const recordResult = await options.client.getRecord("Accounts", accountId);
    const record = firstRecord(recordResult);
    const name = text(record?.Account_Name) ?? associated.find((item) => item.accountId === accountId)?.company ?? accountId;
    const reasons: OrgAssociationReason[] =
      accountId === options.selected.accountId ? ["SELECTED_CONTACT_ACCOUNT"] : ["CONTACT_ACCOUNT"];
    if (options.resolution.identity.domains.length > 0) reasons.push("SAME_BUSINESS_DOMAIN");
    accounts.push({
      recordId: accountId,
      name,
      website: text(record?.Website),
      association_reasons: reasons,
      certainty: "associated",
    });

    const relatedContacts = await listRelated(
      options.client,
      "Accounts",
      accountId,
      "Contacts",
      FALLBACK_RELATED_FIELDS.Contacts ?? ["Full_Name", "Email", "Account_Name", "Title", "Created_Time"],
      options.limits.maxContacts,
    );
    for (const related of relatedContacts) {
      const candidate = candidateFromRecord("Contacts", related);
      const classified = classifyOrgAssociation(options.selected, { ...candidate, accountId }, options.publicDomains);
      if (!classified || classified.certainty !== "associated") continue;
      if (!contactById.has(candidate.recordId)) {
        const member: OrgMember = {
          ...candidate,
          selected: false,
          genericMailbox: false,
          reasons: [...classified.reasons, "RELATED_ACCOUNT"],
          certainty: "associated",
        };
        contactById.set(candidate.recordId, contactNodeFromMember(member));
      }
    }

    const relatedDeals = await listRelated(
      options.client,
      "Accounts",
      accountId,
      "Deals",
      [...(FALLBACK_RELATED_FIELDS.Deals ?? ["Deal_Name", "Stage", "Amount", "Created_Time"]), "Contact_Name", "Pipeline", "Closing_Date"],
      options.limits.maxDeals,
    );
    for (const deal of relatedDeals) {
      dealsById.set(String(deal.id), dealNodeFromRecord(deal, `Zoho Account ${accountId} Deals related list`));
    }

    const relatedNotes = await listRelated(
      options.client,
      "Accounts",
      accountId,
      "Notes",
      FALLBACK_RELATED_FIELDS.Notes ?? ["Note_Title", "Note_Content", "Created_Time"],
      options.limits.maxNotesPerRecord,
    );
    for (const note of relatedNotes) notes.push(noteFromRecord(note, "Accounts", accountId, name));
  }

  for (const member of possible.filter((item) => item.module === "Accounts")) {
    possibleAccounts.push({
      recordId: member.recordId,
      name: member.name,
      association_reasons: member.reasons.includes("POSSIBLE_MATCH") ? [...member.reasons, "POSSIBLE_MATCH_REVIEW"] : member.reasons,
      certainty: "possible",
    });
  }

  let contacts = [...contactById.values()];
  if (contacts.length > options.limits.maxContacts) {
    const selected = contacts.filter((item) => item.selected);
    const rest = contacts.filter((item) => !item.selected);
    omissions.push({ kind: "contacts", omitted: contacts.length - options.limits.maxContacts, reason: `ORG_MAX_CONTACTS=${options.limits.maxContacts}` });
    contacts = [...selected, ...rest].slice(0, options.limits.maxContacts);
  }

  const selectedEmails: AttributedEmail[] = (options.selectedDiagnostic.emails.normalized ?? []).map((email) => ({
    ...email,
    ownerRecordId: options.selected.recordId,
    ownerName: options.selected.name,
  }));
  const emails: AttributedEmail[] = [...selectedEmails];

  for (const contact of contacts) {
    const contactNotes = await listRelated(
      options.client,
      contact.module,
      contact.recordId,
      "Notes",
      FALLBACK_RELATED_FIELDS.Notes ?? ["Note_Title", "Note_Content", "Created_Time"],
      options.limits.maxNotesPerRecord,
    );
    for (const note of contactNotes) notes.push(noteFromRecord(note, contact.module, contact.recordId, contact.name));

    const contactDeals = await listRelated(
      options.client,
      contact.module,
      contact.recordId,
      "Deals",
      [...(FALLBACK_RELATED_FIELDS.Deals ?? ["Deal_Name", "Stage", "Amount", "Created_Time"]), "Contact_Name", "Account_Name", "Pipeline", "Closing_Date"],
      options.limits.maxDeals,
    );
    for (const deal of contactDeals) {
      const node = dealNodeFromRecord(deal, `Zoho ${contact.module} ${contact.recordId} Deals related list`);
      if (!node.associatedContactId) {
        node.associatedContactId = contact.recordId;
        node.associatedContactName = contact.name;
      }
      dealsById.set(node.recordId, node);
    }

    if (contact.selected) continue;
    const retrieved = await retrieveContactEmails({
      client: options.client,
      module: contact.module,
      recordId: contact.recordId,
      ownerName: contact.name,
      prospectEmail: contact.email,
      headerLimit: options.limits.maxEmailHeadersPerContact,
      bodyLimit: options.limits.maxEmailBodiesPerContact,
    });
    emails.push(...retrieved.emails);
    if (retrieved.omittedHeaders > 0) {
      omissions.push({
        kind: "emails",
        omitted: retrieved.omittedHeaders,
        reason: `Email headers beyond ORG_MAX_EMAIL_HEADERS_PER_CONTACT for ${contact.recordId}`,
      });
    }
  }

  for (const deal of dealsById.values()) {
    const owner = deal.associatedContactId
      ? (contacts.find((item) => item.recordId === deal.associatedContactId) ?? contactById.get(deal.associatedContactId))
      : undefined;
    if (owner && !owner.accountId && deal.associatedAccountId) {
      owner.accountId = deal.associatedAccountId;
      owner.accountName = deal.associatedAccountName ?? owner.accountName;
      if (!owner.association_reasons.includes("RELATED_ACCOUNT")) {
        owner.association_reasons = [...owner.association_reasons, "RELATED_ACCOUNT"];
      }
    }
    if (
      deal.associatedAccountId &&
      (owner?.certainty === "associated" || (!deal.associatedContactId && deal.associatedAccountId))
    ) {
      const exists = accounts.some((item) => item.recordId === deal.associatedAccountId);
      const possible = possibleAccounts.some((item) => item.recordId === deal.associatedAccountId);
      if (!exists && !possible) {
        accounts.push({
          recordId: deal.associatedAccountId,
          name: deal.associatedAccountName ?? deal.associatedAccountId,
          association_reasons: ["CONTACT_ACCOUNT", "EXPLICIT_RELATIONSHIP"],
          certainty: "associated",
        });
      }
    }
  }
  if (accounts.length > options.limits.maxAccounts) {
    omissions.push({
      kind: "accounts",
      omitted: accounts.length - options.limits.maxAccounts,
      reason: `ORG_MAX_ACCOUNTS=${options.limits.maxAccounts}`,
    });
    accounts.splice(options.limits.maxAccounts);
  }

  let deals = [...dealsById.values()];
  if (deals.length > options.limits.maxDeals) {
    omissions.push({ kind: "deals", omitted: deals.length - options.limits.maxDeals, reason: `ORG_MAX_DEALS=${options.limits.maxDeals}` });
    deals = deals.slice(0, options.limits.maxDeals);
  }

  return assembleOrganisationGraph({
    selectedContactId: options.selected.recordId,
    selectedContactName: options.selected.name,
    organisationName: options.resolution.identity.name,
    domains: options.resolution.identity.domains,
    certainty: options.resolution.identity.certainty,
    contacts,
    accounts,
    possibleAccounts,
    deals,
    notes,
    emails,
    omissions,
    cache: options.cacheStats,
  });
}
