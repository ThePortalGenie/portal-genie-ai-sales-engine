import type { SalesEvent } from "../domain/sales-event.js";
import { eventAppliesToProduct, followUpDue } from "../domain/sales-event.js";
import { evidence, type EvidenceItem } from "../domain/evidence.js";
import type { ReconstructedTimelineEvent } from "../domain/real-world-interaction.js";

export type SalesEventTemporalDigest = {
  as_of: string;
  recent_operator_events: number;
  consecutive_no_answer_calls: Array<{ contact_name?: string; contact_id?: string; product_scope: string; count: number }>;
  consecutive_meeting_no_shows: Array<{ contact_name?: string; product_scope: string; count: number }>;
  explicit_follow_ups: Array<{
    event_id: string;
    contact_name?: string;
    product_scope: string;
    follow_up_date: string;
    due: boolean;
    next_step?: string;
  }>;
};

export function salesEventsForProduct(events: SalesEvent[], product: "PORTAL_GENIE" | "NAGGING_PANDA"): SalesEvent[] {
  return events.filter((event) => eventAppliesToProduct(event, product));
}

export function salesEventsToTimeline(events: SalesEvent[]): ReconstructedTimelineEvent[] {
  return events.map((event) => ({
    at: event.occurred_at,
    approximate: false,
    kind: "operator_sales_event" as const,
    title: [
      event.event_type.replaceAll("_", " "),
      event.outcome ? event.outcome.replaceAll("_", " ") : "outcome unknown",
      event.contact_name ?? "Organisation",
      event.product_scope.replaceAll("_", " "),
    ].join(" — "),
    interactionId: event.id,
    source: "OPERATOR_ENTERED_SALES_EVENT",
  }));
}

export function buildSalesEventEvidence(events: SalesEvent[]): EvidenceItem[] {
  return events.map((event) =>
    evidence({
      type: "operator_sales_event",
      claim: `Operator ${event.event_type.replaceAll("_", " ")}${event.outcome ? ` · ${event.outcome.replaceAll("_", " ")}` : ""} · ${event.product_scope.replaceAll("_", " ")}${event.contact_name ? ` · ${event.contact_name}` : " · organisation"} on ${event.occurred_at}. Summary is operator interpretation, not a Zoho fact.`,
      source: "OPERATOR_ENTERED_SALES_EVENT",
      recordId: event.id,
      observedAt: event.occurred_at,
    }),
  );
}

export function buildSalesEventTemporal(events: SalesEvent[], asOf: string): SalesEventTemporalDigest {
  const sorted = [...events].sort((left, right) => Date.parse(left.occurred_at) - Date.parse(right.occurred_at));
  const asOfMs = Date.parse(asOf);
  const recent = sorted.filter((event) => {
    const at = Date.parse(event.occurred_at);
    return !Number.isNaN(asOfMs) && !Number.isNaN(at) && asOfMs - at <= 14 * 86_400_000;
  });

  function consecutiveTail(
    predicate: (event: SalesEvent) => boolean,
    keyOf: (event: SalesEvent) => string,
  ): Array<{ key: string; event: SalesEvent; count: number }> {
    const groups = new Map<string, SalesEvent[]>();
    for (const event of sorted) {
      const key = keyOf(event);
      const list = groups.get(key) ?? [];
      list.push(event);
      groups.set(key, list);
    }
    const result: Array<{ key: string; event: SalesEvent; count: number }> = [];
    for (const [key, list] of groups) {
      let count = 0;
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const event = list[index]!;
        if (predicate(event)) count += 1;
        else break;
      }
      if (count > 0) result.push({ key, event: list[list.length - 1]!, count });
    }
    return result;
  }

  const noAnswers = consecutiveTail(
    (event) => event.event_type === "PHONE_CALL" && event.outcome === "NO_ANSWER",
    (event) => `${event.contact_id ?? event.contact_name ?? "org"}:${event.product_scope}`,
  );
  const noShows = consecutiveTail(
    (event) => (event.event_type === "MEETING" && event.outcome === "MEETING_NO_SHOW") || event.event_type === "NO_SHOW",
    (event) => `${event.contact_id ?? event.contact_name ?? "org"}:${event.product_scope}`,
  );

  return {
    as_of: asOf,
    recent_operator_events: recent.length,
    consecutive_no_answer_calls: noAnswers.map((item) => ({
      contact_name: item.event.contact_name,
      contact_id: item.event.contact_id,
      product_scope: item.event.product_scope,
      count: item.count,
    })),
    consecutive_meeting_no_shows: noShows.map((item) => ({
      contact_name: item.event.contact_name,
      product_scope: item.event.product_scope,
      count: item.count,
    })),
    explicit_follow_ups: sorted
      .filter((event) => event.follow_up_date)
      .map((event) => ({
        event_id: event.id,
        contact_name: event.contact_name,
        product_scope: event.product_scope,
        follow_up_date: event.follow_up_date!,
        due: followUpDue(event.follow_up_date, asOf) === true,
        next_step: event.next_step,
      })),
  };
}
