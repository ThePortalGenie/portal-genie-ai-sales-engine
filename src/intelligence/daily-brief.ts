import type {
  CommercialWatchItem,
  DailyBriefActionRow,
  DailyBriefResearchRow,
  DailyBriefWaitRow,
  DailySalesBrief,
  PortfolioFailure,
} from "../domain/commercial-watch.js";
import { classifyInstant } from "./calendar-date.js";
import { DEFAULT_COMMAND_CENTRE_THRESHOLDS } from "../domain/commercial-watch.js";
import { isEffectivelyCustomerExecutable } from "./watch-item-control.js";

function isExecutableNow(item: CommercialWatchItem): boolean {
  return item.executability === "EXECUTABLE_NOW";
}

export function isCustomerExecutableBriefItem(item: CommercialWatchItem): boolean {
  return isEffectivelyCustomerExecutable(item);
}

function shortReason(text: string, max = 140): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const sentence = trimmed.split(/(?<=[.!?])\s+/)[0] ?? trimmed;
  if (sentence.length <= max) return sentence;
  return `${sentence.slice(0, max - 1).trimEnd()}…`;
}

function whenLabel(item: CommercialWatchItem, asOf: string, timeZone: string): string {
  if (item.action_due_at) {
    const instant = classifyInstant(item.action_due_at, asOf, timeZone);
    if (instant === "FUTURE" || instant === "DUE_NOW") {
      return instant === "FUTURE" ? `WAIT UNTIL ${item.action_due_at}` : "NOW";
    }
    if (instant === "OVERDUE") return "OVERDUE";
  }
  if (item.executability === "DATA_REQUIRED") return "USAGE DATA REQUIRED";
  if (item.action_timing === "OVERDUE") return "OVERDUE";
  if (item.action_timing === "TODAY") return "TODAY";
  if (item.action_timing === "ACT_NOW") return "NOW";
  if (item.executability === "WAITING_FOR_CUSTOMER" || item.stalled_state === "WAITING_ON_CUSTOMER") {
    return "AWAITING CUSTOMER";
  }
  if (item.next_best_action === "NO_ACTION" || item.action_timing === "NO_ACTION_REQUIRED") return "NO ACTION TODAY";
  return item.action_timing.replaceAll("_", " ");
}

function actionRow(item: CommercialWatchItem, asOf: string, timeZone: string): DailyBriefActionRow {
  return {
    watch_item_id: item.id,
    organisation_id: item.organisation_id,
    organisation_name: item.organisation_name,
    product_scope: item.product_scope,
    recommended_contact_name: item.recommended_contact_name ?? item.primary_contact_name,
    next_best_action: item.next_best_action,
    when_label: whenLabel(item, asOf, timeZone),
    reason: shortReason(item.why_this_action),
    priority: item.priority === "P0" ? "P0" : "P1",
  };
}

function waitRow(item: CommercialWatchItem, asOf: string, timeZone: string): DailyBriefWaitRow {
  if (item.action_due_at && classifyInstant(item.action_due_at, asOf, timeZone) === "FUTURE") {
    return {
      watch_item_id: item.id,
      organisation_id: item.organisation_id,
      organisation_name: item.organisation_name,
      wait_kind: "WAIT_UNTIL",
      when_label: whenLabel(item, asOf, timeZone),
      reason: shortReason(item.why_this_action || "Scheduled follow-up is not due yet."),
      time_sensitive: true,
    };
  }
  if (item.executability === "WAITING_FOR_CUSTOMER" || item.stalled_state === "WAITING_ON_CUSTOMER") {
    return {
      watch_item_id: item.id,
      organisation_id: item.organisation_id,
      organisation_name: item.organisation_name,
      wait_kind: "WAITING_ON_CUSTOMER",
      reason: shortReason(item.why_this_action || "Await a customer response before chasing again."),
      time_sensitive: false,
    };
  }
  return {
    watch_item_id: item.id,
    organisation_id: item.organisation_id,
    organisation_name: item.organisation_name,
    wait_kind: "NO_ACTION_TODAY",
    reason: shortReason(item.why_this_action || "No customer contact is due today."),
    time_sensitive: false,
  };
}

function operatorResearchRow(item: CommercialWatchItem): DailyBriefResearchRow {
  const reason =
    item.operator_control?.operator_summary ||
    item.operator_control?.suppression_reason ||
    item.why_this_action;
  return {
    watch_item_id: item.id,
    organisation_id: item.organisation_id,
    organisation_name: item.organisation_name,
    product_scope: item.product_scope,
    next_best_action: item.next_best_action,
    actionability_kind:
      item.operator_control?.primary_decision_type === "RESEARCH_REQUIRED" ||
      item.effective_queue_state === "RESEARCH"
        ? "INTERNAL_RESEARCH"
        : "DATA_REQUIRED",
    reason: shortReason(reason || "Operator review required before customer outreach."),
  };
}

function operatorWaitRow(item: CommercialWatchItem): DailyBriefWaitRow {
  const when =
    item.operator_control?.effective_until?.slice(0, 10) ??
    (item.action_due_at ? whenLabel(item, "", DEFAULT_COMMAND_CENTRE_THRESHOLDS.timeZone) : undefined);
  return {
    watch_item_id: item.id,
    organisation_id: item.organisation_id,
    organisation_name: item.organisation_name,
    wait_kind:
      item.operator_control?.primary_decision_type === "WAITING" ? "WAITING_ON_CUSTOMER" : "WAIT_UNTIL",
    when_label: when ? `WAIT UNTIL ${when}` : undefined,
    reason: shortReason(
      item.operator_control?.operator_summary ||
        item.operator_control?.suppression_reason ||
        "Operator marked this as waiting.",
    ),
    time_sensitive: Boolean(item.operator_control?.effective_until),
  };
}
function researchRow(item: CommercialWatchItem): DailyBriefResearchRow {
  return {
    watch_item_id: item.id,
    organisation_id: item.organisation_id,
    organisation_name: item.organisation_name,
    product_scope: item.product_scope,
    next_best_action: item.next_best_action,
    actionability_kind: item.actionability_kind === "DATA_REQUIRED" ? "DATA_REQUIRED" : "INTERNAL_RESEARCH",
    reason: shortReason(item.why_this_action),
  };
}

export function deterministicCommercialWatch(
  items: CommercialWatchItem[],
  doFirst: DailyBriefActionRow[],
  researchCount: number,
  waitCustomerCount: number,
  stalledCount: number,
  warningsCount: number,
): string[] {
  const bullets: string[] = [];
  if (doFirst.length) {
    const top = doFirst[0]!;
    const product = top.product_scope.replaceAll("_", " ");
    bullets.push(`${top.organisation_name} (${product}) is today's highest-priority customer action.`);
  }
  const watchLive = items.filter((item) => item.stalled_state === "WATCH" && item.opportunity_signals.some((s) => s.code === "LIVE_DEAL_PRESENT"));
  if (watchLive.length) {
    bullets.push(`${watchLive.length} quiet relationship(s) still have live deal(s) — monitor without premature chasing.`);
  }
  if (waitCustomerCount >= 2) {
    bullets.push(`${waitCustomerCount} organisations are awaiting customer response — avoid chasing today.`);
  }
  if (researchCount) {
    bullets.push(`${researchCount} item(s) need research or usage data before customer outreach.`);
  }
  if (stalledCount) {
    bullets.push(`${stalledCount} stalled relationship(s) need a deliberate intervention when evidence supports it.`);
  }
  if (warningsCount) {
    bullets.push(`${warningsCount} analysis warning(s) — verify data quality before acting on affected records.`);
  }
  const reopened = items.filter((item) => item.operator_control?.reopened);
  if (reopened.length) {
    bullets.push(`${reopened.length} previously controlled item(s) reopened because material new evidence arrived.`);
  }
  return bullets.slice(0, 5);
}

export function deterministicDailyBrief(
  items: CommercialWatchItem[],
  failures: PortfolioFailure[],
  asOf = new Date().toISOString(),
): DailySalesBrief {
  const timeZone = DEFAULT_COMMAND_CENTRE_THRESHOLDS.timeZone;
  const customerExecutable = items.filter(isCustomerExecutableBriefItem);
  const p0 = customerExecutable.filter((item) => item.priority === "P0");
  const p1 = customerExecutable.filter((item) => item.priority === "P1");
  const doFirstActions = [...p0, ...p1].map((item) => {
    const row = actionRow(item, asOf, timeZone);
    if (item.operator_control?.reopened && item.operator_control.reopen_explanation) {
      row.reason = shortReason(`${item.operator_control.reopen_explanation} ${row.reason}`);
    }
    return row;
  });
  const operatorResearch = items
    .filter(
      (item) =>
        item.operator_control?.controlled &&
        !isCustomerExecutableBriefItem(item) &&
        (item.effective_queue_state === "RESEARCH" ||
          item.effective_queue_state === "REVIEW_REQUIRED" ||
          item.operator_control.primary_decision_type === "RESEARCH_REQUIRED"),
    )
    .map(operatorResearchRow);
  const researchItems = [
    ...items
      .filter(
        (item) =>
          !item.operator_control?.controlled &&
          (item.actionability_kind === "INTERNAL_RESEARCH" || item.actionability_kind === "DATA_REQUIRED"),
      )
      .map(researchRow),
    ...operatorResearch,
  ];
  const stalled = items.filter(
    (item) => item.stalled_state === "STALLED" && item.effective_queue_state !== "NOT_AN_OPPORTUNITY",
  );
  const operatorWaiting = items
    .filter(
      (item) =>
        item.operator_control?.controlled &&
        (item.operator_control.primary_decision_type === "WAITING" ||
          item.operator_control.primary_decision_type === "SNOOZED"),
    )
    .map(operatorWaitRow);
  const waiting = items.filter(
    (item) =>
      !item.operator_control?.controlled &&
      item.effective_queue_state !== "NOT_AN_OPPORTUNITY" &&
      item.actionability_kind !== "INTERNAL_RESEARCH" &&
      item.actionability_kind !== "DATA_REQUIRED" &&
      (item.executability === "WAITING_FOR_TIME" ||
        item.executability === "WAITING_FOR_CUSTOMER" ||
        item.priority === "P4" ||
        item.stalled_state === "SCHEDULED_FOLLOW_UP" ||
        item.stalled_state === "WAITING_ON_CUSTOMER" ||
        item.next_best_action === "WAIT"),
  );
  const waitItems = [...waiting.map((item) => waitRow(item, asOf, timeZone)), ...operatorWaiting].sort(
    (left, right) => Number(right.time_sensitive) - Number(left.time_sensitive),
  );
  const watch = items.filter((item) => item.stalled_state === "WATCH");
  const dataRequired = items.filter((item) => item.executability === "DATA_REQUIRED");
  const waitCustomerCount = waiting.filter(
    (item) => item.executability === "WAITING_FOR_CUSTOMER" || item.stalled_state === "WAITING_ON_CUSTOMER",
  ).length;
  const warnings = [
    ...failures.map((item) => {
      const who = item.organisation_name ? `${item.organisation_name}: ` : "";
      return `${who}${item.state} during ${item.stage} — ${item.message}`;
    }),
    ...items
      .filter((item) => item.reuse === "failed")
      .map((item) => `${item.organisation_name} could not be fully assessed.`),
    ...dataRequired.map(
      (item) =>
        `${item.organisation_name}: usage data required. USAGE UNKNOWN is not an instruction to check usage now.`,
    ),
  ];
  const formatLegacyAction = (row: DailyBriefActionRow) =>
    `${row.organisation_name} (${row.product_scope.replaceAll("_", " ")}) — ${row.next_best_action.replaceAll("_", " ")} · ${row.when_label}. ${row.reason}`;
  const formatLegacyResearch = (row: DailyBriefResearchRow) =>
    `${row.organisation_name} (${row.product_scope.replaceAll("_", " ")}) — ${row.next_best_action.replaceAll("_", " ")} · ${row.actionability_kind.replaceAll("_", " ")}. ${row.reason}`;
  const commercialWatch = deterministicCommercialWatch(
    items,
    doFirstActions,
    researchItems.length,
    waitCustomerCount,
    stalled.length,
    warnings.length,
  );

  return {
    generated_at: asOf,
    mode: "deterministic",
    today_at_a_glance: `${doFirstActions.length} customer action(s) · ${waitItems.length} wait · ${researchItems.length} research/data`,
    do_first_actions: doFirstActions,
    wait_items: waitItems,
    research_items: researchItems,
    commercial_watch: commercialWatch,
    do_first: doFirstActions.filter((row) => row.priority === "P0").map(formatLegacyAction),
    follow_up_today: doFirstActions.filter((row) => row.priority === "P1").map(formatLegacyAction),
    research_required: researchItems.map(formatLegacyResearch),
    stalled: stalled.map((item) => `${item.organisation_name}: ${item.stalled_reasons.join(" ")} Recommended: ${item.next_best_action.replaceAll("_", " ")}.`),
    wait: waitItems.map((item) => {
      if (item.wait_kind === "WAIT_UNTIL") return `${item.when_label} — ${item.organisation_name}. ${item.reason}`;
      if (item.wait_kind === "WAITING_ON_CUSTOMER") return `AWAITING CUSTOMER — ${item.organisation_name}. ${item.reason}`;
      return `NO ACTION TODAY — ${item.organisation_name}. ${item.reason}`;
    }),
    reengage: watch.map((item) => `${item.organisation_name}: ${shortReason(item.commercial_summary, 200)}`),
    recent_changes: items
      .filter((item) => item.reuse === "refreshed")
      .map((item) => `${item.organisation_name} analysis was refreshed.`),
    warnings,
  };
}

export async function maybeSynthesizeBrief(
  brief: DailySalesBrief,
  synthesizer?: (prompt: string) => Promise<{ text: string; inputTokens?: number; outputTokens?: number }>,
): Promise<{ brief: DailySalesBrief; tokens: { input: number; output: number; calls: number } }> {
  if (!synthesizer) return { brief, tokens: { input: 0, output: 0, calls: 0 } };
  const payload = {
    customer_actions: brief.do_first_actions.map((item) => ({
      organisation: item.organisation_name,
      product: item.product_scope,
      action: item.next_best_action,
    })),
    wait_count: brief.wait_items.length,
    research_count: brief.research_items.length,
    stalled_count: brief.stalled.length,
    watch_patterns: brief.reengage.slice(0, 3),
    warnings_count: brief.warnings.length,
    deterministic_watch: brief.commercial_watch,
  };
  try {
    const result = await synthesizer(
      [
        "Return ONLY a JSON array of 3 to 5 strings.",
        "Each string is one portfolio-level COMMERCIAL WATCH bullet for a sales manager.",
        "Use ONLY facts from the JSON. Do not invent organisations, actions, dates, or usage.",
        "Do not list every organisation. No paragraphs. One concise sentence per bullet.",
        "Do not repeat the full action queue. Focus on patterns and priorities.",
        JSON.stringify(payload),
      ].join("\n"),
    );
    let bullets = brief.commercial_watch;
    try {
      const parsed = JSON.parse(result.text.trim()) as unknown;
      if (Array.isArray(parsed)) {
        bullets = parsed
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .map((item) => item.trim())
          .slice(0, 5);
      }
    } catch {
      const lines = result.text
        .split(/\n+/)
        .map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim())
        .filter(Boolean);
      if (lines.length) bullets = lines.slice(0, 5);
    }
    return {
      brief: {
        ...brief,
        mode: "openai_synthesis",
        commercial_watch: bullets.length ? bullets : brief.commercial_watch,
      },
      tokens: { input: result.inputTokens ?? 0, output: result.outputTokens ?? 0, calls: 1 },
    };
  } catch {
    return { brief, tokens: { input: 0, output: 0, calls: 1 } };
  }
}
