import type { EvidenceItem } from "../domain/evidence.js";
import type { OrganisationRelationship, ProductRelationship, ProductRelationshipState } from "../domain/product-relationship.js";
import type { DealSignals } from "./contact-intelligence.js";
import type { OrganisationEvidenceProfile } from "./org-intelligence.js";

function mentions(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

function collectText(options: {
  deals: DealSignals;
  notes: Array<{ title?: string; content?: string }>;
  emails: Array<{ subject?: string | null; currentMessageText?: string | null; bodyText?: string | null }>;
  leadSource?: string;
}): { portalGenie: string[]; naggingPanda: string[] } {
  const blobs = [
    options.leadSource ?? "",
    options.deals.latestName ?? "",
    options.deals.latestStage ?? "",
    ...options.deals.stages,
    ...(options.deals.names ?? []),
    ...options.notes.map((note) => `${note.title ?? ""} ${note.content ?? ""}`),
    ...options.emails.map((email) => `${email.subject ?? ""} ${email.currentMessageText ?? email.bodyText ?? ""}`),
  ];
  const portalGenie: string[] = [];
  const naggingPanda: string[] = [];
  for (const blob of blobs) {
    if (mentions(blob, /\bportal genie\b|\bfirm partner\b|\bpartner programme\b|\bpartner program\b/i)) {
      portalGenie.push(blob.slice(0, 120));
    }
    if (mentions(blob, /\bnagging panda\b/i)) {
      naggingPanda.push(blob.slice(0, 120));
    }
  }
  return { portalGenie, naggingPanda };
}

function portalGenieState(options: {
  usage: OrganisationEvidenceProfile["usage"];
  deals: DealSignals;
  mentioned: boolean;
}): ProductRelationshipState {
  const profile = options.usage.profiles.find((item) => item.matchMethod && options.usage.status === "matched") ?? options.usage.profiles[0];
  if (options.usage.status === "matched" && profile) {
    if (profile.paying === true || profile.paying === "paying") return "PAYING_CUSTOMER";
    if (profile.partnerStatus === true || /partner/i.test(String(profile.partnerStatus ?? ""))) return "PARTNER";
    if (profile.activationState === "highly_active" || profile.activationState === "active") return "ACTIVE_USER";
    if (profile.activationState === "dormant" || profile.activationState === "declining") return profile.registered ? "DORMANT_USER" : "UNCLEAR";
    if (profile.registered && (profile.activationState === "never_activated" || profile.activationState === "registered")) {
      return "REGISTERED_NOT_ACTIVATED";
    }
    if (profile.registered) return "ACTIVATING";
  }
  if (
    options.deals.stages.some((stage) => /partner/i.test(stage)) ||
    /partner/i.test(options.deals.latestName ?? "") ||
    (options.deals.names ?? []).some((name) => /partner/i.test(name))
  ) {
    return "PARTNER_PROSPECT";
  }
  if (options.mentioned) return "ENGAGED_PROSPECT";
  return "UNKNOWN";
}

function naggingPandaState(mentioned: boolean, deals: DealSignals): ProductRelationshipState {
  if (
    deals.stages.some((stage) => /nagging panda/i.test(stage)) ||
    /nagging panda/i.test(deals.latestName ?? "") ||
    (deals.names ?? []).some((name) => /nagging panda/i.test(name))
  ) {
    if (deals.closedWon > 0) return "PAYING_CUSTOMER";
    return "ENGAGED_PROSPECT";
  }
  if (mentioned) return "ENGAGED_PROSPECT";
  return "UNKNOWN";
}

export function buildProductRelationships(options: {
  organisation: OrganisationEvidenceProfile;
  deals: DealSignals;
  emails: Array<{ subject?: string | null; currentMessageText?: string | null; bodyText?: string | null }>;
  evidence: EvidenceItem[];
  leadSource?: string;
}): { products: ProductRelationship[]; organisationRelationship: OrganisationRelationship } {
  const texts = collectText({
    deals: options.deals,
    notes: options.organisation.notes,
    emails: options.emails,
    leadSource: options.leadSource,
  });
  const usageEvidenceIds = options.organisation.usage.evidence.map((item) => item.id);
  const dealEvidenceIds = options.evidence
    .filter((item) => /deal/i.test(item.source) || /Deal/.test(item.claim))
    .map((item) => item.id);
  const pgState = portalGenieState({
    usage: options.organisation.usage,
    deals: options.deals,
    mentioned: texts.portalGenie.length > 0 || /portal genie|xero/i.test(options.leadSource ?? ""),
  });
  const npState = naggingPandaState(texts.naggingPanda.length > 0, options.deals);

  const portalGenie: ProductRelationship = {
    product: "PORTAL_GENIE",
    relationship_state: pgState,
    evidence_ids: [...usageEvidenceIds, ...dealEvidenceIds].slice(0, 12),
    summary:
      pgState === "UNKNOWN"
        ? "No Portal Genie evidence was found. This is unknown, not an assumption of no relationship."
        : `Portal Genie state ${pgState.replaceAll("_", " ")} from available CRM/usage evidence.`,
    confidence: pgState === "UNKNOWN" ? "LOW" : options.organisation.usage.status === "matched" ? "HIGH" : "MEDIUM",
  };
  if (portalGenie.relationship_state === "PARTNER_PROSPECT" && options.organisation.usage.status !== "matched") {
    portalGenie.summary = "Portal Genie partner-stage deal evidence without a confirmed usage match.";
  }

  const naggingPanda: ProductRelationship = {
    product: "NAGGING_PANDA",
    relationship_state: npState,
    evidence_ids: npState === "UNKNOWN" ? [] : dealEvidenceIds.slice(0, 8),
    summary:
      npState === "UNKNOWN"
        ? "No Nagging Panda evidence was found. This is unknown, not an assumption of no relationship."
        : `Nagging Panda state ${npState.replaceAll("_", " ")} from available CRM evidence.`,
    confidence: npState === "UNKNOWN" ? "LOW" : "MEDIUM",
  };

  const twoWay = options.organisation.emailSummary.selectedInbound > 0 && options.organisation.emailSummary.selectedOutbound > 0;
  const organisationRelationship: OrganisationRelationship = {
    characterisation: twoWay
      ? "Established two-way commercial correspondence"
      : options.deals.count > 0
        ? "CRM relationship with at least one deal"
        : "Limited organisation-level CRM relationship",
    summary:
      "Organisation relationship is independent of product-specific state. Product relationships must not be collapsed into this characterisation.",
    evidence_ids: options.evidence.filter((item) => item.type === "crm_fact").slice(0, 8).map((item) => item.id),
  };

  return { products: [portalGenie, naggingPanda], organisationRelationship };
}

export function detectProductContradictions(options: {
  products: ProductRelationship[];
  deals: DealSignals;
  usage: OrganisationEvidenceProfile["usage"];
}): string[] {
  const contradictions: string[] = [];
  const portalGenie = options.products.find((item) => item.product === "PORTAL_GENIE");
  const neverActivated =
    options.usage.status === "matched" &&
    options.usage.profiles.some((profile) => profile.activationState === "never_activated" || profile.registered === false);
  if (options.deals.closedWon > 0 && neverActivated) {
    contradictions.push("Zoho Deal Closed Won, but Portal Genie usage evidence shows the account has not activated.");
  }
  if (options.deals.closedWon > 0 && options.usage.status !== "matched") {
    contradictions.push("Zoho Deal Closed Won, but Portal Genie usage is unknown (not assumed to be zero).");
  }
  if (portalGenie?.relationship_state === "PAYING_CUSTOMER" && options.usage.profiles.some((profile) => profile.activationState === "dormant")) {
    contradictions.push("Paying Portal Genie status coexists with dormant usage.");
  }
  return contradictions;
}
