import { interpretCommercialPosition, type CommercialPosition, type SignalStrength } from "./commercial-position.js";
import type { RelationshipIdentity } from "./identity.js";
import type { IdentityMatch } from "./identity-match.js";
import { matchUsageToCrm } from "./identity-match.js";
import {
  deriveLeadingIndicators,
  usageStrengthFromActivation,
  type LeadingIndicators,
} from "./leading-indicators.js";
import type { ActivationThresholds, NormalizedUsageProfile } from "./normalized-usage.js";
import { DEFAULT_ACTIVATION_THRESHOLDS } from "./normalized-usage.js";

export type CombinedAccountIntelligence = {
  crmIntelligence: {
    present: boolean;
    intent: SignalStrength;
    identity?: RelationshipIdentity;
    match: IdentityMatch;
  };
  usageIntelligence: {
    present: boolean;
    profile?: NormalizedUsageProfile;
    leadingIndicators?: LeadingIndicators;
    productUsage: SignalStrength;
  };
  salesIntelligence: CommercialPosition;
};

export function combineAccountIntelligence(input: {
  usage: NormalizedUsageProfile;
  crmRecords?: RelationshipIdentity[];
  crmIntent?: SignalStrength;
  now?: Date;
  thresholds?: ActivationThresholds;
}): CombinedAccountIntelligence {
  const thresholds = input.thresholds ?? DEFAULT_ACTIVATION_THRESHOLDS;
  const now = input.now ?? new Date();
  const match = matchUsageToCrm(input.usage, input.crmRecords ?? []);
  const indicators = deriveLeadingIndicators(input.usage, now, thresholds);
  const productUsage = indicators.activationState.value
    ? usageStrengthFromActivation(indicators.activationState.value)
    : "unknown";
  const crmIntent = input.crmIntent ?? (match.status === "matched" ? "unknown" : "unknown");

  return {
    crmIntelligence: {
      present: match.status === "matched",
      intent: crmIntent,
      identity: match.crm,
      match,
    },
    usageIntelligence: {
      present: true,
      profile: input.usage,
      leadingIndicators: indicators,
      productUsage,
    },
    salesIntelligence: interpretCommercialPosition({
      crmIntent,
      productUsage,
      usageAvailability: "available",
    }),
  };
}
