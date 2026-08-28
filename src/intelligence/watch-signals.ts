import type { CommandCentreThresholds, WatchSignal } from "../domain/commercial-watch.js";
import { DEFAULT_COMMAND_CENTRE_THRESHOLDS } from "../domain/commercial-watch.js";
import { classifyFollowUpDate, classifyInstant, daysBetweenCalendar } from "./calendar-date.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export type WatchEvidenceInput = {
  asOf: string;
  unansweredOutboundAttempts: number;
  lastMeaningfulActivityAt?: string;
  nextCommitmentAt?: string;
  nextCommitmentKind?: "customer" | "operator";
  liveDeal: boolean;
  historicalDealOnly: boolean;
  historicalLostOnly?: boolean;
  currentProductRelationship?: boolean;
  meetingMissedNoReschedule: boolean;
  meetingAgreed?: boolean;
  usageUnknown: boolean;
  usageDatasetAvailable?: boolean;
  usageActive?: boolean;
  usageGrowing?: boolean;
  accountingConnected?: boolean;
  multipleContacts: boolean;
  fragmentation: boolean;
  inboundRecently: boolean;
  possibleMatchReview: boolean;
  thresholds?: CommandCentreThresholds;
};

export function deterministicWatchSignals(input: WatchEvidenceInput): {
  urgency: WatchSignal[];
  opportunity: WatchSignal[];
  risk: WatchSignal[];
  usage: WatchSignal[];
  dataQuality: WatchSignal[];
} {
  const thresholds = input.thresholds ?? DEFAULT_COMMAND_CENTRE_THRESHOLDS;
  const urgency: WatchSignal[] = [];
  const opportunity: WatchSignal[] = [];
  const risk: WatchSignal[] = [];
  const usage: WatchSignal[] = [];
  const dataQuality: WatchSignal[] = [];

  const dateOnly = Boolean(input.nextCommitmentAt && DATE_ONLY.test(input.nextCommitmentAt.trim()));
  const follow = classifyFollowUpDate(input.nextCommitmentAt, input.asOf, thresholds.timeZone);
  const instant = classifyInstant(input.nextCommitmentAt, input.asOf, thresholds.timeZone);
  const overdue = dateOnly ? follow === "OVERDUE" : instant === "OVERDUE";
  const dueToday = dateOnly ? follow === "DUE_TODAY" : instant === "DUE_NOW";
  const future = dateOnly ? follow === "FUTURE" : instant === "FUTURE";
  if (overdue) {
    urgency.push({
      code: input.nextCommitmentKind === "operator" ? "OPERATOR_COMMITMENT_OVERDUE" : "FOLLOW_UP_OVERDUE",
      message:
        input.nextCommitmentKind === "operator"
          ? `Operator follow-up ${input.nextCommitmentAt} is overdue.`
          : `Follow-up ${input.nextCommitmentAt} is overdue.`,
    });
  } else if (dueToday) {
    urgency.push({ code: "FOLLOW_UP_DUE_TODAY", message: `Follow-up is due today (${input.nextCommitmentAt}).` });
  } else if (future) {
    const days = daysBetweenCalendar(input.asOf, input.nextCommitmentAt, thresholds.timeZone) ?? 99;
    if (days <= 3) {
      urgency.push({
        code: "FOLLOW_UP_DUE_SOON",
        message:
          days === 0
            ? `A commercial event is scheduled later today (${input.nextCommitmentAt}). Do not chase before that time.`
            : `Follow-up is in ${days} day(s) (${input.nextCommitmentAt}).`,
      });
    }
    if (input.nextCommitmentKind === "customer") {
      opportunity.push({
        code: "CUSTOMER_COMMITMENT_PENDING",
        message: `Customer requested contact on ${input.nextCommitmentAt}. Do not chase before that date.`,
      });
    }
  }

  if (input.unansweredOutboundAttempts >= 1) {
    urgency.push({
      code: "RECENT_OUTBOUND_UNANSWERED",
      message: "Latest meaningful outbound sequence is unanswered.",
    });
  }
  if (input.unansweredOutboundAttempts >= 2) {
    risk.push({
      code: "MULTIPLE_OUTBOUND_ATTEMPTS_UNANSWERED",
      message: `${input.unansweredOutboundAttempts} unanswered outbound attempts.`,
    });
  }

  if (input.meetingAgreed) opportunity.push({ code: "MEETING_AGREED", message: "A meeting was agreed." });
  if (input.meetingMissedNoReschedule) {
    risk.push({ code: "MEETING_MISSED", message: "A meeting was missed." });
    urgency.push({ code: "RESCHEDULE_REQUIRED", message: "No reschedule is recorded after a missed meeting." });
  }

  const quietDays = daysBetweenCalendar(input.lastMeaningfulActivityAt, input.asOf, thresholds.timeZone);
  if (quietDays !== undefined && quietDays >= thresholds.quietDaysWatch) {
    risk.push({
      code: "NO_RECENT_MEANINGFUL_ACTIVITY",
      message: `No meaningful activity recorded for ${quietDays} day(s).`,
    });
  }
  if (input.inboundRecently || (quietDays !== undefined && quietDays <= 7 && !input.unansweredOutboundAttempts)) {
    opportunity.push({ code: "RECENT_MEANINGFUL_ENGAGEMENT", message: "Recent meaningful engagement is present." });
  }

  if (input.liveDeal) opportunity.push({ code: "LIVE_DEAL_PRESENT", message: "A live / current deal is present." });
  if (input.historicalDealOnly && !input.currentProductRelationship) {
    opportunity.push({
      code: "HISTORICAL_DEAL_ONLY",
      message: input.historicalLostOnly
        ? "Deal evidence is a historical Closed Lost opportunity."
        : "Sales Deal is closed. This is not automatically the current customer relationship.",
    });
  }
  if (input.usageDatasetAvailable === false && input.usageUnknown) {
    dataQuality.push({
      code: "USAGE_DATASET_UNAVAILABLE",
      message: "No Portal Genie usage dataset is imported. USAGE UNKNOWN is not an instruction to check usage now.",
    });
  }

  if (input.usageUnknown) {
    usage.push({ code: "USAGE_UNKNOWN", message: "Portal Genie usage is unknown, not zero." });
  } else {
    if (input.usageActive) usage.push({ code: "ACTIVE_PRODUCT_USAGE", message: "Imported usage shows product activity." });
    if (input.usageGrowing) usage.push({ code: "USAGE_GROWING", message: "Client portal visits are increasing." });
    if (input.accountingConnected) {
      usage.push({ code: "ACCOUNTING_CONNECTION_PRESENT", message: "Accounting software is connected." });
    }
  }

  if (input.multipleContacts) {
    dataQuality.push({ code: "MULTIPLE_RELEVANT_CONTACTS", message: "More than one relevant person is on this organisation." });
  }
  if (input.fragmentation) {
    dataQuality.push({
      code: "CRM_FRAGMENTATION_PRESENT",
      message: "Possible CRM account fragmentation. Records were not merged.",
    });
  }
  if (input.possibleMatchReview) {
    dataQuality.push({
      code: "POSSIBLE_MATCH_REVIEW",
      message: "A possible organisation match was flagged for review and not auto-merged.",
    });
  }

  return { urgency, opportunity, risk, usage, dataQuality };
}
