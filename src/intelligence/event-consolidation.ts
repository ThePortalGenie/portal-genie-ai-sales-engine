import type { ConfidenceLevel } from "../domain/commercial-intelligence.js";
import type { RealWorldInteraction } from "../domain/real-world-interaction.js";

const STOP = new Set(["the", "a", "an", "and", "or", "to", "for", "of", "with", "at", "in", "our", "your", "you", "hi", "please", "this", "that", "from"]);

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizeOrg(value?: string): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function namedEventKey(item: RealWorldInteraction): string | undefined {
  if (item.event_key) return item.event_key;
  const haystack = `${item.summary} ${item.outcome ?? ""}`.toLowerCase();
  if (item.interaction_type !== "ROADSHOW_CONVERSATION" && !/\broadshow\b/.test(haystack)) return undefined;
  const match = haystack.match(/\b([a-z0-9]+(?:\s+[a-z0-9]+){0,4})\s+roadshow\b/);
  const skip = new Set(["at", "the", "our", "a", "an", "in", "on", "to", "from", "with", "you", "your"]);
  const tokens = (match?.[1] ?? "").split(/\s+/).filter((token) => token && !skip.has(token));
  return `roadshow:${tokens.at(-1) || "unspecified"}`;
}

function significantTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 4 && !STOP.has(token)),
  );
}

function overlapCount(left: string, right: string): number {
  const a = significantTokens(left);
  const b = significantTokens(right);
  let count = 0;
  for (const token of a) {
    if (b.has(token)) count += 1;
  }
  return count;
}

function daysApart(left?: string, right?: string): number | undefined {
  if (!left || !right) return undefined;
  const a = Date.parse(left);
  const b = Date.parse(right);
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
  return Math.abs(a - b) / 86_400_000;
}

function calledName(summary: string): string | undefined {
  const match = summary.match(/\bcalled\s+([A-Z][a-zA-Z'-]+)/);
  return match?.[1]?.toLowerCase();
}

function sameOrganisation(left: RealWorldInteraction, right: RealWorldInteraction): boolean {
  const a = normalizeOrg(left.organisation);
  const b = normalizeOrg(right.organisation);
  if (!a || !b) return true;
  return a === b;
}

function isIndependentWording(left: RealWorldInteraction, right: RealWorldInteraction): boolean {
  const a = `${left.summary} ${left.outcome ?? ""}`.toLowerCase();
  const b = `${right.summary} ${right.outcome ?? ""}`.toLowerCase();
  const patterns = [
    /thank you for taking my call/,
    /telephone conversation/,
    /phone call/,
    /following our (call|telephone)/,
    /called\s+[a-z]/,
    /customer called/,
    /voicemail/,
  ];
  const score = (text: string) => patterns.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source).join("|");
  return Boolean(score(a) && score(b) && score(a) !== score(b));
}

function meetingStage(item: RealWorldInteraction): number {
  const text = `${item.outcome ?? ""} ${item.summary}`.toLowerCase();
  if (/accepted|held|thank you for meeting|following our meeting/.test(text)) return 2;
  if (/requested|set up|meeting request/.test(text)) return 1;
  return 0;
}

export function canConsolidate(left: RealWorldInteraction, right: RealWorldInteraction): boolean {
  if (left.interaction_type !== right.interaction_type) return false;
  if (!sameOrganisation(left, right)) return false;

  const keyLeft = namedEventKey(left);
  const keyRight = namedEventKey(right);
  if (keyLeft && keyRight && keyLeft === keyRight) return true;

  const days = daysApart(left.approximate_date ?? left.occurred_at, right.approximate_date ?? right.occurred_at);

  if (left.interaction_type === "PHONE_CALL") {
    const nameLeft = calledName(left.summary);
    const nameRight = calledName(right.summary);
    if (nameLeft && nameRight && nameLeft !== nameRight) return false;
    if (days === undefined) return false;
    if (days > 2) return false;
    if (left.direction !== right.direction && left.direction !== "UNKNOWN" && right.direction !== "UNKNOWN") {
      return false;
    }
    return true;
  }

  if (left.interaction_type === "MEETING") {
    if (days !== undefined && days <= 1) return true;
    if (days !== undefined && days <= 30 && overlapCount(left.summary, right.summary) >= 3) return true;
    const stages = [meetingStage(left), meetingStage(right)];
    if (
      days !== undefined &&
      days <= 30 &&
      overlapCount(left.summary, right.summary) >= 2 &&
      stages[0] !== stages[1] &&
      Math.max(...stages) >= 2
    ) {
      return true;
    }
    return false;
  }

  if (left.interaction_type === "DEMO" || left.interaction_type === "POSSIBLE_INTERACTION") {
    return days !== undefined && days <= 1;
  }

  return false;
}

function rankConfidence(value: ConfidenceLevel): number {
  return value === "HIGH" ? 3 : value === "MEDIUM" ? 2 : 1;
}

function mergeGroup(group: RealWorldInteraction[]): RealWorldInteraction {
  const sorted = [...group].sort((left, right) => {
    const leftTime = Date.parse(left.approximate_date ?? left.occurred_at ?? "") || 0;
    const rightTime = Date.parse(right.approximate_date ?? right.occurred_at ?? "") || 0;
    return leftTime - rightTime;
  });
  const primary =
    sorted.find((item) => meetingStage(item) === Math.max(...sorted.map(meetingStage))) ?? sorted[0]!;
  const evidenceIds = unique(sorted.flatMap((item) => item.source_evidence_ids));
  const sourceTypes = unique(sorted.flatMap((item) => item.source_types)) as RealWorldInteraction["source_types"];
  const signals = sorted.flatMap((item) => item.commercial_signals);
  const uniqueSignals = signals.filter((signal, index) => {
    const key = `${signal.type}:${signal.text.toLowerCase()}`;
    return signals.findIndex((item) => `${item.type}:${item.text.toLowerCase()}` === key) === index;
  });
  const independentPairs = sorted.some((left, index) =>
    sorted.slice(index + 1).some((right) => isIndependentWording(left, right)),
  );
  const named = Boolean(namedEventKey(primary));
  const corroboration: RealWorldInteraction["corroboration"] = independentPairs
    ? "independent"
    : group.length > 1 && named
      ? "repeated_reference"
      : group.length > 1
        ? "independent"
        : "single";
  let confidence = sorted.reduce(
    (best, item) => (rankConfidence(item.confidence) > rankConfidence(best) ? item.confidence : best),
    primary.confidence,
  );
  if (corroboration === "independent" && rankConfidence(confidence) < 3 && group.length >= 2) {
    confidence = "HIGH";
  }
  if (corroboration === "repeated_reference") {
    confidence = sorted[0]!.confidence;
  }
  const earliest = sorted[0];
  const eventKey = namedEventKey(primary);
  return {
    ...primary,
    participants: unique(sorted.flatMap((item) => item.participants)),
    approximate_date: earliest?.approximate_date ?? primary.approximate_date,
    occurred_at: undefined,
    source_evidence_ids: evidenceIds,
    source_types: sourceTypes,
    commercial_signals: uniqueSignals,
    supporting_evidence_count: group.length,
    event_key: eventKey,
    corroboration,
    confidence,
    provenance:
      group.length > 1
        ? `${primary.provenance} Consolidated from ${group.length} references to the same event (${corroboration.replaceAll("_", " ")}); supporting evidence preserved.`
        : primary.provenance,
  };
}

/**
 * Merge extracted interactions that clearly refer to the same historical event.
 * Conservative: uncertain pairs stay separate. Two genuine calls stay separate.
 */
export function consolidateInteractions(interactions: RealWorldInteraction[]): RealWorldInteraction[] {
  const remaining = [...interactions];
  const groups: RealWorldInteraction[][] = [];
  while (remaining.length > 0) {
    const seed = remaining.shift()!;
    const group = [seed];
    let changed = true;
    while (changed) {
      changed = false;
      for (let index = remaining.length - 1; index >= 0; index -= 1) {
        const candidate = remaining[index]!;
        if (group.some((member) => canConsolidate(member, candidate))) {
          group.push(candidate);
          remaining.splice(index, 1);
          changed = true;
        }
      }
    }
    groups.push(group);
  }
  return groups
    .map(mergeGroup)
    .sort((left, right) => {
      const leftTime = Date.parse(left.approximate_date ?? left.occurred_at ?? "") || 0;
      const rightTime = Date.parse(right.approximate_date ?? right.occurred_at ?? "") || 0;
      return leftTime - rightTime;
    });
}
