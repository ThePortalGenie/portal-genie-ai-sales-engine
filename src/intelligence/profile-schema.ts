import {
  CONFIDENCE_LEVELS,
  DECISION_STATES,
  NEXT_ACTIONS,
  RELATIONSHIP_STATES,
  SALES_MOTIONS,
  type CommercialIntelligenceProfile,
  type OpportunityAssessment,
} from "../domain/commercial-intelligence.js";

const MOTION_ENUM = [...SALES_MOTIONS];
const STATE_ENUM = [...RELATIONSHIP_STATES];
const DECISION_ENUM = [...DECISION_STATES];
const ACTION_ENUM = [...NEXT_ACTIONS];
const CONFIDENCE_ENUM = [...CONFIDENCE_LEVELS];

const opportunitySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    motion: { type: "string", enum: MOTION_ENUM },
    rationale: { type: "string" },
    confidence: { type: "string", enum: CONFIDENCE_ENUM },
  },
  required: ["motion", "rationale", "confidence"],
};

export const COMMERCIAL_INTELLIGENCE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    relationship_summary: { type: "string" },
    relationship_state: { type: "string", enum: STATE_ENUM },
    additional_relationship_states: { type: "array", items: { type: "string", enum: STATE_ENUM } },
    known_facts: { type: "array", items: { type: "string" } },
    important_signals: { type: "array", items: { type: "string" } },
    inferences: { type: "array", items: { type: "string" } },
    unknowns: { type: "array", items: { type: "string" } },
    contradictions: { type: "array", items: { type: "string" } },
    primary_opportunity: opportunitySchema,
    secondary_opportunities: { type: "array", items: opportunitySchema },
    partner_potential: opportunitySchema,
    registration_potential: opportunitySchema,
    activation_potential: opportunitySchema,
    paid_conversion_potential: opportunitySchema,
    reactivation_potential: opportunitySchema,
    decision_state: { type: "string", enum: DECISION_ENUM },
    enrichment_recommended: { type: "boolean" },
    enrichment_questions: { type: "array", items: { type: "string" } },
    recommended_action: { type: "string", enum: ACTION_ENUM },
    recommended_channel: { type: "string" },
    best_contact: { type: "string" },
    reason_for_best_contact: { type: "string" },
    human_attention_required: { type: "boolean" },
    confidence: { type: "string", enum: CONFIDENCE_ENUM },
    confidence_reason: { type: "string" },
    evidence_references: { type: "array", items: { type: "string" } },
    recommended_action_objective: { type: "string" },
    recommended_action_reason: { type: "string" },
    suggested_message_angle: { type: "string" },
    relationship_depth: { type: "string" },
    confirmed_crm_activity: { type: "string" },
    inferred_real_world_activity: { type: "string" },
  },
  required: [
    "relationship_summary",
    "relationship_state",
    "additional_relationship_states",
    "known_facts",
    "important_signals",
    "inferences",
    "unknowns",
    "contradictions",
    "primary_opportunity",
    "secondary_opportunities",
    "partner_potential",
    "registration_potential",
    "activation_potential",
    "paid_conversion_potential",
    "reactivation_potential",
    "decision_state",
    "enrichment_recommended",
    "enrichment_questions",
    "recommended_action",
    "recommended_channel",
    "best_contact",
    "reason_for_best_contact",
    "human_attention_required",
    "confidence",
    "confidence_reason",
    "evidence_references",
    "recommended_action_objective",
    "recommended_action_reason",
    "suggested_message_angle",
    "relationship_depth",
    "confirmed_crm_activity",
    "inferred_real_world_activity",
  ],
} as const;

export class ProfileValidationError extends Error {
  readonly code = "PROFILE_VALIDATION_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "ProfileValidationError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProfileValidationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ProfileValidationError(`${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ProfileValidationError(`${field} must be a boolean`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ProfileValidationError(`${field} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function requireOpportunity(value: unknown, field: string): OpportunityAssessment {
  if (!isObject(value)) {
    throw new ProfileValidationError(`${field} must be an object`);
  }
  return {
    motion: requireEnum(value.motion, `${field}.motion`, SALES_MOTIONS),
    rationale: requireString(value.rationale, `${field}.rationale`),
    confidence: requireEnum(value.confidence, `${field}.confidence`, CONFIDENCE_LEVELS),
  };
}

export function parseCommercialIntelligenceProfile(raw: unknown): CommercialIntelligenceProfile {
  if (!isObject(raw)) {
    throw new ProfileValidationError("AI response must be a JSON object");
  }
  if (typeof raw.confidence === "number") {
    throw new ProfileValidationError("confidence must be HIGH, MEDIUM, or LOW — numeric precision is not allowed");
  }
  const additional = Array.isArray(raw.additional_relationship_states)
    ? raw.additional_relationship_states.map((item, index) =>
        requireEnum(item, `additional_relationship_states[${index}]`, RELATIONSHIP_STATES),
      )
    : (() => {
        throw new ProfileValidationError("additional_relationship_states must be an array");
      })();
  const secondary = Array.isArray(raw.secondary_opportunities)
    ? raw.secondary_opportunities.map((item, index) => requireOpportunity(item, `secondary_opportunities[${index}]`))
    : (() => {
        throw new ProfileValidationError("secondary_opportunities must be an array");
      })();

  return {
    relationship_summary: requireString(raw.relationship_summary, "relationship_summary"),
    relationship_state: requireEnum(raw.relationship_state, "relationship_state", RELATIONSHIP_STATES),
    additional_relationship_states: additional,
    known_facts: requireStringArray(raw.known_facts, "known_facts"),
    important_signals: requireStringArray(raw.important_signals, "important_signals"),
    inferences: requireStringArray(raw.inferences, "inferences"),
    unknowns: requireStringArray(raw.unknowns, "unknowns"),
    contradictions: requireStringArray(raw.contradictions, "contradictions"),
    primary_opportunity: requireOpportunity(raw.primary_opportunity, "primary_opportunity"),
    secondary_opportunities: secondary,
    partner_potential: requireOpportunity(raw.partner_potential, "partner_potential"),
    registration_potential: requireOpportunity(raw.registration_potential, "registration_potential"),
    activation_potential: requireOpportunity(raw.activation_potential, "activation_potential"),
    paid_conversion_potential: requireOpportunity(raw.paid_conversion_potential, "paid_conversion_potential"),
    reactivation_potential: requireOpportunity(raw.reactivation_potential, "reactivation_potential"),
    decision_state: requireEnum(raw.decision_state, "decision_state", DECISION_STATES),
    enrichment_recommended: requireBoolean(raw.enrichment_recommended, "enrichment_recommended"),
    enrichment_questions: requireStringArray(raw.enrichment_questions, "enrichment_questions"),
    recommended_action: requireEnum(raw.recommended_action, "recommended_action", NEXT_ACTIONS),
    recommended_channel: requireString(raw.recommended_channel, "recommended_channel"),
    best_contact: requireString(raw.best_contact, "best_contact"),
    reason_for_best_contact: requireString(raw.reason_for_best_contact, "reason_for_best_contact"),
    human_attention_required: requireBoolean(raw.human_attention_required, "human_attention_required"),
    confidence: requireEnum(raw.confidence, "confidence", CONFIDENCE_LEVELS),
    confidence_reason: requireString(raw.confidence_reason, "confidence_reason"),
    evidence_references: requireStringArray(raw.evidence_references, "evidence_references"),
    recommended_action_objective: requireString(raw.recommended_action_objective, "recommended_action_objective"),
    recommended_action_reason: requireString(raw.recommended_action_reason, "recommended_action_reason"),
    suggested_message_angle: requireString(raw.suggested_message_angle, "suggested_message_angle"),
    relationship_depth: requireString(raw.relationship_depth, "relationship_depth"),
    confirmed_crm_activity: requireString(raw.confirmed_crm_activity, "confirmed_crm_activity"),
    inferred_real_world_activity: requireString(raw.inferred_real_world_activity, "inferred_real_world_activity"),
  };
}

export function parseJsonProfile(text: string): CommercialIntelligenceProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProfileValidationError("AI response was not valid JSON");
  }
  return parseCommercialIntelligenceProfile(parsed);
}

export function validSampleProfile(overrides: Partial<CommercialIntelligenceProfile> = {}): CommercialIntelligenceProfile {
  const opportunity: OpportunityAssessment = {
    motion: "NURTURE",
    rationale: "Sparse evidence; maintain the relationship without heavy human time.",
    confidence: "LOW",
  };
  return {
    relationship_summary: "Sparse historical CRM record with no confirmed product usage.",
    relationship_state: "UNCLEAR",
    additional_relationship_states: [],
    known_facts: ["A CRM record exists"],
    important_signals: [],
    inferences: ["The organisation may still be relevant, but that is not verified"],
    unknowns: ["Current Portal Genie status"],
    contradictions: [],
    primary_opportunity: opportunity,
    secondary_opportunities: [],
    partner_potential: opportunity,
    registration_potential: opportunity,
    activation_potential: opportunity,
    paid_conversion_potential: opportunity,
    reactivation_potential: opportunity,
    decision_state: "ENRICH_FIRST",
    enrichment_recommended: true,
    enrichment_questions: ["Is the organisation still active?"],
    recommended_action: "EXTERNAL_ENRICHMENT",
    recommended_channel: "none",
    best_contact: "Unknown",
    reason_for_best_contact: "Only one CRM person is known",
    human_attention_required: false,
    confidence: "LOW",
    confidence_reason: "Organisation resolution is thin and history is stale.",
    evidence_references: ["ev-1"],
    recommended_action_objective: "Fill critical unknowns before spending sales time",
    recommended_action_reason: "A defensible commercial action needs one or two external facts",
    suggested_message_angle: "Do not send a message until enrichment answers are reviewed",
    relationship_depth: "Sparse CRM history with no inferred real-world conversations.",
    confirmed_crm_activity: "A CRM record exists; Calls and Meetings were not retrieved as populated lists.",
    inferred_real_world_activity: "No real-world interactions were inferred beyond recorded CRM objects.",
    ...overrides,
  };
}
