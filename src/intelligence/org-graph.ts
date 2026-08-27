import type { OrgAssociationReason } from "../domain/commercial-intelligence.js";
import type {
  AttributedEmail,
  AttributedNote,
  CommercialRoleAssessment,
  ContactRole,
  CrmFragmentation,
  DataQualitySignal,
  OrganisationAccountNode,
  OrganisationContactNode,
  OrganisationDealNode,
  OrganisationGraph,
  ProductOpportunity,
} from "../domain/organisation-graph.js";
import type { ProductId, ProductRelationship } from "../domain/product-relationship.js";
import type { SalesEvent } from "../domain/sales-event.js";
import type { DealSignals } from "./contact-intelligence.js";
import type { OrgMember } from "./org-resolution.js";
import { organisationUnansweredSequences } from "./unanswered-sequences.js";

export function deriveContactRole(options: {
  selected: boolean;
  title?: string;
  deals: OrganisationDealNode[];
  inboundEmails: number;
}): CommercialRoleAssessment {
  if (options.selected) {
    return { role: "SELECTED_CONTACT", layer: "crm_fact", evidence: "Operator-selected CRM Contact" };
  }
  const title = options.title ?? "";
  if (/\b(director|owner|partner|principal|managing|ceo|founder)\b/i.test(title)) {
    return { role: "DECISION_MAKER", layer: "derived_signal", evidence: `Job title “${title}” is a CRM fact; commercial role is derived` };
  }
  if (/\b(admin|assistant|receptionist|accounts payable|bookkeeper)\b/i.test(title)) {
    return { role: "ADMINISTRATIVE", layer: "derived_signal", evidence: `Job title “${title}” is a CRM fact; commercial role is derived` };
  }
  if (options.deals.some((deal) => /partner/i.test(`${deal.name ?? ""} ${deal.stage ?? ""}`) && !deal.closedLost)) {
    return { role: "PARTNER_CONTACT", layer: "derived_signal", evidence: "Associated with a current partner-stage Deal" };
  }
  if (options.deals.some((deal) => deal.closedLost) && options.inboundEmails === 0 && !options.deals.some((deal) => !deal.closedLost && !deal.closedWon)) {
    return { role: "PREVIOUS_CONTACT", layer: "derived_signal", evidence: "Only historical Closed Lost Deal evidence and no inbound email on this Contact" };
  }
  const unknown: ContactRole = "UNKNOWN";
  return { role: unknown, layer: "derived_signal", evidence: "Insufficient evidence for a commercial role" };
}

export function classifyDealProduct(name?: string, pipeline?: string): ProductId | "UNKNOWN" {
  const text = `${name ?? ""} ${pipeline ?? ""}`;
  if (/\bnagging panda\b/i.test(text)) return "NAGGING_PANDA";
  if (/\bportal genie\b|\bfirm partner\b/i.test(text)) return "PORTAL_GENIE";
  return "UNKNOWN";
}

export function dealOpportunityStatus(deal: OrganisationDealNode): ProductOpportunity["status"] {
  if (deal.closedLost) return "historical_lost";
  if (deal.closedWon) return "historical_won";
  if (deal.stage) return "current";
  return "unknown";
}

export function dealSignalsFromGraphDeals(deals: OrganisationDealNode[]): DealSignals {
  const stages = deals.map((deal) => deal.stage).filter((item): item is string => Boolean(item));
  const dated = deals
    .map((deal) => ({ name: deal.name, stage: deal.stage, at: deal.closingDate }))
    .filter((item) => item.at && !Number.isNaN(Date.parse(item.at)))
    .sort((left, right) => Date.parse(right.at!) - Date.parse(left.at!));
  const latest = dated[0] ?? deals[0];
  return {
    count: deals.length,
    stages: [...new Set(stages)],
    names: [...new Set(deals.map((deal) => deal.name).filter((item): item is string => Boolean(item)))],
    closedWon: deals.filter((deal) => deal.closedWon).length,
    closedLost: deals.filter((deal) => deal.closedLost).length,
    latestName: latest && "name" in latest ? latest.name : deals[0]?.name,
    latestStage: latest && "stage" in latest ? latest.stage : deals[0]?.stage,
    latestAt: dated[0]?.at,
    values: deals.map((deal) => deal.amount).filter((item): item is string => Boolean(item)),
  };
}

export function membersFromGraph(graph: OrganisationGraph, fallback: OrgMember[] = []): OrgMember[] {
  const members: OrgMember[] = graph.contacts.map((contact) => ({
    module: contact.module,
    recordId: contact.recordId,
    name: contact.name,
    email: contact.email,
    company: contact.accountName,
    accountId: contact.accountId,
    title: contact.title,
    selected: contact.selected,
    genericMailbox: false,
    reasons: contact.association_reasons,
    certainty: contact.certainty,
  }));
  const seen = new Set(members.map((member) => `${member.module}:${member.recordId}`));
  for (const member of fallback) {
    const key = `${member.module}:${member.recordId}`;
    if (!seen.has(key)) {
      seen.add(key);
      members.push(member);
    }
  }
  return members;
}

export type OrgContactEmailMetrics = {
  contact_id: string;
  name?: string;
  outbound: number;
  inbound: number;
  last_inbound_at?: string | null;
  last_outbound_at?: string | null;
  two_way: boolean;
  unanswered_last_outbound: boolean;
};

export function orgEmailMetrics(emails: AttributedEmail[]): {
  outbound: number;
  inbound: number;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  contacts_engaged: number;
  contacts_with_two_way: number;
  unanswered_sequences: number;
  by_contact: OrgContactEmailMetrics[];
} {
  const byContact = new Map<string, OrgContactEmailMetrics>();
  for (const email of emails) {
    const row = byContact.get(email.ownerRecordId) ?? {
      contact_id: email.ownerRecordId,
      name: email.ownerName,
      outbound: 0,
      inbound: 0,
      last_inbound_at: null,
      last_outbound_at: null,
      two_way: false,
      unanswered_last_outbound: false,
    };
    if (email.ownerName) row.name = email.ownerName;
    const at = email.at;
    if (email.direction === "outbound") {
      row.outbound += 1;
      if (at && (!row.last_outbound_at || Date.parse(at) > Date.parse(row.last_outbound_at))) row.last_outbound_at = at;
    }
    if (email.direction === "inbound") {
      row.inbound += 1;
      if (at && (!row.last_inbound_at || Date.parse(at) > Date.parse(row.last_inbound_at))) row.last_inbound_at = at;
    }
    byContact.set(email.ownerRecordId, row);
  }
  const { organisation_unanswered_sequences, by_contact: sequenceByContact } = organisationUnansweredSequences(emails);
  const by_contact = [...byContact.values()].map((row) => {
    const sequence = sequenceByContact.find((item) => item.contact_id === row.contact_id);
    return {
      ...row,
      two_way: row.outbound > 0 && row.inbound > 0,
      unanswered_last_outbound: sequence?.unanswered_sequence ?? false,
    };
  });
  const latest = (dates: Array<string | null | undefined>) => {
    const valid = dates.filter((item): item is string => typeof item === "string" && !Number.isNaN(Date.parse(item)));
    return valid.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
  };
  return {
    outbound: emails.filter((email) => email.direction === "outbound").length,
    inbound: emails.filter((email) => email.direction === "inbound").length,
    last_inbound_at: latest(emails.filter((email) => email.direction === "inbound").map((email) => email.at)),
    last_outbound_at: latest(emails.filter((email) => email.direction === "outbound").map((email) => email.at)),
    contacts_engaged: by_contact.filter((row) => row.outbound + row.inbound > 0).length,
    contacts_with_two_way: by_contact.filter((row) => row.two_way).length,
    unanswered_sequences: organisation_unanswered_sequences,
    by_contact,
  };
}

export function toProductOpportunities(deals: OrganisationDealNode[]): ProductOpportunity[] {
  return deals.map((deal) => ({
    product: deal.product,
    status: dealOpportunityStatus(deal),
    deal_id: deal.recordId,
    deal_name: deal.name,
    stage: deal.stage,
    contact_id: deal.associatedContactId,
    contact_name: deal.associatedContactName,
    account_id: deal.associatedAccountId,
    account_name: deal.associatedAccountName,
  }));
}

export function applyOrganisationDealProducts(
  products: ProductRelationship[],
  deals: OrganisationDealNode[],
): ProductRelationship[] {
  return products.map((product) => {
    const related = deals.filter((deal) => deal.product === product.product);
    if (related.length === 0) return product;
    const current = related.filter((deal) => !deal.closedLost && !deal.closedWon);
    const won = related.filter((deal) => deal.closedWon);
    const lost = related.filter((deal) => deal.closedLost);
    let relationship_state = product.relationship_state;
    if (product.product === "NAGGING_PANDA") {
      if (won.length > 0) relationship_state = "PAYING_CUSTOMER";
      else if (current.length > 0) relationship_state = "ENGAGED_PROSPECT";
      else if (lost.length > 0) relationship_state = "FORMER_CUSTOMER";
    } else if (product.product === "PORTAL_GENIE") {
      if (current.some((deal) => /partner/i.test(`${deal.name ?? ""} ${deal.stage ?? ""}`))) {
        relationship_state = "PARTNER_PROSPECT";
      } else if (won.length > 0) {
        relationship_state = "PAYING_CUSTOMER";
      } else if (relationship_state === "UNKNOWN" && (current.length > 0 || lost.length > 0)) {
        relationship_state = current.length > 0 ? "ENGAGED_PROSPECT" : "FORMER_CUSTOMER";
      }
    }
    return {
      ...product,
      relationship_state,
      summary:
        relationship_state === product.relationship_state
          ? product.summary
          : `${product.product.replaceAll("_", " ")} state ${relationship_state.replaceAll("_", " ")} from organisation Deal evidence. Historical and current Deals remain separate opportunities.`,
      confidence: relationship_state === "UNKNOWN" ? product.confidence : "MEDIUM",
    };
  });
}

export function detectFragmentation(accounts: OrganisationAccountNode[], domains: string[]): CrmFragmentation | null {
  const associated = accounts.filter((item) => item.certainty === "associated");
  if (associated.length < 2 || domains.length === 0) return null;
  return {
    possible_crm_fragmentation: true,
    account_ids: associated.map((item) => item.recordId),
    account_names: associated.map((item) => item.name),
    association_evidence: [
      `${associated.length} Zoho Account records are associated with the same organisation intelligence graph`,
      domains.length > 0 ? `Shared business domain(s): ${domains.join(", ")}` : "",
    ].filter(Boolean),
    confidence: associated.length >= 3 ? "HIGH" : "MEDIUM",
    label: "POSSIBLY RELATED ACCOUNT RECORDS — REVIEW",
  };
}

export function buildDataQualitySignals(options: {
  contacts: OrganisationContactNode[];
  accounts: OrganisationAccountNode[];
  deals: OrganisationDealNode[];
  domains: string[];
  fragmentation: CrmFragmentation | null;
}): DataQualitySignal[] {
  const signals: DataQualitySignal[] = [];
  const associatedContacts = options.contacts.filter((item) => item.certainty === "associated");
  const associatedAccounts = options.accounts.filter((item) => item.certainty === "associated");
  if (associatedAccounts.length > 1 && options.domains.length > 0) {
    signals.push({
      code: "MULTIPLE_ACCOUNTS_SAME_DOMAIN",
      message: `${associatedAccounts.length} Account records associated with domain(s) ${options.domains.join(", ")}. Zoho records were not merged.`,
      recordIds: associatedAccounts.map((item) => item.recordId),
    });
  }
  const withoutAccount = associatedContacts.filter((item) => !item.accountId && item.module === "Contacts");
  if (withoutAccount.length > 0) {
    signals.push({
      code: "CONTACT_WITHOUT_ACCOUNT",
      message: `${withoutAccount.length} associated Contact(s) have no Zoho Account lookup.`,
      recordIds: withoutAccount.map((item) => item.recordId),
    });
  }
  if (associatedContacts.length > 1 && options.domains.length > 0) {
    signals.push({
      code: "MULTIPLE_CONTACTS_SAME_DOMAIN",
      message: `${associatedContacts.length} Contacts associated via organisation evidence (including business domain).`,
      recordIds: associatedContacts.map((item) => item.recordId),
    });
  }
  const mismatchedDeals = options.deals.filter((deal) => {
    const contact = associatedContacts.find((item) => item.recordId === deal.associatedContactId);
    return Boolean(deal.associatedAccountId && contact?.accountId && deal.associatedAccountId !== contact.accountId);
  });
  if (mismatchedDeals.length > 0) {
    signals.push({
      code: "DEAL_ASSOCIATED_WITH_DIFFERENT_ACCOUNT",
      message: `${mismatchedDeals.length} Deal(s) sit on a different Account than their associated Contact.`,
      recordIds: mismatchedDeals.map((item) => item.recordId),
    });
  }
  if (options.fragmentation?.possible_crm_fragmentation) {
    signals.push({
      code: "POSSIBLE_ACCOUNT_FRAGMENTATION",
      message: options.fragmentation.label,
      recordIds: options.fragmentation.account_ids,
    });
  }
  const historical = options.deals.some((deal) => deal.closedLost);
  const current = options.deals.some((deal) => !deal.closedLost && !deal.closedWon);
  if (historical && current) {
    signals.push({
      code: "HISTORICAL_AND_CURRENT_OPPORTUNITIES",
      message: "Historical Closed Lost Deal(s) coexist with current Deal(s). Neither is treated as the whole organisation story.",
      recordIds: options.deals.map((item) => item.recordId),
    });
  }
  return signals;
}

export function contactNodeFromMember(
  member: OrgMember,
  extraReasons: OrgAssociationReason[] = [],
): OrganisationContactNode {
  const reasons = [...new Set([...extraReasons, ...member.reasons])];
  if (member.selected && !reasons.includes("SELECTED_CONTACT")) reasons.unshift("SELECTED_CONTACT");
  return {
    module: member.module === "Leads" ? "Leads" : "Contacts",
    recordId: member.recordId,
    name: member.name,
    email: member.email,
    title: member.title,
    accountId: member.accountId,
    accountName: member.company,
    association_reasons: reasons,
    certainty: member.certainty,
    selected: member.selected,
    commercial_role: deriveContactRole({ selected: member.selected, title: member.title, deals: [], inboundEmails: 0 }),
  };
}

export function assembleOrganisationGraph(options: {
  selectedContactId: string;
  selectedContactName: string;
  organisationName?: string;
  domains: string[];
  certainty: "resolved" | "uncertain";
  contacts: OrganisationContactNode[];
  accounts: OrganisationAccountNode[];
  possibleAccounts?: OrganisationAccountNode[];
  deals: OrganisationDealNode[];
  notes: AttributedNote[];
  emails: AttributedEmail[];
  salesEvents?: SalesEvent[];
  organisationId?: string;
  omissions?: OrganisationGraph["omissions"];
  cache?: OrganisationGraph["cache"];
}): OrganisationGraph {
  const contacts = options.contacts.map((contact) => ({
    ...contact,
    commercial_role: deriveContactRole({
      selected: contact.selected,
      title: contact.title,
      deals: options.deals.filter((deal) => deal.associatedContactId === contact.recordId),
      inboundEmails: options.emails.filter((email) => email.ownerRecordId === contact.recordId && email.direction === "inbound").length,
    }),
  }));
  const fragmentation = detectFragmentation(options.accounts, options.domains);
  return {
    selectedContactId: options.selectedContactId,
    selectedContactName: options.selectedContactName,
    organisationName: options.organisationName,
    domains: options.domains,
    certainty: options.certainty,
    contacts,
    accounts: options.accounts,
    possibleAccounts: options.possibleAccounts ?? [],
    deals: options.deals,
    notes: options.notes,
    emails: options.emails,
    fragmentation,
    dataQualitySignals: buildDataQualitySignals({
      contacts,
      accounts: options.accounts,
      deals: options.deals,
      domains: options.domains,
      fragmentation,
    }),
    productOpportunities: toProductOpportunities(options.deals),
    salesEvents: options.salesEvents ?? [],
    organisationId: options.organisationId,
    omissions: options.omissions ?? [],
    cache: options.cache ?? { hits: 0, misses: 0 },
    zohoRecordsMerged: false,
  };
}
