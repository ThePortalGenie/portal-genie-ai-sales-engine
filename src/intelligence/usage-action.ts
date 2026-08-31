import type { WatchAction } from "../domain/commercial-watch.js";
import type { ProductId } from "../domain/product-relationship.js";

export function productUsageTelemetryUnavailable(
  product: ProductId,
  input: { usageDatasetAvailable: boolean; usageUnknown: boolean },
): boolean {
  if (product === "NAGGING_PANDA") return true;
  return !input.usageDatasetAvailable || input.usageUnknown;
}

export function usageUnavailableReason(
  product: ProductId,
  input: { usageDatasetAvailable: boolean; usageUnknown: boolean },
): string {
  if (product === "NAGGING_PANDA") {
    return "Nagging Panda usage telemetry is not integrated in Sales Engine. Missing usage evidence is not a customer action.";
  }
  if (!input.usageDatasetAvailable) {
    return "No Portal Genie usage dataset is imported. Missing usage data is not a customer action.";
  }
  return "Portal Genie usage is unknown for this organisation. Missing usage data is not a customer action.";
}

export function suppressUsageCheckWithoutTelemetry(
  product: ProductId,
  action: WatchAction,
  input: { usageDatasetAvailable: boolean; usageUnknown: boolean },
): { action: WatchAction; suppressed: boolean; reason?: string } {
  if (action !== "USAGE_CHECK") return { action, suppressed: false };
  if (!productUsageTelemetryUnavailable(product, input)) {
    return { action, suppressed: false };
  }
  return {
    action: "NO_ACTION",
    suppressed: true,
    reason: usageUnavailableReason(product, input),
  };
}

export function productUsageContext(
  product: ProductId,
  input: { usageDatasetAvailable: boolean; usageUnknown: boolean },
): { usageDatasetAvailable: boolean; usageUnknown: boolean } {
  if (product === "NAGGING_PANDA") {
    return { usageDatasetAvailable: false, usageUnknown: true };
  }
  return input;
}
