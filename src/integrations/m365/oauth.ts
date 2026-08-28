import { M365AuthError } from "./errors.js";
import {
  GRAPH_BASE_URL,
  READ_ONLY_DELEGATED_SCOPES,
  TOKEN_EXPIRY_SKEW_MS,
  scopeListForOAuth,
} from "./constants.js";
import type { Logger } from "../../logging/logger.js";
import type { Fetcher } from "./graph-http.js";

import type { M365Env } from "../../config/m365.js";

export type M365TokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  tokenType: string;
  scope?: string;
};

type TokenCache = {
  accessToken: string;
  expiresAt: number;
  tokenType: string;
  refreshToken?: string;
};

function formBody(params: Record<string, string>): URLSearchParams {
  return new URLSearchParams(params);
}

function parseTokenResponse(json: unknown): {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
} {
  if (!json || typeof json !== "object") return {};
  return json as {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
}

export class M365OAuth {
  private cache: TokenCache | null = null;
  private refreshInFlight: Promise<TokenCache> | null = null;

  constructor(
    private readonly env: M365Env,
    private readonly logger: Logger,
    private readonly fetchImpl: Fetcher = fetch,
    private initialRefreshToken?: string,
  ) {}

  setRefreshToken(refreshToken: string | undefined): void {
    this.initialRefreshToken = refreshToken;
    this.cache = null;
  }

  getRefreshToken(): string | undefined {
    return this.cache?.refreshToken ?? this.initialRefreshToken;
  }

  tokenEndpoint(): string {
    return `https://login.microsoftonline.com/${encodeURIComponent(this.env.tenantId)}/oauth2/v2.0/token`;
  }

  authorizeEndpoint(): string {
    return `https://login.microsoftonline.com/${encodeURIComponent(this.env.tenantId)}/oauth2/v2.0/authorize`;
  }

  authorizationUrl(state: string): string {
    const url = new URL(this.authorizeEndpoint());
    url.searchParams.set("client_id", this.env.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", this.env.redirectUri);
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", scopeListForOAuth());
    url.searchParams.set("state", state);
    url.searchParams.set("prompt", "consent");
    return url.toString();
  }

  async exchangeAuthorizationCode(code: string): Promise<M365TokenSet> {
    const json = await this.postToken({
      grant_type: "authorization_code",
      client_id: this.env.clientId,
      client_secret: this.env.clientSecret,
      redirect_uri: this.env.redirectUri,
      code,
      scope: scopeListForOAuth(),
    });

    const parsed = parseTokenResponse(json);
    if (!parsed.access_token) {
      throw new M365AuthError("Authorization code exchange did not return access_token", {
        error: parsed.error,
        error_description: parsed.error_description,
      });
    }

    this.logger.info("m365.oauth.code_exchanged", { scope: parsed.scope });

    const tokenSet: M365TokenSet = {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      tokenType: parsed.token_type ?? "Bearer",
      expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
      scope: parsed.scope,
    };
    this.remember(tokenSet);
    return tokenSet;
  }

  async refreshAccessToken(): Promise<M365TokenSet> {
    const refreshToken = this.getRefreshToken();
    if (!refreshToken) {
      throw new M365AuthError("No refresh token available for this mailbox connection.");
    }

    const json = await this.postToken({
      grant_type: "refresh_token",
      client_id: this.env.clientId,
      client_secret: this.env.clientSecret,
      refresh_token: refreshToken,
      scope: scopeListForOAuth(),
    });

    const parsed = parseTokenResponse(json);
    if (!parsed.access_token) {
      throw new M365AuthError("Refresh token request did not return access_token", {
        error: parsed.error,
        error_description: parsed.error_description,
      });
    }

    this.logger.info("m365.oauth.refreshed", { scope: parsed.scope });

    const tokenSet: M365TokenSet = {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token ?? refreshToken,
      tokenType: parsed.token_type ?? "Bearer",
      expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
      scope: parsed.scope,
    };
    this.remember(tokenSet);
    return tokenSet;
  }

  async getAccessToken(): Promise<string> {
    const token = await this.ensureAccessToken();
    return token.accessToken;
  }

  expectedScopes(): readonly string[] {
    return READ_ONLY_DELEGATED_SCOPES;
  }

  private remember(tokenSet: M365TokenSet): void {
    this.cache = {
      accessToken: tokenSet.accessToken,
      expiresAt: tokenSet.expiresAt,
      tokenType: tokenSet.tokenType,
      refreshToken: tokenSet.refreshToken ?? this.cache?.refreshToken ?? this.initialRefreshToken,
    };
  }

  private async ensureAccessToken(): Promise<TokenCache> {
    if (this.cache && this.cache.expiresAt - TOKEN_EXPIRY_SKEW_MS > Date.now()) {
      return this.cache;
    }
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refreshAccessToken()
        .then((tokens) => {
          this.remember(tokens);
          return this.cache as TokenCache;
        })
        .finally(() => {
          this.refreshInFlight = null;
        });
    }
    return this.refreshInFlight;
  }

  private async postToken(params: Record<string, string>): Promise<unknown> {
    const response = await this.fetchImpl(this.tokenEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody(params),
    });
    const text = await response.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { parseError: true };
      }
    }
    if (!response.ok) {
      const parsed = parseTokenResponse(json);
      throw new M365AuthError("Microsoft token request failed", {
        status: response.status,
        error: parsed.error,
        error_description: parsed.error_description,
      });
    }
    return json;
  }
}

export function graphProfilePath(mailboxEmail?: string): string {
  if (mailboxEmail?.trim()) {
    return `/users/${encodeURIComponent(mailboxEmail.trim())}`;
  }
  return "/me";
}

export const GRAPH_API_BASE = GRAPH_BASE_URL;
