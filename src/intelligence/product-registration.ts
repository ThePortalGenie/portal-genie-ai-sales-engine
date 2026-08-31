import type { WatchAction } from "../domain/commercial-watch.js";
import type { ProductId } from "../domain/product-relationship.js";
import type { ProductRegistrationClassification, ProductRegistrationState } from "../domain/product-registration.js";
import { loadProductRegistrationStages } from "../config/product-registration-stages.js";
import { classifyDealProduct } from "./org-graph.js";

export type RegistrationDealEvidence = {
  recordId: string;
  name?: string;
  stage?: string;
  pipeline?: string;
  product?: ProductId | "UNKNOWN";
  closedLost?: boolean;
  closedWon?: boolean;
};

function dealAppliesToProduct(deal: RegistrationDealEvidence, product: ProductId, pipelineNames: string[]): boolean {
  if (deal.pipeline && pipelineNames.some((name) => name.localeCompare(deal.pipeline!, undefined, { sensitivity: "accent" }) === 0)) {
    return true;
  }
  const classified = deal.product && deal.product !== "UNKNOWN" ? deal.product : classifyDealProduct(deal.name, deal.pipeline);
  return classified === product;
}

function provenanceFromDeal(deal: RegistrationDealEvidence): ProductRegistrationClassification["provenance"] {
  return {
    source: "CRM_DEAL_STAGE",
    stage: deal.stage,
    deal_id: deal.recordId,
    deal_name: deal.name,
    pipeline: deal.pipeline,
  };
}

export function classifyProductRegistration(
  product: ProductId,
  deals: RegistrationDealEvidence[],
  config = loadProductRegistrationStages(),
): ProductRegistrationClassification {
  const productConfig = config[product];
  const productDeals = deals.filter((deal) => dealAppliesToProduct(deal, product, productConfig.pipeline_names));

  if (!productDeals.length) {
    return {
      state: "UNKNOWN",
      provenance: { source: "CRM_DEAL_STAGE" },
    };
  }

  const activeDeals = productDeals.filter((deal) => !deal.closedLost);

  if (!activeDeals.length) {
    return {
      state: "UNKNOWN",
      provenance: provenanceFromDeal(productDeals[0]!),
    };
  }

  const registeredDeal = activeDeals.find((deal) => deal.stage && productConfig.registered_stages.includes(deal.stage));
  if (registeredDeal) {
    return {
      state: "REGISTERED",
      provenance: provenanceFromDeal(registeredDeal),
    };
  }

  const prospectDeal = activeDeals.find(
    (deal) => deal.stage && productConfig.pre_registration_stages.includes(deal.stage),
  );
  if (prospectDeal) {
    return {
      state: "NOT_REGISTERED",
      provenance: provenanceFromDeal(prospectDeal),
    };
  }

  const unknownDeal = activeDeals.find((deal) => deal.stage) ?? activeDeals[0]!;
  return {
    state: "UNKNOWN",
    provenance: provenanceFromDeal(unknownDeal),
  };
}

export function registrationLabel(state: ProductRegistrationState | undefined): string | undefined {
  if (state === "REGISTERED") return "Registered";
  if (state === "NOT_REGISTERED") return "Prospect";
  return undefined;
}

export function refineActionForRegistration(action: WatchAction, registration: ProductRegistrationClassification): WatchAction {
  if (registration.state !== "REGISTERED") return action;
  if (action === "DEMO_INVITATION") return "FOLLOW_UP";
  return action;
}

export function registrationAwareWhy(baseWhy: string, registration: ProductRegistrationClassification): string {
  if (registration.state !== "REGISTERED") return baseWhy;
  const stage = registration.provenance.stage ? ` (${registration.provenance.stage})` : "";
  return `Registered product account${stage}. Registration is separate from paying status, usage, and onboarding completion. ${baseWhy}`;
}

export function registrationAwareSummary(
  baseSummary: string,
  product: ProductId,
  registration: ProductRegistrationClassification,
): string {
  const productLabel = product === "NAGGING_PANDA" ? "Nagging Panda" : "Portal Genie";
  const orgPrefix = baseSummary.split(" · ")[0] ?? baseSummary;
  if (registration.state === "REGISTERED") {
    const stage = registration.provenance.stage ? ` · ${registration.provenance.stage}` : "";
    return `${orgPrefix} · ${productLabel} registered account${stage}. Not assumed paying or fully onboarded.`;
  }
  if (registration.state === "NOT_REGISTERED") {
    return `${orgPrefix} · ${productLabel} prospect.`;
  }
  return baseSummary;
}
