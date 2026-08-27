/**
 * Contract only. Do not scrape, search the web, or call paid vendors from this interface.
 */
export type EnrichmentQuestion = string;

export type ExternalEnrichmentRequest = {
  organisationName?: string;
  domain?: string;
  contactName?: string;
  questions: EnrichmentQuestion[];
};

export type ExternalEnrichmentResult = {
  provider: string;
  retrievedAt: string;
  answers: Array<{ question: string; answer: string; confidence: "HIGH" | "MEDIUM" | "LOW" }>;
};

export type ExternalEnrichmentProvider = {
  readonly id: string;
  enrich(request: ExternalEnrichmentRequest): Promise<ExternalEnrichmentResult>;
};

export class NotImplementedEnrichmentProvider implements ExternalEnrichmentProvider {
  readonly id = "not-implemented";

  enrich(): Promise<ExternalEnrichmentResult> {
    return Promise.reject(new Error("External enrichment is not implemented. Questions are recorded on the profile only."));
  }
}
