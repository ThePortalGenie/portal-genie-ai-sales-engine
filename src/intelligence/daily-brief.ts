import type { CommercialWatchItem, DailySalesBrief, PortfolioFailure } from "../domain/commercial-watch.js";

function isExecutableNow(item: CommercialWatchItem): boolean {
  return item.executability === "EXECUTABLE_NOW";
}

export function deterministicDailyBrief(
  items: CommercialWatchItem[],
  failures: PortfolioFailure[],
  asOf = new Date().toISOString(),
): DailySalesBrief {
  const p0 = items.filter((item) => item.priority === "P0" && isExecutableNow(item));
  const p1 = items.filter((item) => item.priority === "P1" && isExecutableNow(item));
  const stalled = items.filter((item) => item.stalled_state === "STALLED");
  const waiting = items.filter(
    (item) =>
      item.executability === "WAITING_FOR_TIME" ||
      item.executability === "WAITING_FOR_CUSTOMER" ||
      item.executability === "DATA_REQUIRED" ||
      item.priority === "P4" ||
      item.stalled_state === "SCHEDULED_FOLLOW_UP" ||
      item.stalled_state === "WAITING_ON_CUSTOMER" ||
      item.next_best_action === "WAIT",
  );
  const watch = items.filter((item) => item.stalled_state === "WATCH");
  const dataRequired = items.filter((item) => item.executability === "DATA_REQUIRED");
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
  const formatItem = (item: CommercialWatchItem) =>
    `${item.organisation_name} (${item.product_scope.replaceAll("_", " ")}) — ${item.next_best_action.replaceAll("_", " ")} · ${item.action_timing.replaceAll("_", " ")}${item.action_due_at ? ` ${item.action_due_at}` : ""}. ${item.why_this_action}`;

  return {
    generated_at: asOf,
    mode: "deterministic",
    today_at_a_glance: `${p0.length + p1.length} opportunities need action today. ${stalled.length} stalled. ${waiting.length} wait / do not chase. ${warnings.length} analysis warning(s).`,
    do_first: p0.map(formatItem),
    follow_up_today: p1.map(formatItem),
    stalled: stalled.map((item) => `${item.organisation_name}: ${item.stalled_reasons.join(" ")} Recommended: ${item.next_best_action.replaceAll("_", " ")}.`),
    wait: waiting.map((item) => {
      if (item.executability === "DATA_REQUIRED") {
        return `USAGE DATA REQUIRED — ${item.organisation_name}. ${item.why_this_action}`;
      }
      if (item.action_due_at) return `WAIT UNTIL ${item.action_due_at} — ${item.organisation_name}. ${item.why_this_action}`;
      if (item.executability === "WAITING_FOR_CUSTOMER" || item.stalled_state === "WAITING_ON_CUSTOMER") {
        return `AWAITING CUSTOMER — ${item.organisation_name}.`;
      }
      return `NO ACTION TODAY — ${item.organisation_name}.`;
    }),
    reengage: watch.map((item) => `${item.organisation_name}: ${item.commercial_summary}`),
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
    today_at_a_glance: brief.today_at_a_glance,
    do_first: brief.do_first,
    follow_up_today: brief.follow_up_today,
    stalled: brief.stalled,
    wait: brief.wait,
    reengage: brief.reengage,
    warnings: brief.warnings,
  };
  try {
    const result = await synthesizer(
      [
        "Write a concise operational Daily Sales Brief from ONLY the JSON facts below.",
        "Do not invent organisations, dates, usage, or email activity.",
        "Do first / follow up today are the only items the operator can act on now.",
        "Do not tell the operator to check usage if wait or warnings say usage data is required or no usage dataset is imported.",
        "Do not tell the operator to contact someone before a WAIT UNTIL time. Waiting and data-required items are not Do first.",
        "If warnings mention retrieval ERROR or UNAVAILABLE, say those organisations could not be fully assessed. Never say they had no activity.",
        "No motivational copy.",
        JSON.stringify(payload),
      ].join("\n"),
    );
    return {
      brief: {
        ...brief,
        mode: "openai_synthesis",
        narrative: result.text.trim(),
      },
      tokens: { input: result.inputTokens ?? 0, output: result.outputTokens ?? 0, calls: 1 },
    };
  } catch {
    return { brief, tokens: { input: 0, output: 0, calls: 1 } };
  }
}
