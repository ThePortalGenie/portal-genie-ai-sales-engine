import assert from "node:assert/strict";
import test from "node:test";
import { interpretCommercialPosition, momentumRequiresIntervention } from "../src/domain/commercial-position.js";
import { ILLUSTRATIVE_USAGE_SCORE_WEIGHTS } from "../src/domain/journey.js";
import { UnavailablePortalGenieUsageReader } from "../src/integrations/portal-genie/reader.js";

test("high CRM intent and low usage means activation assistance", () => {
  const result = interpretCommercialPosition({ crmIntent: "high", productUsage: "low" });
  assert.equal(result.interpretation, "Interested prospect struggling to activate.");
  assert.equal(result.actionFamily, "product_assistance");
  assert.equal(result.requiresHuman, true);
});

test("low CRM intent and high usage means product-led opportunity", () => {
  const result = interpretCommercialPosition({ crmIntent: "low", productUsage: "high" });
  assert.equal(result.interpretation, "Product-led sales opportunity.");
  assert.equal(result.actionFamily, "upgrade_or_pay");
});

test("high CRM intent and high usage means commercial intervention", () => {
  const result = interpretCommercialPosition({ crmIntent: "high", productUsage: "high" });
  assert.equal(result.interpretation, "High-priority conversion opportunity.");
  assert.equal(result.actionFamily, "sales_call");
  assert.equal(result.requiresHuman, true);
});

test("low CRM intent and low usage is nurture, not human time", () => {
  const result = interpretCommercialPosition({ crmIntent: "low", productUsage: "low" });
  assert.equal(result.actionFamily, "nurture");
  assert.equal(result.requiresHuman, false);
});

test("unknown product usage is not treated as low usage", () => {
  const result = interpretCommercialPosition({ crmIntent: "high", productUsage: "unknown" });
  assert.equal(result.productUsage, "unknown");
  assert.notEqual(result.interpretation, "Interested prospect struggling to activate.");
  assert.match(result.notes.join(" "), /must not be treated as low usage/);
});

test("declining and dormant momentum require intervention later", () => {
  assert.equal(momentumRequiresIntervention("declining"), true);
  assert.equal(momentumRequiresIntervention("increasing"), false);
});

test("illustrative usage weights are marked non-operational", () => {
  assert.equal(ILLUSTRATIVE_USAGE_SCORE_WEIGHTS.status, "illustrative_only");
});

test("Portal Genie reader returns not-yet-integrated aggregates", async () => {
  const reader = new UnavailablePortalGenieUsageReader();
  const usage = await reader.getUsageAggregates({ email: "jane@example.com" });
  assert.equal(usage.availability, "not_yet_integrated");
});
