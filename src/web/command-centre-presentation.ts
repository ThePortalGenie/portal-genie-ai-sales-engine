/** Command Centre presentation-only categorisation. Keep in sync with ccPresentationBucket in public/app.js. */

export type CcPresentationBucket = "excluded" | "focus_now" | "next" | "later" | "waiting";

export type CcPresentationItem = {
  priority?: string;
  effective_queue_state?: string;
  next_best_action?: string;
  action_timing?: string;
  action_due_at?: string;
  executability?: string;
  actionability_kind?: string;
  customer_queue?: boolean;
  operator_control?: { controlled?: boolean; actionable?: boolean };
};

export function ccPresentationBucket(item: CcPresentationItem): CcPresentationBucket {
  if (item.priority === "P5") return "excluded";
  if (item.effective_queue_state === "SYSTEM_NO_ACTION") return "excluded";
  if (item.next_best_action === "NO_ACTION" && item.action_timing === "NO_ACTION_REQUIRED") return "excluded";
  if (item.operator_control?.controlled && item.operator_control.actionable === false) return "excluded";

  if (
    item.effective_queue_state === "WAIT" ||
    item.executability === "WAITING_FOR_TIME" ||
    item.executability === "WAITING_FOR_CUSTOMER" ||
    item.next_best_action === "WAIT"
  ) {
    return "waiting";
  }

  if (
    (item.priority === "P0" || item.priority === "P1") &&
    item.executability === "EXECUTABLE_NOW" &&
    item.actionability_kind === "CUSTOMER_ACTION" &&
    item.customer_queue !== false
  ) {
    return "focus_now";
  }

  if (item.effective_queue_state === "REVIEW_REQUIRED") return "next";
  if (item.effective_queue_state === "RESEARCH" && item.actionability_kind === "INTERNAL_RESEARCH") return "next";
  if (
    (item.priority === "P2" || item.priority === "P3") &&
    item.actionability_kind === "CUSTOMER_ACTION" &&
    item.customer_queue !== false &&
    item.executability === "EXECUTABLE_NOW"
  ) {
    return "next";
  }

  return "later";
}

export function ccUrgencyLabel(item: CcPresentationItem, bucket = ccPresentationBucket(item)): string {
  if (bucket === "waiting") {
    if (item.action_due_at) {
      const due = Date.parse(item.action_due_at);
      if (!Number.isNaN(due)) {
        const when = new Date(due);
        const day = when.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
        return `WAIT UNTIL ${day}`;
      }
    }
    return "WAITING";
  }
  if (bucket === "focus_now") {
    if (item.action_timing === "TODAY") return "TODAY";
    return "NOW";
  }
  if (bucket === "next") {
    if (item.action_timing === "TODAY") return "TODAY";
    if (item.action_timing === "SCHEDULED_DATE") return "THIS WEEK";
    if (item.action_due_at) {
      const due = Date.parse(item.action_due_at);
      if (!Number.isNaN(due)) {
        const days = (due - Date.now()) / 86400000;
        if (days <= 1) return "TODAY";
        if (days <= 7) return "THIS WEEK";
      }
    }
    return "NEXT";
  }
  if (bucket === "later") return "LATER";
  return "—";
}

export function ccQueueInsightCounts(items: CcPresentationItem[]): {
  actNow: number;
  next: number;
  later: number;
  waiting: number;
} {
  const counts = { actNow: 0, next: 0, later: 0, waiting: 0 };
  for (const item of items) {
    const bucket = ccPresentationBucket(item);
    if (bucket === "focus_now") counts.actNow += 1;
    else if (bucket === "next") counts.next += 1;
    else if (bucket === "later") counts.later += 1;
    else if (bucket === "waiting") counts.waiting += 1;
  }
  return counts;
}

export function ccFocusNowItems(items: CcPresentationItem[]): CcPresentationItem[] {
  return items.filter((item) => ccPresentationBucket(item) === "focus_now");
}

export function ccNextItems(items: CcPresentationItem[]): CcPresentationItem[] {
  return items.filter((item) => ccPresentationBucket(item) === "next");
}

export function ccItemsForBucket(
  items: CcPresentationItem[],
  bucket: Exclude<CcPresentationBucket, "excluded">,
): CcPresentationItem[] {
  return items.filter((item) => ccPresentationBucket(item) === bucket);
}
