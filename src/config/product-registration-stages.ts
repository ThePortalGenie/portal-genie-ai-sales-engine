import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProductRegistrationConfig } from "../domain/product-registration.js";

const DEFAULT_CONFIG: ProductRegistrationConfig = {
  PORTAL_GENIE: {
    pipeline_names: ["The Portal Genie"],
    registered_stages: [
      "Freemium",
      "In Trial - 30 Days",
      "Event Special 30 Days + 70% for 3 Months",
      "Event Special 60 Days +70% for 3 Months",
      "Firm Partner Deal - New",
    ],
    pre_registration_stages: ["Demo Stage", "Demo Decision Maker", "Proposal Review"],
  },
  NAGGING_PANDA: {
    pipeline_names: ["Nagging Panda"],
    registered_stages: ["Awaiting Payment", "Closed Won - Single License"],
    pre_registration_stages: ["Proposal Review"],
  },
};

function mergeProductConfig(
  parsed: ProductRegistrationConfig[keyof ProductRegistrationConfig] | undefined,
  fallback: ProductRegistrationConfig[keyof ProductRegistrationConfig],
): ProductRegistrationConfig[keyof ProductRegistrationConfig] {
  return {
    pipeline_names: parsed?.pipeline_names ?? fallback.pipeline_names,
    registered_stages: parsed?.registered_stages ?? fallback.registered_stages,
    pre_registration_stages: parsed?.pre_registration_stages ?? fallback.pre_registration_stages,
  };
}

export function loadProductRegistrationStages(cwd = process.cwd()): ProductRegistrationConfig {
  const filePath = resolve(cwd, "config/product-registration-stages.json");
  if (!existsSync(filePath)) return DEFAULT_CONFIG;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as ProductRegistrationConfig;
    return {
      PORTAL_GENIE: mergeProductConfig(parsed.PORTAL_GENIE, DEFAULT_CONFIG.PORTAL_GENIE),
      NAGGING_PANDA: mergeProductConfig(parsed.NAGGING_PANDA, DEFAULT_CONFIG.NAGGING_PANDA),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function isRegisteredStage(
  product: keyof ProductRegistrationConfig,
  stage: string | undefined,
  config?: ProductRegistrationConfig,
): boolean {
  if (!stage) return false;
  const cfg = config ?? loadProductRegistrationStages();
  return cfg[product].registered_stages.includes(stage);
}

export function isPreRegistrationStage(
  product: keyof ProductRegistrationConfig,
  stage: string | undefined,
  config?: ProductRegistrationConfig,
): boolean {
  if (!stage) return false;
  const cfg = config ?? loadProductRegistrationStages();
  return cfg[product].pre_registration_stages.includes(stage);
}
