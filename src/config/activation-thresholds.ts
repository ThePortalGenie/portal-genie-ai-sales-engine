import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_ACTIVATION_THRESHOLDS,
  type ActivationThresholds,
} from "../domain/normalized-usage.js";

export function loadActivationThresholds(filePath?: string): ActivationThresholds {
  const path = filePath ?? resolve(process.cwd(), "config/activation-thresholds.json");
  if (!existsSync(path)) {
    return DEFAULT_ACTIVATION_THRESHOLDS;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ActivationThresholds>;
  return {
    ...DEFAULT_ACTIVATION_THRESHOLDS,
    ...parsed,
    calibrated: parsed.calibrated === true,
    recentLoginDays: parsed.recentLoginDays ?? DEFAULT_ACTIVATION_THRESHOLDS.recentLoginDays,
    staleLoginDays: parsed.staleLoginDays ?? parsed.dormantAfterDays ?? DEFAULT_ACTIVATION_THRESHOLDS.staleLoginDays,
    portalVisitTrendMinDelta:
      parsed.portalVisitTrendMinDelta ?? DEFAULT_ACTIVATION_THRESHOLDS.portalVisitTrendMinDelta,
    crmQuietAfterDays: parsed.crmQuietAfterDays ?? DEFAULT_ACTIVATION_THRESHOLDS.crmQuietAfterDays,
  };
}
