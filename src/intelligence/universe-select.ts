import type { OrganisationCluster, UniverseAuditStats, UniverseRecord } from "../domain/commercial-watch.js";
import { DEFAULT_COMMAND_CENTRE_THRESHOLDS } from "../domain/commercial-watch.js";
import { classifyDealProduct } from "./org-graph.js";
import { daysBetweenCalendar } from "./calendar-date.js";
import { listSalesEvents } from "./sales-event-store.js";

/**
 * Stage 2 / Command Centre sample selection.
 *
 * Does NOT prefer organisations that already have stored analysis.
 * Tags come only from CRM listing evidence (module, Deal stage/name, recency).
 * Quotas are filled rarest-first on evidence-ranked clusters, then remaining slots by rank.
 * Tie-break: lastActivityAt descending, then organisation_id.
 */
export const COMMAND_CENTRE_SELECTION_METHOD =
  "Deterministic evidence-ranked stratified sample from listing evidence. Does not prefer cached analyses. Quotas: Nagging Panda, Closed Lost, Closed Won, possible-match, multi-contact, Lead, quiet, incomplete CRM, live Deal, Portal Genie, Contact; remaining slots by commercial rank. Cap applied last.";

export const ORGANISATION_LISTING_TAGS = [
  "nagging_panda",
  "closed_lost",
  "closed_won",
  "possible_match",
  "multi_contact",
  "lead",
  "quiet",
  "incomplete",
  "live_deal",
  "portal_genie",
  "contact",
] as const;
export type OrganisationListingTag = (typeof ORGANISATION_LISTING_TAGS)[number];

const QUOTAS: Array<{ tag: OrganisationListingTag; min: number }> = [
  { tag: "nagging_panda", min: 2 },
  { tag: "closed_lost", min: 2 },
  { tag: "closed_won", min: 2 },
  { tag: "possible_match", min: 1 },
  { tag: "multi_contact", min: 2 },
  { tag: "lead", min: 3 },
  { tag: "quiet", min: 2 },
  { tag: "incomplete", min: 2 },
  { tag: "live_deal", min: 3 },
  { tag: "portal_genie", min: 3 },
  { tag: "contact", min: 3 },
];

function isLost(stage?: string): boolean {
  return Boolean(stage && /lost/i.test(stage));
}

function isWon(stage?: string): boolean {
  return Boolean(stage && /won/i.test(stage) && !/lost/i.test(stage));
}

function dealsOf(cluster: OrganisationCluster): UniverseRecord[] {
  return cluster.records.filter((item) => item.module === "Deals");
}

function leadsOf(cluster: OrganisationCluster): UniverseRecord[] {
  return cluster.records.filter((item) => item.module === "Leads");
}

function contactsOf(cluster: OrganisationCluster): UniverseRecord[] {
  return cluster.records.filter((item) => item.module === "Contacts");
}

function hasLiveDeal(cluster: OrganisationCluster): boolean {
  return dealsOf(cluster).some((deal) => !isLost(deal.stage) && !isWon(deal.stage));
}

export function listingTagsForCluster(
  cluster: OrganisationCluster,
  asOf = new Date().toISOString(),
  timeZone = DEFAULT_COMMAND_CENTRE_THRESHOLDS.timeZone,
): OrganisationListingTag[] {
  const tags = new Set<OrganisationListingTag>();
  const contacts = contactsOf(cluster);
  const leads = leadsOf(cluster);
  const deals = dealsOf(cluster);
  if (leads.length) tags.add("lead");
  if (contacts.length) tags.add("contact");
  if (contacts.length > 1) tags.add("multi_contact");
  if (cluster.possibleMatchReviews.length) tags.add("possible_match");
  for (const deal of deals) {
    const product = classifyDealProduct(deal.name, deal.pipeline);
    if (product === "NAGGING_PANDA") tags.add("nagging_panda");
    if (product === "PORTAL_GENIE") tags.add("portal_genie");
    if (isLost(deal.stage)) tags.add("closed_lost");
    else if (isWon(deal.stage)) tags.add("closed_won");
    else tags.add("live_deal");
  }
  const noAccount = contacts.length > 0 && contacts.every((item) => !item.accountId);
  if (deals.length === 0 && (leads.length > 0 || noAccount)) tags.add("incomplete");
  const quietDays = daysBetweenCalendar(cluster.lastActivityAt, asOf, timeZone);
  if (quietDays !== undefined && quietDays >= DEFAULT_COMMAND_CENTRE_THRESHOLDS.quietDaysStalled) {
    tags.add("quiet");
  }
  return ORGANISATION_LISTING_TAGS.filter((tag) => tags.has(tag));
}

function recencyMs(cluster: OrganisationCluster): number {
  return Date.parse(cluster.lastActivityAt ?? cluster.lastModifiedAt ?? "1970-01-01");
}

function byRecencyThenId(left: OrganisationCluster, right: OrganisationCluster): number {
  const recency = recencyMs(right) - recencyMs(left);
  if (recency !== 0) return recency;
  return left.organisationId.localeCompare(right.organisationId);
}

function recentActivityDays(cluster: OrganisationCluster, asOf: string, timeZone: string): number | undefined {
  return daysBetweenCalendar(cluster.lastActivityAt ?? cluster.lastModifiedAt, asOf, timeZone);
}

export type CandidateSelectionScoreBreakdown = {
  total: number;
  recency: number;
  live_deal: number;
  lead: number;
  possible_match: number;
  multi_contact: number;
  overdue_commitment: number;
  recent_sales_event: number;
  quiet_penalty: number;
  historical_only_penalty: number;
};

function classifyInstantOverdue(value: string, asOf: string, timeZone: string): boolean {
  const days = daysBetweenCalendar(value, asOf, timeZone);
  return days !== undefined && days < 0;
}

/**
 * Lightweight commercial rank from listing evidence and local Sales Events.
 * Does not require a Deal; strong recent Lead activity can outrank a weak Deal.
 */
export function candidateSelectionScoreBreakdown(
  cluster: OrganisationCluster,
  asOf: string,
  timeZone = DEFAULT_COMMAND_CENTRE_THRESHOLDS.timeZone,
): CandidateSelectionScoreBreakdown {
  const recentDays = recentActivityDays(cluster, asOf, timeZone);
  const recency = recentDays !== undefined ? Math.max(0, 120 - recentDays) : 0;

  const leads = leadsOf(cluster);
  const deals = dealsOf(cluster);
  const liveDeal = hasLiveDeal(cluster);
  const leadOnly = leads.length > 0 && deals.length === 0;

  let liveDealScore = 0;
  if (liveDeal) {
    liveDealScore = recentDays !== undefined && recentDays <= 45 ? 45 : 25;
  }

  let leadScore = 0;
  if (leadOnly) {
    if (recentDays !== undefined && recentDays <= 30) leadScore = 55;
    else if (recentDays !== undefined && recentDays <= 90) leadScore = 30;
    else leadScore = 5;
  } else if (leads.length > 0 && recentDays !== undefined && recentDays <= 60) {
    leadScore = 20;
  }

  const possibleMatch = cluster.possibleMatchReviews.length ? 12 : 0;
  const multiContact = contactsOf(cluster).length > 1 ? 8 : 0;

  const contactIds = cluster.records.filter((item) => item.module !== "Deals").map((item) => item.recordId);
  const events = listSalesEvents({
    organisationIds: [cluster.organisationId],
    contactIds,
  });
  const overdueCommitment = events.some(
    (event) => event.follow_up_date && classifyInstantOverdue(event.follow_up_date, asOf, timeZone),
  )
    ? 70
    : 0;
  const recentSalesEvent = events.some(
    (event) => Date.parse(event.occurred_at) >= Date.parse(asOf) - 14 * 86_400_000,
  )
    ? 25
    : 0;

  const quietPenalty =
    recentDays !== undefined && recentDays >= DEFAULT_COMMAND_CENTRE_THRESHOLDS.quietDaysStalled ? -35 : 0;

  const historicalOnly =
    deals.length > 0 &&
    deals.every((deal) => isLost(deal.stage) || isWon(deal.stage)) &&
    !liveDeal &&
    (recentDays === undefined || recentDays > 90);
  const historicalOnlyPenalty = historicalOnly && !leadOnly ? -25 : 0;

  const total =
    recency +
    liveDealScore +
    leadScore +
    possibleMatch +
    multiContact +
    overdueCommitment +
    recentSalesEvent +
    quietPenalty +
    historicalOnlyPenalty;

  return {
    total,
    recency,
    live_deal: liveDealScore,
    lead: leadScore,
    possible_match: possibleMatch,
    multi_contact: multiContact,
    overdue_commitment: overdueCommitment,
    recent_sales_event: recentSalesEvent,
    quiet_penalty: quietPenalty,
    historical_only_penalty: historicalOnlyPenalty,
  };
}

export function candidateSelectionScore(
  cluster: OrganisationCluster,
  asOf: string,
  timeZone = DEFAULT_COMMAND_CENTRE_THRESHOLDS.timeZone,
): number {
  return candidateSelectionScoreBreakdown(cluster, asOf, timeZone).total;
}

export function rankClustersForCandidateSelection(
  clusters: OrganisationCluster[],
  asOf: string,
  timeZone = DEFAULT_COMMAND_CENTRE_THRESHOLDS.timeZone,
): OrganisationCluster[] {
  return [...clusters].sort((left, right) => {
    const scoreDelta = candidateSelectionScore(right, asOf, timeZone) - candidateSelectionScore(left, asOf, timeZone);
    if (scoreDelta !== 0) return scoreDelta;
    return byRecencyThenId(left, right);
  });
}

export function computeUniverseAuditStats(
  clusters: OrganisationCluster[],
  records: UniverseRecord[],
): UniverseAuditStats {
  let organisationsWithLeads = 0;
  let leadOnlyOrganisations = 0;
  let organisationsWithDeals = 0;
  let contactOrAccountWithoutDeal = 0;

  for (const cluster of clusters) {
    const leads = leadsOf(cluster);
    const deals = dealsOf(cluster);
    const contacts = contactsOf(cluster);
    const accounts = cluster.records.filter((item) => item.module === "Accounts");
    if (leads.length) organisationsWithLeads += 1;
    if (leads.length && deals.length === 0) leadOnlyOrganisations += 1;
    if (deals.length) organisationsWithDeals += 1;
    if (deals.length === 0 && (contacts.length > 0 || accounts.length > 0)) contactOrAccountWithoutDeal += 1;
  }

  return {
    reconstructed_organisations: clusters.length,
    organisations_with_leads: organisationsWithLeads,
    lead_only_organisations: leadOnlyOrganisations,
    organisations_with_deals: organisationsWithDeals,
    contact_or_account_without_deal: contactOrAccountWithoutDeal,
    records_by_module: countRecordsByModule(records),
  };
}

function auditClusterCandidate(cluster: OrganisationCluster): { hasLead: boolean; leadOnly: boolean } {
  const leads = leadsOf(cluster);
  const deals = dealsOf(cluster);
  return { hasLead: leads.length > 0, leadOnly: leads.length > 0 && deals.length === 0 };
}

/**
 * Select a commercially mixed sample without using stored-analysis presence.
 */
export function selectOrganisationsForCommandCentre(
  clusters: OrganisationCluster[],
  maxOrganisations?: number,
  asOf = new Date().toISOString(),
  timeZone = DEFAULT_COMMAND_CENTRE_THRESHOLDS.timeZone,
): OrganisationCluster[] {
  if (!maxOrganisations || clusters.length <= maxOrganisations) {
    return rankClustersForCandidateSelection(clusters, asOf, timeZone);
  }
  const sorted = rankClustersForCandidateSelection(clusters, asOf, timeZone);
  const picked = new Set<string>();
  const counts: Record<string, number> = {};
  const take = (cluster: OrganisationCluster) => {
    if (picked.has(cluster.organisationId) || picked.size >= maxOrganisations) return;
    picked.add(cluster.organisationId);
    for (const tag of listingTagsForCluster(cluster, asOf, timeZone)) {
      counts[tag] = (counts[tag] ?? 0) + 1;
    }
  };

  for (const quota of QUOTAS) {
    const pool = quota.tag === "quiet" ? [...sorted].reverse() : sorted;
    for (const cluster of pool) {
      if (picked.size >= maxOrganisations) break;
      if ((counts[quota.tag] ?? 0) >= quota.min) break;
      if (picked.has(cluster.organisationId)) continue;
      if (!listingTagsForCluster(cluster, asOf, timeZone).includes(quota.tag)) continue;
      take(cluster);
    }
  }

  for (const cluster of sorted) {
    if (picked.size >= maxOrganisations) break;
    take(cluster);
  }

  return sorted.filter((item) => picked.has(item.organisationId)).slice(0, maxOrganisations);
}

/** Next ranked organisations not yet in the working snapshot (rolling backfill). */
export function selectNextCandidatesForBackfill(
  clusters: OrganisationCluster[],
  excludeOrganisationIds: Set<string>,
  limit: number,
  asOf: string,
  timeZone = DEFAULT_COMMAND_CENTRE_THRESHOLDS.timeZone,
): OrganisationCluster[] {
  if (limit <= 0) return [];
  const ranked = rankClustersForCandidateSelection(clusters, asOf, timeZone);
  const next: OrganisationCluster[] = [];
  for (const cluster of ranked) {
    if (excludeOrganisationIds.has(cluster.organisationId)) continue;
    next.push(cluster);
    if (next.length >= limit) break;
  }
  return next;
}

export function candidateAuditForSelection(clusters: OrganisationCluster[]): {
  candidates_selected: number;
  candidates_with_leads: number;
  lead_only_candidates: number;
} {
  let candidatesWithLeads = 0;
  let leadOnlyCandidates = 0;
  for (const cluster of clusters) {
    const audit = auditClusterCandidate(cluster);
    if (audit.hasLead) candidatesWithLeads += 1;
    if (audit.leadOnly) leadOnlyCandidates += 1;
  }
  return {
    candidates_selected: clusters.length,
    candidates_with_leads: candidatesWithLeads,
    lead_only_candidates: leadOnlyCandidates,
  };
}

export function countRecordsByModule(records: Array<{ module: string }>): {
  Contacts: number;
  Leads: number;
  Deals: number;
} {
  return {
    Contacts: records.filter((item) => item.module === "Contacts").length,
    Leads: records.filter((item) => item.module === "Leads").length,
    Deals: records.filter((item) => item.module === "Deals").length,
  };
}
