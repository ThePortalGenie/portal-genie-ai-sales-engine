export class M365AuthError extends Error {
  readonly name = "M365AuthError";

  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export class M365ReadOnlyViolationError extends Error {
  readonly name = "M365ReadOnlyViolationError";

  constructor(
    readonly method: string,
    readonly url: string,
  ) {
    super(`Microsoft Graph write operation blocked: ${method} ${url}`);
  }
}

export class M365ConfigurationError extends Error {
  readonly code = "CONFIGURATION_ERROR";
  readonly name = "M365ConfigurationError";

  constructor(message: string) {
    super(message);
  }
}
