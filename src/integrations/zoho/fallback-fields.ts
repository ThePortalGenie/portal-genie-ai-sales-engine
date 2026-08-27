import { FALLBACK_RELATED_FIELDS, MAX_RELATED_FIELDS } from "./constants.js";

export function uniqueFields(fields: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const field of fields) {
    const trimmed = field.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= MAX_RELATED_FIELDS) {
      break;
    }
  }
  return result;
}

/**
 * Chronological view metadata uses names like `!Calls.Subject`.
 * Related Records requests need the field API name only.
 */
export function stripRelatedListFieldPrefix(apiName: string): string {
  const match = /^!(?:[A-Za-z0-9_]+)\.(.+)$/.exec(apiName);
  return match?.[1] ?? apiName.replace(/^!/, "");
}

export function fieldsForRelatedList(options: {
  relatedListApiName: string;
  relatedModuleApiName: string | null;
  relatedListFields: string[];
  moduleFieldApiNames: Map<string, string[]>;
}): string[] {
  if (options.relatedListFields.length > 0) {
    const fromList = uniqueFields(options.relatedListFields.map(stripRelatedListFieldPrefix));
    if (fromList.length > 0) {
      return fromList;
    }
  }

  const moduleKey = options.relatedModuleApiName ?? options.relatedListApiName;
  const fromMetadata = options.moduleFieldApiNames.get(moduleKey);
  if (fromMetadata && fromMetadata.length > 0) {
    return uniqueFields(fromMetadata);
  }

  return uniqueFields(
    FALLBACK_RELATED_FIELDS[options.relatedListApiName] ??
      FALLBACK_RELATED_FIELDS[moduleKey] ?? ["id", "Created_Time", "Owner"],
  );
}
