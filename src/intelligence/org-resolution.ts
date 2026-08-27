import type { OrgAssociationReason } from "../domain/commercial-intelligence.js";
import { evidence, type EvidenceItem } from "../domain/evidence.js";
import { domainFromEmail, levenshteinRatio, normalizeCompanyName, normalizeEmail } from "../domain/normalize-identity.js";
import { isGenericMailbox, organisationDomainFromEmail } from "./email-domains.js";

export type OrgMemberModule = "Contacts" | "Leads" | "Accounts";

export type OrgCandidate = {
  module: OrgMemberModule;
  recordId: string;
  name: string;
  email?: string;
  company?: string;
  accountId?: string;
  lastActivity?: string;
  title?: string;
  portalGenieOrgId?: string;
};

export type OrgMember = OrgCandidate & {
  selected: boolean;
  genericMailbox: boolean;
  reasons: OrgAssociationReason[];
  certainty: "associated" | "possible";
};

export type OrganisationResolution = {
  identity: {
    name?: string;
    domains: string[];
    zohoAccountId?: string;
    portalGenieOrgId?: string;
    certainty: "resolved" | "uncertain";
  };
  members: OrgMember[];
  evidence: EvidenceItem[];
};

export function candidateKey(candidate: OrgCandidate): string {
  return `${candidate.module}:${candidate.recordId}`;
}

export function classifyOrgAssociation(
  selected: OrgCandidate,
  candidate: OrgCandidate,
  publicDomains: Set<string>,
): { reasons: OrgAssociationReason[]; certainty: "associated" | "possible" } | null {
  if (candidate.module === selected.module && candidate.recordId === selected.recordId) {
    const reasons: OrgAssociationReason[] = ["SELECTED_CONTACT"];
    if (selected.accountId) reasons.push("SAME_ZOHO_ACCOUNT");
    const domain = selected.email ? organisationDomainFromEmail(selected.email, publicDomains) : undefined;
    if (domain) reasons.push("SAME_BUSINESS_DOMAIN");
    if (selected.portalGenieOrgId) reasons.push("PORTAL_GENIE_ORG_MATCH");
    return { reasons, certainty: "associated" };
  }

  const reasons: OrgAssociationReason[] = [];
  let possibleOnly = false;

  if (selected.accountId && candidate.accountId && selected.accountId === candidate.accountId) {
    reasons.push("SAME_ZOHO_ACCOUNT");
  }

  const selectedDomain = selected.email ? organisationDomainFromEmail(selected.email, publicDomains) : undefined;
  const candidateDomain = candidate.email ? organisationDomainFromEmail(candidate.email, publicDomains) : undefined;
  if (selectedDomain && candidateDomain && selectedDomain === candidateDomain) {
    reasons.push("SAME_BUSINESS_DOMAIN");
  }

  if (selected.portalGenieOrgId && candidate.portalGenieOrgId && selected.portalGenieOrgId === candidate.portalGenieOrgId) {
    reasons.push("PORTAL_GENIE_ORG_MATCH");
  }

  const selectedCompany = selected.company ? normalizeCompanyName(selected.company) : "";
  const candidateCompany = candidate.company ? normalizeCompanyName(candidate.company) : "";
  if (selectedCompany && candidateCompany && selectedCompany === candidateCompany && selectedCompany.length >= 4) {
    reasons.push("EXACT_COMPANY_NAME");
  } else if (selectedCompany && candidateCompany && selectedCompany.length >= 4 && candidateCompany.length >= 4) {
    const score = levenshteinRatio(selectedCompany, candidateCompany);
    if (score >= 0.85) {
      reasons.push("POSSIBLE_MATCH");
      possibleOnly = true;
    }
  }

  if (reasons.length === 0) return null;

  const strong = reasons.some(
    (reason) =>
      reason === "SAME_ZOHO_ACCOUNT" ||
      reason === "SAME_BUSINESS_DOMAIN" ||
      reason === "PORTAL_GENIE_ORG_MATCH",
  );
  if (!strong && reasons.includes("EXACT_COMPANY_NAME") && !possibleOnly) {
    return { reasons: ["POSSIBLE_MATCH", "EXACT_COMPANY_NAME"], certainty: "possible" };
  }
  if (!strong) {
    return { reasons: reasons.includes("POSSIBLE_MATCH") ? reasons : [...reasons, "POSSIBLE_MATCH"], certainty: "possible" };
  }
  return { reasons, certainty: "associated" };
}

export function resolveOrganisation(
  selected: OrgCandidate,
  candidates: OrgCandidate[],
  publicDomains: Set<string>,
): OrganisationResolution {
  const seen = new Set<string>();
  const members: OrgMember[] = [];
  const evidenceItems: EvidenceItem[] = [];

  const all = [selected, ...candidates.filter((item) => candidateKey(item) !== candidateKey(selected))];
  for (const candidate of all) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    const classified = classifyOrgAssociation(selected, candidate, publicDomains);
    if (!classified) continue;
    members.push({
      ...candidate,
      selected: candidateKey(candidate) === candidateKey(selected),
      genericMailbox: candidate.email ? isGenericMailbox(candidate.email) : false,
      reasons: classified.reasons,
      certainty: classified.certainty,
    });
  }

  const associated = members.filter((member) => member.certainty === "associated");
  const domains = [
    ...new Set(
      associated
        .map((member) => (member.email ? organisationDomainFromEmail(member.email, publicDomains) : undefined))
        .filter((domain): domain is string => Boolean(domain)),
    ),
  ];
  const zohoAccountId = associated.find((member) => member.accountId)?.accountId ?? selected.accountId;
  const portalGenieOrgId =
    associated.find((member) => member.portalGenieOrgId)?.portalGenieOrgId ?? selected.portalGenieOrgId;
  const name = selected.company ?? associated.find((member) => member.company)?.company;
  const resolved = Boolean(zohoAccountId || domains.length > 0 || portalGenieOrgId);

  if (zohoAccountId) {
    evidenceItems.push(
      evidence({
        type: "crm_fact",
        claim: `Zoho Account ID ${zohoAccountId}`,
        source: "Zoho Account lookup",
        recordId: zohoAccountId,
      }),
    );
  }
  for (const domain of domains) {
    evidenceItems.push(
      evidence({
        type: "derived_signal",
        claim: `Organisation business domain ${domain}`,
        source: "Email domain extraction (public domains excluded)",
        derivedFrom: associated.filter((member) => member.email && domainFromEmail(member.email) === domain).map(candidateKey),
      }),
    );
  }
  if (!resolved) {
    evidenceItems.push(
      evidence({
        type: "unknown",
        claim: "Organisation identity is uncertain; records were not merged",
        source: "Organisation resolution",
      }),
    );
  }

  const gmailSelected = selected.email ? !organisationDomainFromEmail(selected.email, publicDomains) && Boolean(domainFromEmail(selected.email)) : false;
  if (gmailSelected && selected.email) {
    evidenceItems.push(
      evidence({
        type: "derived_signal",
        claim: `Email domain ${domainFromEmail(selected.email)} is treated as personal/public and is not organisation evidence`,
        source: "Public email-domain exclusion list",
        derivedFrom: [normalizeEmail(selected.email)],
      }),
    );
  }

  return {
    identity: {
      name,
      domains,
      zohoAccountId,
      portalGenieOrgId,
      certainty: resolved ? "resolved" : "uncertain",
    },
    members,
    evidence: evidenceItems,
  };
}
