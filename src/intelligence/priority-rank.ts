import type {
  ActionExecutability,
  ActionTiming,
  ActionabilityKind,
  CommercialWatchItem,
  PriorityBand,
  WatchAction,
} from "../domain/commercial-watch.js";
import { classifyFollowUpDate, classifyInstant } from "./calendar-date.js";
import { classifyStalled } from "./stalled-engine.js";
import type { WatchEvidenceInput } from "./watch-signals.js";

/**
 * Tie-break within a priority band, in order:
 * 1. Overdue explicit commitments (older overdue first)
 * 2. Due date sooner first
 * 3. Stalled before not stalled
 * 4. Live deal before historical-only
 * 5. More unanswered attempts first
 * 6. Recent inbound engagement before quiet
 * 7. Growing usage as an opportunity signal
 * 8. Confidence HIGH > MEDIUM > LOW
 * 9. Organisation name (stable)
 *
 * AI must not create this ordering.
 */
export const PRIORITY_TIEBREAK =
  "Overdue commitments, then due date, stalled state, live deal, unanswered attempts, recent inbound, growing usage, confidence, organisation name. P0/P1 require EXECUTABLE_NOW customer-facing actions.";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function decideActionTiming(input: WatchEvidenceInput, action: WatchAction): ActionTiming {
  if (action === "NO_ACTION" || action === "NURTURE") return "NO_ACTION_REQUIRED";
  const tz = input.thresholds?.timeZone;
  const scheduled = classifyInstant(input.nextCommitmentAt, input.asOf, tz);
  const dateOnly = Boolean(input.nextCommitmentAt && DATE_ONLY.test(input.nextCommitmentAt.trim()));
  if (scheduled === "FUTURE") return "WAIT_UNTIL";
  if (dateOnly) {
    const follow = classifyFollowUpDate(input.nextCommitmentAt, input.asOf, tz);
    if (follow === "OVERDUE") return "OVERDUE";
    if (follow === "DUE_TODAY") return "TODAY";
  } else if (scheduled === "OVERDUE" && input.nextCommitmentAt) {
    return "OVERDUE";
  }
  if (action === "WAIT") return "NO_ACTION_REQUIRED";
  if (action === "USAGE_CHECK" && (input.usageDatasetAvailable === false || input.usageUnknown)) {
    return "NO_ACTION_REQUIRED";
  }
  if (action === "RESCHEDULE" || input.nextCommitmentKind === "operator") return "ACT_NOW";
  return "ACT_NOW";
}

export function overrideAction(input: WatchEvidenceInput, recommended: WatchAction): WatchAction {
  const scheduled = classifyInstant(input.nextCommitmentAt, input.asOf, input.thresholds?.timeZone);
  if (scheduled === "FUTURE") return "WAIT";
  if (scheduled === "OVERDUE" && input.nextCommitmentKind === "operator") {
    return recommended === "NO_ACTION" || recommended === "USAGE_CHECK" ? "FOLLOW_UP" : recommended;
  }
  if (input.meetingMissedNoReschedule) return "RESCHEDULE";
  if (input.historicalLostOnly && !input.liveDeal && (recommended === "PHONE_CALL" || recommended === "PERSONAL_EMAIL" || recommended === "FOLLOW_UP")) {
    return "NO_ACTION";
  }
  return recommended;
}

export function classifyExecutability(input: {
  action: WatchAction;
  timing: ActionTiming;
  stalledState: string;
  usageDatasetAvailable?: boolean;
  usageUnknown?: boolean;
}): ActionExecutability {
  if (input.action === "NO_ACTION" || input.action === "NURTURE") return "NO_ACTION_REQUIRED";
  if (input.action === "USAGE_CHECK" && (input.usageDatasetAvailable === false || input.usageUnknown)) {
    return "DATA_REQUIRED";
  }
  if (input.timing === "WAIT_UNTIL" || (input.action === "WAIT" && input.stalledState === "SCHEDULED_FOLLOW_UP")) {
    return "WAITING_FOR_TIME";
  }
  if (input.stalledState === "WAITING_ON_CUSTOMER" || input.action === "WAIT") return "WAITING_FOR_CUSTOMER";
  if (input.timing === "NO_ACTION_REQUIRED") return "NO_ACTION_REQUIRED";
  return "EXECUTABLE_NOW";
}

export function priorityBand(item: {
  action_timing: ActionTiming;
  next_best_action: WatchAction;
  stalled_state: string;
  liveDeal: boolean;
  executability?: ActionExecutability;
  actionability_kind?: ActionabilityKind;
  customer_queue?: boolean;
}): PriorityBand {
  const executability =
    item.executability ??
    classifyExecutability({
      action: item.next_best_action,
      timing: item.action_timing,
      stalledState: item.stalled_state,
    });
  if (item.customer_queue === false) {
    return "P5";
  }
  if (executability === "EXECUTABLE_NOW" && item.actionability_kind === "INTERNAL_RESEARCH") {
    if (item.stalled_state === "STALLED") return "P2";
    return "P3";
  }
  if (item.stalled_state === "WAITING_ON_US" && executability === "EXECUTABLE_NOW" && item.actionability_kind === "CUSTOMER_ACTION") {
    return "P0";
  }
  if (executability === "WAITING_FOR_TIME" || executability === "WAITING_FOR_CUSTOMER" || executability === "DATA_REQUIRED") {
    return "P4";
  }
  if (executability === "NO_ACTION_REQUIRED") {
    if (item.stalled_state === "STALLED") return "P2";
    if (item.next_best_action === "NURTURE" || item.stalled_state === "WATCH") return "P3";
    return "P5";
  }
  if (item.action_timing === "OVERDUE" && item.actionability_kind === "CUSTOMER_ACTION") return "P0";
  if (
    (item.action_timing === "TODAY" || item.action_timing === "ACT_NOW") &&
    item.actionability_kind === "CUSTOMER_ACTION"
  ) {
    return "P1";
  }
  if (item.stalled_state === "STALLED") return "P2";
  if (item.liveDeal && item.action_timing !== "WAIT_UNTIL" && item.action_timing !== "NO_ACTION_REQUIRED") return "P2";
  if (item.stalled_state === "WATCH" || item.next_best_action === "NURTURE") return "P3";
  if (item.action_timing === "WAIT_UNTIL" || item.stalled_state === "SCHEDULED_FOLLOW_UP" || item.stalled_state === "WAITING_ON_CUSTOMER") {
    return "P4";
  }
  return "P5";
}

function stalledRank(state: string): number {
  if (state === "WAITING_ON_US") return 0;
  if (state === "STALLED") return 1;
  if (state === "WATCH") return 2;
  return 3;
}

function confidenceRank(value: string): number {
  if (value === "HIGH") return 0;
  if (value === "MEDIUM") return 1;
  return 2;
}

export function sortWatchItems(items: CommercialWatchItem[]): CommercialWatchItem[] {
  const bandOrder: Record<PriorityBand, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, P5: 5 };
  const sorted = [...items].sort((left, right) => {
    const band = bandOrder[left.priority] - bandOrder[right.priority];
    if (band !== 0) return band;
    const leftDue = left.action_due_at ?? "";
    const rightDue = right.action_due_at ?? "";
    if (left.action_timing === "OVERDUE" || right.action_timing === "OVERDUE") {
      if (leftDue && rightDue && leftDue !== rightDue) return leftDue.localeCompare(rightDue);
    }
    if (leftDue && rightDue && left.priority === "P1") return leftDue.localeCompare(rightDue);
    const stall = stalledRank(left.stalled_state) - stalledRank(right.stalled_state);
    if (stall !== 0) return stall;
    const live = Number(right.opportunity_signals.some((item) => item.code === "LIVE_DEAL_PRESENT")) -
      Number(left.opportunity_signals.some((item) => item.code === "LIVE_DEAL_PRESENT"));
    if (live !== 0) return live;
    const unanswered =
      (right.risk_signals.find((item) => item.code === "MULTIPLE_OUTBOUND_ATTEMPTS_UNANSWERED") ? 1 : 0) -
      (left.risk_signals.find((item) => item.code === "MULTIPLE_OUTBOUND_ATTEMPTS_UNANSWERED") ? 1 : 0);
    if (unanswered !== 0) return unanswered;
    const inbound =
      Number(right.opportunity_signals.some((item) => item.code === "RECENT_MEANINGFUL_ENGAGEMENT")) -
      Number(left.opportunity_signals.some((item) => item.code === "RECENT_MEANINGFUL_ENGAGEMENT"));
    if (inbound !== 0) return inbound;
    const usage =
      Number(right.usage_signals.some((item) => item.code === "USAGE_GROWING")) -
      Number(left.usage_signals.some((item) => item.code === "USAGE_GROWING"));
    if (usage !== 0) return usage;
    const confidence = confidenceRank(left.confidence) - confidenceRank(right.confidence);
    if (confidence !== 0) return confidence;
    return left.organisation_name.localeCompare(right.organisation_name) || left.product_scope.localeCompare(right.product_scope);
  });
  return sorted.map((item, index) => ({
    ...item,
    rank: index + 1,
    why_ranked: `${item.priority} · ${item.executability} · ${PRIORITY_TIEBREAK}`,
  }));
}

export function applyPriority(
  item: Omit<CommercialWatchItem, "priority" | "rank" | "why_ranked"> & { liveDeal: boolean },
): CommercialWatchItem {
  const priority = priorityBand({
    action_timing: item.action_timing,
    next_best_action: item.next_best_action,
    stalled_state: item.stalled_state,
    liveDeal: item.liveDeal,
    executability: item.executability,
    actionability_kind: item.actionability_kind,
    customer_queue: item.customer_queue,
  });
  const { liveDeal: _live, ...rest } = item;
  return {
    ...rest,
    priority,
    rank: 0,
    why_ranked: `${priority} · ${item.executability} · ${PRIORITY_TIEBREAK}`,
  };
}

export { classifyStalled };
