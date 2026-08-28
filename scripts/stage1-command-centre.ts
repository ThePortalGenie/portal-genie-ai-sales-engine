/**
 * Stage 1 live validation only. MAXIMUM 5 organisations.
 * Do not use this for Stage 2 or a full CRM rebuild.
 */
import { scanSalesCommandCentre, buildSalesCommandCentre } from "../src/services/command-centre-runtime.js";

const MAX = 5;

const scan = await scanSalesCommandCentre({ maxOrganisations: MAX });
const summary = {
  scan: {
    organisations_discovered: scan.organisations_discovered,
    universe_size: scan.universe_size,
    analyses_reusable: scan.analyses_reusable,
    analyses_require_refresh: scan.analyses_require_refresh,
    openai_would_be_called: scan.openai_would_be_called,
    openai_calls: scan.tokens.openai_calls,
    truncated_reason: scan.truncated_reason,
    retrieval_warnings: scan.retrieval_warnings,
    organisations: scan.organisations.map((item) => ({
      name: item.organisation_name,
      id: item.organisation_id,
      reuse: item.reuse,
      reuse_reason: item.reuse_reason,
      contacts: item.contact_count,
      leads: item.lead_count,
      deals: item.deal_count,
      possible_match_reviews: item.possible_match_reviews,
      representative: item.representative,
    })),
  },
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write("\n--- BUILDING (max 5, confirm=true) ---\n");

const snapshot = await buildSalesCommandCentre({
  mode: "build_changed",
  confirm: true,
  maxOrganisations: MAX,
  includeBriefSynthesis: true,
});

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
    source_record: item.source_record,
    last_meaningful_activity_at: item.last_meaningful_activity_at,
    next_commitment_at: item.next_commitment_at,
  })),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
