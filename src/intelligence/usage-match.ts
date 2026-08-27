import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RelationshipIdentity } from "../domain/identity.js";
import { matchUsageToCrm } from "../domain/identity-match.js";
import type { ActivationThresholds, NormalizedUsageProfile } from "../domain/normalized-usage.js";
import { DEFAULT_ACTIVATION_THRESHOLDS } from "../domain/normalized-usage.js";
import { domainFromEmail, normalizeEmail } from "../domain/normalize-identity.js";
import type { OrganisationUsageLayer, SubscriberUsageView } from "../domain/portal-genie-usage.js";
import type { OrgMember } from "./org-resolution.js";
import { loadPublicEmailDomains, organisationDomainFromEmail } from "./email-domains.js";
import { usageFromProfiles, usageUnknown, type UsageMatchSummary } from "./org-intelligence.js";
import {
  contradictionsForOrganisation,
  organisationSignals,
  summariseOrganisationUsage,
  toSubscriberView,
  type CrmUsageContext,
} from "./usage-signals.js";
import { loadActivationThresholds } from "../config/activation-thresholds.js";

export type UsageImportMeta = {
  importedAt?: string;
  source?: string;
  rowCount: number;
};

export function loadUsageImportMeta(cwd = process.cwd()): UsageImportMeta {
  const filePath = resolve(cwd, "diagnostics/usage-import.json");
  if (!existsSync(filePath)) return { rowCount: 0 };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      importedAt?: string;
      source?: string;
      counts?: { rows?: number; accepted?: number };
    };
    return {
      importedAt: parsed.importedAt,
      source: parsed.source,
      rowCount: parsed.counts?.accepted ?? parsed.counts?.rows ?? 0,
    };
  } catch {
    return { rowCount: 0 };
  }
}

export function loadImportedUsageProfiles(cwd = process.cwd()): NormalizedUsageProfile[] {
  const filePath = resolve(cwd, "diagnostics/usage-import.json");
  if (!existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      accounts?: Array<{ usageIntelligence?: { profile?: NormalizedUsageProfile } }>;
    };
    return (parsed.accounts ?? [])
      .map((account) => account.usageIntelligence?.profile)
      .filter((profile): profile is NormalizedUsageProfile => Boolean(profile?.accepted !== false));
  } catch {
    return [];
  }
}

export function identityFromMember(member: OrgMember): RelationshipIdentity {
  return {
    zoho: {
      contactId: member.module === "Contacts" ? member.recordId : undefined,
      leadId: member.module === "Leads" ? member.recordId : undefined,
      accountId: member.accountId ?? (member.module === "Accounts" ? member.recordId : undefined),
    },
    portalGenie: { accountId: member.portalGenieOrgId },
    emails: member.email ? [member.email] : [],
    domains: member.email ? [domainFromEmail(member.email) ?? ""].filter(Boolean) : [],
    companyName: member.company,
    source: "zoho",
  };
}

function contactLevelMethod(
  method: string | undefined,
): SubscriberUsageView["matchMethod"] | undefined {
  if (method === "email") return "email";
  if (method === "portal_genie_account_id") return "client_id";
  if (method === "zoho_id") return "zoho_id";
  return undefined;
}

export function matchUsageForOrganisation(
  members: OrgMember[],
  profiles: NormalizedUsageProfile[],
  options: {
    orgDomains?: string[];
    orgPortalGenieId?: string;
    publicDomains?: Set<string>;
    crm?: CrmUsageContext;
    now?: Date;
    thresholds?: ActivationThresholds;
    importedAt?: string;
  } = {},
): UsageMatchSummary {
  const layer = associateUsageWithOrganisation(members, profiles, options);
  if (layer.summary.label === "USAGE UNKNOWN" && layer.contactProfiles.length === 0 && layer.organisationDiscoveredProfiles.length === 0) {
    return usageUnknown(layer.summary.message, layer);
  }
  const matches = [...layer.contactProfiles, ...layer.organisationDiscoveredProfiles].map((view) => ({
    view,
    status: "matched" as const,
  }));
  const summary = usageFromProfiles(
    matches.map((item) => ({
      profile: profileFromView(profiles, item.view),
      method: item.view.matchMethod,
      status: item.status,
      view: item.view,
    })),
    layer,
  );
  return summary;
}

function profileFromView(profiles: NormalizedUsageProfile[], view: SubscriberUsageView): NormalizedUsageProfile {
  return (
    profiles.find(
      (profile) =>
        (view.clientId && profile.identity.portalGenieAccountId === view.clientId) ||
        (view.email && profile.identity.primaryEmail === view.email),
    ) ?? profiles[0]!
  );
}

export function associateUsageWithOrganisation(
  members: OrgMember[],
  profiles: NormalizedUsageProfile[],
  options: {
    orgDomains?: string[];
    orgPortalGenieId?: string;
    publicDomains?: Set<string>;
    crm?: CrmUsageContext;
    now?: Date;
    thresholds?: ActivationThresholds;
    importedAt?: string;
  } = {},
): OrganisationUsageLayer {
  const thresholds = options.thresholds ?? loadActivationThresholds();
  const now = options.now ?? new Date();
  const publicDomains = options.publicDomains ?? loadPublicEmailDomains();
  const orgDomains = new Set((options.orgDomains ?? []).map((domain) => domain.toLowerCase()).filter(Boolean));
  const identities = members.map(identityFromMember);
  const contactProfiles: SubscriberUsageView[] = [];
  const organisationDiscoveredProfiles: SubscriberUsageView[] = [];
  const seen = new Set<string>();

  for (const profile of profiles) {
    if (profile.accepted === false) continue;
    const key =
      profile.identity.portalGenieAccountId ??
      profile.identity.primaryEmail ??
      `row:${profile.source.rowNumber}`;
    if (seen.has(key)) continue;

    const contactMatch = matchUsageToCrm(profile, identities);
    const method = contactLevelMethod(contactMatch.method);
    if (contactMatch.status === "matched" && method && contactMatch.crm) {
      seen.add(key);
      const member = members.find(
        (item) =>
          item.recordId === contactMatch.crm?.zoho.contactId ||
          item.recordId === contactMatch.crm?.zoho.leadId ||
          item.recordId === contactMatch.crm?.zoho.accountId,
      );
      contactProfiles.push(
        toSubscriberView(profile, {
          layer: "contact",
          matchMethod: method === "client_id" && member?.portalGenieOrgId ? "portal_genie_org_mapping" : method,
          matchReason:
            method === "email"
              ? `Exact normalised email ${profile.identity.primaryEmail}`
              : method === "zoho_id"
                ? `Exact Zoho ID ${profile.identity.zohoId}`
                : `Client ID ${profile.identity.portalGenieAccountId} matches an existing Portal Genie mapping`,
          matchedContactId: member?.recordId,
          matchedContactName: member?.name,
          thresholds,
        }),
      );
      continue;
    }

    if (
      options.orgPortalGenieId &&
      profile.identity.portalGenieAccountId &&
      profile.identity.portalGenieAccountId === options.orgPortalGenieId
    ) {
      seen.add(key);
      organisationDiscoveredProfiles.push(
        toSubscriberView(profile, {
          layer: "organisation",
          matchMethod: "approved_portal_genie_org",
          matchReason: "Approved Portal Genie organisation mapping. Not assigned to a CRM Contact.",
          thresholds,
        }),
      );
      continue;
    }

    const usageDomain = profile.identity.primaryEmail
      ? organisationDomainFromEmail(profile.identity.primaryEmail, publicDomains)
      : profile.identity.domain && !publicDomains.has(profile.identity.domain)
        ? profile.identity.domain
        : undefined;
    if (usageDomain && orgDomains.has(usageDomain)) {
      seen.add(key);
      organisationDiscoveredProfiles.push(
        toSubscriberView(profile, {
          layer: "organisation",
          matchMethod: "business_domain",
          matchReason: `Business domain ${usageDomain} is on this organisation. Personal last-login and visit metrics are not assigned to another Contact.`,
          thresholds,
        }),
      );
    }
  }

  const matchedIds = new Set(contactProfiles.map((item) => item.matchedContactId).filter(Boolean));
  const unmatchedContacts = members
    .filter((member) => member.module !== "Accounts" && !matchedIds.has(member.recordId))
    .map((member) => ({
      contactId: member.recordId,
      name: member.name,
      email: member.email,
      message: "No matching usage profile" as const,
    }));

  const views = [...contactProfiles, ...organisationDiscoveredProfiles];
  const summary = summariseOrganisationUsage({
    contactProfiles,
    organisationDiscoveredProfiles,
    unmatchedContacts,
    importedAt: options.importedAt,
  });
  const signals = organisationSignals(views, now, thresholds);
  const contradictions = options.crm
    ? contradictionsForOrganisation({
        views,
        unmatchedContactCount: unmatchedContacts.length,
        crm: options.crm,
        now,
        thresholds,
      })
    : [];

  return {
    product: "PORTAL_GENIE",
    importedAt: options.importedAt,
    contactProfiles,
    organisationDiscoveredProfiles,
    unmatchedContacts,
    summary,
    signals,
    contradictions,
  };
}

export function usageImportIsNewerThan(analysedAt: string | undefined, importedAt?: string): boolean {
  if (!analysedAt || !importedAt) return false;
  const analysis = Date.parse(analysedAt);
  const imported = Date.parse(importedAt);
  if (Number.isNaN(analysis) || Number.isNaN(imported)) return false;
  return imported > analysis;
}

export { normalizeEmail };
