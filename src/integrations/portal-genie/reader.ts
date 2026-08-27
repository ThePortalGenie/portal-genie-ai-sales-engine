import type { UsageAggregates } from "../../domain/usage.js";
import { unavailableUsageAggregates } from "../../domain/usage.js";

/**
 * Product-usage port. Implementations may be a file import, a later API, or a
 * reporting connection. All must normalise to NormalizedUsageProfile / UsageAggregates.
 * Do not invent a live Portal Genie schema here.
 */
export type PortalGenieUsageReader = {
  getUsageAggregates(identity: { email?: string; accountId?: string; zohoId?: string }): Promise<UsageAggregates>;
};

export class PortalGenieUsageNotIntegratedError extends Error {
  readonly code = "PORTAL_GENIE_NOT_INTEGRATED";

  constructor() {
    super(
      "Portal Genie usage integration is not available until the Zoho Discovery Connector is validated (Milestone 3).",
    );
    this.name = "PortalGenieUsageNotIntegratedError";
  }
}

export class UnavailablePortalGenieUsageReader implements PortalGenieUsageReader {
  async getUsageAggregates(_identity: { email?: string; accountId?: string }): Promise<UsageAggregates> {
    return unavailableUsageAggregates();
  }
}
