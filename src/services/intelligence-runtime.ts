import { loadEnvFile } from "../config/load-env.js";
import { ConfigurationError } from "../config/env.js";
import { OPERATOR_VERDICTS, type OperatorVerdict } from "../domain/commercial-intelligence.js";
import { zohoRuntime } from "./zoho-runtime.js";
import { analyseRelationship } from "../intelligence/analyse.js";
import { appendFeedback, readStoredAnalysis, writeStoredAnalysis, type StoredAnalysis } from "../intelligence/analysis-store.js";
import { createOpenAiReasoner, DEFAULT_OPENAI_MODEL } from "../intelligence/openai-reasoner.js";
import type { CommercialReasoner } from "../intelligence/openai-reasoner.js";

export type OpenAiStatus = {
  configured: boolean;
  model: string;
};

export function openaiStatus(): OpenAiStatus {
  loadEnvFile();
  return {
    configured: Boolean(process.env.OPENAI_API_KEY?.trim()),
    model: process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL,
  };
}

function requireReasoner(): { reasoner: CommercialReasoner; model: string } {
  loadEnvFile();
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigurationError("Missing OPENAI_API_KEY. Copy .env.example and add a server-side OpenAI key.");
  }
  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
  return { reasoner: createOpenAiReasoner({ apiKey, model }), model };
}

export async function runCommercialAnalysis(options: {
  module: string;
  recordId: string;
  force?: boolean;
}): Promise<StoredAnalysis> {
  if (!options.force) {
    const cached = readStoredAnalysis(options.module, options.recordId);
    if (cached?.success && cached.profile) {
      return cached;
    }
  }
  const { reasoner, model } = requireReasoner();
  const { client } = zohoRuntime.getClient();
  const diagnostic = await zohoRuntime.discover(options.module, options.recordId);
  const analysis = await analyseRelationship({
    module: options.module,
    recordId: options.recordId,
    diagnostic,
    client,
    reasoner,
    model,
  });
  return writeStoredAnalysis(analysis);
}

export function loadCommercialProfile(moduleName: string, recordId: string): StoredAnalysis | undefined {
  return readStoredAnalysis(moduleName, recordId);
}

export function recordOperatorFeedback(options: {
  module: string;
  recordId: string;
  verdict: string;
  notes?: string;
}): StoredAnalysis {
  if (!OPERATOR_VERDICTS.includes(options.verdict as OperatorVerdict)) {
    throw new Error("verdict must be CORRECT, PARTIALLY_CORRECT, or WRONG");
  }
  const stored = appendFeedback(options.module, options.recordId, {
    at: new Date().toISOString(),
    verdict: options.verdict as OperatorVerdict,
    notes: options.notes?.trim() || undefined,
  });
  if (!stored) {
    throw new Error("Analyse this relationship before recording feedback.");
  }
  return stored;
}
