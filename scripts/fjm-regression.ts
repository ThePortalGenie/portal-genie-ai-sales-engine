import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "../src/config/load-env.js";
import { runCommercialAnalysis } from "../src/services/intelligence-runtime.js";

loadEnvFile();

const CURRENT = "diagnostics/intelligence/Contacts-5290417000031698239.json";
const M22_BASELINE = "diagnostics/intelligence/Contacts-5290417000031698239.m22-baseline.json";
if (existsSync(CURRENT) && !existsSync(M22_BASELINE)) {
  copyFileSync(CURRENT, M22_BASELINE);
}

const before = JSON.parse(readFileSync(existsSync(M22_BASELINE) ? M22_BASELINE : CURRENT, "utf8")) as {
  profile?: {
    relationship_summary?: string;
    primary_opportunity?: { motion?: string };
    recommended_action?: string;
    decision_state?: string;
    confidence?: string;
    relationship_depth?: string;
    best_contact?: string;
    reason_for_best_contact?: string;
  };
  usage?: { inputTokens?: number; outputTokens?: number };
  latencyMs?: number;
  interactions?: Array<{
    interaction_type: string;
    supporting_evidence_count?: number;
    summary?: string;
    corroboration?: string;
  }>;
};

const after = await runCommercialAnalysis({
  module: "Contacts",
  recordId: "5290417000031698239",
  force: true,
});

function summariseInteractions(
  items: Array<{ interaction_type: string; supporting_evidence_count?: number; corroboration?: string }> = [],
) {
  return items.map((item) => ({
    type: item.interaction_type,
    supporting: item.supporting_evidence_count ?? 1,
    corroboration: item.corroboration ?? "single",
  }));
}

const graph = after.organisationGraph;
const cmp = {
  before: {
    summary: before.profile?.relationship_summary,
    primary: before.profile?.primary_opportunity?.motion,
    action: before.profile?.recommended_action,
    decision: before.profile?.decision_state,
    confidence: before.profile?.confidence,
    bestContact: before.profile?.best_contact,
    inputTokens: before.usage?.inputTokens,
    outputTokens: before.usage?.outputTokens,
    latencyMs: before.latencyMs,
    depth: before.profile?.relationship_depth ?? null,
    interactionCount: before.interactions?.length ?? 0,
    interactions: summariseInteractions(before.interactions),
  },
  after: {
    success: after.success,
    error: after.error,
    summary: after.profile?.relationship_summary,
    primary: after.profile?.primary_opportunity?.motion,
    action: after.profile?.recommended_action,
    decision: after.profile?.decision_state,
    confidence: after.profile?.confidence,
    bestContact: after.profile?.best_contact,
    reasonForBestContact: after.profile?.reason_for_best_contact,
    selectedContact: graph?.selectedContactName,
    inputTokens: after.usage?.inputTokens,
    outputTokens: after.usage?.outputTokens,
    latencyMs: after.latencyMs,
    depth: after.profile?.relationship_depth ?? null,
    interactionCount: (after.interactions ?? []).length,
    interactions: summariseInteractions(after.interactions),
    products: after.productRelationships?.map((item) => `${item.product}:${item.relationship_state}`),
    omittedDueToBudget: after.omittedDueToBudget,
    confirmed: after.profile?.confirmed_crm_activity,
    inferredText: after.profile?.inferred_real_world_activity,
    zohoRecordsMerged: graph?.zohoRecordsMerged,
    contacts: graph?.contacts.map((item) => ({
      name: item.name,
      email: item.email,
      account: item.accountName,
      selected: item.selected,
      reasons: item.association_reasons,
      role: item.commercial_role.role,
    })),
    accounts: graph?.accounts.map((item) => ({
      name: item.name,
      id: item.recordId,
      reasons: item.association_reasons,
    })),
    possibleAccounts: graph?.possibleAccounts.map((item) => ({
      name: item.name,
      id: item.recordId,
      reasons: item.association_reasons,
    })),
    deals: graph?.deals.map((item) => ({
      id: item.recordId,
      name: item.name,
      stage: item.stage,
      product: item.product,
      contact: item.associatedContactName,
      account: item.associatedAccountName,
      closedLost: item.closedLost,
      closedWon: item.closedWon,
    })),
    emailsByContact: Object.fromEntries(
      [...new Set((graph?.emails ?? []).map((item) => item.ownerName ?? item.ownerRecordId))].map((owner) => [
        owner,
        (graph?.emails ?? []).filter((item) => (item.ownerName ?? item.ownerRecordId) === owner).length,
      ]),
    ),
    notesByContact: Object.fromEntries(
      [...new Set((graph?.notes ?? []).map((item) => item.ownerName ?? item.ownerRecordId))].map((owner) => [
        owner,
        (graph?.notes ?? []).filter((item) => (item.ownerName ?? item.ownerRecordId) === owner).length,
      ]),
    ),
    fragmentation: graph?.fragmentation,
    dataQualitySignals: graph?.dataQualitySignals,
    omissions: graph?.omissions,
    cache: graph?.cache,
  },
};

writeFileSync("diagnostics/intelligence/fjm-m221-comparison.json", `${JSON.stringify(cmp, null, 2)}\n`);
console.log(JSON.stringify(cmp, null, 2));
