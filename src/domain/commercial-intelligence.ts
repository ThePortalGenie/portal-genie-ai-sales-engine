export const SALES_MOTIONS = [
  "REGISTRATION",
  "ACTIVATION",
  "PAID_CONVERSION",
  "PARTNER_CONVERSION",
  "REFERRAL_ACTIVATION",
  "REACTIVATION",
  "EXPANSION",
  "NURTURE",
  "DEPRIORITISE",
] as const;

export type SalesMotion = (typeof SALES_MOTIONS)[number];

export const RELATIONSHIP_STATES = [
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
] as const;

export type RelationshipState = (typeof RELATIONSHIP_STATES)[number];

export const DECISION_STATES = [
  "ACT_NOW",
  "ENRICH_FIRST",
  "NURTURE",
  "HUMAN_INPUT_REQUIRED",
  "DEPRIORITISE",
] as const;

export type DecisionState = (typeof DECISION_STATES)[number];

export const NEXT_ACTIONS = [
  "PERSONAL_EMAIL",
  "PHONE_CALL",
  "PARTNER_INVITATION",
  "PRODUCT_ACTIVATION_EMAIL",
  "DEMO_INVITATION",
  "REACTIVATION_EMAIL",
  "USAGE_CHECK",
  "EXTERNAL_ENRICHMENT",
  "HUMAN_REVIEW",
  "NURTURE",
  "WAIT",
  "RESCHEDULE",
  "CONTACT_ALTERNATIVE_PERSON",
  "NO_ACTION",
] as const;

export type NextAction = (typeof NEXT_ACTIONS)[number];

export const CONFIDENCE_LEVELS = ["HIGH", "MEDIUM", "LOW"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const OPERATOR_VERDICTS = ["CORRECT", "PARTIALLY_CORRECT", "WRONG"] as const;
export type OperatorVerdict = (typeof OPERATOR_VERDICTS)[number];

export const ORG_ASSOCIATION_REASONS = [
  "SELECTED_CONTACT",
  "SAME_ZOHO_ACCOUNT",
  "SAME_BUSINESS_DOMAIN",
  "PORTAL_GENIE_ORG_MATCH",
  "RELATED_ACCOUNT",
  "SELECTED_CONTACT_ACCOUNT",
  "CONTACT_ACCOUNT",
  "EXPLICIT_RELATIONSHIP",
  "EXACT_COMPANY_NAME",
  "POSSIBLE_MATCH",
  "POSSIBLE_MATCH_REVIEW",
] as const;

export type OrgAssociationReason = (typeof ORG_ASSOCIATION_REASONS)[number];

export const PROFILE_SCHEMA_VERSION = "commercial-intelligence.v1.4";

export type OpportunityAssessment = {
  motion: SalesMotion;
  rationale: string;
  confidence: ConfidenceLevel;
};

export type CommercialIntelligenceProfile = {
  relationship_summary: string;
  relationship_state: RelationshipState;
  additional_relationship_states: RelationshipState[];
  known_facts: string[];
  important_signals: string[];
  inferences: string[];
  unknowns: string[];
  contradictions: string[];
  primary_opportunity: OpportunityAssessment;
  secondary_opportunities: OpportunityAssessment[];
  partner_potential: OpportunityAssessment;
  registration_potential: OpportunityAssessment;
  activation_potential: OpportunityAssessment;
  paid_conversion_potential: OpportunityAssessment;
  reactivation_potential: OpportunityAssessment;
  decision_state: DecisionState;
  enrichment_recommended: boolean;
  enrichment_questions: string[];
  recommended_action: NextAction;
  recommended_channel: string;
  best_contact: string;
  reason_for_best_contact: string;
  human_attention_required: boolean;
  confidence: ConfidenceLevel;
  confidence_reason: string;
  evidence_references: string[];
  recommended_action_objective: string;
  recommended_action_reason: string;
  suggested_message_angle: string;
  relationship_depth: string;
  confirmed_crm_activity: string;
  inferred_real_world_activity: string;
};

export type OperatorFeedback = {
  at: string;
  verdict: OperatorVerdict;
  notes?: string;
};
