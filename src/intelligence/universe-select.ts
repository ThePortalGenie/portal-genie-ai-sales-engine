import type { OrganisationCluster, UniverseRecord } from "../domain/commercial-watch.js";
import { DEFAULT_COMMAND_CENTRE_THRESHOLDS } from "../domain/commercial-watch.js";
import { classifyDealProduct } from "./org-graph.js";
import { daysBetweenCalendar } from "./calendar-date.js";

/**
 * Stage 2 / Command Centre sample selection.
 *
 * Does NOT prefer organisations that already have stored analysis.
 * Tags come only from CRM listing evidence (module, Deal stage/name, recency).
 * Quotas are filled rarest-first, then remaining slots by last activity.
 * Tie-break: lastActivityAt descending, then organisation_id.
 */
export const COMMAND_CENTRE_SELECTION_METHOD =
  "Deterministic stratified sample from listing evidence. Does not prefer cached analyses. Quotas: Nagging Panda, Closed Lost, Closed Won, possible-match, multi-contact, Lead, quiet, incomplete CRM, live Deal, Portal Genie, Contact; remaining slots by recency. Cap applied last.";

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
  { tag: "lead", min: 2 },
  { tag: "quiet", min: 2 },
  { tag: "incomplete", min: 2 },
  { tag: "live_deal", min: 3 },
  { tag: "portal_genie", min: 3 },
  { tag: "contact", min: 4 },
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

export function listingTagsForCluster(
  cluster: OrganisationCluster,
  asOf = new Date().toISOString(),
  timeZone = DEFAULT_COMMAND_CENTRE_THRESHOLDS.timeZone,
): OrganisationListingTag[] {
  const tags = new Set<OrganisationListingTag>();
  const contacts = cluster.records.filter((item) => item.module === "Contacts");
  const leads = cluster.records.filter((item) => item.module === "Leads");
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

/**
 * Select a commercially mixed sample without using stored-analysis presence.
 */
export function selectOrganisationsForCommandCentre(
  clusters: OrganisationCluster[],
  maxOrganisations?: number,
  asOf = new Date().toISOString(),
): OrganisationCluster[] {
  if (!maxOrganisations || clusters.length <= maxOrganisations) return [...clusters].sort(byRecencyThenId);
  const sorted = [...clusters].sort(byRecencyThenId);
  const picked = new Set<string>();
  const counts: Record<string, number> = {};
  const take = (cluster: OrganisationCluster) => {
    if (picked.has(cluster.organisationId) || picked.size >= maxOrganisations) return;
    picked.add(cluster.organisationId);
    for (const tag of listingTagsForCluster(cluster, asOf)) {
      counts[tag] = (counts[tag] ?? 0) + 1;
    }
  };

  for (const quota of QUOTAS) {
    const pool =
      quota.tag === "quiet"
        ? [...sorted].reverse()
        : sorted;
    for (const cluster of pool) {
      if (picked.size >= maxOrganisations) break;
      if ((counts[quota.tag] ?? 0) >= quota.min) break;
      if (picked.has(cluster.organisationId)) continue;
      if (!listingTagsForCluster(cluster, asOf).includes(quota.tag)) continue;
      take(cluster);
    }
  }

  for (const cluster of sorted) {
    if (picked.size >= maxOrganisations) break;
    take(cluster);
  }

  return sorted.filter((item) => picked.has(item.organisationId)).slice(0, maxOrganisations);
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
