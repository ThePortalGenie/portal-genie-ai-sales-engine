import type { StoredAnalysis } from "./analysis-store.js";
import type {
  CommercialWatchItem,
  CommandCentreThresholds,
  UniverseRecord,
  WatchAction,
} from "../domain/commercial-watch.js";
import { asWatchAction, DEFAULT_COMMAND_CENTRE_THRESHOLDS } from "../domain/commercial-watch.js";
import type { OrganisationDealNode, OrganisationGraph } from "../domain/organisation-graph.js";
import type { ProductId } from "../domain/product-relationship.js";
import { isCurrentProductRelationship } from "../domain/product-relationship.js";
import type { SalesEvent } from "../domain/sales-event.js";
import { eventAppliesToProduct } from "../domain/sales-event.js";
import { trailingOutboundStreak } from "./unanswered-sequences.js";
import { calendarDate, classifyInstant, formatZonedDateTime } from "./calendar-date.js";
import { deterministicWatchSignals, type WatchEvidenceInput } from "./watch-signals.js";
import { applyPriority, classifyExecutability, decideActionTiming, overrideAction } from "./priority-rank.js";
import { classifyStalled } from "./stalled-engine.js";
import { classifyDealProduct } from "./org-graph.js";
import { classifyActionabilityKind } from "./actionability.js";
import {
  classifyProductRegistration,
  refineActionForRegistration,
  registrationAwareSummary,
  registrationAwareWhy,
} from "./product-registration.js";
import { productUsageContext, suppressUsageCheckWithoutTelemetry } from "./usage-action.js";
import { applyAntiChaseToAction } from "./anti-chase.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function dealsFromListing(records?: UniverseRecord[]): OrganisationDealNode[] {
  return (records ?? [])
    .filter((item) => item.module === "Deals")
    .map((item) => {
      const stage = item.stage;
      return {
        recordId: item.recordId,
        name: item.name,
        stage,
        pipeline: item.pipeline,
        product: classifyDealProduct(item.name, item.pipeline),
        closedLost: Boolean(stage && /lost/i.test(stage)),
        closedWon: Boolean(stage && /won/i.test(stage) && !/lost/i.test(stage)),
        provenance: "universe_listing",
      };
    });
}

function mergeDeals(graphDeals: OrganisationDealNode[], listingDeals: OrganisationDealNode[]): OrganisationDealNode[] {
  const merged = [...graphDeals];
  for (const deal of listingDeals) {
    if (!merged.some((item) => item.recordId === deal.recordId)) merged.push(deal);
  }
  return merged;
}

function parseMs(value: string): number {
  return DATE_ONLY.test(value.trim()) ? Date.parse(`${value.trim()}T00:00:00Z`) : Date.parse(value);
}

function latestPastIso(values: Array<string | undefined>, asOf: string, timeZone: string): string | undefined {
  return values
    .filter((item): item is string => typeof item === "string" && item.trim() !== "" && !Number.isNaN(parseMs(item)))
    .filter((item) => classifyInstant(item, asOf, timeZone) !== "FUTURE")
    .sort((left, right) => parseMs(right) - parseMs(left))[0];
}

function earliestFutureIso(values: Array<string | undefined>, asOf: string, timeZone: string): string | undefined {
  return values
    .filter((item): item is string => typeof item === "string" && item.trim() !== "" && !Number.isNaN(parseMs(item)))
    .filter((item) => classifyInstant(item, asOf, timeZone) === "FUTURE")
    .sort((left, right) => parseMs(left) - parseMs(right))[0];
}

function oldestOverdueIso(values: Array<string | undefined>, asOf: string, timeZone: string): string | undefined {
  return values
    .filter((item): item is string => typeof item === "string" && item.trim() !== "" && !Number.isNaN(parseMs(item)))
    .filter((item) => classifyInstant(item, asOf, timeZone) === "OVERDUE")
    .sort((left, right) => parseMs(left) - parseMs(right))[0];
}

function productsForWatch(analysis: StoredAnalysis): ProductId[] {
  const deals = analysis.organisationGraph?.deals ?? [];
  const products = analysis.productRelationships ?? [];
  const pg =
    products.find((item) => item.product === "PORTAL_GENIE" && item.relationship_state !== "UNKNOWN") ||
    deals.some((deal) => deal.product === "PORTAL_GENIE" || classifyDealProduct(deal.name, deal.pipeline) === "PORTAL_GENIE") ||
    analysis.organisation?.usage.status === "matched" ||
    products.some((item) => item.product === "PORTAL_GENIE");
  const np =
    products.find((item) => item.product === "NAGGING_PANDA" && item.relationship_state !== "UNKNOWN") ||
    deals.some((deal) => deal.product === "NAGGING_PANDA" || classifyDealProduct(deal.name, deal.pipeline) === "NAGGING_PANDA");
  const out: ProductId[] = [];
  if (pg) out.push("PORTAL_GENIE");
  if (np) out.push("NAGGING_PANDA");
  if (!out.length) out.push("PORTAL_GENIE");
  return out;
}

function productEventsFor(graph: OrganisationGraph | undefined, product: ProductId): SalesEvent[] {
  return (graph?.salesEvents ?? []).filter(
    (event) => eventAppliesToProduct(event, product) || event.product_scope === "ORGANISATION_GENERAL",
  );
}

function pickNextCommitment(
  events: SalesEvent[],
  extraFuture: Array<string | undefined>,
  asOf: string,
  timeZone: string,
): { at?: string; kind?: "customer" | "operator" } {
  const dated = events.filter((event) => event.follow_up_date);
  const followDates = dated.map((event) => event.follow_up_date);
  const futureOccurred = events
    .filter((event) => classifyInstant(event.occurred_at, asOf, timeZone) === "FUTURE")
    .map((event) => event.occurred_at);
  const overdue = oldestOverdueIso(followDates, asOf, timeZone);
  if (overdue) {
    const event = dated.find((item) => item.follow_up_date === overdue);
    return {
      at: overdue,
      kind: event?.outcome === "FOLLOW_UP_REQUESTED" ? "customer" : "operator",
    };
  }
  const dueNow = followDates.find((item) => item && classifyInstant(item, asOf, timeZone) === "DUE_NOW");
  if (dueNow) {
    const event = dated.find((item) => item.follow_up_date === dueNow);
    return {
      at: dueNow,
      kind: event?.outcome === "FOLLOW_UP_REQUESTED" ? "customer" : "operator",
    };
  }
  const future = earliestFutureIso([...followDates, ...futureOccurred, ...extraFuture], asOf, timeZone);
  if (future) {
    const event =
      dated.find((item) => item.follow_up_date === future) ??
      events.find((item) => item.occurred_at === future);
    return {
      at: future,
      kind: event?.outcome === "FOLLOW_UP_REQUESTED" ? "customer" : "operator",
    };
  }
  const leftover = dated.sort((left, right) => (left.follow_up_date ?? "").localeCompare(right.follow_up_date ?? "")).at(-1);
  return leftover
    ? {
        at: leftover.follow_up_date,
        kind: leftover.outcome === "FOLLOW_UP_REQUESTED" ? "customer" : "operator",
      }
    : {};
}

function productRecommendedContact(
  graph: OrganisationGraph | undefined,
  productDeals: OrganisationDealNode[],
  productEvents: SalesEvent[],
  omit: boolean,
  analysisFallbackName?: string,
): { id?: string; name?: string; reason?: string } {
  if (omit) return {};
  const live = productDeals.find((deal) => !deal.closedLost && !deal.closedWon && deal.associatedContactId);
  const anyDeal = productDeals.find((deal) => deal.associatedContactId || deal.associatedContactName);
  const deal = live ?? anyDeal;
  if (deal?.associatedContactId || deal?.associatedContactName) {
    const node = graph?.contacts.find((item) => item.recordId === deal.associatedContactId);
    return {
      id: deal.associatedContactId ?? node?.recordId,
      name: node?.name ?? deal.associatedContactName,
      reason: "Product Deal associated contact.",
    };
  }
  const event = [...productEvents].reverse().find((item) => item.contact_id || item.contact_name);
  if (event?.contact_id || event?.contact_name) {
    const node = graph?.contacts.find((item) => item.recordId === event.contact_id);
    return {
      id: event.contact_id ?? node?.recordId,
      name: node?.name ?? event.contact_name,
      reason: "Product-specific operator sales event.",
    };
  }
  const selected = graph?.contacts.find((item) => item.selected) ?? graph?.contacts.find((item) => item.module === "Contacts");
  if (selected?.name || graph?.selectedContactName) {
    return {
      id: selected?.recordId,
      name: selected?.name ?? graph?.selectedContactName,
      reason: "No product-specific contact evidence. Fallback to the selected organisation contact.",
    };
  }
  if (analysisFallbackName?.trim()) {
    return {
      name: analysisFallbackName.trim(),
      reason: "No product-specific contact evidence. Fallback to the analysis recommended contact.",
    };
  }
  return {};
}

export function watchItemsFromAnalysis(
  analysis: StoredAnalysis,
  options: {
    asOf?: string;
    organisationId: string;
    organisationName: string;
    thresholds?: CommandCentreThresholds;
    reuse: CommercialWatchItem["reuse"];
    possibleMatchReview?: boolean;
    usageDatasetAvailable?: boolean;
    listingDeals?: UniverseRecord[];
    customerQueue?: boolean;
  },
): CommercialWatchItem[] {
  const asOf = options.asOf ?? new Date().toISOString();
  const thresholds = options.thresholds ?? DEFAULT_COMMAND_CENTRE_THRESHOLDS;
  const usageDatasetAvailable = options.usageDatasetAvailable ?? false;
  const graph = analysis.organisationGraph;
  const profile = analysis.profile;
  const emails = graph?.emails ?? [];
  const unanswered = trailingOutboundStreak(emails.map((email) => ({ at: email.at, direction: email.direction })));
  const lastInbound = latestPastIso(
    emails.filter((email) => email.direction === "inbound").map((email) => email.at ?? undefined),
    asOf,
    thresholds.timeZone,
  );
  const lastEmail = latestPastIso(
    emails.map((email) => email.at ?? undefined),
    asOf,
    thresholds.timeZone,
  );
  const lastEvent = latestPastIso((graph?.salesEvents ?? []).map((event) => event.occurred_at), asOf, thresholds.timeZone);
  const lastTimeline = latestPastIso((analysis.reconstructedTimeline ?? []).map((item) => item.at), asOf, thresholds.timeZone);
  const lastInteraction = latestPastIso((analysis.interactions ?? []).map((item) => item.occurred_at), asOf, thresholds.timeZone);
  const lastNote = latestPastIso((graph?.notes ?? []).map((note) => note.at), asOf, thresholds.timeZone);
  const lastDealTouch = latestPastIso((graph?.deals ?? []).map((deal) => deal.closingDate), asOf, thresholds.timeZone);
  const lastMeaningful = latestPastIso(
    [lastInbound, lastEmail, lastEvent, lastTimeline, lastInteraction, lastNote, lastDealTouch],
    asOf,
    thresholds.timeZone,
  );
  const meetingMissed = (graph?.salesEvents ?? []).some(
    (event) =>
      (event.outcome === "MEETING_NO_SHOW" || event.event_type === "NO_SHOW") &&
      !(graph?.salesEvents ?? []).some((later) => later.outcome === "MEETING_RESCHEDULED" && later.occurred_at >= event.occurred_at),
  );
  const meetingAgreed =
    (graph?.salesEvents ?? []).some(
      (event) => event.event_type === "MEETING" && (event.outcome === "MEETING_COMPLETED" || event.outcome === "MEETING_RESCHEDULED" || !event.outcome),
    ) || (analysis.interactions ?? []).some((item) => item.interaction_type === "MEETING");
  const usage = analysis.organisation?.usage;
  const usageUnknown = !usage || usage.label === "USAGE UNKNOWN" || usage.status !== "matched";
  const usageActive = Boolean(usage?.signals?.some((item) => item.code === "USAGE_PRESENT" || item.code === "PORTAL_CLIENT_ACTIVITY_PRESENT"));
  const usageGrowing = Boolean(usage?.signals?.some((item) => item.code === "PORTAL_CLIENT_ACTIVITY_INCREASING"));
  const accountingConnected = Boolean(usage?.signals?.some((item) => item.code === "ACCOUNTING_SOFTWARE_CONNECTED"));
  const inboundRecently = Boolean(lastInbound && daysRecent(lastInbound, asOf, 14, thresholds.timeZone));
  const fragmentation = Boolean(graph?.fragmentation?.possible_crm_fragmentation);
  const contacts = graph?.contacts.filter((item) => item.module === "Contacts") ?? [];
  const leads = graph?.contacts.filter((item) => item.module === "Leads") ?? analysis.organisation?.members.filter((item) => item.module === "Leads") ?? [];
  const selected = graph?.contacts.find((item) => item.selected) ?? contacts[0];
  const allDeals = mergeDeals(graph?.deals ?? [], dealsFromListing(options.listingDeals));
  const customerQueue = options.customerQueue !== false;

  return productsForWatch({ ...analysis, organisationGraph: graph ? { ...graph, deals: allDeals } : { deals: allDeals } as OrganisationGraph }).map((product) => {
    const productDeals = allDeals.filter(
      (deal) => deal.product === product || classifyDealProduct(deal.name, deal.pipeline) === product,
    );
    const liveDeal = productDeals.some((deal) => !deal.closedLost && !deal.closedWon);
    const historicalDealOnly = productDeals.length > 0 && !liveDeal;
    const historicalLostOnly =
      historicalDealOnly && productDeals.some((deal) => deal.closedLost) && !productDeals.some((deal) => deal.closedWon);
    const relationship =
      analysis.productRelationships?.find((item) => item.product === product)?.relationship_state ?? "UNKNOWN";
    const currentProductRelationship = isCurrentProductRelationship(relationship);
    const productEvents = productEventsFor(graph, product);
    const extraFuture = historicalLostOnly
      ? []
      : [
          ...(analysis.reconstructedTimeline ?? []).map((item) => item.at),
          ...(analysis.interactions ?? []).map((item) => item.occurred_at),
        ];
    const commitment = pickNextCommitment(productEvents, extraFuture, asOf, thresholds.timeZone);
    const scheduledInstant = classifyInstant(commitment.at, asOf, thresholds.timeZone);
    const usageContext = productUsageContext(product, { usageDatasetAvailable, usageUnknown });
    const evidence: WatchEvidenceInput = {
      asOf,
      product,
      unansweredOutboundAttempts: unanswered,
      lastMeaningfulActivityAt: lastMeaningful,
      nextCommitmentAt: commitment.at,
      nextCommitmentKind: commitment.kind,
      liveDeal,
      historicalDealOnly,
      historicalLostOnly,
      currentProductRelationship,
      meetingMissedNoReschedule: meetingMissed,
      meetingAgreed,
      usageUnknown: usageContext.usageUnknown,
      usageDatasetAvailable: usageContext.usageDatasetAvailable,
      usageActive: product === "PORTAL_GENIE" ? usageActive : false,
      usageGrowing: product === "PORTAL_GENIE" ? usageGrowing : false,
      accountingConnected: product === "PORTAL_GENIE" ? accountingConnected : false,
      multipleContacts: contacts.length > 1,
      fragmentation,
      inboundRecently,
      possibleMatchReview: Boolean(options.possibleMatchReview),
      thresholds,
    };
    const signals = deterministicWatchSignals(evidence);
    const stalled = classifyStalled(evidence);
    const registration = classifyProductRegistration(product, productDeals);
    let action: WatchAction = overrideAction(evidence, asWatchAction(profile?.recommended_action));
    action = refineActionForRegistration(action, registration);
    const antiChase = applyAntiChaseToAction(action, evidence);
    action = antiChase.action;
    if (scheduledInstant === "FUTURE") action = "WAIT";
    if (historicalLostOnly && stalled.state !== "WAITING_ON_US") action = "NO_ACTION";
    const usageResolution = suppressUsageCheckWithoutTelemetry(product, action, usageContext);
    action = usageResolution.action;
    const timing = decideActionTiming(evidence, action);
    const executability = classifyExecutability({
      action,
      timing,
      stalledState: stalled.state,
      usageDatasetAvailable: usageContext.usageDatasetAvailable,
      usageUnknown: usageContext.usageUnknown,
    });
    const actionability_kind = classifyActionabilityKind({
      action,
      executability,
      stalledState: stalled.state,
    });
    const omitContact = action === "NO_ACTION" && historicalLostOnly;
    const contact = productRecommendedContact(graph, productDeals, productEvents, omitContact, profile?.best_contact);
    const whenLabel = commitment.at ? formatZonedDateTime(commitment.at, thresholds.timeZone) ?? commitment.at : undefined;
    const why = usageResolution.suppressed
      ? usageResolution.reason ?? "Missing usage evidence is not a customer action."
      : antiChase.reason
        ? antiChase.reason
        : scheduledInstant === "FUTURE"
          ? `Wait until ${whenLabel}. Explicit commitment overrides generic urgency. Do not chase before that time.`
          : action === "NO_ACTION" && historicalLostOnly
            ? `${product === "NAGGING_PANDA" ? "Nagging Panda" : "Portal Genie"} is a historical Closed Lost relationship. It is independent of any current opportunity on the other product.`
            : profile?.recommended_action_reason || profile?.relationship_summary || "Deterministic next action from retrieved evidence.";
    const summary =
      product === "NAGGING_PANDA" && historicalLostOnly
        ? `${options.organisationName} · Nagging Panda historical Closed Lost. Independent of Portal Genie.`
        : currentProductRelationship && historicalDealOnly
          ? `${options.organisationName} · ${product.replaceAll("_", " ")} current customer relationship. Closed sales Deal stage is not the product relationship.`
          : profile?.relationship_summary || `${options.organisationName} · ${product.replaceAll("_", " ")}.`;
    return applyPriority({
      id: `${options.organisationId}:${product}`,
      organisation_id: options.organisationId,
      organisation_name: options.organisationName,
      product_scope: product,
      relationship_state: relationship,
      product_registration_state: registration.state,
      product_registration_provenance: registration.provenance,
      primary_contact_id: selected?.recordId,
      primary_contact_name: selected?.name ?? graph?.selectedContactName,
      recommended_contact_id: contact.id,
      recommended_contact_name: contact.name,
      recommended_contact_reason: contact.reason,
      deal_ids: productDeals.map((deal) => deal.recordId),
      lead_ids: leads.map((item) => item.recordId),
      contact_ids: contacts.map((item) => item.recordId),
      primary_motion: profile?.primary_opportunity.motion,
      next_best_action: action,
      actionability_kind,
      customer_queue: customerQueue,
      executability,
      decision: profile?.decision_state ?? stalled.state,
      action_timing: timing,
      action_due_at: commitment.at,
      confidence: profile?.confidence ?? "LOW",
      why_this_action: registrationAwareWhy(why, registration),
      commercial_summary: registrationAwareSummary(summary, product, registration),
      last_meaningful_activity_at: lastMeaningful,
      next_commitment_at: commitment.at,
      stalled_state: stalled.state,
      stalled_reasons: stalled.reasons,
      urgency_signals: signals.urgency,
      opportunity_signals: signals.opportunity,
      risk_signals: signals.risk,
      usage_signals: signals.usage,
      data_quality_signals: signals.dataQuality,
      evidence_refs: (analysis.evidence ?? []).map((item) => item.id).slice(0, 12),
      analysis_generated_at: analysis.analysedAt,
      source_analysis_id: `${analysis.module}-${analysis.recordId}`,
      source_record: { module: analysis.module, recordId: analysis.recordId },
      reuse: options.reuse,
      liveDeal,
    });
  });
}

function daysRecent(iso: string, asOf: string, days: number, timeZone: string): boolean {
  const from = calendarDate(iso, timeZone);
  const to = calendarDate(asOf, timeZone);
  if (!from || !to) return false;
  return Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) <= days * 86_400_000;
}
