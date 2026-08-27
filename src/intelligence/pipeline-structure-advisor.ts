import type { ProductId } from "../domain/product-relationship.js";

/**
 * Contract only. Pipeline recommendations, Zoho pipeline changes, and remapping
 * are not implemented in this milestone.
 */
export type PipelineStructureAdvisorInput = {
  product: ProductId;
  currentStages?: Array<{ apiName: string; displayLabel?: string; recordCount?: number }>;
  sampleRecordStages?: Array<{ recordId: string; stage: string }>;
};

export type PipelineStructureAdvice = {
  product: ProductId;
  suggestedStages?: Array<{ name: string; definition: string }>;
  missingLifecycleStates?: string[];
  staleOrInappropriateStages?: string[];
  recordsRequiringRemapping?: Array<{ recordId: string; fromStage: string; toStage?: string; reason: string }>;
  productOverlap?: string[];
  organisationOpportunities?: string[];
};

export type PipelineStructureAdvisor = {
  analyse(input: PipelineStructureAdvisorInput): PipelineStructureAdvice | Promise<PipelineStructureAdvice>;
};

export function createUnimplementedPipelineStructureAdvisor(): PipelineStructureAdvisor {
  return {
    analyse() {
      throw new Error(
        "PipelineStructureAdvisor is a future contract only. Pipeline recommendations and Zoho pipeline changes are not implemented.",
      );
    },
  };
}
