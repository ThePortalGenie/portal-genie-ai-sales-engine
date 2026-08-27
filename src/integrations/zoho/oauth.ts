import { ZohoAuthError } from "./errors.js";
import { READ_ONLY_SCOPES, TOKEN_EXPIRY_SKEW_MS } from "./constants.js";
import type { Logger } from "../../logging/logger.js";
import type { ZohoEnv } from "../../config/env.js";

export type Fetcher = typeof fetch;

export type TokenSet = {
  accessToken: string;
  apiDomain: string;
  expiresAt: number;
  tokenType: string;
  refreshToken?: string;
};

type TokenCache = {
  accessToken: string;
  apiDomain: string;
  expiresAt: number;
  tokenType: string;
};

function formBody(params: Record<string, string>): URLSearchParams {
  return new URLSearchParams(params);
}

function parseTokenResponse(json: unknown): {
  access_token?: string;
  refresh_token?: string;
  api_domain?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
} {
  if (!json || typeof json !== "object") {
    return {};
  }
  return json as {
    access_token?: string;
    refresh_token?: string;
    api_domain?: string;
    token_type?: string;
    expires_in?: number;
    error?: string;
  };
}

export class ZohoOAuth {
  private cache: TokenCache | null = null;

  constructor(
    private readonly env: ZohoEnv,
    private readonly logger: Logger,
    private readonly fetchImpl: Fetcher = fetch,
  ) {}

  async getAccessToken(): Promise<string> {
    const token = await this.ensureAccessToken();
    return token.accessToken;
  }

  async getApiDomain(): Promise<string> {
    if (this.env.apiDomainOverride) {
      return this.env.apiDomainOverride;
    }
    const token = await this.ensureAccessToken();
    return token.apiDomain;
  }

  async exchangeGrantCode(code: string): Promise<TokenSet> {
    const json = await this.postToken({
      grant_type: "authorization_code",
      client_id: this.env.clientId,
      client_secret: this.env.clientSecret,
      redirect_uri: this.env.redirectUri,
      code,
    });

    const parsed = parseTokenResponse(json);
    if (!parsed.access_token || !parsed.api_domain) {
      throw new ZohoAuthError("Grant token exchange did not return access_token and api_domain", {
        error: parsed.error,
      });
    }

    this.logger.info("zoho.oauth.grant_exchanged", { apiDomain: parsed.api_domain });

    const tokenSet: TokenSet = {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      apiDomain: parsed.api_domain.replace(/\/$/, ""),
      tokenType: parsed.token_type ?? "Bearer",
      expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
    };
    this.remember(tokenSet);
    return tokenSet;
  }

  async refreshAccessToken(): Promise<TokenSet> {
    if (!this.env.refreshToken) {
      throw new ZohoAuthError("ZOHO_REFRESH_TOKEN is not set. Run npm run zoho:auth first.");
    }

    const json = await this.postToken({
      grant_type: "refresh_token",
      client_id: this.env.clientId,
      client_secret: this.env.clientSecret,
      refresh_token: this.env.refreshToken,
    });

    const parsed = parseTokenResponse(json);
    if (!parsed.access_token || !parsed.api_domain) {
      throw new ZohoAuthError("Refresh token request did not return access_token and api_domain", {
        error: parsed.error,
      });
    }

    this.logger.info("zoho.oauth.refreshed", { apiDomain: parsed.api_domain });

    const tokenSet: TokenSet = {
      accessToken: parsed.access_token,
      apiDomain: parsed.api_domain.replace(/\/$/, ""),
      tokenType: parsed.token_type ?? "Bearer",
      expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
    };
    this.remember(tokenSet);
    return tokenSet;
  }

  private async ensureAccessToken(): Promise<TokenCache> {
    if (this.cache && this.cache.expiresAt - TOKEN_EXPIRY_SKEW_MS > Date.now()) {
      return this.cache;
    }
    await this.refreshAccessToken();
    if (!this.cache) {
      throw new ZohoAuthError("Failed to cache access token after refresh");
    }
    return this.cache;
  }

  private remember(token: TokenSet): void {
    this.cache = {
      accessToken: token.accessToken,
      apiDomain: token.apiDomain,
      expiresAt: token.expiresAt,
      tokenType: token.tokenType,
    };
  }

  authorizationUrl(state: string): string {
    const url = new URL(`${this.env.accountsUrl}/oauth/v2/auth`);
    url.searchParams.set("scope", READ_ONLY_SCOPES.join(","));
    url.searchParams.set("client_id", this.env.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("redirect_uri", this.env.redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  }

  private async postToken(params: Record<string, string>): Promise<unknown> {
    const url = `${this.env.accountsUrl}/oauth/v2/token`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody(params),
    });
    const json: unknown = await response.json().catch(() => null);
    const parsed = parseTokenResponse(json);

    if (!response.ok || parsed.error) {
      throw new ZohoAuthError(
        `Zoho OAuth token request failed (${parsed.error ?? response.status})`,
        { status: response.status, error: parsed.error },
      );
    }

    return json;
  }
}
