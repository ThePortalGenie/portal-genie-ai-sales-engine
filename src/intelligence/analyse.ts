import { resetEvidenceIds, type EvidenceItem } from "../domain/evidence.js";
import type { OrganisationGraph } from "../domain/organisation-graph.js";
import type { DiscoveryDiagnostic } from "../integrations/zoho/types.js";
import type { ZohoCrmReader } from "../integrations/zoho/client.js";
import { buildTimeline } from "../web/timeline.js";
import { buildContactIntelligence } from "./contact-intelligence.js";
import { loadPublicEmailDomains } from "./email-domains.js";
import { discoverOrgCandidates } from "./org-discovery.js";
import { buildOrganisationEvidenceProfile } from "./org-intelligence.js";
import { resolveOrganisation, type OrgCandidate } from "./org-resolution.js";
import { buildCommercialReasoningContext } from "./reasoning-context.js";
import type { CommercialReasoner } from "./openai-reasoner.js";
import { OpenAiReasonerError } from "./openai-reasoner.js";
import { ProfileValidationError } from "./profile-schema.js";
import { PROFILE_SCHEMA_VERSION } from "../domain/commercial-intelligence.js";
import { salesEngineWrittenZohoNoteIds } from "../integrations/zoho/write-back.js";
import { organisationKey } from "../domain/sales-event.js";
import type { NormalizedUsageProfile } from "../domain/normalized-usage.js";
import { loadImportedUsageProfiles, loadUsageImportMeta, matchUsageForOrganisation } from "./usage-match.js";
import { usageTimelineEvents, type CrmUsageContext } from "./usage-signals.js";
import { reconstructFromSources } from "./interaction-extraction.js";
import { buildProductRelationships, detectProductContradictions } from "./product-relationships.js";
import { createRequestCachedClient } from "./request-cache.js";
import { loadOrgExpansionLimits } from "./org-expansion-limits.js";
import { expandOrganisationGraph } from "./org-graph-expand.js";
import {
  applyOrganisationDealProducts,
  assembleOrganisationGraph,
  contactNodeFromMember,
  dealSignalsFromGraphDeals,
  membersFromGraph,
} from "./org-graph.js";
import { listSalesEvents } from "./sales-event-store.js";
import { listOperatorDecisions } from "./operator-decision-store.js";
import { buildSalesEventEvidence, salesEventsToTimeline } from "./sales-event-digest.js";
import {
  buildOperatorContextEvidence,
  contextAddedDecisionsForOrganisation,
} from "./operator-context-digest.js";
import type { StoredAnalysis } from "./analysis-store.js";

export type AnalyseInput = {
  module: string;
  recordId: string;
  diagnostic: DiscoveryDiagnostic;
  client: ZohoCrmReader;
  reasoner: CommercialReasoner;
  model: string;
  usageProfiles?: NormalizedUsageProfile[];
  usageImportedAt?: string;
  publicDomains?: Set<string>;
};

function attributedFromEmail(
  email: {
    messageId: string | null;
    threadId: string | null;
    at: string | null;
    direction: string;
    subject: string | null;
    currentMessageText?: string | null;
    bodyText?: string | null;
    quoteStrippingConfidence?: string;
    ownerName?: string;
    ownerRecordId?: string;
  },
  ownerName: string,
  ownerRecordId: string,
) {
  return {
    messageId: email.messageId,
    threadId: email.threadId,
    at: email.at,
    direction: email.direction,
    subject: email.subject,
    currentMessageText: email.currentMessageText || email.bodyText || "",
    bodyText: email.bodyText,
    quoteStrippingConfidence: email.quoteStrippingConfidence,
    ownerName: email.ownerName ?? ownerName,
    ownerRecordId: email.ownerRecordId ?? ownerRecordId,
  };
}

function fallbackGraph(options: {
  selected: OrgCandidate;
  resolution: ReturnType<typeof resolveOrganisation>;
  diagnostic: DiscoveryDiagnostic;
  contactName: string;
  cache: { hits: number; misses: number };
}): OrganisationGraph {
  return assembleOrganisationGraph({
    selectedContactId: options.selected.recordId,
    selectedContactName: options.selected.name,
    organisationName: options.resolution.identity.name,
    domains: options.resolution.identity.domains,
    certainty: options.resolution.identity.certainty,
    contacts: options.resolution.members
      .filter((member) => member.module !== "Accounts")
      .map((member) => contactNodeFromMember(member)),
    accounts: [],
    deals: [],
    notes: [],
    emails: (options.diagnostic.emails.normalized ?? []).map((email) => ({
      ...email,
      ownerRecordId: options.selected.recordId,
      ownerName: options.contactName,
    })),
    omissions: [{ kind: "contacts", omitted: 0, reason: "Organisation expansion unavailable; selected Contact evidence only" }],
    cache: options.cache,
  });
}

export async function analyseRelationship(input: AnalyseInput): Promise<StoredAnalysis> {
  resetEvidenceIds();
  const publicDomains = input.publicDomains ?? loadPublicEmailDomains();
  const cached = createRequestCachedClient(input.client);
  const client = cached.client;
  const contact = buildContactIntelligence(input.diagnostic, publicDomains);
  const selected: OrgCandidate = {
    module:
      contact.identity.module === "Leads" || contact.identity.module === "Accounts" ? contact.identity.module : "Contacts",
    recordId: contact.identity.recordId,
    name: contact.identity.name,
    email: contact.identity.email,
    company: contact.identity.organisation,
    accountId: contact.identity.accountId,
    lastActivity: contact.identity.createdAt,
    title: contact.identity.jobTitle,
  };

  let discovered: Awaited<ReturnType<typeof discoverOrgCandidates>> = { candidates: [], accountNotes: [], accountDeals: [] };
  try {
    discovered = await discoverOrgCandidates({ client, selected, publicDomains });
  } catch {
    discovered = { candidates: [], accountNotes: [], accountDeals: [] };
  }

  const resolution = resolveOrganisation(selected, discovered.candidates, publicDomains);
  let graph: OrganisationGraph;
  try {
    graph = await expandOrganisationGraph({
      client,
      selected,
      resolution,
      selectedDiagnostic: input.diagnostic,
      publicDomains,
      limits: loadOrgExpansionLimits(),
      cacheStats: cached.stats,
    });
  } catch {
    graph = fallbackGraph({
      selected,
      resolution,
      diagnostic: input.diagnostic,
      contactName: contact.identity.name,
      cache: cached.stats,
    });
  }

  const organisationId = organisationKey({
    domains: graph.domains,
    zohoAccountId: graph.accounts[0]?.recordId ?? contact.identity.accountId,
    selectedModule: input.module,
    selectedRecordId: input.recordId,
  });
  const salesEvents = listSalesEvents({
    organisationIds: [organisationId, `contact:${input.module}:${input.recordId}`],
    contactIds: [contact.identity.recordId, ...graph.contacts.map((item) => item.recordId)],
  });
  const operatorContextDecisions = contextAddedDecisionsForOrganisation(
    listOperatorDecisions({ organisation_key: organisationId }),
    organisationId,
  );
  graph = { ...graph, organisationId, salesEvents };

  const members = membersFromGraph(graph, resolution.members);
  const usageMeta = loadUsageImportMeta();
  const crmUsage: CrmUsageContext = {
    inboundEmails: graph.emails.filter((email) => email.direction === "inbound").length || contact.emails.inboundCount,
    outboundEmails: graph.emails.filter((email) => email.direction === "outbound").length || contact.emails.outboundCount,
    lastInboundAt:
      graph.emails
        .filter((email) => email.direction === "inbound" && email.at)
        .map((email) => email.at as string)
        .sort()
        .at(-1) ?? contact.emails.lastAt,
    lastActivityAt: contact.identity.createdAt,
    calls: contact.calls,
    meetings: contact.meetings,
    notesOrEmailsSuggestProductUse: communicationSuggestsProductUse(graph, contact),
  };
  const usage = matchUsageForOrganisation(members, input.usageProfiles ?? loadImportedUsageProfiles(), {
    orgDomains: graph.domains,
    orgPortalGenieId: resolution.identity.portalGenieOrgId,
    publicDomains,
    crm: crmUsage,
    importedAt: input.usageImportedAt ?? usageMeta.importedAt,
  });
  graph = { ...graph, portalGenieUsage: usage.layer };
  const timeline = buildTimeline(input.diagnostic).map((event) => ({
    at: event.at,
    title: event.title,
    source: event.type,
  }));
  const graphDealSignals = dealSignalsFromGraphDeals(graph.deals);
  const writtenNoteIds = salesEngineWrittenZohoNoteIds();
  const crmNotes = graph.notes.filter((note) => !(note.id && writtenNoteIds.has(note.id)));
  const organisation = buildOrganisationEvidenceProfile({
    resolution: { ...resolution, members, evidence: resolution.evidence },
    selectedNotes: crmNotes.length
      ? crmNotes.map((note) => ({ id: note.id, title: note.title, content: note.content, at: note.at }))
      : contact.notes,
    selectedDeals: graphDealSignals.count > 0 ? graphDealSignals : contact.deals,
    selectedEmails: {
      outboundCount: graph.emails.length
        ? graph.emails.filter((email) => email.direction === "outbound").length
        : contact.emails.outboundCount,
      inboundCount: graph.emails.length
        ? graph.emails.filter((email) => email.direction === "inbound").length
        : contact.emails.inboundCount,
      lastAt: contact.emails.lastAt,
    },
    accountNotes: discovered.accountNotes,
    accountDeals: discovered.accountDeals,
    timeline,
    usage,
  });
  if (graphDealSignals.count > 0) {
    organisation.deals = graphDealSignals;
  }
  organisation.notes = crmNotes.length
    ? crmNotes.map((note) => ({
        id: note.id,
        title: note.title,
        content: note.content,
        at: note.at,
        source: `Zoho ${note.ownerModule} Notes (${note.ownerName ?? note.ownerRecordId})`,
      }))
    : organisation.notes;

  const reconstruction = reconstructFromSources({
    notes: crmNotes.length
      ? crmNotes.map((note) => ({
          id: note.id,
          title: note.title,
          content: note.content,
          at: note.at,
          ownerName: note.ownerName,
          ownerRecordId: note.ownerRecordId,
        }))
      : [
          ...contact.notes,
          ...discovered.accountNotes.map((note) => ({
            id: typeof note.id === "string" ? note.id : undefined,
            title: typeof note.Note_Title === "string" ? note.Note_Title : undefined,
            content: typeof note.Note_Content === "string" ? note.Note_Content : undefined,
            at: typeof note.Created_Time === "string" ? note.Created_Time : undefined,
          })),
        ],
    emails: (graph.emails.length ? graph.emails : input.diagnostic.emails.normalized ?? []).map((email) =>
      attributedFromEmail(email, contact.identity.name, contact.identity.recordId),
    ),
    organisation: graph.organisationName ?? contact.identity.organisation,
    zohoCalls: contact.calls,
    zohoMeetings: contact.meetings,
    emailOutbound: organisation.emailSummary.selectedOutbound,
    emailInbound: organisation.emailSummary.selectedInbound,
    leadSource: contact.identity.source,
    crmEvents: [
      ...timeline,
      ...graph.deals
        .filter((deal) => deal.closingDate)
        .map((deal) => ({
          at: deal.closingDate!,
          title: `Deal ${deal.name ?? deal.recordId} (${deal.stage ?? "unknown stage"})`,
          source: "Deals",
        })),
    ],
  });
  reconstruction.timeline = [
    ...reconstruction.timeline,
    ...salesEventsToTimeline(salesEvents).filter(
      (event) => !reconstruction.timeline.some((item) => item.interactionId === event.interactionId),
    ),
    ...usageTimelineEvents([
      ...(usage.layer?.contactProfiles ?? []),
      ...(usage.layer?.organisationDiscoveredProfiles ?? []),
    ]).map((event) => ({
      at: event.at,
      approximate: false,
      kind: "usage" as const,
      title: event.title,
      source: event.source,
    })),
  ].sort((left, right) => (left.at ? Date.parse(left.at) : 0) - (right.at ? Date.parse(right.at) : 0));

  const evidence: EvidenceItem[] = [
    ...contact.evidence,
    ...organisation.evidence,
    ...reconstruction.evidence,
    ...buildSalesEventEvidence(salesEvents),
    ...buildOperatorContextEvidence(operatorContextDecisions),
  ];
  const productEmails = (graph.emails.length ? graph.emails : input.diagnostic.emails.normalized ?? []).map((email) => ({
    subject: email.subject,
    currentMessageText: email.currentMessageText,
    bodyText: email.bodyText,
  }));
  const productBundle = buildProductRelationships({
    organisation,
    deals: organisation.deals,
    emails: productEmails,
    evidence,
    leadSource: contact.identity.source,
  });
  productBundle.products = applyOrganisationDealProducts(productBundle.products, graph.deals);
  const contradictions = detectProductContradictions({
    products: productBundle.products,
    deals: organisation.deals,
    usage: organisation.usage,
  });
  const context = buildCommercialReasoningContext({
    contact,
    organisation,
    emails: (graph.emails.length ? graph.emails : input.diagnostic.emails.normalized ?? []).map((email) => {
      const mapped = attributedFromEmail(email, contact.identity.name, contact.identity.recordId);
      return {
        at: mapped.at,
        direction: mapped.direction,
        subject: mapped.subject,
        bodyText: mapped.bodyText,
        currentMessageText: mapped.currentMessageText,
        quoteStrippingConfidence: mapped.quoteStrippingConfidence,
        messageId: mapped.messageId,
        ownerName: mapped.ownerName,
        ownerRecordId: mapped.ownerRecordId,
      };
    }),
    evidence,
    reconstruction,
    products: productBundle.products,
    organisationRelationship: productBundle.organisationRelationship,
    contradictions,
    graph,
    salesEvents,
    operatorContextDecisions,
  });

  const started = Date.now();
  try {
    const result = await input.reasoner.reason(context);
    return {
      analysedAt: new Date().toISOString(),
      module: input.module,
      recordId: input.recordId,
      schemaVersion: PROFILE_SCHEMA_VERSION,
      model: result.model,
      requestId: result.requestId,
      usage: result.usage,
      latencyMs: result.latencyMs,
      success: true,
      profile: result.profile,
      organisation,
      organisationGraph: graph,
      evidence,
      interactions: reconstruction.interactions,
      reconstructedTimeline: reconstruction.timeline,
      productRelationships: productBundle.products,
      organisationRelationship: productBundle.organisationRelationship,
      omittedDueToBudget: context.omitted_due_to_budget,
    };
  } catch (error) {
    const message =
      error instanceof ProfileValidationError || error instanceof OpenAiReasonerError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Commercial analysis failed";
    return {
      analysedAt: new Date().toISOString(),
      module: input.module,
      recordId: input.recordId,
      schemaVersion: PROFILE_SCHEMA_VERSION,
      model: input.model,
      usage: {},
      latencyMs: Date.now() - started,
      success: false,
      error: message,
      organisation,
      organisationGraph: graph,
      evidence,
      interactions: reconstruction.interactions,
      reconstructedTimeline: reconstruction.timeline,
      productRelationships: productBundle.products,
      organisationRelationship: productBundle.organisationRelationship,
      omittedDueToBudget: context.omitted_due_to_budget,
    };
  }
}

function communicationSuggestsProductUse(
  graph: OrganisationGraph,
  contact: ReturnType<typeof buildContactIntelligence>,
): boolean {
  const blobs = [
    ...graph.notes.map((note) => `${note.title ?? ""} ${note.content ?? ""}`),
    ...graph.emails.map((email) => `${email.subject ?? ""} ${email.currentMessageText ?? email.bodyText ?? ""}`),
    ...contact.notes.map((note) => `${note.title ?? ""} ${note.content ?? ""}`),
  ].join("\n");
  return /\b(logged in|log in|using portal genie|set(?:ting)? up|activated|went live|portal visit)/i.test(blobs);
}
