import { randomUUID } from "node:crypto";
import type { ZohoCrmReader } from "../integrations/zoho/client.js";
import type {
  CommandCentreThresholds,
  OrganisationCluster,
  PortfolioFailure,
  PortfolioSnapshot,
  ScanEstimate,
  UniverseRecord,
} from "../domain/commercial-watch.js";
import { DEFAULT_COMMAND_CENTRE_THRESHOLDS } from "../domain/commercial-watch.js";
import type { StoredAnalysis } from "./analysis-store.js";
import { findStoredAnalysisForRecords, writeStoredAnalysis } from "./analysis-store.js";
import { listSalesEvents } from "./sales-event-store.js";
import { loadUsageImportMeta, usageImportIsOperational } from "./usage-match.js";
import { clusterFingerprint } from "./evidence-fingerprint.js";
import { groupUniverseRecords } from "./universe-group.js";
import { discoverUniverse } from "./universe-discovery.js";
import { watchItemsFromAnalysis } from "./watch-from-analysis.js";
import { sortWatchItems, PRIORITY_TIEBREAK } from "./priority-rank.js";
import { deterministicDailyBrief, maybeSynthesizeBrief } from "./daily-brief.js";
import { writeLastScan, writePortfolioSnapshot } from "./portfolio-store.js";
import { usageImportIsNewerThan } from "./usage-match.js";
import {
  COMMAND_CENTRE_SELECTION_METHOD,
  countRecordsByModule,
  listingTagsForCluster,
  selectOrganisationsForCommandCentre,
} from "./universe-select.js";

export type AnalyseFn = (moduleName: string, recordId: string) => Promise<StoredAnalysis>;

export type CommandCentreDeps = {
  client: ZohoCrmReader;
  publicDomains: Set<string>;
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
  const stored = findStoredAnalysisForRecords(
    cluster.records
      .filter((item) => item.module === "Contacts" || item.module === "Leads")
      .map((item) => ({ module: item.module, recordId: item.recordId })),
  );
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

function selectClusters(
  clusters: OrganisationCluster[],
  maxOrganisations?: number,
  asOf?: string,
): OrganisationCluster[] {
  return selectOrganisationsForCommandCentre(clusters, maxOrganisations, asOf);
}

export async function scanCommandCentre(
  deps: CommandCentreDeps,
  options: { maxOrganisations?: number; persist?: boolean; organisationIds?: string[] } = {},
): Promise<ScanEstimate> {
  const thresholds = deps.thresholds ?? DEFAULT_COMMAND_CENTRE_THRESHOLDS;
  const asOf = (deps.now ?? (() => new Date()))().toISOString();
  const usageImportedAt = loadUsageImportMeta().importedAt;
  const discovered = await discoverUniverse(deps.client, { maxRecordsPerModule: thresholds.maxRecordsPerModule });
  const clusters = groupUniverseRecords(discovered.records, deps.publicDomains);
  const selected = options.organisationIds?.length
    ? clusters.filter((item) => options.organisationIds!.includes(item.organisationId))
    : selectClusters(clusters, options.maxOrganisations, asOf);
  const organisations = selected.map((cluster) => {
    const fingerprint = fingerprintForCluster(cluster, usageImportedAt);
    const decision = reuseDecision(cluster, fingerprint, usageImportedAt);
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
    };
  });
  const estimate: ScanEstimate = {
    generated_at: asOf,
    organisations_discovered: selected.length,
    organisations_selected: selected.length,
    universe_size: clusters.length,
    records_by_module: countRecordsByModule(discovered.records),
    selection_method: COMMAND_CENTRE_SELECTION_METHOD,
    analyses_reusable: organisations.filter((item) => item.reuse === "reuse").length,
    analyses_require_refresh: organisations.filter((item) => item.reuse !== "reuse").length,
    retrieval_warnings: discovered.failures.map((item) => item.message),
    truncated: discovered.truncated || Boolean(options.maxOrganisations && clusters.length > options.maxOrganisations),
    truncated_reason:
      options.maxOrganisations && clusters.length > options.maxOrganisations
        ? `Scan limited to ${options.maxOrganisations} organisations of ${clusters.length} discovered.`
        : discovered.truncated
          ? `Module listing capped at ${thresholds.maxRecordsPerModule} records.`
          : undefined,
    organisations,
    tokens: { openai_calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    openai_would_be_called: organisations.filter((item) => item.reuse !== "reuse").length,
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
  const asOf = (deps.now ?? (() => new Date()))().toISOString();
  const usageImportedAt = loadUsageImportMeta().importedAt;
  const discovered = await discoverUniverse(deps.client, { maxRecordsPerModule: thresholds.maxRecordsPerModule });
  const universe = groupUniverseRecords(discovered.records, deps.publicDomains);
  let clusters = universe;
  if (options.organisationIds?.length) {
    const wanted = new Set(options.organisationIds);
    clusters = clusters.filter((item) => wanted.has(item.organisationId));
  } else {
    clusters = selectClusters(clusters, options.maxOrganisations, asOf);
  }
  if (options.maxOrganisations && clusters.length > options.maxOrganisations) {
    throw new Error(
      `Command Centre refused to analyse ${clusters.length} organisations; max is ${options.maxOrganisations}.`,
    );
  }

  const failures: PortfolioFailure[] = [...discovered.failures];
  let reused = 0;
  let refreshed = 0;
  let failed = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let openaiCalls = 0;

  const built = await mapLimit(clusters, thresholds.analyseConcurrency, async (cluster) => {
    const fingerprint = fingerprintForCluster(cluster, usageImportedAt);
    const decision = reuseDecision(cluster, fingerprint, usageImportedAt);
    const mustRefresh = options.mode === "full_rebuild" || decision.reuse !== "reuse";
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
    if (!analysis?.profile) {
      return [];
    }
    return watchItemsFromAnalysis(analysis, {
      asOf,
      organisationId: cluster.organisationId,
      organisationName: cluster.organisationName,
      thresholds,
      reuse,
      possibleMatchReview: cluster.possibleMatchReviews.length > 0,
      usageDatasetAvailable: usageImportIsOperational(),
    });
  });

  const items = sortWatchItems(built.flat());
  let brief = deterministicDailyBrief(items, failures, asOf);
  if (options.includeBriefSynthesis !== false && deps.synthesizer) {
    const synthesized = await maybeSynthesizeBrief(brief, deps.synthesizer);
    brief = synthesized.brief;
    openaiCalls += synthesized.tokens.calls;
    inputTokens += synthesized.tokens.input;
    outputTokens += synthesized.tokens.output;
  }

  const snapshot: PortfolioSnapshot = {
    generated_at: asOf,
    run_id: `cc-${randomUUID()}`,
    duration_ms: Date.now() - started,
    mode: options.mode,
    organisations_discovered: clusters.length,
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
    needs_action_today: items.filter(
      (item) => (item.priority === "P0" || item.priority === "P1") && item.executability === "EXECUTABLE_NOW",
    ).length,
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
    truncated: discovered.truncated || clusters.length < universe.length,
    truncated_reason:
      clusters.length < universe.length
        ? `Build limited to ${clusters.length} organisations of ${universe.length} discovered.`
        : discovered.truncated
          ? `Module listing capped at ${thresholds.maxRecordsPerModule} records.`
          : undefined,
  };
  writePortfolioSnapshot(snapshot);
  return snapshot;
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
