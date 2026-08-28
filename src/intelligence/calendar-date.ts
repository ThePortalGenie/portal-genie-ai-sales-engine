import { DEFAULT_COMMAND_CENTRE_THRESHOLDS } from "../domain/commercial-watch.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Civil calendar date in the operator timezone.
 * Date-only strings are treated as calendar dates, not timestamps.
 */
export function calendarDate(value: string | undefined, timeZone = DEFAULT_COMMAND_CENTRE_THRESHOLDS.timeZone): string | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim();
  if (DATE_ONLY.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
}

export function daysBetweenCalendar(
  from: string | undefined,
  to: string | undefined,
  timeZone = DEFAULT_COMMAND_CENTRE_THRESHOLDS.timeZone,
): number | undefined {
  const start = calendarDate(from, timeZone);
  const end = calendarDate(to, timeZone);
  if (!start || !end) return undefined;
  const startUtc = Date.parse(`${start}T00:00:00Z`);
  const endUtc = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(startUtc) || Number.isNaN(endUtc)) return undefined;
  return Math.round((endUtc - startUtc) / 86_400_000);
}

export type FollowUpTiming = "OVERDUE" | "DUE_TODAY" | "FUTURE" | "UNKNOWN";

export function classifyFollowUpDate(
  followUpDate: string | undefined,
  asOf: string,
  timeZone = DEFAULT_COMMAND_CENTRE_THRESHOLDS.timeZone,
): FollowUpTiming {
  const due = calendarDate(followUpDate, timeZone);
  const today = calendarDate(asOf, timeZone);
  if (!due || !today) return "UNKNOWN";
  if (due < today) return "OVERDUE";
  if (due === today) return "DUE_TODAY";
  return "FUTURE";
}

export function formatZonedDateTime(
  value: string | undefined,
  timeZone = DEFAULT_COMMAND_CENTRE_THRESHOLDS.timeZone,
): string | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim();
  if (DATE_ONLY.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(parsed);
}

const NEAR_MS = 15 * 60 * 1000;

export type InstantTiming = "OVERDUE" | "DUE_NOW" | "FUTURE" | "UNKNOWN";

/**
 * Timestamp comparison in real instants. Date-only values stay calendar dates.
 * OpenAI must not decide this.
 */
export function classifyInstant(
  eventAt: string | undefined,
  asOf: string,
  timeZone = DEFAULT_COMMAND_CENTRE_THRESHOLDS.timeZone,
): InstantTiming {
  if (!eventAt?.trim()) return "UNKNOWN";
  const trimmed = eventAt.trim();
  if (DATE_ONLY.test(trimmed)) {
    const follow = classifyFollowUpDate(trimmed, asOf, timeZone);
    if (follow === "OVERDUE") return "OVERDUE";
    if (follow === "DUE_TODAY") return "DUE_NOW";
    if (follow === "FUTURE") return "FUTURE";
    return "UNKNOWN";
  }
  const eventMs = Date.parse(trimmed);
  const asOfMs = Date.parse(asOf);
  if (Number.isNaN(eventMs) || Number.isNaN(asOfMs)) return "UNKNOWN";
  const delta = eventMs - asOfMs;
  if (delta > NEAR_MS) return "FUTURE";
  if (delta < -NEAR_MS) return "OVERDUE";
  return "DUE_NOW";
}

export function isFutureInstant(
  eventAt: string | undefined,
  asOf: string,
  timeZone = DEFAULT_COMMAND_CENTRE_THRESHOLDS.timeZone,
): boolean {
  return classifyInstant(eventAt, asOf, timeZone) === "FUTURE";
}
