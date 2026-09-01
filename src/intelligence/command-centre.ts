import { randomUUID } from "node:crypto";
import type { ZohoCrmReader } from "../integrations/zoho/client.js";
import type {
  CommandCentreThresholds,
  CommercialWatchItem,
  OrganisationCluster,
  PortfolioFailure,
  PortfolioSnapshot,
  ScanEstimate,
  UniverseRecord,
} from "../domain/commercial-watch.js";
import { DEFAULT_COMMAND_CENTRE_THRESHOLDS } from "../domain/commercial-watch.js";
import type { StoredAnalysis } from "./analysis-store.js";
import { analysisRootsForCluster, findStoredAnalysisForRecords, writeStoredAnalysis } from "./analysis-store.js";
import { listSalesEvents } from "./sales-event-store.js";
import { loadUsageImportMeta, usageImportIsOperational } from "./usage-match.js";
import { clusterFingerprint } from "./evidence-fingerprint.js";
import { groupUniverseRecords } from "./universe-group.js";
import { discoverUniverse } from "./universe-discovery.js";
import { watchItemsFromAnalysis } from "./watch-from-analysis.js";
import { sortWatchItems, PRIORITY_TIEBREAK } from "./priority-rank.js";
import { deterministicDailyBrief, maybeSynthesizeBrief } from "./daily-brief.js";
import {
  decisionContextSnapshotFromWatchItem,
  recommendationFingerprintFromWatchItem,
} from "../domain/operator-decision.js";
import { writeLastScan, writePortfolioSnapshot } from "./portfolio-store.js";
import { usageImportIsNewerThan } from "./usage-match.js";
import {
  COMMAND_CENTRE_SELECTION_METHOD,
  candidateAuditForSelection,
  computeUniverseAuditStats,
  countRecordsByModule,
  listingTagsForCluster,
  selectOrganisationsForCommandCentre,
  rankClustersForCandidateSelection,
} from "./universe-select.js";
import { isFirstPartyOrganisation } from "../config/first-party-domains.js";
import { loadFirstPartyDomains } from "../config/first-party-domains.js";
import {
  applyOperatorControlToWatchItems,
  isEffectivelyCustomerExecutable,
  type WatchItemEvidenceContext,
} from "./watch-item-control.js";

export type AnalyseFn = (moduleName: string, recordId: string) => Promise<StoredAnalysis>;

export type CommandCentreDeps = {
  client: ZohoCrmReader;
  publicDomains: Set<string>;
  firstPartyDomains?: Set<string>;
  thresholds?: CommandCentreThresholds;
  analyse: AnalyseFn;
  synthesizer?: (prompt: string) => Promise<{ text: string; inputTokens?: number; outputTokens?: number }>;
  now?: () => Date;
};

function salesStamp(organisationId: string, contactIds: string[]): string {
  return listSalesEvents({ organisationIds: [organisationId], contactIds })
    .map((event) => `${event.id}:${event.updated_at ?? event.created_at}:${event.occurred_at}:${event.follow_up_date ?? ""}`)
    .sort()
    .join(",");
}

export function fingerprintForCluster(cluster: OrganisationCluster, usageImportedAt?: string): string {
  const contactIds = cluster.records.filter((item) => item.module !== "Deals").map((item) => item.recordId);
  return clusterFingerprint({
    organisationId: cluster.organisationId,
    recordKeys: cluster.records.map((item) => `${item.module}:${item.recordId}:${item.modifiedAt ?? ""}:${item.stage ?? ""}`),
    lastModifiedAt: cluster.lastModifiedAt,
    lastActivityAt: cluster.lastActivityAt,
    salesEventStamp: salesStamp(cluster.organisationId, contactIds),
    usageImportedAt,
  });
}

export function reuseDecision(
  cluster: OrganisationCluster,
  fingerprint: string,
  usageImportedAt?: string,
): { stored?: StoredAnalysis; reuse: "reuse" | "refresh" | "missing"; reason: string } {
  const stored = findStoredAnalysisForRecords(analysisRootsForCluster(cluster));
  if (!stored?.success || !stored.profile) {
    return { stored, reuse: "missing", reason: "No successful stored organisation analysis." };
  }
  if (stored.evidenceFingerprint && stored.evidenceFingerprint === fingerprint) {
    return { stored, reuse: "reuse", reason: "Evidence fingerprint unchanged." };
  }
  if (usageImportIsNewerThan(stored.analysedAt, usageImportedAt)) {
    return { stored, reuse: "refresh", reason: "Portal Genie usage import is newer than the stored analysis." };
  }
  const events = listSalesEvents({
    organisationIds: [cluster.organisationId],
    contactIds: cluster.records.map((item) => item.recordId),
  });
  if (events.some((event) => Date.parse(event.updated_at ?? event.created_at) > Date.parse(stored.analysedAt))) {
    return { stored, reuse: "refresh", reason: "An operator Sales Event was recorded after the stored analysis." };
  }
  if (cluster.lastModifiedAt && Date.parse(cluster.lastModifiedAt) > Date.parse(stored.analysedAt)) {
    return { stored, reuse: "refresh", reason: "CRM listing Modified_Time is newer than the stored analysis." };
  }
  if (stored.evidenceFingerprint && stored.evidenceFingerprint !== fingerprint) {
    return { stored, reuse: "refresh", reason: "Evidence fingerprint changed." };
  }
  return { stored, reuse: "reuse", reason: "Legacy analysis is still current (no newer listing, usage import, or Sales Event)." };
}

/** Selected candidates still lacking a usable completed stored analysis. */
export function countScanCandidatesAwaitingAnalysis(
  organisations: Array<{ reuse: "reuse" | "refresh" | "missing" }>,
): number {
  return organisations.filter((item) => item.reuse !== "reuse").length;
}

/** Cumulative awaiting count after a build: selected minus successfully analysed orgs. */
export function countBuildCandidatesAwaitingAnalysis(candidatesSelected: number, organisationsAnalysed: number): number {
  return Math.max(0, candidatesSelected - organisationsAnalysed);
}

function candidateLimitReason(
  selectedCount: number,
  universeSize: number,
  capacity: number | undefined,
): string | undefined {
  const cap = capacity ?? selectedCount;
  if (universeSize > selectedCount || cap > selectedCount) {
    return `${selectedCount} of ${universeSize} discovered organisations selected for commercial analysis (capacity ${cap}).`;
  }
  return undefined;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index]!, index);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: items.length ? n : 0 }, () => worker()));
  return out;
}

function resolveMaxOrganisations(thresholds: CommandCentreThresholds, maxOrganisations?: number): number | undefined {
  return maxOrganisations ?? thresholds.maxCandidateOrganisations;
}

function organisationIdsInSnapshot(snapshot: PortfolioSnapshot): Set<string> {
  return new Set(snapshot.watch_items.map((item) => item.organisation_id));
}

type ClusterBuildResult = {
  watchItems: ReturnType<typeof watchItemsFromAnalysis>;
  failures: PortfolioFailure[];
  reused: number;
  refreshed: number;
  failed: number;
  openaiCalls: number;
  inputTokens: number;
  outputTokens: number;
  firstParty?: NonNullable<PortfolioSnapshot["first_party_organisations"]>[number];
  evidence: WatchItemEvidenceContext;
};

async function buildWatchItemsForCluster(
  deps: CommandCentreDeps,
  cluster: OrganisationCluster,
  options: {
    asOf: string;
    thresholds: CommandCentreThresholds;
    usageImportedAt?: string;
    mode: "build_changed" | "full_rebuild" | "selected" | "refresh_backfill";
    firstPartyDomains: Set<string>;
    publicDomains: Set<string>;
  },
): Promise<ClusterBuildResult> {
  const { asOf, thresholds, usageImportedAt, mode, firstPartyDomains, publicDomains } = options;
  const fingerprint = fingerprintForCluster(cluster, usageImportedAt);
  const dealStages = Object.fromEntries(
    cluster.records
      .filter((item) => item.module === "Deals" && item.stage)
      .map((item) => [item.recordId, item.stage as string]),
  );
  const evidence: WatchItemEvidenceContext = {
    evidence_fingerprint: fingerprint,
    sales_events: listSalesEvents({
      organisationIds: [cluster.organisationId],
      contactIds: cluster.records.filter((item) => item.module !== "Deals").map((item) => item.recordId),
    }),
    deal_stages: dealStages,
    retrieval_ok: cluster.records.every((item) => item.retrieval !== "ERROR" && item.retrieval !== "UNAVAILABLE"),
  };
  const decision = reuseDecision(cluster, fingerprint, usageImportedAt);
  const firstParty = isFirstPartyOrganisation(cluster, firstPartyDomains, publicDomains);
  const failures: PortfolioFailure[] = [];
  let reused = 0;
  let refreshed = 0;
  let failed = 0;
  let openaiCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  const mustRefresh = mode === "full_rebuild" || decision.reuse !== "reuse";
  let analysis = decision.stored;
  let reuse: "reused" | "refreshed" | "failed" | "insufficient" = "reused";
  if (mustRefresh) {
    try {
      analysis = await deps.analyse(cluster.representative.module, cluster.representative.recordId);
      openaiCalls += 1;
      inputTokens += analysis.usage.inputTokens ?? 0;
      outputTokens += analysis.usage.outputTokens ?? 0;
      writeStoredAnalysis({ ...analysis, evidenceFingerprint: fingerprint });
      reuse = analysis.success ? "refreshed" : "failed";
      if (!analysis.success) {
        failed += 1;
        failures.push({
          organisation_id: cluster.organisationId,
          organisation_name: cluster.organisationName,
          stage: "openai",
          state: "ERROR",
          message: analysis.error ?? "Analysis failed.",
        });
      } else refreshed += 1;
    } catch (error) {
      failed += 1;
      reuse = "failed";
      failures.push({
        organisation_id: cluster.organisationId,
        organisation_name: cluster.organisationName,
        stage: error instanceof Error && /zoho|crm|HTTP/i.test(error.message) ? "analysis" : "openai",
        state: "ERROR",
        message: error instanceof Error ? error.message : "Organisation analysis failed.",
      });
      analysis = decision.stored;
    }
  } else {
    reused += 1;
  }

  const firstPartyEntry = firstParty
    ? {
        organisation_id: cluster.organisationId,
        organisation_name: cluster.organisationName,
        domains: cluster.domains,
        analysis_stored: decision.reuse === "reuse" || Boolean(decision.stored?.success),
        note: "Internal first-party organisation. Evidence preserved; excluded from external customer queue.",
      }
    : undefined;

  if (!analysis?.profile) {
    return {
      watchItems: [],
      failures,
      reused,
      refreshed,
      failed,
      openaiCalls,
      inputTokens,
      outputTokens,
      firstParty: firstPartyEntry,
      evidence,
    };
  }

  const watchItems = watchItemsFromAnalysis(analysis, {
    asOf,
    organisationId: cluster.organisationId,
    organisationName: cluster.organisationName,
    thresholds,
    reuse,
    possibleMatchReview: cluster.possibleMatchReviews.length > 0,
    usageDatasetAvailable: usageImportIsOperational(),
    listingDeals: cluster.records.filter((item) => item.module === "Deals"),
    customerQueue: !firstParty,
  });

  return {
    watchItems,
    failures,
    reused,
    refreshed,
    failed,
    openaiCalls,
    inputTokens,
    outputTokens,
    firstParty: firstPartyEntry,
    evidence,
  };
}

/** Max active-work vacancies to try filling on one refresh-control. */
export const BACKFILL_MAX_VACANCIES_PER_REFRESH = 10;
/** Max ranked unaudited organisations examined while filling one vacancy. */
export const BACKFILL_MAX_ORGANISATIONS_EXAMINED_PER_VACANCY = 5;
/** Max fresh OpenAI organisation analyses during one backfill refresh. */
export const BACKFILL_MAX_FRESH_ORGANISATION_ANALYSES_PER_REFRESH = 1;

export function isWorthwhileBackfillReplacement(items: CommercialWatchItem[]): boolean {
  return items.some((item) => {
    if (item.priority === "P5") return false;
    if (item.next_best_action === "NO_ACTION" && item.action_timing === "NO_ACTION_REQUIRED") return false;
    if (item.actionability_kind === "NO_ACTION") return false;
    if (item.customer_queue === false) return false;
    return true;
  });
}

function partitionClustersForBuild(
  clusters: OrganisationCluster[],
  mode: "build_changed" | "full_rebuild" | "selected",
  thresholds: CommandCentreThresholds,
  usageImportedAt?: string,
  asOf?: string,
): {
  process: OrganisationCluster[];
  deferred: number;
  reusable: number;
  freshRefresh: number;
  freshInitial: number;
} {
  if (mode === "full_rebuild") {
    return { process: clusters, deferred: 0, reusable: 0, freshRefresh: clusters.length, freshInitial: 0 };
  }

  const reusable: OrganisationCluster[] = [];
  const needsRefresh: OrganisationCluster[] = [];
  const neverAnalysed: OrganisationCluster[] = [];
  for (const cluster of clusters) {
    const fingerprint = fingerprintForCluster(cluster, usageImportedAt);
    const decision = reuseDecision(cluster, fingerprint, usageImportedAt);
    if (decision.reuse === "reuse") reusable.push(cluster);
    else if (decision.reuse === "missing") neverAnalysed.push(cluster);
    else needsRefresh.push(cluster);
  }

  if (mode === "selected") {
    return {
      process: [...reusable, ...needsRefresh, ...neverAnalysed],
      deferred: 0,
      reusable: reusable.length,
      freshRefresh: needsRefresh.length,
      freshInitial: neverAnalysed.length,
    };
  }

  const freshCap = thresholds.maxFreshOrganisationAnalysesPerBuild;
  const refreshBatch = needsRefresh.slice(0, freshCap);
  const remainingFresh = Math.max(0, freshCap - refreshBatch.length);
  const rankedNever = rankClustersForCandidateSelection(
    neverAnalysed,
    asOf ?? new Date().toISOString(),
    thresholds.timeZone,
  );
  const initialBatch = rankedNever.slice(0, remainingFresh);
  return {
    process: [...reusable, ...refreshBatch, ...initialBatch],
    deferred: needsRefresh.length - refreshBatch.length + (neverAnalysed.length - initialBatch.length),
    reusable: reusable.length,
    freshRefresh: refreshBatch.length,
    freshInitial: initialBatch.length,
  };
}

function selectClusters(
  clusters: OrganisationCluster[],
  maxOrganisations?: number,
  asOf?: string,
  timeZone?: string,
): OrganisationCluster[] {
  return selectOrganisationsForCommandCentre(clusters, maxOrganisations, asOf, timeZone);
}

export async function scanCommandCentre(
  deps: CommandCentreDeps,
  options: { maxOrganisations?: number; persist?: boolean; organisationIds?: string[] } = {},
): Promise<ScanEstimate> {
  const thresholds = deps.thresholds ?? DEFAULT_COMMAND_CENTRE_THRESHOLDS;
  const firstPartyDomains = deps.firstPartyDomains ?? loadFirstPartyDomains();
  const asOf = (deps.now ?? (() => new Date()))().toISOString();
  const usageImportedAt = loadUsageImportMeta().importedAt;
  const maxOrganisations = resolveMaxOrganisations(thresholds, options.maxOrganisations);
  const discovered = await discoverUniverse(deps.client, { maxRecordsPerModule: thresholds.maxRecordsPerModule });
  const clusters = groupUniverseRecords(discovered.records, deps.publicDomains);
  const universeAudit = computeUniverseAuditStats(clusters, discovered.records);
  const selected = options.organisationIds?.length
    ? clusters.filter((item) => options.organisationIds!.includes(item.organisationId))
    : selectClusters(clusters, maxOrganisations, asOf, thresholds.timeZone);
  const candidateAudit = candidateAuditForSelection(selected);
  const buildProjection = partitionClustersForBuild(selected, "build_changed", thresholds, usageImportedAt, asOf);
  const candidatesAwaitingAnalysis = countScanCandidatesAwaitingAnalysis(
    selected.map((cluster) => {
      const fingerprint = fingerprintForCluster(cluster, usageImportedAt);
      return reuseDecision(cluster, fingerprint, usageImportedAt);
    }),
  );
  const organisations = selected.map((cluster) => {
    const fingerprint = fingerprintForCluster(cluster, usageImportedAt);
    const decision = reuseDecision(cluster, fingerprint, usageImportedAt);
    const firstParty = isFirstPartyOrganisation(cluster, firstPartyDomains, deps.publicDomains);
    return {
      organisation_id: cluster.organisationId,
      organisation_name: cluster.organisationName,
      representative: cluster.representative,
      reuse: decision.reuse,
      reuse_reason: decision.reason,
      fingerprint,
      contact_count: cluster.records.filter((item) => item.module === "Contacts").length,
      lead_count: cluster.records.filter((item) => item.module === "Leads").length,
      deal_count: cluster.records.filter((item) => item.module === "Deals").length,
      possible_match_reviews: cluster.possibleMatchReviews.length,
      listing_tags: listingTagsForCluster(cluster, asOf, thresholds.timeZone),
      first_party: firstParty,
    };
  });
  const estimate: ScanEstimate = {
    generated_at: asOf,
    organisations_discovered: clusters.length,
    organisations_selected: selected.length,
    universe_size: clusters.length,
    candidate_capacity: maxOrganisations,
    candidates_awaiting_analysis: candidatesAwaitingAnalysis,
    records_by_module: countRecordsByModule(discovered.records),
    universe_audit: universeAudit,
    candidate_audit: {
      ...candidateAudit,
      max_candidate_organisations: maxOrganisations ?? clusters.length,
    },
    build_projection: {
      would_analyse: buildProjection.process.length,
      would_reuse: buildProjection.reusable,
      would_fresh_analyse: buildProjection.freshRefresh + buildProjection.freshInitial,
      would_defer: buildProjection.deferred,
    },
    selection_method: COMMAND_CENTRE_SELECTION_METHOD,
    analyses_reusable: organisations.filter((item) => item.reuse === "reuse").length,
    analyses_require_refresh: organisations.filter((item) => item.reuse !== "reuse").length,
    retrieval_warnings: discovered.failures.map((item) => item.message),
    truncated: discovered.truncated || selected.length < universeAudit.reconstructed_organisations,
    truncated_reason:
      discovered.truncated
        ? `Module listing capped at ${thresholds.maxRecordsPerModule} records.`
        : candidateLimitReason(selected.length, clusters.length, maxOrganisations),
    organisations,
    first_party_organisations: organisations
      .filter((item) => item.first_party)
      .map((item) => {
        const cluster = selected.find((candidate) => candidate.organisationId === item.organisation_id)!;
        return {
          organisation_id: item.organisation_id,
          organisation_name: item.organisation_name,
          domains: cluster.domains,
          analysis_stored: item.reuse === "reuse",
          note: "Internal first-party organisation. Evidence preserved; excluded from external customer queue.",
        };
      }),
    tokens: { openai_calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    openai_would_be_called: buildProjection.freshRefresh + buildProjection.freshInitial,
  };
  if (options.persist !== false) writeLastScan(estimate);
  return estimate;
}

export async function buildCommandCentre(
  deps: CommandCentreDeps,
  options: {
    mode: "build_changed" | "full_rebuild" | "selected";
    maxOrganisations?: number;
    organisationIds?: string[];
    confirm: boolean;
    includeBriefSynthesis?: boolean;
  },
): Promise<PortfolioSnapshot> {
  if (!options.confirm) {
    throw new Error("Build Command Centre requires explicit operator confirmation.");
  }
  const started = Date.now();
  const thresholds = deps.thresholds ?? DEFAULT_COMMAND_CENTRE_THRESHOLDS;
  const firstPartyDomains = deps.firstPartyDomains ?? loadFirstPartyDomains();
  const asOf = (deps.now ?? (() => new Date()))().toISOString();
  const usageImportedAt = loadUsageImportMeta().importedAt;
  const maxOrganisations = resolveMaxOrganisations(thresholds, options.maxOrganisations);
  const discovered = await discoverUniverse(deps.client, { maxRecordsPerModule: thresholds.maxRecordsPerModule });
  const universe = groupUniverseRecords(discovered.records, deps.publicDomains);
  let clusters = universe;
  if (options.organisationIds?.length) {
    const wanted = new Set(options.organisationIds);
    clusters = clusters.filter((item) => wanted.has(item.organisationId));
  } else {
    clusters = selectClusters(clusters, maxOrganisations, asOf, thresholds.timeZone);
  }
  if (maxOrganisations && clusters.length > maxOrganisations) {
    throw new Error(
      `Command Centre refused to analyse ${clusters.length} organisations; max is ${maxOrganisations}.`,
    );
  }

  const { process: clustersToProcess, deferred: analysesDeferred } = partitionClustersForBuild(
    clusters,
    options.mode,
    thresholds,
    usageImportedAt,
    asOf,
  );

  const failures: PortfolioFailure[] = [...discovered.failures];
  let reused = 0;
  let refreshed = 0;
  let failed = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let openaiCalls = 0;

  const firstPartyTracked: NonNullable<PortfolioSnapshot["first_party_organisations"]> = [];
  const evidenceByOrganisation = new Map<string, WatchItemEvidenceContext>();

  const built = await mapLimit(clustersToProcess, thresholds.analyseConcurrency, async (cluster) => {
    const result = await buildWatchItemsForCluster(deps, cluster, {
      asOf,
      thresholds,
      usageImportedAt,
      mode: options.mode,
      firstPartyDomains,
      publicDomains: deps.publicDomains,
    });
    evidenceByOrganisation.set(cluster.organisationId, result.evidence);
    if (result.firstParty) firstPartyTracked.push(result.firstParty);
    failures.push(...result.failures);
    reused += result.reused;
    refreshed += result.refreshed;
    failed += result.failed;
    openaiCalls += result.openaiCalls;
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;
    return result.watchItems;
  });

  const sorted = sortWatchItems(built.flat());
  const enriched = enrichWatchItemsForOperatorControl(sorted, evidenceByOrganisation);
  const items = applyOperatorControlToWatchItems(enriched, { asOf, evidenceByOrganisation });
  let brief = deterministicDailyBrief(items, failures, asOf);
  if (options.includeBriefSynthesis !== false && deps.synthesizer) {
    const synthesized = await maybeSynthesizeBrief(brief, deps.synthesizer);
    brief = synthesized.brief;
    openaiCalls += synthesized.tokens.calls;
    inputTokens += synthesized.tokens.input;
    outputTokens += synthesized.tokens.output;
  }

  const organisationsAnalysed = new Set(items.map((item) => item.organisation_id)).size;
  const candidatesAwaitingAnalysis = countBuildCandidatesAwaitingAnalysis(clusters.length, organisationsAnalysed);

  const snapshot: PortfolioSnapshot = {
    generated_at: asOf,
    run_id: `cc-${randomUUID()}`,
    duration_ms: Date.now() - started,
    mode: options.mode,
    organisations_discovered: organisationsAnalysed,
    universe_size: universe.length,
    candidate_capacity: maxOrganisations,
    candidates_selected: clusters.length,
    organisations_analysed: organisationsAnalysed,
    candidates_awaiting_analysis: candidatesAwaitingAnalysis,
    watch_items: items,
    ranking_note: PRIORITY_TIEBREAK,
    stalled_count: items.filter((item) => item.stalled_state === "STALLED").length,
    waiting_count: items.filter(
      (item) =>
        item.executability === "WAITING_FOR_TIME" ||
        item.executability === "WAITING_FOR_CUSTOMER" ||
        item.executability === "DATA_REQUIRED" ||
        item.priority === "P4" ||
        item.next_best_action === "WAIT",
    ).length,
    needs_action_today: items.filter((item) => isEffectivelyCustomerExecutable(item)).length,
    active_opportunities: items.filter((item) => item.opportunity_signals.some((signal) => signal.code === "LIVE_DEAL_PRESENT")).length,
    brief,
    failures,
    tokens: {
      openai_calls: openaiCalls,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
    analyses_reused: reused,
    analyses_refreshed: refreshed,
    analyses_failed: failed,
    analyses_deferred: analysesDeferred > 0 ? analysesDeferred : undefined,
    first_party_organisations: firstPartyTracked.length ? firstPartyTracked : undefined,
    truncated: discovered.truncated || clusters.length < universe.length || analysesDeferred > 0,
    truncated_reason:
      analysesDeferred > 0
        ? `Progressive analysis: ${organisationsAnalysed} of ${clusters.length} selected candidates analysed; ${candidatesAwaitingAnalysis} awaiting analysis (${analysesDeferred} deferred this build; max ${thresholds.maxFreshOrganisationAnalysesPerBuild} fresh per build).`
        : candidateLimitReason(clusters.length, universe.length, maxOrganisations) ??
          (discovered.truncated ? `Module listing capped at ${thresholds.maxRecordsPerModule} records.` : undefined),
  };
  writePortfolioSnapshot(snapshot);
  return snapshot;
}

export async function refreshSnapshotWithBackfill(
  deps: CommandCentreDeps,
  snapshot: PortfolioSnapshot,
): Promise<{ snapshot: PortfolioSnapshot; openaiCalls: number }> {
  const thresholds = deps.thresholds ?? DEFAULT_COMMAND_CENTRE_THRESHOLDS;
  const firstPartyDomains = deps.firstPartyDomains ?? loadFirstPartyDomains();
  const asOf = (deps.now ?? (() => new Date()))().toISOString();
  const usageImportedAt = loadUsageImportMeta().importedAt;
  const maxCandidates = thresholds.maxCandidateOrganisations;

  const beforeActive = snapshot.watch_items.filter((item) => isEffectivelyCustomerExecutable(item)).length;
  let refreshed = refreshSnapshotOperatorControl(snapshot, asOf);
  const afterActive = refreshed.watch_items.filter((item) => isEffectivelyCustomerExecutable(item)).length;
  const presentOrgIds = organisationIdsInSnapshot(refreshed);

  let openaiCalls = 0;
  let inputTokens = refreshed.tokens.input_tokens;
  let outputTokens = refreshed.tokens.output_tokens;
  let reused = refreshed.analyses_reused;
  let refreshedCount = refreshed.analyses_refreshed;
  let failed = refreshed.analyses_failed;
  const failures = [...refreshed.failures];
  const firstPartyTracked = [...(refreshed.first_party_organisations ?? [])];
  const evidenceByOrganisation = new Map<string, WatchItemEvidenceContext>();

  for (const item of refreshed.watch_items) {
    if (!evidenceByOrganisation.has(item.organisation_id)) {
      evidenceByOrganisation.set(item.organisation_id, {
        evidence_fingerprint: item.evidence_snapshot_ref,
        sales_events: listSalesEvents({
          organisationIds: [item.organisation_id],
          contactIds: item.contact_ids,
        }),
        retrieval_ok: true,
      });
    }
  }

  const capacityFreed = afterActive < beforeActive;
  const candidateRoom = presentOrgIds.size < maxCandidates;
  const universeHasCandidates =
    snapshot.universe_size !== undefined && snapshot.universe_size > presentOrgIds.size;
  if (!capacityFreed || !candidateRoom || !universeHasCandidates) {
    return { snapshot: refreshed, openaiCalls: 0 };
  }

  const discovered = await discoverUniverse(deps.client, { maxRecordsPerModule: thresholds.maxRecordsPerModule });
  const universe = groupUniverseRecords(discovered.records, deps.publicDomains);
  const vacanciesToFill = Math.min(
    Math.max(0, beforeActive - afterActive),
    BACKFILL_MAX_VACANCIES_PER_REFRESH,
  );
  const maxOrgsToExamine = vacanciesToFill * BACKFILL_MAX_ORGANISATIONS_EXAMINED_PER_VACANCY;
  const rankedCandidates = rankClustersForCandidateSelection(universe, asOf, thresholds.timeZone);
  const workingPresentIds = new Set(presentOrgIds);

  let vacanciesFilled = 0;
  let orgsExamined = 0;
  let backfillFreshBudget = BACKFILL_MAX_FRESH_ORGANISATION_ANALYSES_PER_REFRESH;
  const backfillItems: ReturnType<typeof watchItemsFromAnalysis> = [];

  for (const cluster of rankedCandidates) {
    if (vacanciesFilled >= vacanciesToFill || orgsExamined >= maxOrgsToExamine) break;
    if (workingPresentIds.has(cluster.organisationId)) continue;
    if (workingPresentIds.size >= maxCandidates) break;

    const fingerprint = fingerprintForCluster(cluster, usageImportedAt);
    const decision = reuseDecision(cluster, fingerprint, usageImportedAt);
    if (decision.reuse !== "reuse" && backfillFreshBudget <= 0) continue;

    orgsExamined += 1;
    workingPresentIds.add(cluster.organisationId);

    const result = await buildWatchItemsForCluster(deps, cluster, {
      asOf,
      thresholds,
      usageImportedAt,
      mode: "refresh_backfill",
      firstPartyDomains,
      publicDomains: deps.publicDomains,
    });
    evidenceByOrganisation.set(cluster.organisationId, result.evidence);
    if (result.firstParty) firstPartyTracked.push(result.firstParty);
    failures.push(...result.failures);
    reused += result.reused;
    refreshedCount += result.refreshed;
    failed += result.failed;
    openaiCalls += result.openaiCalls;
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;
    if (result.openaiCalls > 0) backfillFreshBudget -= result.openaiCalls;
    backfillItems.push(...result.watchItems);

    const controlledNew = applyOperatorControlToWatchItems(
      enrichWatchItemsForOperatorControl(sortWatchItems(result.watchItems), evidenceByOrganisation),
      { asOf, evidenceByOrganisation },
    );
    if (isWorthwhileBackfillReplacement(controlledNew)) {
      vacanciesFilled += 1;
    }
  }

  if (!backfillItems.length) {
    return { snapshot: refreshed, openaiCalls };
  }

  const mergedRaw = [...refreshed.watch_items, ...backfillItems];
  const sorted = sortWatchItems(mergedRaw);
  const enriched = enrichWatchItemsForOperatorControl(sorted, evidenceByOrganisation);
  const items = applyOperatorControlToWatchItems(enriched, { asOf, evidenceByOrganisation });
  const brief = deterministicDailyBrief(items, failures, asOf);

  const nextSnapshot: PortfolioSnapshot = {
    ...refreshed,
    generated_at: asOf,
    mode: "refresh_backfill",
    universe_size: universe.length,
    organisations_discovered: new Set(items.map((item) => item.organisation_id)).size,
    watch_items: items,
    brief,
    failures,
    needs_action_today: items.filter((item) => isEffectivelyCustomerExecutable(item)).length,
    waiting_count: items.filter(
      (item) =>
        item.effective_queue_state === "WAIT" ||
        item.executability === "WAITING_FOR_TIME" ||
        item.executability === "WAITING_FOR_CUSTOMER" ||
        item.executability === "DATA_REQUIRED" ||
        item.priority === "P4" ||
        item.next_best_action === "WAIT",
    ).length,
    stalled_count: items.filter((item) => item.stalled_state === "STALLED").length,
    active_opportunities: items.filter((item) =>
      item.opportunity_signals.some((signal) => signal.code === "LIVE_DEAL_PRESENT"),
    ).length,
    analyses_reused: reused,
    analyses_refreshed: refreshedCount,
    analyses_failed: failed,
    first_party_organisations: firstPartyTracked.length ? firstPartyTracked : undefined,
    tokens: {
      openai_calls: refreshed.tokens.openai_calls + openaiCalls,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };

  return { snapshot: nextSnapshot, openaiCalls };
}

export function refreshSnapshotOperatorControl(
  snapshot: PortfolioSnapshot,
  asOf?: string,
): PortfolioSnapshot {
  const now = asOf ?? new Date().toISOString();
  const evidenceByOrganisation = new Map<string, WatchItemEvidenceContext>();
  for (const item of snapshot.watch_items) {
    if (!evidenceByOrganisation.has(item.organisation_id)) {
      evidenceByOrganisation.set(item.organisation_id, {
        evidence_fingerprint: item.evidence_snapshot_ref,
        sales_events: listSalesEvents({
          organisationIds: [item.organisation_id],
          contactIds: item.contact_ids,
        }),
        retrieval_ok: true,
      });
    }
  }
  const resetItems = snapshot.watch_items.map((item) => ({
    ...item,
    customer_queue: item.system_customer_queue ?? item.customer_queue,
    operator_control: undefined,
    effective_queue_state: undefined,
  }));
  const items = applyOperatorControlToWatchItems(resetItems, { asOf: now, evidenceByOrganisation });
  const brief = deterministicDailyBrief(items, snapshot.failures, now);
  return {
    ...snapshot,
    generated_at: now,
    watch_items: items,
    brief,
    needs_action_today: items.filter((item) => isEffectivelyCustomerExecutable(item)).length,
    waiting_count: items.filter(
      (item) =>
        item.effective_queue_state === "WAIT" ||
        item.executability === "WAITING_FOR_TIME" ||
        item.executability === "WAITING_FOR_CUSTOMER" ||
        item.executability === "DATA_REQUIRED" ||
        item.priority === "P4" ||
        item.next_best_action === "WAIT",
    ).length,
    stalled_count: items.filter((item) => item.stalled_state === "STALLED").length,
    active_opportunities: items.filter((item) =>
      item.opportunity_signals.some((signal) => signal.code === "LIVE_DEAL_PRESENT"),
    ).length,
    tokens: { ...snapshot.tokens, openai_calls: snapshot.tokens.openai_calls },
  };
}

export function enrichWatchItemsForOperatorControl(
  items: ReturnType<typeof sortWatchItems>,
  evidenceByOrganisation: Map<string, WatchItemEvidenceContext>,
) {
  return items.map((item) => ({
    ...item,
    system_customer_queue: item.customer_queue,
    system_priority_band: item.priority,
    recommendation_fingerprint: recommendationFingerprintFromWatchItem(item),
    decision_context_snapshot: decisionContextSnapshotFromWatchItem(item),
    evidence_snapshot_ref: evidenceByOrganisation.get(item.organisation_id)?.evidence_fingerprint,
  }));
}

export function _testOnlyPartitionClustersForBuild(
  clusters: OrganisationCluster[],
  mode: "build_changed" | "full_rebuild" | "selected",
  thresholds: CommandCentreThresholds,
  usageImportedAt?: string,
  asOf?: string,
) {
  return partitionClustersForBuild(clusters, mode, thresholds, usageImportedAt, asOf);
}

export function _testOnlyGroup(records: UniverseRecord[], publicDomains: Set<string>): OrganisationCluster[] {
  return groupUniverseRecords(records, publicDomains);
}

export function _testOnlySelect(
  clusters: OrganisationCluster[],
  maxOrganisations?: number,
  asOf?: string,
): OrganisationCluster[] {
  return selectClusters(clusters, maxOrganisations, asOf);
}
