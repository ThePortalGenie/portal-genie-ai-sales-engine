import type { EvidenceItem } from "../domain/evidence.js";
import { evidence } from "../domain/evidence.js";
import type { NormalizedUsageProfile } from "../domain/normalized-usage.js";
import { deriveLeadingIndicators } from "../domain/leading-indicators.js";
import type { DealSignals } from "./contact-intelligence.js";
import { extractDealSignals } from "./contact-intelligence.js";
import type { OrganisationResolution, OrgMember } from "./org-resolution.js";
import type { JsonObject } from "../integrations/zoho/types.js";

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
    company?: string;
    email?: string;
    registered?: boolean;
    registrationDate?: string;
    accountingSoftware?: string;
    accountingConnected?: boolean;
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
  }>;
  evidence: EvidenceItem[];
};

export function usageUnknown(message: string): UsageMatchSummary {
  return {
    status: "unavailable",
    label: "USAGE UNKNOWN",
    message,
    profiles: [],
    evidence: [
      evidence({
        type: "unknown",
        claim: "USAGE UNKNOWN — product usage was not assumed to be zero",
        source: "Portal Genie usage import",
      }),
    ],
  };
}

export function usageFromProfiles(
  matches: Array<{ profile: NormalizedUsageProfile; method?: string; status: "matched" | "needs_review" }>,
): UsageMatchSummary {
  if (matches.length === 0) {
    return usageUnknown("No deterministic usage match for this organisation.");
  }
  const confirmed = matches.filter((item) => item.status === "matched");
  const review = matches.filter((item) => item.status === "needs_review");
  const status = confirmed.length > 0 ? "matched" : "needs_review";
  const evidenceItems: EvidenceItem[] = [];
  const profiles = matches.map(({ profile, method, status: matchStatus }) => {
    const indicators = deriveLeadingIndicators(profile);
    if (matchStatus === "matched") {
      evidenceItems.push(
        evidence({
          type: "usage_fact",
          claim: `Portal Genie usage matched via ${method ?? "identity"} for ${profile.identity.company ?? profile.identity.primaryEmail ?? "account"}`,
          source: "Imported Portal Genie usage (not Zoho)",
          recordId: profile.identity.portalGenieAccountId,
        }),
      );
      if (profile.registrationDate) {
        evidenceItems.push(
          evidence({
            type: "usage_fact",
            claim: `Registered ${profile.registrationDate}`,
            source: "Imported Portal Genie usage",
          }),
        );
      }
      if (profile.accountingSoftware) {
        evidenceItems.push(
          evidence({
            type: "usage_fact",
            claim: `Accounting software ${profile.accountingConnected ? "connected" : "not connected"}: ${profile.accountingSoftware}`,
            source: "Imported Portal Genie usage",
          }),
        );
      }
      if (profile.payingStatus === true || profile.payingStatusRaw) {
        evidenceItems.push(
          evidence({
            type: "usage_fact",
            claim: `Paying status = ${profile.payingStatus === true ? "paying" : profile.payingStatusRaw}`,
            source: "Imported Portal Genie usage",
          }),
        );
      }
    } else {
      evidenceItems.push(
        evidence({
          type: "unknown",
          claim: "Possible Portal Genie usage match flagged for review; not treated as a usage fact",
          source: "Identity matching",
        }),
      );
    }
    return {
      company: profile.identity.company,
      email: profile.identity.primaryEmail,
      registered: Boolean(profile.registrationDate || profile.identity.portalGenieAccountId),
      registrationDate: profile.registrationDate,
      accountingSoftware: profile.accountingSoftware,
      accountingConnected: profile.accountingConnected,
      portalVisitsLast30Days: profile.visitsLast30Days,
      paymentsProcessed: profile.paymentsProcessed,
      documentsViewed: profile.documentsViewed,
      emailsSent: profile.emailsSent,
      lastActivity: profile.lastMeaningfulActivityAt ?? profile.lastVisitAt,
      activityTrend: indicators.usageMomentum.value ?? undefined,
      paying: profile.payingStatus ?? profile.payingStatusRaw,
      partnerStatus: profile.partnerStatus ?? profile.partnerStatusRaw,
      activationState: indicators.activationState.value,
      matchMethod: method,
    };
  });

  return {
    status,
    label: confirmed.length > 0 ? "USAGE MATCHED" : "USAGE UNKNOWN",
    message:
      confirmed.length > 0
        ? `${confirmed.length} deterministic Portal Genie usage match(es). Product evidence is separate from CRM evidence.`
        : review.length > 0
          ? "Possible usage matches need review. Usage is unknown until confirmed."
          : "USAGE UNKNOWN",
    profiles,
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
