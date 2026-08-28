import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROFILE_SCHEMA_VERSION, type CommercialIntelligenceProfile, type OperatorFeedback } from "../domain/commercial-intelligence.js";
import type { EvidenceItem } from "../domain/evidence.js";
import type { OrganisationEvidenceProfile } from "./org-intelligence.js";
import type { ReasonerUsage } from "./openai-reasoner.js";
import type { OrganisationRelationship, ProductRelationship } from "../domain/product-relationship.js";
import type { OrganisationGraph } from "../domain/organisation-graph.js";
import type { RealWorldInteraction, ReconstructedTimelineEvent } from "../domain/real-world-interaction.js";

export type StoredAnalysis = {
  analysedAt: string;
  module: string;
  recordId: string;
  schemaVersion: string;
  model: string;
  requestId?: string;
  usage: ReasonerUsage;
  latencyMs: number;
  success: boolean;
  error?: string;
  profile?: CommercialIntelligenceProfile;
  organisation?: OrganisationEvidenceProfile;
  organisationGraph?: OrganisationGraph;
  evidence?: EvidenceItem[];
  interactions?: RealWorldInteraction[];
  reconstructedTimeline?: ReconstructedTimelineEvent[];
  productRelationships?: ProductRelationship[];
  organisationRelationship?: OrganisationRelationship;
  omittedDueToBudget?: string[];
  feedback?: OperatorFeedback[];
  evidenceFingerprint?: string;
};

const DIR = () => resolve(process.env.INTELLIGENCE_STORE_DIR?.trim() || resolve(process.cwd(), "diagnostics/intelligence"));

function fileFor(moduleName: string, recordId: string): string {
  return resolve(DIR(), `${moduleName}-${recordId}.json`);
}

export function readStoredAnalysis(moduleName: string, recordId: string): StoredAnalysis | undefined {
  const filePath = fileFor(moduleName, recordId);
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as StoredAnalysis;
  } catch {
    return undefined;
  }
}

export function writeStoredAnalysis(record: StoredAnalysis): StoredAnalysis {
  mkdirSync(DIR(), { recursive: true });
  const existing = readStoredAnalysis(record.module, record.recordId);
  const merged: StoredAnalysis = {
    ...record,
    schemaVersion: PROFILE_SCHEMA_VERSION,
    feedback: record.feedback ?? existing?.feedback ?? [],
    evidenceFingerprint: record.evidenceFingerprint ?? existing?.evidenceFingerprint,
  };
  writeFileSync(fileFor(record.module, record.recordId), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return merged;
}

export function appendFeedback(moduleName: string, recordId: string, feedback: OperatorFeedback): StoredAnalysis | undefined {
  const existing = readStoredAnalysis(moduleName, recordId);
  if (!existing) return undefined;
  const updated = { ...existing, feedback: [...(existing.feedback ?? []), feedback] };
  writeFileSync(fileFor(moduleName, recordId), `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return updated;
}

export function listStoredAnalyses(): StoredAnalysis[] {
  const dir = DIR();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.includes("comparison") && !name.includes("baseline"))
    .map((name) => {
      try {
        return JSON.parse(readFileSync(resolve(dir, name), "utf8")) as StoredAnalysis;
      } catch {
        return undefined;
      }
    })
    .filter((item): item is StoredAnalysis => Boolean(item?.module && item.recordId));
}

export function findStoredAnalysisForRecords(records: Array<{ module: string; recordId: string }>): StoredAnalysis | undefined {
  for (const record of records) {
    const stored = readStoredAnalysis(record.module, record.recordId);
    if (stored?.success && stored.profile) return stored;
  }
  return undefined;
}
