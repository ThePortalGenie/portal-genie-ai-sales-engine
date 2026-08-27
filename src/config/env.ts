export class ConfigurationError extends Error {
  readonly code = "CONFIGURATION_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export type ZohoEnv = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accountsUrl: string;
  redirectUri: string;
  apiDomainOverride?: string;
  grantCode?: string;
};

const DEFAULT_ACCOUNTS_URL = "https://accounts.zoho.com";

function required(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new ConfigurationError(
      `Missing ${name}. Copy .env.example to .env and fill in Zoho API Console values.`,
    );
  }
  return trimmed;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadZohoEnv(
  source: NodeJS.ProcessEnv = process.env,
  options: { requireRefreshToken?: boolean } = {},
): ZohoEnv {
  const requireRefreshToken = options.requireRefreshToken ?? true;

  return {
    clientId: required("ZOHO_CLIENT_ID", source.ZOHO_CLIENT_ID),
    clientSecret: required("ZOHO_CLIENT_SECRET", source.ZOHO_CLIENT_SECRET),
    refreshToken: requireRefreshToken
      ? required("ZOHO_REFRESH_TOKEN", source.ZOHO_REFRESH_TOKEN)
      : (optional(source.ZOHO_REFRESH_TOKEN) ?? ""),
    accountsUrl: (optional(source.ZOHO_ACCOUNTS_URL) ?? DEFAULT_ACCOUNTS_URL).replace(
      /\/$/,
      "",
    ),
    redirectUri: required("ZOHO_REDIRECT_URI", source.ZOHO_REDIRECT_URI),
    apiDomainOverride: optional(source.ZOHO_API_DOMAIN)?.replace(/\/$/, ""),
    grantCode: optional(source.ZOHO_GRANT_CODE),
  };
}
