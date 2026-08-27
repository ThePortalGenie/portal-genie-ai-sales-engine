import type { ActivationThresholds, NormalizedUsageProfile } from "../domain/normalized-usage.js";
import { DEFAULT_ACTIVATION_THRESHOLDS } from "../domain/normalized-usage.js";
import type {
  OrganisationUsageLayer,
  OrganisationUsageSummary,
  PortalVisitTrend,
  SubscriberUsageView,
  UsageContradiction,
  UsageSignal,
} from "../domain/portal-genie-usage.js";
import { emptyFieldQuality } from "../domain/portal-genie-usage.js";

export type CrmUsageContext = {
  inboundEmails: number;
  outboundEmails: number;
  lastInboundAt?: string | null;
  lastActivityAt?: string | null;
  calls: number;
  meetings: number;
  notesOrEmailsSuggestProductUse: boolean;
};

function daysBetween(iso: string | undefined, now: Date): number | undefined {
  if (!iso) return undefined;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return undefined;
  return Math.floor((now.getTime() - parsed) / 86_400_000);
}

export function portalVisitTrend(
  current?: number,
  previous?: number,
  twoMonthsAgo?: number,
  minDelta = DEFAULT_ACTIVATION_THRESHOLDS.portalVisitTrendMinDelta,
): PortalVisitTrend {
  const known = [twoMonthsAgo, previous, current].filter((value): value is number => value !== undefined);
  if (known.length < 2) return "INSUFFICIENT_DATA";
  if (current === undefined || previous === undefined || twoMonthsAgo === undefined) {
    if (known.length === 2) {
      const [first, second] = known;
      if (Math.abs(second! - first!) < minDelta) return "STABLE";
      return second! > first! ? "INCREASING" : "DECLINING";
    }
    return "INSUFFICIENT_DATA";
  }
  const later = current - previous;
  const earlier = previous - twoMonthsAgo;
  const laterMove = Math.abs(later) >= minDelta;
  const earlierMove = Math.abs(earlier) >= minDelta;
  if (!laterMove && !earlierMove) return "STABLE";
  if ((later > 0 && earlier < 0) || (later < 0 && earlier > 0)) {
    if (laterMove && earlierMove) return "MIXED";
  }
  if (current >= previous && previous >= twoMonthsAgo && (laterMove || earlierMove) && current - twoMonthsAgo >= minDelta) {
    return "INCREASING";
  }
  if (current <= previous && previous <= twoMonthsAgo && (laterMove || earlierMove) && twoMonthsAgo - current >= minDelta) {
    return "DECLINING";
  }
  if (!laterMove && !earlierMove) return "STABLE";
  return "MIXED";
}

export function displayName(profile: NormalizedUsageProfile): string | undefined {
  const parts = [profile.identity.firstName, profile.identity.surname].filter(Boolean);
  if (parts.length) return parts.join(" ");
  return profile.identity.company;
}

export function toSubscriberView(
  profile: NormalizedUsageProfile,
  options: {
    layer: SubscriberUsageView["layer"];
    matchMethod: SubscriberUsageView["matchMethod"];
    matchReason: string;
    matchedContactId?: string;
    matchedContactName?: string;
    thresholds?: ActivationThresholds;
  },
): SubscriberUsageView {
  const thresholds = options.thresholds ?? DEFAULT_ACTIVATION_THRESHOLDS;
  return {
    layer: options.layer,
    matchMethod: options.matchMethod,
    matchReason: options.matchReason,
    matchedContactId: options.matchedContactId,
    matchedContactName: options.matchedContactName,
    firstName: profile.identity.firstName,
    surname: profile.identity.surname,
    name: displayName(profile),
    email: profile.identity.primaryEmail,
    clientId: profile.identity.portalGenieAccountId,
    accountingConnected: profile.accountingConnected === undefined ? "unknown" : profile.accountingConnected,
    accountingPlatform: profile.accountingPlatform ?? profile.accountingSoftware ?? "UNKNOWN",
    lastLoginAt: profile.lastLoginAt,
    lastLoginPresence: profile.fieldQuality?.lastLoginAt ?? (profile.lastLoginAt ? "present" : "unknown"),
    portalVisitsCurrentMonth: profile.portalVisitsCurrentMonth,
    portalVisitsPreviousMonth: profile.portalVisitsPreviousMonth,
    portalVisitsTwoMonthsAgo: profile.portalVisitsTwoMonthsAgo,
    portalVisitTrend: portalVisitTrend(
      profile.portalVisitsCurrentMonth,
      profile.portalVisitsPreviousMonth,
      profile.portalVisitsTwoMonthsAgo,
      thresholds.portalVisitTrendMinDelta,
    ),
    documentUploadUsage: profile.documentUploadUsage,
    documentUploadPresence: profile.fieldQuality?.documentUploadUsage ?? (profile.documentUploadUsage ? "present" : "unknown"),
    dataQuality: profile.fieldQuality ?? emptyFieldQuality(),
    warnings: profile.warnings ?? [],
  };
}

function profileHasProductActivity(view: SubscriberUsageView): boolean {
  return (
    view.accountingConnected === true ||
    Boolean(view.lastLoginAt) ||
    (view.portalVisitsCurrentMonth ?? 0) > 0 ||
    (view.portalVisitsPreviousMonth ?? 0) > 0 ||
    (view.portalVisitsTwoMonthsAgo ?? 0) > 0 ||
    (view.documentUploadUsage?.value ?? 0) > 0
  );
}

function profileActivated(view: SubscriberUsageView): boolean {
  return (
    view.accountingConnected === true ||
    (view.portalVisitsCurrentMonth ?? 0) > 0 ||
    (view.documentUploadUsage?.value ?? 0) > 0
  );
}

export function signalsForView(
  view: SubscriberUsageView,
  now: Date,
  thresholds: ActivationThresholds,
): UsageSignal[] {
  const signals: UsageSignal[] = [];
  const recency = daysBetween(view.lastLoginAt, now);
  if (view.accountingConnected === true) {
    signals.push({
      code: "ACCOUNTING_SOFTWARE_CONNECTED",
      layer: view.layer,
      message: `${view.name ?? view.email ?? "Subscriber"} accounting software is connected (${view.accountingPlatform}).`,
    });
  } else if (view.accountingConnected === false) {
    signals.push({
      code: "ACCOUNTING_SOFTWARE_NOT_CONNECTED",
      layer: view.layer,
      message: `${view.name ?? view.email ?? "Subscriber"} accounting software is explicitly not connected.`,
    });
  }
  if (recency !== undefined && recency <= thresholds.recentLoginDays) {
    signals.push({
      code: "RECENT_LOGIN",
      layer: view.layer,
      message: `Subscriber last login ${recency} day(s) ago (recentLoginDays=${thresholds.recentLoginDays}).`,
    });
  } else if (recency !== undefined && recency >= thresholds.staleLoginDays) {
    signals.push({
      code: "LOGIN_STALE",
      layer: view.layer,
      message: `Subscriber last login ${recency} day(s) ago (staleLoginDays=${thresholds.staleLoginDays}). This is not the same as client portal visits.`,
    });
  }
  const currentKnown = view.portalVisitsCurrentMonth !== undefined;
  const anyVisits =
    (view.portalVisitsCurrentMonth ?? 0) > 0 ||
    (view.portalVisitsPreviousMonth ?? 0) > 0 ||
    (view.portalVisitsTwoMonthsAgo ?? 0) > 0;
  if (anyVisits) {
    signals.push({
      code: "PORTAL_CLIENT_ACTIVITY_PRESENT",
      layer: view.layer,
      message: "Client portal visits are present. Portal visits = visits by the subscriber's clients.",
    });
  } else if (currentKnown && view.portalVisitsCurrentMonth === 0) {
    signals.push({
      code: "PORTAL_CLIENT_ACTIVITY_ZERO",
      layer: view.layer,
      message: "Current-month client portal visits are a known zero, not unknown.",
    });
  }
  if (view.portalVisitTrend === "INCREASING") {
    signals.push({
      code: "PORTAL_CLIENT_ACTIVITY_INCREASING",
      layer: view.layer,
      message: "Three-month client portal visits are increasing beyond the configured trend tolerance.",
    });
  }
  if (view.portalVisitTrend === "DECLINING") {
    signals.push({
      code: "PORTAL_CLIENT_ACTIVITY_DECLINING",
      layer: view.layer,
      message: "Three-month client portal visits are declining beyond the configured trend tolerance.",
    });
  }
  if (view.documentUploadPresence === "present") {
    signals.push({
      code: "DOCUMENT_UPLOAD_USAGE_PRESENT",
      layer: view.layer,
      message: `Document upload data used: ${view.documentUploadUsage?.original ?? view.documentUploadUsage?.value}.`,
    });
  } else if (view.documentUploadPresence === "zero") {
    signals.push({
      code: "DOCUMENT_UPLOAD_USAGE_ZERO",
      layer: view.layer,
      message: "Document upload usage is a known zero, not unknown.",
    });
  }
  if (profileHasProductActivity(view) || view.accountingConnected === false || view.lastLoginPresence === "present") {
    signals.push({
      code: "USAGE_PRESENT",
      layer: view.layer,
      message: "A Portal Genie usage profile is present for this subscriber.",
    });
  }
  return signals;
}

function crmQuiet(crm: CrmUsageContext, now: Date, thresholds: ActivationThresholds): boolean {
  const recency = daysBetween(crm.lastInboundAt ?? crm.lastActivityAt ?? undefined, now);
  const noInbound = crm.inboundEmails === 0 || (recency !== undefined && recency >= thresholds.crmQuietAfterDays);
  return noInbound && crm.calls === 0 && crm.meetings === 0;
}

function crmEngaged(crm: CrmUsageContext): boolean {
  return crm.inboundEmails > 0 || crm.calls > 0 || crm.meetings > 0;
}

function limitedSalesActivity(crm: CrmUsageContext, now: Date, thresholds: ActivationThresholds): boolean {
  return crmQuiet(crm, now, thresholds) && crm.outboundEmails <= 2;
}

export function contradictionsForOrganisation(options: {
  views: SubscriberUsageView[];
  unmatchedContactCount: number;
  crm: CrmUsageContext;
  now?: Date;
  thresholds?: ActivationThresholds;
}): UsageContradiction[] {
  const thresholds = options.thresholds ?? DEFAULT_ACTIVATION_THRESHOLDS;
  const now = options.now ?? new Date();
  const views = options.views;
  const contradictions: UsageContradiction[] = [];
  if (views.length === 0) {
    if (options.crm.notesOrEmailsSuggestProductUse) {
      contradictions.push({
        code: "CUSTOMER_COMMUNICATION_SAYS_ACTIVE_BUT_USAGE_UNKNOWN",
        message: "CRM notes or emails suggest product activity, but no Portal Genie usage profile matched. Usage is unknown, not zero.",
      });
    }
    return contradictions;
  }
  const productActive = views.some(profileHasProductActivity);
  const accountingConnected = views.some((view) => view.accountingConnected === true);
  const lowPortal =
    views.every(
      (view) =>
        (view.portalVisitsCurrentMonth === undefined || view.portalVisitsCurrentMonth === 0) &&
        (view.portalVisitsPreviousMonth === undefined || view.portalVisitsPreviousMonth === 0),
    ) && views.some((view) => view.portalVisitsCurrentMonth === 0);
  const notActivated = views.every((view) => !profileActivated(view));
  const staleLoginActiveClients = views.some(
    (view) => view.lastLoginPresence === "present" && signalsForView(view, now, thresholds).some((item) => item.code === "LOGIN_STALE") &&
      ((view.portalVisitsCurrentMonth ?? 0) > 0 || (view.portalVisitsPreviousMonth ?? 0) > 0),
  );
  const growing = views.some((view) => view.portalVisitTrend === "INCREASING");

  if (crmQuiet(options.crm, now, thresholds) && productActive) {
    contradictions.push({
      code: "CRM_QUIET_BUT_PRODUCT_ACTIVE",
      message: "CRM engagement is quiet while Portal Genie product behaviour is present. Do not treat CRM silence as product inactivity.",
    });
  }
  if (crmEngaged(options.crm) && notActivated) {
    contradictions.push({
      code: "CRM_ENGAGED_BUT_PRODUCT_NOT_ACTIVATED",
      message: "CRM shows engagement, but imported usage does not show accounting connection, client portal visits, or document uploads.",
    });
  }
  if (accountingConnected && lowPortal) {
    contradictions.push({
      code: "CUSTOMER_CONNECTED_ACCOUNTING_BUT_LOW_PORTAL_ACTIVITY",
      message: "Accounting software is connected while current client portal visits are a known zero or missing recent visits.",
    });
  }
  if (staleLoginActiveClients) {
    contradictions.push({
      code: "CUSTOMER_NOT_LOGGING_IN_BUT_CLIENT_PORTAL_ACTIVITY_EXISTS",
      message: "Subscriber login is stale, but clients are still visiting the portal. Do not automatically call the customer inactive.",
    });
  }
  if (growing && limitedSalesActivity(options.crm, now, thresholds)) {
    contradictions.push({
      code: "USAGE_GROWING_DESPITE_LIMITED_SALES_ACTIVITY",
      message: "Client portal visits are increasing while CRM sales activity is limited.",
    });
  }
  return contradictions;
}

export function summariseOrganisationUsage(options: {
  contactProfiles: SubscriberUsageView[];
  organisationDiscoveredProfiles: SubscriberUsageView[];
  unmatchedContacts: OrganisationUsageLayer["unmatchedContacts"];
  importedAt?: string;
}): OrganisationUsageSummary {
  const profiles = [...options.contactProfiles, ...options.organisationDiscoveredProfiles];
  const connected = profiles.filter((item) => item.accountingConnected === true).length;
  const notConnected = profiles.filter((item) => item.accountingConnected === false).length;
  const unknownAccounting = profiles.filter((item) => item.accountingConnected === "unknown").length;
  const clientPortalActivityPresent = profiles.some(
    (item) =>
      (item.portalVisitsCurrentMonth ?? 0) > 0 ||
      (item.portalVisitsPreviousMonth ?? 0) > 0 ||
      (item.portalVisitsTwoMonthsAgo ?? 0) > 0,
  );
  const clientPortalActivityUnknown = profiles.length > 0 && profiles.every((item) => item.portalVisitsCurrentMonth === undefined);
  const latestLoginAt = profiles
    .map((item) => item.lastLoginAt)
    .filter((item): item is string => Boolean(item))
    .sort()
    .at(-1);
  const trendValues = profiles.map((item) => item.portalVisitTrend);
  const portalVisitTrendValue: PortalVisitTrend = trendValues.includes("INCREASING") && !trendValues.includes("DECLINING")
    ? "INCREASING"
    : trendValues.includes("DECLINING") && !trendValues.includes("INCREASING")
      ? "DECLINING"
      : trendValues.includes("MIXED") || (trendValues.includes("INCREASING") && trendValues.includes("DECLINING"))
        ? "MIXED"
        : trendValues.includes("STABLE")
          ? "STABLE"
          : "INSUFFICIENT_DATA";
  const documentUploadPresent = profiles.some((item) => item.documentUploadPresence === "present");
  const documentUploadZero = !documentUploadPresent && profiles.some((item) => item.documentUploadPresence === "zero");
  const documentUploadUnknown = profiles.length === 0 || (!documentUploadPresent && !documentUploadZero);
  const label = profiles.length > 0 ? "USAGE MATCHED" : "USAGE UNKNOWN";
  const parts = [
    `${profiles.length} Portal Genie subscriber profile${profiles.length === 1 ? "" : "s"} discovered`,
    `${options.contactProfiles.length} matched to a CRM Contact`,
    options.unmatchedContacts.length
      ? `${options.unmatchedContacts.length} CRM Contact${options.unmatchedContacts.length === 1 ? "" : "s"} with no matching usage profile`
      : undefined,
    connected > 0 ? "at least one accounting integration connected" : undefined,
    clientPortalActivityPresent ? "client portal activity present" : clientPortalActivityUnknown ? "client portal activity unknown" : undefined,
  ].filter(Boolean);
  return {
    product: "PORTAL_GENIE",
    label,
    subscriberProfileCount: profiles.length,
    contactMatchedCount: options.contactProfiles.length,
    organisationDiscoveredCount: options.organisationDiscoveredProfiles.length,
    contactsWithoutUsage: options.unmatchedContacts.length,
    accountingConnectedCount: connected,
    accountingNotConnectedCount: notConnected,
    accountingUnknownCount: unknownAccounting,
    clientPortalActivityPresent,
    clientPortalActivityUnknown,
    latestLoginAt,
    portalVisitTrend: portalVisitTrendValue,
    documentUploadPresent,
    documentUploadZero,
    documentUploadUnknown,
    message:
      profiles.length === 0
        ? "USAGE UNKNOWN — no Portal Genie usage profile was matched. Usage is unknown, not zero."
        : `${parts.join("; ")}. Portal visits = visits by the subscriber's clients. Personal usage was not transferred between Contacts.`,
  };
}

export function usageTimelineEvents(views: SubscriberUsageView[]): Array<{ at: string; title: string; source: string; kind: "usage" }> {
  const events: Array<{ at: string; title: string; source: string; kind: "usage" }> = [];
  for (const view of views) {
    if (view.lastLoginAt) {
      events.push({
        at: view.lastLoginAt,
        title: `Portal Genie subscriber last login (${view.name ?? view.email ?? view.clientId ?? "subscriber"})`,
        source: "USAGE",
        kind: "usage",
      });
    }
  }
  return events;
}

export function organisationSignals(
  views: SubscriberUsageView[],
  now: Date,
  thresholds: ActivationThresholds,
): UsageSignal[] {
  if (!views.length) {
    return [
      {
        code: "USAGE_UNKNOWN",
        layer: "organisation",
        message: "USAGE UNKNOWN — no matched Portal Genie usage profile. Unknown is not zero.",
      },
    ];
  }
  return views.flatMap((view) => signalsForView(view, now, thresholds));
}
