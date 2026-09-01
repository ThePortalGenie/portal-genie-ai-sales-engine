import type {
  ActionExecutability,
  ActionabilityKind,
  StalledState,
  WatchAction,
} from "../domain/commercial-watch.js";

const CUSTOMER_FACING_ACTIONS = new Set<WatchAction>([
  "PERSONAL_EMAIL",
  "PHONE_CALL",
  "PARTNER_INVITATION",
  "PRODUCT_ACTIVATION_EMAIL",
  "DEMO_INVITATION",
  "REACTIVATION_EMAIL",
  "RESCHEDULE",
  "CONTACT_ALTERNATIVE_PERSON",
  "FOLLOW_UP",
]);

/**
 * Deterministic operator work classification. Preserves the existing action vocabulary.
 * INTERNAL_RESEARCH is executable operator work but not customer-facing sales action.
 */
export function classifyActionabilityKind(input: {
  action: WatchAction;
  executability: ActionExecutability;
  stalledState: StalledState;
}): ActionabilityKind {
  if (input.executability === "DATA_REQUIRED") return "DATA_REQUIRED";
  if (
    input.executability === "WAITING_FOR_TIME" ||
    input.executability === "WAITING_FOR_CUSTOMER" ||
    input.action === "WAIT" ||
    input.stalledState === "SCHEDULED_FOLLOW_UP"
  ) {
    return "WAIT";
  }
  if (input.action === "NO_ACTION" || input.action === "NURTURE" || input.executability === "NO_ACTION_REQUIRED") {
    return "NO_ACTION";
  }
  if (input.action === "HUMAN_REVIEW" || input.action === "EXTERNAL_ENRICHMENT") {
    return "INTERNAL_RESEARCH";
  }
  if (CUSTOMER_FACING_ACTIONS.has(input.action)) return "CUSTOMER_ACTION";
  if (input.action === "USAGE_CHECK") return "DATA_REQUIRED";
  return "CUSTOMER_ACTION";
}

export function isCustomerFacingAction(action: WatchAction): boolean {
  return CUSTOMER_FACING_ACTIONS.has(action);
}
