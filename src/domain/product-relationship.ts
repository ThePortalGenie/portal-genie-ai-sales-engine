import type { ConfidenceLevel, RelationshipState } from "./commercial-intelligence.js";

export const PRODUCTS = ["PORTAL_GENIE", "NAGGING_PANDA"] as const;
export type ProductId = (typeof PRODUCTS)[number];

export const PRODUCT_RELATIONSHIP_STATES = [
  "UNKNOWN",
  ...([
    "COLD_PROSPECT",
    "WARM_PROSPECT",
    "ENGAGED_PROSPECT",
    "REGISTERED_NOT_ACTIVATED",
    "ACTIVATING",
    "ACTIVE_USER",
    "DORMANT_USER",
    "PAYING_CUSTOMER",
    "PARTNER_PROSPECT",
    "PARTNER",
    "ACTIVE_REFERRING_PARTNER",
    "FORMER_CUSTOMER",
    "UNCLEAR",
  ] as const satisfies readonly RelationshipState[]),
] as const;

export type ProductRelationshipState = (typeof PRODUCT_RELATIONSHIP_STATES)[number];

/**
 * One organisation may have independent product relationships.
 * UNKNOWN means no evidence yet — not "no relationship".
 */
export type ProductRelationship = {
  product: ProductId;
  relationship_state: ProductRelationshipState;
  evidence_ids: string[];
  summary: string;
  confidence: ConfidenceLevel;
};

export type OrganisationRelationship = {
  summary: string;
  evidence_ids: string[];
  /** Organisation-level characterisation. Never a substitute for product state. */
  characterisation: string;
};
