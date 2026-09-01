import type { CommandCentreThresholds, StalledState } from "../domain/commercial-watch.js";
import { DEFAULT_COMMAND_CENTRE_THRESHOLDS } from "../domain/commercial-watch.js";
import { classifyFollowUpDate, classifyInstant, daysBetweenCalendar } from "./calendar-date.js";
import type { WatchEvidenceInput } from "./watch-signals.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function classifyStalled(input: WatchEvidenceInput): { state: StalledState; reasons: string[] } {
  const thresholds = input.thresholds ?? DEFAULT_COMMAND_CENTRE_THRESHOLDS;
  const follow = classifyFollowUpDate(input.nextCommitmentAt, input.asOf, thresholds.timeZone);
  const instant = classifyInstant(input.nextCommitmentAt, input.asOf, thresholds.timeZone);
  const dateOnly = Boolean(input.nextCommitmentAt && DATE_ONLY.test(input.nextCommitmentAt.trim()));
  const quietDays = daysBetweenCalendar(input.lastMeaningfulActivityAt, input.asOf, thresholds.timeZone);

  if ((!dateOnly && instant === "FUTURE") || (dateOnly && follow === "FUTURE")) {
    return {
      state: "SCHEDULED_FOLLOW_UP",
      reasons: [`An explicit follow-up is scheduled for ${input.nextCommitmentAt}. This is not stalled.`],
    };
  }

  const overdue = dateOnly ? follow === "OVERDUE" : instant === "OVERDUE";
  if (overdue && input.nextCommitmentKind === "operator") {
    return {
      state: "WAITING_ON_US",
      reasons: [`An operator commitment (${input.nextCommitmentAt}) is overdue.`],
    };
  }

  if (dateOnly && follow === "DUE_TODAY") {
    return {
      state: "SCHEDULED_FOLLOW_UP",
      reasons: [`Follow-up is due today (${input.nextCommitmentAt}).`],
    };
  }

  if (
    follow === "UNKNOWN" &&
    input.unansweredOutboundAttempts >= thresholds.unansweredAttemptsForStall &&
    quietDays !== undefined &&
    quietDays < thresholds.quietDaysWatch
  ) {
    return {
      state: "WAITING_ON_CUSTOMER",
      reasons: [
        `${input.unansweredOutboundAttempts} unanswered outbound attempts. Await a customer response before chasing again.`,
      ],
    };
  }

  if (input.usageActive && (quietDays === undefined || quietDays >= thresholds.quietDaysWatch) && !input.liveDeal) {
    return {
      state: "WATCH",
      reasons: [
        "CRM activity is quiet while Portal Genie product usage is present. The relationship is not classified as dead.",
      ],
    };
  }

  if (input.usageActive && input.usageGrowing && !input.nextCommitmentAt) {
    return {
      state: "WATCH",
      reasons: ["Product usage is active/growing with no current sales commitment. Watch for expansion/adoption, not chase as stalled."],
    };
  }

  const quietEnough = quietDays !== undefined && quietDays >= thresholds.quietDaysStalled;
  const unanswered = input.unansweredOutboundAttempts >= thresholds.unansweredAttemptsForStall;
  const noFuture = follow === "UNKNOWN" || follow === "OVERDUE";
  if (input.liveDeal && quietEnough && unanswered && noFuture) {
    const reasons = [
      `No meaningful interaction for ${quietDays} day(s).`,
      `${input.unansweredOutboundAttempts} outbound attempt(s) have received no response.`,
      "There is no future follow-up commitment.",
      "A live opportunity remains open.",
    ];
    if (input.meetingMissedNoReschedule) reasons.push("A meeting was missed and not rescheduled.");
    return { state: "STALLED", reasons };
  }

  if (input.meetingMissedNoReschedule && input.liveDeal) {
    return {
      state: quietEnough ? "STALLED" : "WATCH",
      reasons: ["A meeting was missed and no reschedule is recorded."],
    };
  }

  if (quietDays !== undefined && quietDays >= thresholds.quietDaysWatch && input.liveDeal) {
    return {
      state: "WATCH",
      reasons: [`Quiet for ${quietDays} day(s) with a live opportunity. An old deal age alone is not treated as stalled.`],
    };
  }

  if (!input.lastMeaningfulActivityAt && !input.liveDeal && input.usageUnknown) {
    return {
      state: "INSUFFICIENT_EVIDENCE",
      reasons: ["Not enough retrieved evidence to classify stalling. This is not the same as no activity."],
    };
  }

  return { state: "NOT_STALLED", reasons: [] };
}
