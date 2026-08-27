import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "../src/config/load-env.js";
import { runCommercialAnalysis } from "../src/services/intelligence-runtime.js";
import { createSalesEvent, deleteSalesEvent, listSalesEvents } from "../src/intelligence/sales-event-store.js";

loadEnvFile();

const MODULE = "Contacts";
const RECORD_ID = "5290417000031698239";
const TAG = "[M23-TEST]";

function profileBits(analysis: {
  success: boolean;
  error?: string;
  profile?: {
    recommended_action?: string;
    decision_state?: string;
    confidence?: string;
    best_contact?: string;
    reason_for_best_contact?: string;
    recommended_action_reason?: string;
    relationship_summary?: string;
    inferences?: string[];
  };
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  latencyMs?: number;
  productRelationships?: Array<{ product: string; relationship_state: string }>;
  organisationGraph?: { organisationId?: string; selectedContactName?: string };
}) {
  return {
    success: analysis.success,
    error: analysis.error,
    action: analysis.profile?.recommended_action,
    decision: analysis.profile?.decision_state,
    confidence: analysis.profile?.confidence,
    bestContact: analysis.profile?.best_contact,
    reasonForBestContact: analysis.profile?.reason_for_best_contact,
    actionReason: analysis.profile?.recommended_action_reason,
    summary: analysis.profile?.relationship_summary,
    inferences: analysis.profile?.inferences,
    products: analysis.productRelationships?.map((item) => `${item.product}:${item.relationship_state}`),
    inputTokens: analysis.usage?.inputTokens,
    outputTokens: analysis.usage?.outputTokens,
    totalTokens: analysis.usage?.totalTokens,
    latencyMs: analysis.latencyMs,
    organisationId: analysis.organisationGraph?.organisationId,
    selectedContact: analysis.organisationGraph?.selectedContactName,
  };
}

function cleanupTestEvents() {
  for (const event of listSalesEvents()) {
    if (event.summary.includes(TAG)) deleteSalesEvent(event.id);
  }
}

cleanupTestEvents();

const baseline = await runCommercialAnalysis({ module: MODULE, recordId: RECORD_ID, force: true });
if (!baseline.success) {
  throw new Error(baseline.error || "Baseline analysis failed");
}

const organisationId =
  baseline.organisationGraph?.organisationId || `contact:${MODULE}:${RECORD_ID}`;
const contactId = RECORD_ID;
const contactName = baseline.organisationGraph?.selectedContactName || "Sumere";

const eventA = createSalesEvent({
  organisation_id: organisationId,
  contact_id: contactId,
  contact_name: contactName,
  product_scope: "PORTAL_GENIE",
  event_type: "PHONE_CALL",
  occurred_at: "2026-08-27T09:00:00Z",
  outcome: "NO_ANSWER",
  summary: `${TAG} Called — no answer`,
});
const scenarioA = await runCommercialAnalysis({ module: MODULE, recordId: RECORD_ID, force: true });

const eventB = createSalesEvent({
  organisation_id: organisationId,
  contact_id: contactId,
  contact_name: contactName,
  product_scope: "PORTAL_GENIE",
  event_type: "PHONE_CALL",
  occurred_at: "2026-08-27T11:00:00Z",
  outcome: "NO_ANSWER",
  summary: `${TAG} Second call — no answer`,
});
const scenarioB = await runCommercialAnalysis({ module: MODULE, recordId: RECORD_ID, force: true });

createSalesEvent({
  organisation_id: organisationId,
  contact_id: contactId,
  contact_name: contactName,
  product_scope: "PORTAL_GENIE",
  event_type: "PHONE_CALL",
  occurred_at: "2026-08-27T14:00:00Z",
  outcome: "CONNECTED",
  summary: `${TAG} Spoke to Sumere. Management has not reviewed the proposal yet. Asked me to call again on 15 September 2026.`,
  next_step: "Call after management meeting",
  follow_up_date: "2026-09-15",
});
const scenarioC = await runCommercialAnalysis({ module: MODULE, recordId: RECORD_ID, force: true });

cleanupTestEvents();
const restored = await runCommercialAnalysis({ module: MODULE, recordId: RECORD_ID, force: true });

const m221 = existsSync("diagnostics/intelligence/fjm-m221-comparison.json")
  ? (JSON.parse(readFileSync("diagnostics/intelligence/fjm-m221-comparison.json", "utf8")) as {
      after?: { inputTokens?: number; outputTokens?: number };
    })
  : {};

const report = {
  baseline: profileBits(baseline),
  scenarioA: {
    eventId: eventA.id,
    ...profileBits(scenarioA),
    changedFromBaseline: {
      action: scenarioA.profile?.recommended_action !== baseline.profile?.recommended_action,
      decision: scenarioA.profile?.decision_state !== baseline.profile?.decision_state,
      bestContact: scenarioA.profile?.best_contact !== baseline.profile?.best_contact,
    },
  },
  scenarioB: {
    eventId: eventB.id,
    ...profileBits(scenarioB),
    changedFromA: {
      action: scenarioB.profile?.recommended_action !== scenarioA.profile?.recommended_action,
      decision: scenarioB.profile?.decision_state !== scenarioA.profile?.decision_state,
    },
  },
  scenarioC: profileBits(scenarioC),
  restored: profileBits(restored),
  tokens: {
    m221Input: m221.after?.inputTokens,
    m221Output: m221.after?.outputTokens,
    baselineInput: baseline.usage?.inputTokens,
    baselineOutput: baseline.usage?.outputTokens,
    scenarioCInput: scenarioC.usage?.inputTokens,
    scenarioCOutput: scenarioC.usage?.outputTokens,
  },
  naggingPandaIndependent: {
    baseline: baseline.productRelationships?.find((item) => item.product === "NAGGING_PANDA")?.relationship_state,
    scenarioC: scenarioC.productRelationships?.find((item) => item.product === "NAGGING_PANDA")?.relationship_state,
  },
};

writeFileSync("diagnostics/intelligence/fjm-m23-comparison.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
