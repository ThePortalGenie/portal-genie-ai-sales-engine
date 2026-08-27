import type { NextActionId, UsageMomentum } from "./journey.js";
import type { SignalAvailability } from "./usage.js";

export type SignalStrength = "high" | "low" | "unknown";

export type CommercialPosition = {
  crmIntent: SignalStrength;
  productUsage: SignalStrength;
  usageAvailability: SignalAvailability;
  interpretation: string;
  actionFamily: NextActionId;
  requiresHuman: boolean;
  notes: string[];
};

/**
 * Deterministic CRM × product-usage matrix from the usage-intelligence brief.
 * Unknown usage is never treated as low usage.
 */
export function interpretCommercialPosition(input: {
  crmIntent: SignalStrength;
  productUsage: SignalStrength;
  usageAvailability?: SignalAvailability;
}): CommercialPosition {
  const usageAvailability =
    input.usageAvailability ?? (input.productUsage === "unknown" ? "not_yet_integrated" : "available");

  if (input.productUsage === "unknown" || usageAvailability !== "available") {
    return {
      crmIntent: input.crmIntent,
      productUsage: "unknown",
      usageAvailability,
      interpretation:
        input.crmIntent === "high"
          ? "CRM interest is high. Product usage is unknown, so this is not yet an activation or product-led reading."
          : input.crmIntent === "low"
            ? "CRM interest is low. Product usage is unknown; do not deprioritise solely on missing usage data."
            : "Neither CRM intent nor product usage is known yet.",
      actionFamily: input.crmIntent === "high" ? "escalate_to_human" : "nurture",
      requiresHuman: input.crmIntent === "high",
      notes: [
        "Product usage is unavailable until a usage file is imported or a live Portal Genie connector exists.",
        "Unknown usage must not be treated as low usage.",
      ],
    };
  }

  if (input.crmIntent === "high" && input.productUsage === "low") {
    return {
      crmIntent: "high",
      productUsage: "low",
      usageAvailability,
      interpretation: "Interested prospect struggling to activate.",
      actionFamily: "product_assistance",
      requiresHuman: true,
      notes: ["Prioritise activation assistance over new prospecting."],
    };
  }

  if (input.crmIntent === "low" && input.productUsage === "high") {
    return {
      crmIntent: "low",
      productUsage: "high",
      usageAvailability,
      interpretation: "Product-led sales opportunity.",
      actionFamily: "upgrade_or_pay",
      requiresHuman: true,
      notes: ["Investigate upgrade and Partner potential."],
    };
  }

  if (input.crmIntent === "high" && input.productUsage === "high") {
    return {
      crmIntent: "high",
      productUsage: "high",
      usageAvailability,
      interpretation: "High-priority conversion opportunity.",
      actionFamily: "sales_call",
      requiresHuman: true,
      notes: ["Commercial intervention is likely to change the outcome."],
    };
  }

  if (input.crmIntent === "low" && input.productUsage === "low") {
    return {
      crmIntent: "low",
      productUsage: "low",
      usageAvailability,
      interpretation: "Low immediate priority.",
      actionFamily: "nurture",
      requiresHuman: false,
      notes: ["Do not spend scarce human time here unless Partner potential is independently high."],
    };
  }

  return {
    crmIntent: input.crmIntent,
    productUsage: input.productUsage,
    usageAvailability,
    interpretation: "Insufficient classified signals for a commercial reading.",
    actionFamily: "nurture",
    requiresHuman: false,
    notes: ["Escalate rather than invent missing intent or usage."],
  };
}

export function momentumRequiresIntervention(momentum: UsageMomentum): boolean {
  return momentum === "declining" || momentum === "dormant" || momentum === "never_activated";
}
