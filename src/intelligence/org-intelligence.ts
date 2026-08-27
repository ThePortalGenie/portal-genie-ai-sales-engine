import type { EvidenceItem } from "../domain/evidence.js";
import { evidence } from "../domain/evidence.js";
import type { NormalizedUsageProfile } from "../domain/normalized-usage.js";
import { deriveLeadingIndicators } from "../domain/leading-indicators.js";
import type { DealSignals } from "./contact-intelligence.js";
import { extractDealSignals } from "./contact-intelligence.js";
import type { OrganisationUsageLayer, SubscriberUsageView } from "../domain/portal-genie-usage.js";
import type { JsonObject } from "../integrations/zoho/types.js";
import type { OrganisationResolution, OrgMember } from "./org-resolution.js";

export type OrganisationEvidenceProfile = {
  identity: OrganisationResolution["identity"];
  members: OrgMember[];
  notes: Array<{ id?: string; title?: string; content?: string; at?: string; source: string }>;
  deals: DealSignals;
  emailSummary: {
    selectedOutbound: number;
    selectedInbound: number;
    selectedLastAt: string | null;
    otherMembersDiscovered: number;
  };
  timeline: Array<{ at: string; title: string; source: string }>;
  usage: UsageMatchSummary;
  evidence: EvidenceItem[];
};

export type UsageMatchSummary = {
  status: "matched" | "unmatched" | "needs_review" | "unavailable";
  label: "USAGE MATCHED" | "USAGE UNKNOWN";
  message: string;
  profiles: Array<{
    layer?: "contact" | "organisation";
    company?: string;
    name?: string;
    firstName?: string;
    surname?: string;
    email?: string;
    clientId?: string;
    registered?: boolean;
    registrationDate?: string;
    accountingSoftware?: string;
    accountingPlatform?: string;
    accountingConnected?: boolean | "unknown";
    lastLoginAt?: string;
    portalVisitsCurrentMonth?: number;
    portalVisitsPreviousMonth?: number;
    portalVisitsTwoMonthsAgo?: number;
    portalVisitTrend?: string;
    documentUploadUsage?: string;
    portalVisitsLast30Days?: number;
    paymentsProcessed?: number;
    documentsViewed?: number;
    emailsSent?: number;
    lastActivity?: string;
    activityTrend?: string;
    paying?: boolean | string;
    partnerStatus?: boolean | string;
    activationState?: string | null;
    matchMethod?: string;
    matchReason?: string;
    matchedContactId?: string;
    matchedContactName?: string;
    dataQualityStatus?: string;
  }>;
  unmatchedContacts?: OrganisationUsageLayer["unmatchedContacts"];
  organisationSummary?: OrganisationUsageLayer["summary"];
  signals?: OrganisationUsageLayer["signals"];
  contradictions?: OrganisationUsageLayer["contradictions"];
  importedAt?: string;
  layer?: OrganisationUsageLayer;
  evidence: EvidenceItem[];
};

export function usageUnknown(message: string, layer?: OrganisationUsageLayer): UsageMatchSummary {
  return {
    status: "unavailable",
    label: "USAGE UNKNOWN",
    message,
    profiles: [],
    unmatchedContacts: layer?.unmatchedContacts,
    organisationSummary: layer?.summary,
    signals: layer?.signals,
    contradictions: layer?.contradictions,
    importedAt: layer?.importedAt,
    layer,
    evidence: [
      evidence({
        type: "unknown",
        claim: "USAGE UNKNOWN — product usage was not assumed to be zero",
        source: "USAGE",
      }),
    ],
  };
}

export function usageFromProfiles(
  matches: Array<{
    profile: NormalizedUsageProfile;
    method?: string;
    status: "matched" | "needs_review";
    view?: SubscriberUsageView;
  }>,
  layer?: OrganisationUsageLayer,
): UsageMatchSummary {
  if (matches.length === 0) {
    return usageUnknown("No deterministic usage match for this organisation.");
  }
  const confirmed = matches.filter((item) => item.status === "matched");
  const review = matches.filter((item) => item.status === "needs_review");
  const status = confirmed.length > 0 ? "matched" : "needs_review";
  const evidenceItems: EvidenceItem[] = [];
  const profiles = matches.map(({ profile, method, status: matchStatus, view }) => {
    const indicators = deriveLeadingIndicators(profile);
    if (matchStatus === "matched") {
      evidenceItems.push(
        evidence({
          type: "usage_fact",
          claim: `Portal Genie usage matched via ${view?.matchReason ?? method ?? "identity"} for ${view?.name ?? profile.identity.company ?? profile.identity.primaryEmail ?? "account"}`,
          source: "USAGE",
          recordId: profile.identity.portalGenieAccountId,
        }),
      );
      if (profile.lastLoginAt) {
        evidenceItems.push(
          evidence({
            type: "usage_fact",
            claim: `Subscriber last login ${profile.lastLoginAt}`,
            source: "USAGE",
          }),
        );
      }
      if (profile.portalVisitsCurrentMonth !== undefined) {
        evidenceItems.push(
          evidence({
            type: "usage_fact",
            claim: `Client portal visits this month = ${profile.portalVisitsCurrentMonth} (visits by the subscriber's clients, not subscriber logins)`,
            source: "USAGE",
          }),
        );
      }
      if (profile.accountingSoftware || profile.accountingConnected !== undefined) {
        evidenceItems.push(
          evidence({
            type: "usage_fact",
            claim: `Accounting software ${profile.accountingConnected === true ? "connected" : profile.accountingConnected === false ? "not connected" : "unknown"}: ${profile.accountingPlatform ?? profile.accountingSoftware ?? "UNKNOWN"}`,
            source: "USAGE",
          }),
        );
      }
      if (profile.payingStatus === true || profile.payingStatusRaw) {
        evidenceItems.push(
          evidence({
            type: "usage_fact",
            claim: `Paying status = ${profile.payingStatus === true ? "paying" : profile.payingStatusRaw}`,
            source: "USAGE",
          }),
        );
      }
    } else {
      evidenceItems.push(
        evidence({
          type: "unknown",
          claim: view?.matchMethod === "business_domain"
            ? "Portal Genie usage exists within this organisation by business domain. Personal usage was not assigned to another Contact."
            : "Possible Portal Genie usage match flagged for review; not treated as a personal usage fact",
          source: "USAGE",
        }),
      );
    }
    return {
      layer: view?.layer,
      company: profile.identity.company,
      name: view?.name,
      firstName: profile.identity.firstName,
      surname: profile.identity.surname,
      email: profile.identity.primaryEmail,
      clientId: profile.identity.portalGenieAccountId,
      registered: Boolean(profile.registrationDate || profile.identity.portalGenieAccountId),
      registrationDate: profile.registrationDate,
      accountingSoftware: profile.accountingSoftware,
      accountingPlatform: view?.accountingPlatform ?? profile.accountingPlatform,
      accountingConnected: view?.accountingConnected ?? profile.accountingConnected,
      lastLoginAt: profile.lastLoginAt,
      portalVisitsCurrentMonth: profile.portalVisitsCurrentMonth,
      portalVisitsPreviousMonth: profile.portalVisitsPreviousMonth,
      portalVisitsTwoMonthsAgo: profile.portalVisitsTwoMonthsAgo,
      portalVisitTrend: view?.portalVisitTrend,
      documentUploadUsage: profile.documentUploadUsage?.original,
      portalVisitsLast30Days: profile.visitsLast30Days ?? profile.portalVisitsCurrentMonth,
      paymentsProcessed: profile.paymentsProcessed,
      documentsViewed: profile.documentsViewed,
      emailsSent: profile.emailsSent,
      lastActivity: profile.lastLoginAt ?? profile.lastMeaningfulActivityAt ?? profile.lastVisitAt,
      activityTrend: view?.portalVisitTrend ?? indicators.usageMomentum.value ?? undefined,
      paying: profile.payingStatus ?? profile.payingStatusRaw,
      partnerStatus: profile.partnerStatus ?? profile.partnerStatusRaw,
      activationState: indicators.activationState.value,
      matchMethod: view?.matchMethod ?? method,
      matchReason: view?.matchReason,
      matchedContactId: view?.matchedContactId,
      matchedContactName: view?.matchedContactName,
      dataQualityStatus: view
        ? Object.entries(view.dataQuality)
            .map(([field, presence]) => `${field}=${presence}`)
            .join(", ")
        : undefined,
    };
  });

  for (const contradiction of layer?.contradictions ?? []) {
    evidenceItems.push(
      evidence({
        type: "derived_signal",
        claim: `${contradiction.code}: ${contradiction.message}`,
        source: "USAGE",
      }),
    );
  }

  return {
    status,
    label: layer?.summary.label ?? (confirmed.length > 0 ? "USAGE MATCHED" : "USAGE UNKNOWN"),
    message:
      layer?.summary.message ??
      (confirmed.length > 0
        ? `${confirmed.length} deterministic Portal Genie usage match(es). Product evidence is separate from CRM evidence.`
        : review.length > 0
          ? "Possible usage matches need review. Usage is unknown until confirmed."
          : "USAGE UNKNOWN"),
    profiles,
    unmatchedContacts: layer?.unmatchedContacts,
    organisationSummary: layer?.summary,
    signals: layer?.signals,
    contradictions: layer?.contradictions,
    importedAt: layer?.importedAt,
    layer,
    evidence: evidenceItems,
  };
}

export function buildOrganisationEvidenceProfile(options: {
  resolution: OrganisationResolution;
  selectedNotes: Array<{ id?: string; title?: string; content?: string; at?: string }>;
  selectedDeals: DealSignals;
  selectedEmails: { outboundCount: number; inboundCount: number; lastAt: string | null };
  accountNotes?: JsonObject[];
  accountDeals?: JsonObject[];
  timeline: Array<{ at: string; title: string; source: string }>;
  usage: UsageMatchSummary;
}): OrganisationEvidenceProfile {
  const accountNotes = (options.accountNotes ?? []).map((note) => ({
    id: typeof note.id === "string" ? note.id : undefined,
    title: typeof note.Note_Title === "string" ? note.Note_Title : undefined,
    content: typeof note.Note_Content === "string" ? note.Note_Content : undefined,
    at: typeof note.Created_Time === "string" ? note.Created_Time : undefined,
    source: "Zoho Account Notes",
  }));
  const selectedNotes = options.selectedNotes.map((note) => ({ ...note, source: "Zoho Contact/Lead Notes" }));
  const accountDealSignals = extractDealSignals(options.accountDeals ?? []);
  const deals: DealSignals = {
    count: options.selectedDeals.count + accountDealSignals.count,
    stages: [...new Set([...options.selectedDeals.stages, ...accountDealSignals.stages])],
    names: [...new Set([...(options.selectedDeals.names ?? []), ...(accountDealSignals.names ?? [])])],
    closedWon: options.selectedDeals.closedWon + accountDealSignals.closedWon,
    closedLost: options.selectedDeals.closedLost + accountDealSignals.closedLost,
    latestName: options.selectedDeals.latestAt && accountDealSignals.latestAt
      ? Date.parse(options.selectedDeals.latestAt) >= Date.parse(accountDealSignals.latestAt)
        ? options.selectedDeals.latestName
        : accountDealSignals.latestName
      : options.selectedDeals.latestName ?? accountDealSignals.latestName,
    latestStage: options.selectedDeals.latestAt && accountDealSignals.latestAt
      ? Date.parse(options.selectedDeals.latestAt) >= Date.parse(accountDealSignals.latestAt)
        ? options.selectedDeals.latestStage
        : accountDealSignals.latestStage
      : options.selectedDeals.latestStage ?? accountDealSignals.latestStage,
    latestAt: options.selectedDeals.latestAt && accountDealSignals.latestAt
      ? Date.parse(options.selectedDeals.latestAt) >= Date.parse(accountDealSignals.latestAt)
        ? options.selectedDeals.latestAt
        : accountDealSignals.latestAt
      : options.selectedDeals.latestAt ?? accountDealSignals.latestAt,
    values: [...options.selectedDeals.values, ...accountDealSignals.values],
  };

  return {
    identity: options.resolution.identity,
    members: options.resolution.members,
    notes: [...selectedNotes, ...accountNotes],
    deals,
    emailSummary: {
      selectedOutbound: options.selectedEmails.outboundCount,
      selectedInbound: options.selectedEmails.inboundCount,
      selectedLastAt: options.selectedEmails.lastAt,
      otherMembersDiscovered: options.resolution.members.filter((member) => !member.selected).length,
    },
    timeline: options.timeline,
    usage: options.usage,
    evidence: [...options.resolution.evidence, ...options.usage.evidence],
  };
}
