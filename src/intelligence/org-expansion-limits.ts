export type OrgExpansionLimits = {
  maxContacts: number;
  maxAccounts: number;
  maxEmailHeadersPerContact: number;
  maxEmailBodiesPerContact: number;
  maxNotesPerRecord: number;
  maxDeals: number;
};

export const DEFAULT_ORG_EXPANSION_LIMITS: OrgExpansionLimits = {
  maxContacts: 8,
  maxAccounts: 5,
  maxEmailHeadersPerContact: 15,
  maxEmailBodiesPerContact: 4,
  maxNotesPerRecord: 20,
  maxDeals: 20,
};

function readLimit(source: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const parsed = Number(source[key]?.trim());
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

export function loadOrgExpansionLimits(source: NodeJS.ProcessEnv = process.env): OrgExpansionLimits {
  return {
    maxContacts: readLimit(source, "ORG_MAX_CONTACTS", DEFAULT_ORG_EXPANSION_LIMITS.maxContacts),
    maxAccounts: readLimit(source, "ORG_MAX_ACCOUNTS", DEFAULT_ORG_EXPANSION_LIMITS.maxAccounts),
    maxEmailHeadersPerContact: readLimit(source, "ORG_MAX_EMAIL_HEADERS_PER_CONTACT", DEFAULT_ORG_EXPANSION_LIMITS.maxEmailHeadersPerContact),
    maxEmailBodiesPerContact: readLimit(source, "ORG_MAX_EMAIL_BODIES_PER_CONTACT", DEFAULT_ORG_EXPANSION_LIMITS.maxEmailBodiesPerContact),
    maxNotesPerRecord: readLimit(source, "ORG_MAX_NOTES_PER_RECORD", DEFAULT_ORG_EXPANSION_LIMITS.maxNotesPerRecord),
    maxDeals: readLimit(source, "ORG_MAX_DEALS", DEFAULT_ORG_EXPANSION_LIMITS.maxDeals),
  };
}
