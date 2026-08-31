import type { ProductId } from "./product-relationship.js";

export type ProductRegistrationState = "REGISTERED" | "NOT_REGISTERED" | "UNKNOWN";

export type ProductRegistrationProvenance = {
  source: "CRM_DEAL_STAGE";
  stage?: string;
  deal_id?: string;
  deal_name?: string;
  pipeline?: string;
};

export type ProductRegistrationClassification = {
  state: ProductRegistrationState;
  provenance: ProductRegistrationProvenance;
};

export type ProductRegistrationStageConfig = {
  pipeline_names: string[];
  registered_stages: string[];
  pre_registration_stages: string[];
};

export type ProductRegistrationConfig = Record<ProductId, ProductRegistrationStageConfig>;

export const PRODUCT_REGISTRATION_STATES = ["REGISTERED", "NOT_REGISTERED", "UNKNOWN"] as const;
