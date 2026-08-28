export const RETRIEVAL_STATES = ["RETRIEVED", "EMPTY", "UNAVAILABLE", "ERROR"] as const;
export type RetrievalState = (typeof RETRIEVAL_STATES)[number];

/**
 * Classify Microsoft Graph (or similar) HTTP responses into retrieval semantics.
 * API/auth failures must never become EMPTY.
 */
export function classifyHttpRetrieval(status: number, body?: unknown): RetrievalState {
  if (status === 401 || status === 403) return "UNAVAILABLE";
  if (status === 429 || status >= 500) return "ERROR";
  if (status >= 400) return "ERROR";
  if (status === 204) return "EMPTY";
  if (status >= 200 && status < 300) {
    return graphBodyIsEmpty(body) ? "EMPTY" : "RETRIEVED";
  }
  return "ERROR";
}

function graphBodyIsEmpty(body: unknown): boolean {
  if (body == null) return true;
  if (typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.value)) return record.value.length === 0;
  if ("value" in record && record.value == null) return true;
  return false;
}
