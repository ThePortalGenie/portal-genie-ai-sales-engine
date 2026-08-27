import type { ConfidenceLevel, OrgAssociationReason } from "./commercial-intelligence.js";
import type { NormalizedEmail } from "./normalized-email.js";
import type { ProductId } from "./product-relationship.js";
import type { SalesEvent } from "./sales-event.js";
import type { OrganisationUsageLayer } from "./portal-genie-usage.js";

export const CONTACT_ROLES = [
  "SELECTED_CONTACT",
  "DECISION_MAKER",
  "INFLUENCER",
  "CHAMPION",
  "ADMINISTRATIVE",
  "PARTNER_CONTACT",
  "PREVIOUS_CONTACT",
  "UNKNOWN",
] as const;

export type ContactRole = (typeof CONTACT_ROLES)[number];

export const DATA_QUALITY_SIGNAL_CODES = [
  "MULTIPLE_ACCOUNTS_SAME_DOMAIN",
  "CONTACT_WITHOUT_ACCOUNT",
  "MULTIPLE_CONTACTS_SAME_DOMAIN",
  "DEAL_ASSOCIATED_WITH_DIFFERENT_ACCOUNT",
  "POSSIBLE_ACCOUNT_FRAGMENTATION",
  "HISTORICAL_AND_CURRENT_OPPORTUNITIES",
] as const;

export type DataQualitySignalCode = (typeof DATA_QUALITY_SIGNAL_CODES)[number];

export type DataQualitySignal = {
  code: DataQualitySignalCode;
  message: string;
  recordIds: string[];
};

export type CommercialRoleAssessment = {
  role: ContactRole;
  layer: "crm_fact" | "derived_signal" | "ai_inference";
  evidence: string;
};

export type OrganisationContactNode = {
  module: "Contacts" | "Leads";
  recordId: string;
  name: string;
  email?: string;
  title?: string;
  accountId?: string;
  accountName?: string;
  association_reasons: OrgAssociationReason[];
  certainty: "associated" | "possible";
  selected: boolean;
  commercial_role: CommercialRoleAssessment;
};

export type OrganisationAccountNode = {
  recordId: string;
  name: string;
  website?: string;
  association_reasons: OrgAssociationReason[];
  certainty: "associated" | "possible";
};

export type OrganisationDealNode = {
  recordId: string;
  name?: string;
  stage?: string;
  pipeline?: string;
  amount?: string;
  closingDate?: string;
  product: ProductId | "UNKNOWN";
  associatedContactId?: string;
  associatedContactName?: string;
  associatedAccountId?: string;
  associatedAccountName?: string;
  owner?: string;
  closedLost: boolean;
  closedWon: boolean;
  provenance: string;
};

export type AttributedNote = {
  id?: string;
  title?: string;
  content?: string;
  at?: string;
  author?: string;
  ownerModule: "Contacts" | "Leads" | "Accounts";
  ownerRecordId: string;
  ownerName?: string;
};

export type AttributedEmail = NormalizedEmail & {
  ownerRecordId: string;
  ownerName?: string;
};

export type CrmFragmentation = {
  possible_crm_fragmentation: boolean;
  account_ids: string[];
  account_names: string[];
  association_evidence: string[];
  confidence: ConfidenceLevel;
  label: "POSSIBLY RELATED ACCOUNT RECORDS — REVIEW";
};

export type ProductOpportunity = {
  product: ProductId | "UNKNOWN";
  status: "current" | "historical_lost" | "historical_won" | "unknown";
  deal_id: string;
  deal_name?: string;
  stage?: string;
  contact_id?: string;
  contact_name?: string;
  account_id?: string;
  account_name?: string;
};

export type ExpansionOmission = {
  kind: "contacts" | "accounts" | "emails" | "notes" | "deals";
  omitted: number;
  reason: string;
};

/**
 * Intelligence graph above Zoho. Never a CRM merge.
 * Every node keeps its original Zoho record ID.
 */
export type OrganisationGraph = {
  selectedContactId: string;
  selectedContactName: string;
  organisationName?: string;
  domains: string[];
  certainty: "resolved" | "uncertain";
  contacts: OrganisationContactNode[];
  accounts: OrganisationAccountNode[];
  possibleAccounts: OrganisationAccountNode[];
  deals: OrganisationDealNode[];
  notes: AttributedNote[];
  emails: AttributedEmail[];
  fragmentation: CrmFragmentation | null;
  dataQualitySignals: DataQualitySignal[];
  productOpportunities: ProductOpportunity[];
  omissions: ExpansionOmission[];
  cache: { hits: number; misses: number };
  organisationId?: string;
  salesEvents: SalesEvent[];
  zohoRecordsMerged: false;
  portalGenieUsage?: OrganisationUsageLayer;
};
