export class ZohoApiError extends Error {
  readonly code = "ZOHO_API_ERROR";

  constructor(
    message: string,
    readonly httpStatus: number,
    readonly zohoCode?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ZohoApiError";
  }
}

export class ReadOnlyViolationError extends Error {
  readonly code = "READ_ONLY_VIOLATION";

  constructor(method: string, url: string) {
    super(`Zoho CRM connector is read-only. Refused ${method} ${url}`);
    this.name = "ReadOnlyViolationError";
  }
}

export class ZohoAuthError extends Error {
  readonly code = "ZOHO_AUTH_ERROR";

  constructor(message: string, readonly details?: unknown) {
    super(message);
    this.name = "ZohoAuthError";
  }
}
