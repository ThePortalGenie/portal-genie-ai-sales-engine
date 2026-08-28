import OpenAI from "openai";
import { loadEnvFile } from "../config/load-env.js";
import { loadPublicEmailDomains } from "../intelligence/email-domains.js";
import { loadCommandCentreThresholds } from "../config/command-centre.js";
import { zohoRuntime } from "./zoho-runtime.js";
import { runCommercialAnalysis } from "./intelligence-runtime.js";
import { scanCommandCentre, buildCommandCentre, type CommandCentreDeps } from "../intelligence/command-centre.js";
import { readLastScan, readPortfolioSnapshot } from "../intelligence/portfolio-store.js";
import { DEFAULT_OPENAI_MODEL } from "../intelligence/openai-reasoner.js";
import { redactOpenAiError } from "../intelligence/openai-reasoner.js";

function deps(): CommandCentreDeps {
  loadEnvFile();
  const { client } = zohoRuntime.getClient();
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
  const synthesizer = apiKey
    ? async (prompt: string) => {
        const clientAi = new OpenAI({ apiKey });
        try {
          const response = await clientAi.responses.create({
            model,
            instructions: "You summarise an already-computed sales queue. You may not invent facts.",
            input: prompt,
          });
          return {
            text: response.output_text ?? "",
            inputTokens: response.usage?.input_tokens,
            outputTokens: response.usage?.output_tokens,
          };
        } catch (error) {
          throw new Error(redactOpenAiError(error));
        }
      }
    : undefined;
  return {
    client,
    publicDomains: loadPublicEmailDomains(),
    thresholds: loadCommandCentreThresholds(),
    analyse: (moduleName, recordId) => runCommercialAnalysis({ module: moduleName, recordId, force: true }),
    synthesizer,
  };
}

export function loadCommandCentreSnapshot() {
  return {
    snapshot: readPortfolioSnapshot() ?? null,
    lastScan: readLastScan() ?? null,
  };
}

export async function scanSalesCommandCentre(
  options: { maxOrganisations?: number; organisationIds?: string[] } = {},
) {
  return scanCommandCentre(deps(), {
    maxOrganisations: options.maxOrganisations,
    organisationIds: options.organisationIds,
    persist: true,
  });
}

export async function buildSalesCommandCentre(options: {
  mode: "build_changed" | "full_rebuild" | "selected";
  confirm: boolean;
  maxOrganisations?: number;
  organisationIds?: string[];
  includeBriefSynthesis?: boolean;
}) {
  return buildCommandCentre(deps(), options);
}
