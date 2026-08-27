import type { UsageMomentum } from "./journey.js";
import type { SignalStrength } from "./commercial-position.js";
import type {
  ActivationThresholds,
  InitialActivationState,
  NormalizedUsageProfile,
} from "./normalized-usage.js";
import { DEFAULT_ACTIVATION_THRESHOLDS } from "./normalized-usage.js";

export type Indicator<T> = {
  present: boolean;
  value: T | null;
};

export type LeadingIndicators = {
  registered: Indicator<boolean>;
  accountingConnected: Indicator<boolean>;
  portalVisitsLast30Days: Indicator<number>;
  lastVisitAt: Indicator<string>;
  paymentsProcessed: Indicator<number>;
  documentsViewed: Indicator<number>;
  emailsSent: Indicator<number>;
  usageRecencyDays: Indicator<number>;
  usageFrequencyLast30Days: Indicator<number>;
  usageMomentum: Indicator<UsageMomentum>;
  activationState: Indicator<InitialActivationState>;
  payingStatus: Indicator<boolean>;
};

function indicator<T>(value: T | undefined | null): Indicator<T> {
  if (value === undefined || value === null) {
    return { present: false, value: null };
  }
  return { present: true, value };
}

function daysBetween(iso: string, now: Date): number | undefined {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return Math.floor((now.getTime() - parsed) / 86_400_000);
}

function lastActivityAt(profile: NormalizedUsageProfile): string | undefined {
  return profile.lastMeaningfulActivityAt ?? profile.lastVisitAt ?? profile.accountingConnectedAt ?? profile.registrationDate;
}

function meaningfulActionCount(profile: NormalizedUsageProfile): number {
  const payments = profile.paymentsProcessed ?? profile.paymentsLast30Days ?? 0;
  const documents = profile.documentsViewed ?? profile.documentsViewedLast30Days ?? 0;
  const emails = profile.emailsSent ?? profile.emailsSentLast30Days ?? 0;
  return (payments > 0 ? 1 : 0) + (documents > 0 ? 1 : 0) + (emails > 0 ? 1 : 0);
}

function hasAnyActivity(profile: NormalizedUsageProfile): boolean {
  return Boolean(
    profile.lastVisitAt ||
      (profile.visitsLast7Days ?? 0) > 0 ||
      (profile.visitsLast30Days ?? 0) > 0 ||
      (profile.paymentsProcessed ?? 0) > 0 ||
      (profile.documentsViewed ?? 0) > 0 ||
      (profile.emailsSent ?? 0) > 0 ||
      profile.lastMeaningfulActivityAt,
  );
}

export function classifyUsageMomentum(
  profile: NormalizedUsageProfile,
  now: Date,
  thresholds: ActivationThresholds,
): UsageMomentum {
  const recency = profile.lastVisitAt
    ? daysBetween(profile.lastVisitAt, now)
    : profile.lastMeaningfulActivityAt
      ? daysBetween(profile.lastMeaningfulActivityAt, now)
      : undefined;
  const visits30 = profile.visitsLast30Days;
  const visits7 = profile.visitsLast7Days;

  if (!hasAnyActivity(profile) && profile.accountingConnected !== true) {
    return profile.registrationDate || profile.identity.portalGenieAccountId ? "never_activated" : "unknown";
  }
  if (recency !== undefined && recency >= thresholds.dormantAfterDays) {
    return "dormant";
  }
  if (visits30 !== undefined && visits7 !== undefined && visits30 > 0) {
    const expectedWeekly = visits30 / (30 / 7);
    if (expectedWeekly > 0 && visits7 < expectedWeekly * thresholds.decliningVisitRatio) {
      return "declining";
    }
    if (expectedWeekly > 0 && visits7 >= expectedWeekly * 2) {
      return "rapidly_increasing";
    }
    if (expectedWeekly > 0 && visits7 > expectedWeekly) {
      return "increasing";
    }
    return "stable";
  }
  return "unknown";
}

export function classifyActivationState(
  profile: NormalizedUsageProfile,
  now: Date,
  thresholds: ActivationThresholds = DEFAULT_ACTIVATION_THRESHOLDS,
): { state: InitialActivationState; reasons: string[] } {
  const reasons: string[] = [];
  const registered = Boolean(profile.registrationDate || profile.identity.portalGenieAccountId);
  const connected = profile.accountingConnected === true;
  const visits30 = profile.visitsLast30Days ?? 0;
  const visits7 = profile.visitsLast7Days;
  const recencySource = lastActivityAt(profile);
  const recency = recencySource ? daysBetween(recencySource, now) : undefined;
  const actions = meaningfulActionCount(profile);
  const activity = hasAnyActivity(profile);
  const momentum = classifyUsageMomentum(profile, now, thresholds);

  if (!registered && !activity && !connected) {
    return { state: "unknown", reasons: ["Insufficient usage fields to classify activation"] };
  }

  if (registered && !connected && !activity) {
    reasons.push("Registered with no accounting connection and no recorded product activity");
    return { state: "never_activated", reasons };
  }

  if (activity && recency !== undefined && recency >= thresholds.dormantAfterDays) {
    reasons.push(`Last activity ${recency} days ago (dormantAfterDays=${thresholds.dormantAfterDays})`);
    return { state: "dormant", reasons };
  }

  if (momentum === "declining") {
    reasons.push(
      `Visit rate last 7 days (${visits7 ?? "n/a"}) is below the configurable declining ratio versus last 30 days (${visits30})`,
    );
    return { state: "declining", reasons };
  }

  if (visits30 >= thresholds.highlyActiveMinVisitsLast30Days && actions >= 1) {
    reasons.push(
      `Visits last 30 days ${visits30} >= highlyActiveMinVisitsLast30Days ${thresholds.highlyActiveMinVisitsLast30Days}`,
    );
    return { state: "highly_active", reasons };
  }

  if (visits30 >= thresholds.activeMinVisitsLast30Days) {
    reasons.push(
      `Visits last 30 days ${visits30} >= activeMinVisitsLast30Days ${thresholds.activeMinVisitsLast30Days}`,
    );
    return { state: "active", reasons };
  }

  const activatedByActions = actions >= thresholds.activatedMinMeaningfulActions;
  const activatedByConnection = !thresholds.activatedRequiresAccountingConnection || connected;
  if (activatedByActions && activatedByConnection) {
    reasons.push("Meaningful workflow proxies present (payments, documents, or emails)");
    if (connected) reasons.push("Accounting software connected");
    return { state: "activated", reasons };
  }

  if (connected) {
    reasons.push("Accounting software connected; first-value workflow not yet evidenced");
    return { state: "accounting_connected", reasons };
  }

  if (activity) {
    reasons.push("Some portal activity without accounting connection");
    return { state: "setup_started", reasons };
  }

  if (registered) {
    reasons.push("Registration present");
    return { state: "registered", reasons };
  }

  return { state: "unknown", reasons: ["Insufficient usage fields to classify activation"] };
}

export function deriveLeadingIndicators(
  profile: NormalizedUsageProfile,
  now: Date = new Date(),
  thresholds: ActivationThresholds = DEFAULT_ACTIVATION_THRESHOLDS,
): LeadingIndicators {
  const activation = classifyActivationState(profile, now, thresholds);
  const recencySource = lastActivityAt(profile);
  const recency = recencySource ? daysBetween(recencySource, now) : undefined;
  return {
    registered: indicator(Boolean(profile.registrationDate || profile.identity.portalGenieAccountId)),
    accountingConnected: indicator(profile.accountingConnected),
    portalVisitsLast30Days: indicator(profile.visitsLast30Days),
    lastVisitAt: indicator(profile.lastVisitAt),
    paymentsProcessed: indicator(profile.paymentsProcessed),
    documentsViewed: indicator(profile.documentsViewed),
    emailsSent: indicator(profile.emailsSent),
    usageRecencyDays: indicator(recency),
    usageFrequencyLast30Days: indicator(profile.visitsLast30Days),
    usageMomentum: indicator(classifyUsageMomentum(profile, now, thresholds)),
    activationState: { present: activation.state !== "unknown", value: activation.state },
    payingStatus: indicator(profile.payingStatus),
  };
}

export function usageStrengthFromActivation(state: InitialActivationState): SignalStrength {
  if (state === "unknown") return "unknown";
  if (state === "highly_active" || state === "active" || state === "activated") return "high";
  return "low";
}
