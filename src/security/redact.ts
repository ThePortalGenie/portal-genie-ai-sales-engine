const SENSITIVE_KEY = /token|secret|password|authorization|api[_-]?key|grant|refresh|access_token|client_secret/i;

export function redactSecrets<T>(value: T): T {
  return redact(value) as T;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(nested);
    }
    return output;
  }
  return value;
}

export function publicErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && error.code === "CONFIGURATION_ERROR") {
    return error instanceof Error ? error.message : "Configuration error";
  }
  if (error && typeof error === "object" && "name" in error && error.name === "ZohoAuthError") {
    return "Zoho authentication failed. Check client credentials, data centre, and refresh token on the server.";
  }
  if (error instanceof Error) {
    return error.message
      .replace(/1000\.[A-Za-z0-9.]+/g, "[redacted]")
      .replace(/sk-[a-zA-Z0-9._-]+/g, "[redacted]")
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  }
  return "Unexpected error";
}
