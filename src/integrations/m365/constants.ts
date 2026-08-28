/** Delegated Microsoft Graph scopes for read-only mailbox intelligence. */
export const READ_ONLY_DELEGATED_SCOPES = [
  "offline_access",
  "User.Read",
  "Mail.Read",
  "Mail.Read.Shared",
] as const;

/** Scopes that must never be requested for this integration. */
export const FORBIDDEN_GRAPH_SCOPES = [
  "Mail.Send",
  "Mail.ReadWrite",
  "Mail.ReadWrite.Shared",
  "Contacts.ReadWrite",
] as const;

export const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

export const TOKEN_EXPIRY_SKEW_MS = 60_000;

export const DEFAULT_M365_LOOKBACK_DAYS = 90;
export const DEFAULT_M365_MAX_MESSAGES_PER_MAILBOX = 200;
export const DEFAULT_M365_PAGE_SIZE = 50;

export function assertReadOnlyScopes(scopes: readonly string[]): void {
  const forbidden = new Set<string>(FORBIDDEN_GRAPH_SCOPES);
  for (const scope of scopes) {
    if (forbidden.has(scope)) {
      throw new Error(`Forbidden Microsoft Graph scope: ${scope}`);
    }
  }
}

export function scopeListForOAuth(): string {
  assertReadOnlyScopes(READ_ONLY_DELEGATED_SCOPES);
  return READ_ONLY_DELEGATED_SCOPES.join(" ");
}
