import type { WatchAction } from "../domain/commercial-watch.js";
import { DEFAULT_COMMAND_CENTRE_THRESHOLDS } from "../domain/commercial-watch.js";
import { daysBetweenCalendar } from "./calendar-date.js";
import type { WatchEvidenceInput } from "./watch-signals.js";

/** Customer actions that repeat the email channel after unanswered outbound. */
const EMAIL_CHANNEL_ACTIONS = new Set<WatchAction>([
  "PERSONAL_EMAIL",
  "REACTIVATION_EMAIL",
  "PRODUCT_ACTIVATION_EMAIL",
  "NURTURE",
]);

/** Legitimate alternate channels when email was recently unanswered. */
const ALTERNATE_CHANNEL_ACTIONS = new Set<WatchAction>([
  "PHONE_CALL",
  "CONTACT_ALTERNATIVE_PERSON",
  "RESCHEDULE",
  "DEMO_INVITATION",
  "PARTNER_INVITATION",
]);

const NON_CUSTOMER_ACTIONS = new Set<WatchAction>([
  "NO_ACTION",
  "WAIT",
  "HUMAN_REVIEW",
  "EXTERNAL_ENRICHMENT",
  "USAGE_CHECK",
  "NURTURE",
]);

export type AntiChaseResult = {
  action: WatchAction;
  suppressed?: boolean;
  reason?: string;
};

export function recentUnansweredWithinQuietWindow(evidence: WatchEvidenceInput): boolean {
  const thresholds = evidence.thresholds ?? DEFAULT_COMMAND_CENTRE_THRESHOLDS;
  if (evidence.unansweredOutboundAttempts < 1) return false;
  const quietDays = daysBetweenCalendar(evidence.lastMeaningfulActivityAt, evidence.asOf, thresholds.timeZone);
  return quietDays !== undefined && quietDays < thresholds.quietDaysWatch;
}

/**
 * Channel-aware anti-chase. Preserves evidence signals; constrains which actions may execute.
 * Does not replace genuine WAIT from future commitments or operator control.
 */
export function applyAntiChaseToAction(action: WatchAction, evidence: WatchEvidenceInput): AntiChaseResult {
  if (!recentUnansweredWithinQuietWindow(evidence)) return { action };

  const thresholds = evidence.thresholds ?? DEFAULT_COMMAND_CENTRE_THRESHOLDS;
  const multipleUnanswered = evidence.unansweredOutboundAttempts >= thresholds.unansweredAttemptsForStall;

  if (EMAIL_CHANNEL_ACTIONS.has(action)) {
    return {
      action: "NO_ACTION",
      suppressed: true,
      reason: "Recent outbound email is unanswered. Do not send another email yet.",
    };
  }

  if (ALTERNATE_CHANNEL_ACTIONS.has(action)) {
    return { action };
  }

  if (NON_CUSTOMER_ACTIONS.has(action)) {
    return { action };
  }

  if (multipleUnanswered) {
    return {
      action: "WAIT",
      suppressed: true,
      reason: `${evidence.unansweredOutboundAttempts} unanswered outbound attempts. Await a customer response or use phone.`,
    };
  }

  return { action };
}
