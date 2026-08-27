/**
 * Identity keys only. Matching stays deterministic and does not auto-merge.
 * Portal Genie IDs are unknown until Usage Discovery inspects the real schema.
 */
export type ZohoIdentity = {
  leadId?: string;
  contactId?: string;
  accountId?: string;
  dealIds?: string[];
};

export type PortalGenieIdentity = {
  accountId?: string;
  userId?: string;
};

export type RelationshipIdentity = {
  zoho: ZohoIdentity;
  portalGenie: PortalGenieIdentity;
  emails: string[];
  domains?: string[];
  companyName?: string;
  source: "zoho" | "portal_genie" | "combined" | "usage_import";
};
