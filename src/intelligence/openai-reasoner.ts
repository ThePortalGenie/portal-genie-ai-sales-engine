import OpenAI from "openai";
import type { CommercialIntelligenceProfile } from "../domain/commercial-intelligence.js";
import { COMMERCIAL_INTELLIGENCE_JSON_SCHEMA, parseJsonProfile } from "./profile-schema.js";
import { SYSTEM_PROMPT, wrapUntrustedContext, type CommercialReasoningContext } from "./reasoning-context.js";

export const DEFAULT_OPENAI_MODEL = "gpt-5.6";

export type ReasonerUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type ReasonerResult = {
  profile: CommercialIntelligenceProfile;
  model: string;
  requestId?: string;
  usage: ReasonerUsage;
  latencyMs: number;
  rawText: string;
};

export type CommercialReasoner = {
  reason(context: CommercialReasoningContext): Promise<ReasonerResult>;
};

export class OpenAiReasonerError extends Error {
  readonly code = "OPENAI_REASONER_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "OpenAiReasonerError";
  }
}

export function createOpenAiReasoner(options: {
  apiKey: string;
  model: string;
  client?: {
    responses: {
      create: (body: Record<string, unknown>) => Promise<{
        id?: string;
        output_text?: string;
        usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
      }>;
    };
  };
}): CommercialReasoner {
  const client = (options.client ?? new OpenAI({ apiKey: options.apiKey })) as {
    responses: {
      create: (body: Record<string, unknown>) => Promise<{
        id?: string;
        output_text?: string;
        usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
      }>;
    };
  };
  return {
    async reason(context) {
      const started = Date.now();
      let response: {
        id?: string;
        output_text?: string;
        usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
      };
      try {
        response = await client.responses.create({
          model: options.model,
          instructions: SYSTEM_PROMPT,
          input: wrapUntrustedContext(context),
          text: {
            format: {
              type: "json_schema",
              name: "commercial_intelligence_profile",
              strict: true,
              schema: COMMERCIAL_INTELLIGENCE_JSON_SCHEMA as unknown as { [key: string]: unknown },
            },
          },
        });
      } catch (error) {
        throw new OpenAiReasonerError(redactOpenAiError(error));
      }

      const text = "output_text" in response && typeof response.output_text === "string" ? response.output_text : "";
      if (!text.trim()) {
        throw new OpenAiReasonerError("OpenAI returned an empty structured response");
      }
      const profile = parseJsonProfile(text);
      const usage =
        "usage" in response && response.usage
          ? {
              inputTokens: response.usage.input_tokens,
              outputTokens: response.usage.output_tokens,
              totalTokens: response.usage.total_tokens,
            }
          : {};
      return {
        profile,
        model: options.model,
        requestId: "id" in response && typeof response.id === "string" ? response.id : undefined,
        usage,
        latencyMs: Date.now() - started,
        rawText: text,
      };
    },
  };
}

export function redactOpenAiError(error: unknown): string {
  const message = error instanceof Error ? error.message : "OpenAI request failed";
  return message
    .replace(/sk-[a-zA-Z0-9._-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/api[_-]?key["']?\s*[:=]\s*["']?[^"' \n]+/gi, "api_key=[redacted]");
}
