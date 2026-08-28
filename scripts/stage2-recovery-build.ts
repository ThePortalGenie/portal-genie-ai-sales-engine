/**
 * Stage 2 recovery rebuild: SAME pinned 20 organisations. Cap 20.
 * Run only after retrieval verification succeeds.
 */
import { scanSalesCommandCentre, buildSalesCommandCentre } from "../src/services/command-centre-runtime.js";
import { STAGE2_ORGANISATION_IDS } from "./stage2-sample.js";

const MAX = 20;
const organisationIds = [...STAGE2_ORGANISATION_IDS];

process.stdout.write("--- PINNED SAMPLE SCAN (no OpenAI) ---\n");
const scan = await scanSalesCommandCentre({ maxOrganisations: MAX, organisationIds });
const selected = scan.organisations.length;
const wouldAnalyse = scan.openai_would_be_called;

process.stdout.write(
  `${JSON.stringify(
    {
      records_by_module: scan.records_by_module,
      universe_size: scan.universe_size,
      organisations_selected: selected,
      missing_from_universe: organisationIds.filter(
        (id) => !scan.organisations.some((item) => item.organisation_id === id),
      ),
      analyses_reusable: scan.analyses_reusable,
      analyses_require_refresh: scan.analyses_require_refresh,
      openai_would_be_called: wouldAnalyse,
      estimated_total_openai_calls: wouldAnalyse + 1,
      organisations: scan.organisations.map((item) => ({
        name: item.organisation_name,
        id: item.organisation_id,
        reuse: item.reuse,
        reuse_reason: item.reuse_reason,
        representative: item.representative,
        listing_tags: item.listing_tags,
      })),
    },
    null,
    2,
  )}\n`,
);

if (selected > MAX || wouldAnalyse > MAX) {
  process.stderr.write(`\nSTOP: would analyse ${selected} organisations (${wouldAnalyse} OpenAI org calls). Max is ${MAX}.\n`);
  process.exit(1);
}
if (selected !== organisationIds.length) {
  process.stderr.write(
    `\nSTOP: pinned sample expected ${organisationIds.length} organisations, scan found ${selected}.\n`,
  );
  process.exit(1);
}

process.stdout.write(`\n--- BUILD_CHANGED pinned ${MAX} ---\n`);
const snapshot = await buildSalesCommandCentre({
  mode: "build_changed",
  confirm: true,
  maxOrganisations: MAX,
  organisationIds,
  includeBriefSynthesis: true,
});

if (snapshot.organisations_discovered > MAX) {
  process.stderr.write(`\nSTOP: Build analysed ${snapshot.organisations_discovered} organisations.\n`);
  process.exit(1);
}

process.stdout.write("\n--- CACHE CHECK (scan only) ---\n");
const rescan = await scanSalesCommandCentre({ maxOrganisations: MAX, organisationIds });

process.stdout.write(
  `${JSON.stringify(
    {
      generated_at: snapshot.generated_at,
      duration_ms: snapshot.duration_ms,
      organisations_discovered: snapshot.organisations_discovered,
      analyses_reused: snapshot.analyses_reused,
      analyses_refreshed: snapshot.analyses_refreshed,
      analyses_failed: snapshot.analyses_failed,
      tokens: snapshot.tokens,
      needs_action_today: snapshot.needs_action_today,
      stalled_count: snapshot.stalled_count,
      waiting_count: snapshot.waiting_count,
      failures: snapshot.failures,
      brief: {
        mode: snapshot.brief.mode,
        today_at_a_glance: snapshot.brief.today_at_a_glance,
        narrative: snapshot.brief.narrative,
        do_first: snapshot.brief.do_first,
        follow_up_today: snapshot.brief.follow_up_today,
        stalled: snapshot.brief.stalled,
        wait: snapshot.brief.wait,
        reengage: snapshot.brief.reengage,
        warnings: snapshot.brief.warnings,
      },
      watch_items: snapshot.watch_items.map((item) => ({
        rank: item.rank,
        priority: item.priority,
        organisation_name: item.organisation_name,
        organisation_id: item.organisation_id,
        product_scope: item.product_scope,
        relationship_state: item.relationship_state,
        recommended_contact_name: item.recommended_contact_name,
        recommended_contact_reason: item.recommended_contact_reason,
        next_best_action: item.next_best_action,
        executability: item.executability,
        action_timing: item.action_timing,
        action_due_at: item.action_due_at,
        stalled_state: item.stalled_state,
        stalled_reasons: item.stalled_reasons,
        why_this_action: item.why_this_action,
        commercial_summary: item.commercial_summary,
        confidence: item.confidence,
        reuse: item.reuse,
        deal_ids: item.deal_ids,
        data_quality_signals: item.data_quality_signals.map((signal) => signal.code),
      })),
      cache_check: {
        organisations_selected: rescan.organisations.length,
        analyses_reusable: rescan.analyses_reusable,
        analyses_require_refresh: rescan.analyses_require_refresh,
        openai_would_be_called: rescan.openai_would_be_called,
        organisations: rescan.organisations.map((item) => ({
          name: item.organisation_name,
          reuse: item.reuse,
          reuse_reason: item.reuse_reason,
        })),
      },
    },
    null,
    2,
  )}\n`,
);
