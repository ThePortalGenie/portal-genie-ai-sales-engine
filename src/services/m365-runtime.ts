import { loadEnvFile } from "../config/load-env.js";
import { ConfigurationError } from "../config/env.js";
import {
  loadM365Env,
  loadM365MailboxConfig,
  loadM365RetrievalLimits,
} from "../config/m365.js";
import { createLogger, type Logger } from "../logging/logger.js";
import { GraphHttp } from "../integrations/m365/graph-http.js";
import {
  M365OAuth,
  graphProfilePath,
  type M365TokenSet,
} from "../integrations/m365/oauth.js";
import {
  readMailboxToken,
  writeMailboxToken,
  type MailboxTokenRecord,
} from "../integrations/m365/mailbox-store.js";
import {
  READ_ONLY_DELEGATED_SCOPES,
  scopeListForOAuth,
} from "../integrations/m365/constants.js";
import { redactSecrets } from "../security/redact.js";
import type {
  MailboxConnectionConfig,
  MailboxConnectionRecord,
  M365ConnectionOverview,
} from "../domain/m365-mailbox.js";
import type { GraphUserProfile } from "../integrations/m365/types.js";
import type { RetrievalState } from "../domain/retrieval-state.js";

type OAuthStatePayload = {
  connection_id: string;
  expires: number;
};

const pendingOAuthState = new Map<string, OAuthStatePayload>();

function asProfile(json: unknown): GraphUserProfile | null {
  if (!json || typeof json !== "object") return null;
  return json as GraphUserProfile;
}

function publicError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]");
  }
  return "Connection failed";
}

function mergeMailboxRecord(
  config: MailboxConnectionConfig,
  token: MailboxTokenRecord | null,
): MailboxConnectionRecord {
  const authenticated = Boolean(token?.refresh_token);
  const status = !authenticated
    ? "not_connected"
    : token?.error
      ? "connection_error"
      : "connected";

  return {
    connection_id: config.connection_id,
    product_scope: config.product_scope,
    mailbox_email: token?.mailbox_email ?? config.mailbox_email,
    display_name: token?.display_name ?? config.display_name,
    status,
    authentication_status: !authenticated ? "not_authenticated" : token?.error ? "error" : "authenticated",
    last_successful_connection: token?.last_successful_connection,
    last_sync_attempt: token?.last_sync_attempt,
    last_successful_sync: token?.last_successful_sync,
    retrieval_state: token?.retrieval_state ?? "UNAVAILABLE",
    error: token?.error,
    read_only: true,
  };
}

export class M365Runtime {
  private logger: Logger = createLogger();

  reset(): void {
    loadEnvFile();
  }

  getMailboxConfigs(): MailboxConnectionConfig[] {
    return loadM365MailboxConfig();
  }

  getConnectionConfig(connectionId: string): MailboxConnectionConfig | undefined {
    return this.getMailboxConfigs().find((item) => item.connection_id === connectionId);
  }

  oauthStartUrl(connectionId: string): string {
    const config = this.getConnectionConfig(connectionId);
    if (!config) {
      throw new ConfigurationError(`Unknown mailbox connection_id: ${connectionId}`);
    }
    const env = loadM365Env(process.env, { requireCredentials: true });
    const state = `${connectionId}:${crypto.randomUUID()}`;
    pendingOAuthState.set(state, {
      connection_id: connectionId,
      expires: Date.now() + 10 * 60_000,
    });
    const oauth = new M365OAuth(env, this.logger);
    return oauth.authorizationUrl(state);
  }

  consumeOAuthState(state: string): string | null {
    const payload = pendingOAuthState.get(state);
    pendingOAuthState.delete(state);
    if (!payload || payload.expires <= Date.now()) return null;
    return payload.connection_id;
  }

  private oauthForConnection(connectionId: string): M365OAuth {
    const env = loadM365Env(process.env, { requireCredentials: true });
    const token = readMailboxToken(connectionId);
    return new M365OAuth(env, this.logger, fetch, token?.refresh_token);
  }

  async connectWithAuthorizationCode(connectionId: string, code: string): Promise<M365ConnectionOverview> {
    const config = this.getConnectionConfig(connectionId);
    if (!config) {
      throw new ConfigurationError(`Unknown mailbox connection_id: ${connectionId}`);
    }

    const oauth = this.oauthForConnection(connectionId);
    const tokens = await oauth.exchangeAuthorizationCode(code);
    if (!tokens.refreshToken) {
      throw new Error("Microsoft did not return a refresh token. Reconnect with consent (offline_access).");
    }

    const profile = await this.fetchProfile(connectionId, tokens, config.mailbox_email);
    const now = new Date().toISOString();
    const record: MailboxTokenRecord = {
      connection_id: connectionId,
      product_scope: config.product_scope,
      mailbox_email: profile.mailbox_email ?? config.mailbox_email,
      display_name: profile.display_name ?? config.display_name,
      refresh_token: tokens.refreshToken,
      last_successful_connection: now,
      retrieval_state: profile.retrieval_state,
      error: profile.error,
    };
    writeMailboxToken(record);
    return this.connectionStatus();
  }

  async testConnection(connectionId: string): Promise<MailboxConnectionRecord> {
    const config = this.getConnectionConfig(connectionId);
    if (!config) {
      throw new ConfigurationError(`Unknown mailbox connection_id: ${connectionId}`);
    }

    const existing = readMailboxToken(connectionId);
    if (!existing?.refresh_token) {
      return mergeMailboxRecord(config, {
        connection_id: connectionId,
        product_scope: config.product_scope,
        retrieval_state: "UNAVAILABLE",
        error: "Mailbox is not authenticated. Connect via OAuth first.",
      });
    }

    const profile = await this.fetchProfile(connectionId);
    const now = new Date().toISOString();
    const updated: MailboxTokenRecord = {
      ...existing,
      mailbox_email: profile.mailbox_email ?? existing.mailbox_email,
      display_name: profile.display_name ?? existing.display_name,
      last_successful_connection: profile.retrieval_state === "RETRIEVED" ? now : existing.last_successful_connection,
      retrieval_state: profile.retrieval_state,
      error: profile.error,
    };
    if (profile.refresh_token) {
      updated.refresh_token = profile.refresh_token;
    }
    writeMailboxToken(updated);
    return mergeMailboxRecord(config, updated);
  }

  /**
   * Stage 1: records a sync attempt and re-validates Graph connectivity only.
   * Bounded message retrieval is implemented in Stage 2.
   */
  async syncMailbox(connectionId: string): Promise<MailboxConnectionRecord> {
    const config = this.getConnectionConfig(connectionId);
    if (!config) {
      throw new ConfigurationError(`Unknown mailbox connection_id: ${connectionId}`);
    }

    const existing = readMailboxToken(connectionId);
    const attemptAt = new Date().toISOString();
    if (!existing?.refresh_token) {
      const record: MailboxTokenRecord = {
        connection_id: connectionId,
        product_scope: config.product_scope,
        retrieval_state: "UNAVAILABLE",
        last_sync_attempt: attemptAt,
        error: "Mailbox is not authenticated. Connect via OAuth first.",
      };
      writeMailboxToken(record);
      return mergeMailboxRecord(config, record);
    }

    const profile = await this.fetchProfile(connectionId);
    const updated: MailboxTokenRecord = {
      ...existing,
      mailbox_email: profile.mailbox_email ?? existing.mailbox_email,
      display_name: profile.display_name ?? existing.display_name,
      last_sync_attempt: attemptAt,
      last_successful_sync: profile.retrieval_state === "RETRIEVED" ? attemptAt : existing.last_successful_sync,
      last_successful_connection:
        profile.retrieval_state === "RETRIEVED" ? attemptAt : existing.last_successful_connection,
      retrieval_state: profile.retrieval_state,
      error: profile.error,
    };
    if (profile.refresh_token) {
      updated.refresh_token = profile.refresh_token;
    }
    writeMailboxToken(updated);
    return mergeMailboxRecord(config, updated);
  }

  async connectionStatus(): Promise<M365ConnectionOverview> {
    loadEnvFile();
    const env = loadM365Env(process.env, { requireCredentials: false });
    const configs = this.getMailboxConfigs();
    const mailboxes = configs.map((config) => mergeMailboxRecord(config, readMailboxToken(config.connection_id)));
    const configured = Boolean(env.clientId && env.clientSecret);

    return {
      configured,
      clientIdConfigured: Boolean(env.clientId),
      clientSecretConfigured: Boolean(env.clientSecret),
      tenantId: env.tenantId,
      redirectUri: env.redirectUri,
      scopes: [...READ_ONLY_DELEGATED_SCOPES],
      readOnly: true,
      mailboxes,
    };
  }

  retrievalLimits() {
    return loadM365RetrievalLimits();
  }

  diagnosticsView(): Record<string, unknown> {
    const status = {
      scopes: scopeListForOAuth(),
      limits: this.retrievalLimits(),
      mailboxes: this.getMailboxConfigs().map((config) => {
        const token = readMailboxToken(config.connection_id);
        return redactSecrets({
          connection_id: config.connection_id,
          product_scope: config.product_scope,
          mailbox_email: token?.mailbox_email ?? config.mailbox_email,
          display_name: token?.display_name ?? config.display_name,
          authenticated: Boolean(token?.refresh_token),
          last_successful_connection: token?.last_successful_connection,
          last_sync_attempt: token?.last_sync_attempt,
          last_successful_sync: token?.last_successful_sync,
          retrieval_state: token?.retrieval_state ?? "UNAVAILABLE",
          error: token?.error,
        });
      }),
    };
    return redactSecrets(status) as Record<string, unknown>;
  }

  private async fetchProfile(
    connectionId: string,
    freshTokens?: M365TokenSet,
    mailboxEmail?: string,
  ): Promise<{
    mailbox_email?: string;
    display_name?: string;
    retrieval_state: RetrievalState;
    error?: string;
    refresh_token?: string;
  }> {
    const oauth = this.oauthForConnection(connectionId);
    if (freshTokens?.refreshToken) {
      oauth.setRefreshToken(freshTokens.refreshToken);
    }

    const http = new GraphHttp({
      getAccessToken: () => oauth.getAccessToken(),
      logger: this.logger,
    });

    try {
      const result = await http.get(graphProfilePath(mailboxEmail));
      if (result.retrieval === "UNAVAILABLE") {
        return {
          retrieval_state: "UNAVAILABLE",
          error: "Microsoft Graph authentication or permission failure.",
          refresh_token: oauth.getRefreshToken(),
        };
      }
      if (result.retrieval === "ERROR") {
        return {
          retrieval_state: "ERROR",
          error: `Microsoft Graph request failed (${result.status}).`,
          refresh_token: oauth.getRefreshToken(),
        };
      }
      if (result.retrieval === "EMPTY") {
        return {
          retrieval_state: "EMPTY",
          error: "Microsoft Graph returned no profile data.",
          refresh_token: oauth.getRefreshToken(),
        };
      }

      const profile = asProfile(result.json);
      const email = profile?.mail ?? profile?.userPrincipalName;
      return {
        mailbox_email: email,
        display_name: profile?.displayName,
        retrieval_state: "RETRIEVED",
        refresh_token: oauth.getRefreshToken(),
      };
    } catch (error) {
      return {
        retrieval_state: "ERROR",
        error: publicError(error),
        refresh_token: oauth.getRefreshToken(),
      };
    }
  }
}

export const m365Runtime = new M365Runtime();
