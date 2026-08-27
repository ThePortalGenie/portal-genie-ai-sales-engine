/**
 * Product and commercial journeys. Thresholds are not calibrated until real
 * Portal Genie data is inspected in Milestone 3.
 */

export const CUSTOMER_JOURNEY_STAGES = [
  "lead",
  "registration",
  "setup",
  "activation",
  "usage",
  "habit",
  "paying",
  "expansion",
  "partner",
  "referrals",
] as const;

export type CustomerJourneyStage = (typeof CUSTOMER_JOURNEY_STAGES)[number];

export const ACTIVATION_MILESTONES = [
  { id: "A0", name: "Registered", meaning: "Account exists." },
  { id: "A1", name: "Setup Started", meaning: "Meaningful configuration has started." },
  { id: "A2", name: "Accounting Connected", meaning: "Xero, QuickBooks, or supported Sage connection established." },
  { id: "A3", name: "First Value", meaning: "At least one meaningful Portal Genie workflow completed." },
  { id: "A4", name: "Repeat Value", meaning: "Meaningful actions repeated on different days or sessions." },
  { id: "A5", name: "Active", meaning: "Sustained useful product activity." },
  { id: "A6", name: "Established User", meaning: "Usage suggests Portal Genie is part of the normal workflow." },
] as const;

export type ActivationMilestoneId = (typeof ACTIVATION_MILESTONES)[number]["id"];

export const USAGE_MOMENTUM = [
  "rapidly_increasing",
  "increasing",
  "stable",
  "declining",
  "dormant",
  "never_activated",
  "unknown",
] as const;

export type UsageMomentum = (typeof USAGE_MOMENTUM)[number];

export const PARTNER_LIFECYCLE_STAGES = [
  "potential",
  "identified",
  "approached",
  "interested",
  "applied",
  "partner_registered",
  "partner_activated",
  "first_client_referred",
  "first_referred_client_registered",
  "first_referred_client_activated",
  "first_referred_client_paying",
  "multiple_referrals",
  "active_referring_partner",
] as const;

export type PartnerLifecycleStage = (typeof PARTNER_LIFECYCLE_STAGES)[number];

export const PRODUCT_EVENT_NAMES = [
  "user.registered",
  "accounting.connected",
  "accounting.disconnected",
  "first_value.completed",
  "portal.activity",
  "payment.processed",
  "document.viewed",
  "email.sent",
  "account.activated",
  "usage.increased",
  "usage.declined",
  "account.dormant",
  "partner.created",
  "partner.first_referral",
  "referral.registered",
  "referral.activated",
  "referral.paying",
] as const;

export type ProductEventName = (typeof PRODUCT_EVENT_NAMES)[number];

export const NEXT_ACTION_CATALOG = [
  "register",
  "connect_accounting_platform",
  "complete_setup",
  "complete_first_workflow",
  "return_to_portal_genie",
  "increase_usage",
  "upgrade_or_pay",
  "become_partner",
  "refer_first_client",
  "refer_additional_clients",
  "sales_call",
  "demo",
  "product_assistance",
  "nurture",
  "no_action",
  "escalate_to_human",
] as const;

export type NextActionId = (typeof NEXT_ACTION_CATALOG)[number];

/**
 * Illustrative only. Do not use these weights to score live accounts until
 * conversion analysis exists.
 */
export const ILLUSTRATIVE_USAGE_SCORE_WEIGHTS = {
  status: "illustrative_only" as const,
  accountingSoftwareConnected: 25,
  meaningfulPortalActivity: 15,
  firstKeyWorkflowCompleted: 20,
  repeatKeyWorkflow: 15,
  paymentsProcessed: 10,
  documentsUsed: 5,
  emailsOrActionsPerformed: 5,
  recentActivity: 5,
};
