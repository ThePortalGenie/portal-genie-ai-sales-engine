import { ZOHO_DOCS } from "./constants.js";
import type { ZohoRelatedListMeta } from "./types.js";

export type RelatedListSkipCategory = "dedicated-endpoint" | "unsupported-api" | "not-sales-relevant";

export type RelatedListAction =
  | { action: "retrieve" }
  | { action: "skip"; category: RelatedListSkipCategory; reason: string; documentationNote?: string };

const SALES_API_NAMES = new Set([
  "Notes",
  "Deals",
  "Potentials",
  "Tasks",
  "Calls",
  "Events",
  "Meetings",
  "Activities",
  "Campaigns",
  "Contacts",
  "Accounts",
]);

const SALES_RELATED_MODULES = new Set([
  "Notes",
  "Deals",
  "Tasks",
  "Calls",
  "Events",
  "Activities",
  "Campaigns",
  "Contacts",
  "Accounts",
]);

function normalised(value: string): string {
  return value.replace(/[\s_-]+/g, "").toLowerCase();
}

function matches(related: ZohoRelatedListMeta, candidates: string[]): boolean {
  const names = [related.apiName, related.displayLabel, related.relatedModuleApiName ?? ""].map(normalised);
  return candidates.some((candidate) => names.includes(normalised(candidate)));
}

/**
 * Decide whether a related list from metadata should be retrieved for Sales Intelligence.
 * The full catalog is still recorded. Chronological views, Social, and Voice of the Customer
 * are skipped rather than expanding OAuth scopes.
 */
export function classifyRelatedList(related: ZohoRelatedListMeta): RelatedListAction {
  if (related.apiName === "Emails" || normalised(related.displayLabel) === "emails") {
    return {
      action: "skip",
      category: "dedicated-endpoint",
      reason: "Fetched via dedicated Emails API instead of generic related records",
      documentationNote: ZOHO_DOCS.emails,
    };
  }

  if (matches(related, ["Activities_Chronological_View", "ChronologicalView"])) {
    return {
      action: "skip",
      category: "unsupported-api",
      reason:
        "ChronologicalView is skipped. Zoho requires the mandatory fields parameter and often returns REQUIRED_PARAM_MISSING. Open Tasks, Calls, and Meetings are retrieved instead.",
      documentationNote: ZOHO_DOCS.relatedRecords,
    };
  }

  if (matches(related, ["Activities_Chronological_View_History", "ChronologicalViewHistory"])) {
    return {
      action: "skip",
      category: "unsupported-api",
      reason:
        "ChronologicalViewHistory is skipped. Closed Tasks, Calls, and Meetings are retrieved from those related lists instead.",
      documentationNote: ZOHO_DOCS.relatedRecords,
    };
  }

  if (matches(related, ["Social"])) {
    return {
      action: "skip",
      category: "unsupported-api",
      reason:
        "Social requires additional OAuth scopes that are not granted. It is not required for Sales Intelligence.",
    };
  }

  if (matches(related, ["Voice_of_the_Customer", "Voice of the Customer", "VOC"])) {
    return {
      action: "skip",
      category: "unsupported-api",
      reason: "Zoho reports this relation is not supported in the API. It is not retrieved.",
    };
  }

  if (SALES_API_NAMES.has(related.apiName) || (related.relatedModuleApiName && SALES_RELATED_MODULES.has(related.relatedModuleApiName))) {
    return { action: "retrieve" };
  }

  return {
    action: "skip",
    category: "not-sales-relevant",
    reason: "Listed in Zoho related-list metadata but not retrieved for Sales Intelligence.",
  };
}
