/**
 * Stage 2 live validation only. MAXIMUM 20 organisations.
 * Do not use this for a full CRM rebuild.
 */
import { scanSalesCommandCentre, buildSalesCommandCentre } from "../src/services/command-centre-runtime.js";

const MAX = 20;

const scan = await scanSalesCommandCentre({ maxOrganisations: MAX });
const selected = scan.organisations.length;
const wouldAnalyse = scan.openai_would_be_called;

const scanReport = {
  scan: {
    records_by_module: scan.records_by_module,
    organisations_discovered_in_universe: scan.universe_size,
    organisations_selected: selected,
    analyses_reusable: scan.analyses_reusable,
    analyses_require_refresh: scan.analyses_require_refresh,
    retrieval_warnings: scan.retrieval_warnings,
    openai_would_be_called: wouldAnalyse,
    brief_synthesis_extra_call: 1,
    estimated_total_openai_calls: wouldAnalyse + 1,
    truncated_reason: scan.truncated_reason,
    selection_method: scan.selection_method,
    organisations: scan.organisations.map((item) => ({
      name: item.organisation_name,
      id: item.organisation_id,
      reuse: item.reuse,
      reuse_reason: item.reuse_reason,
      contacts: item.contact_count,
      leads: item.lead_count,
      deals: item.deal_count,
      possible_match_reviews: item.possible_match_reviews,
      listing_tags: item.listing_tags,
      representative: item.representative,
    })),
  },
};

process.stdout.write(`${JSON.stringify(scanReport, null, 2)}\n`);

if (selected > MAX || wouldAnalyse > MAX) {
  process.stderr.write(
    `\nSTOP: Stage 2 would analyse ${selected} organisations (${wouldAnalyse} OpenAI org calls). Hard maximum is ${MAX}.\n`,
  );
  process.exit(1);
}

process.stdout.write(`\n--- BUILDING (max ${MAX}, confirm=true) ---\n`);

const snapshot = await buildSalesCommandCentre({
  mode: "build_changed",
  confirm: true,
  maxOrganisations: MAX,
  includeBriefSynthesis: true,
});

if (snapshot.organisations_discovered > MAX) {
  process.stderr.write(`\nSTOP: Build analysed ${snapshot.organisations_discovered} organisations.\n`);
  process.exit(1);
}

process.stdout.write("\n--- CACHE CHECK (scan only, no rebuild) ---\n");
const rescan = await scanSalesCommandCentre({ maxOrganisations: MAX });

const report = {
  generated_at: snapshot.generated_at,
  duration_ms: snapshot.duration_ms,
  mode: snapshot.mode,
  organisations_discovered: snapshot.organisations_discovered,
  truncated_reason: snapshot.truncated_reason,
  analyses_reused: snapshot.analyses_reused,
  analyses_refreshed: snapshot.analyses_refreshed,
  analyses_failed: snapshot.analyses_failed,
  tokens: snapshot.tokens,
  needs_action_today: snapshot.needs_action_today,
  stalled_count: snapshot.stalled_count,
  waiting_count: snapshot.waiting_count,
  active_opportunities: snapshot.active_opportunities,
  failures: snapshot.failures,
  ranking_note: snapshot.ranking_note,
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
    why_ranked: item.why_ranked,
    reuse: item.reuse,
    usage_signals: item.usage_signals.map((signal) => signal.code),
    opportunity_signals: item.opportunity_signals.map((signal) => signal.code),
    urgency_signals: item.urgency_signals.map((signal) => signal.code),
    data_quality_signals: item.data_quality_signals.map((signal) => signal.code),
    source_record: item.source_record,
    last_meaningful_activity_at: item.last_meaningful_activity_at,
    next_commitment_at: item.next_commitment_at,
  })),
  cache_check: {
    organisations_selected: rescan.organisations.length,
    analyses_reusable: rescan.analyses_reusable,
    analyses_require_refresh: rescan.analyses_require_refresh,
    openai_would_be_called: rescan.openai_would_be_called,
    openai_calls: rescan.tokens.openai_calls,
    organisations: rescan.organisations.map((item) => ({
      name: item.organisation_name,
      reuse: item.reuse,
      reuse_reason: item.reuse_reason,
    })),
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
