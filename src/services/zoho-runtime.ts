import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "../config/load-env.js";
import { ConfigurationError, loadZohoEnv, type ZohoEnv } from "../config/env.js";
import { upsertEnvValue } from "../config/write-env.js";
import { createLogger, type Logger } from "../logging/logger.js";
import { ZohoOAuth } from "../integrations/zoho/oauth.js";
import { ZohoHttp } from "../integrations/zoho/http.js";
import { ZohoCrmReadClient, type ZohoCrmReader } from "../integrations/zoho/client.js";
import { ZohoCrmWriteClient } from "../integrations/zoho/write-client.js";
import { runDiscovery } from "../integrations/zoho/discovery.js";
import {
  DEFAULT_EMAIL_BODY_FETCH_LIMIT,
  DEFAULT_RELATED_PAGE_SIZE,
  READ_ONLY_SCOPES,
  WRITE_BACK_SCOPES,
} from "../integrations/zoho/constants.js";
import { asJsonObject } from "../integrations/zoho/http.js";
import { normalizeZohoEmail, prospectEmailsFromRecord } from "../integrations/zoho/normalize-email.js";
import { searchCrmRecords, type CrmSearchResponse } from "./crm-search.js";
import { redactSecrets } from "../security/redact.js";
import type { DiscoveryDiagnostic } from "../integrations/zoho/types.js";

export type ConnectionStatus = "connected" | "not_connected" | "connection_error";

export type CrmWritesMode = "disabled" | "notes_only";

export type ZohoConnectionView = {
  status: ConnectionStatus;
  organisation?: string;
  dataCentre?: string;
  apiDomain?: string;
  lastSuccessfulConnection?: string;
  apiStatus?: string;
  capabilities: string[];
  clientIdConfigured: boolean;
  clientSecretConfigured: boolean;
  refreshTokenConfigured: boolean;
  redirectUri?: string;
  error?: string;
  /** CRM record fields and pipeline remain read-only; see crmWrites for Notes exception. */
  readOnly: true;
  crmWrites: CrmWritesMode;
};

type Runtime = {
  env: ZohoEnv;
  oauth: ZohoOAuth;
  client: ZohoCrmReadClient;
  writeClient: ZohoCrmWriteClient;
  logger: Logger;
};

const STATUS_FILE = () => resolve(process.cwd(), "diagnostics/zoho-status.json");

function crmWritesMode(): CrmWritesMode {
  return process.env.ZOHO_WRITE_ENABLED === "true" ? "notes_only" : "disabled";
}

function readStatusFile(): { lastSuccessfulConnection?: string } {
  try {
    if (!existsSync(STATUS_FILE())) return {};
    return JSON.parse(readFileSync(STATUS_FILE(), "utf8")) as { lastSuccessfulConnection?: string };
  } catch {
    return {};
  }
}

function writeStatusFile(payload: Record<string, unknown>): void {
  mkdirSync(resolve(process.cwd(), "diagnostics"), { recursive: true });
  writeFileSync(STATUS_FILE(), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export class ZohoRuntime {
  private runtime: Runtime | null = null;

  reset(): void {
    this.runtime = null;
    loadEnvFile();
  }

  private tryLoad(): Runtime | { error: string; missingRefresh: boolean } {
    try {
      loadEnvFile();
      const env = loadZohoEnv(process.env, { requireRefreshToken: true });
      const logger = createLogger();
      const oauth = new ZohoOAuth(env, logger);
      const http = new ZohoHttp({
        getAccessToken: () => oauth.getAccessToken(),
        getApiDomain: () => oauth.getApiDomain(),
        logger,
      });
      return { env, oauth, client: new ZohoCrmReadClient(http), writeClient: new ZohoCrmWriteClient(http), logger };
    } catch (error) {
      if (error instanceof ConfigurationError) {
        return { error: error.message, missingRefresh: error.message.includes("ZOHO_REFRESH_TOKEN") };
      }
      return { error: "Zoho is not configured.", missingRefresh: false };
    }
  }

  getClient(): { client: ZohoCrmReader; oauth: ZohoOAuth; env: ZohoEnv; writeClient: ZohoCrmWriteClient } {
    if (this.runtime) {
      return this.runtime;
    }
    const loaded = this.tryLoad();
    if ("error" in loaded) {
      throw new ConfigurationError(loaded.error);
    }
    this.runtime = loaded;
    return loaded;
  }

  getWriteClient(): ZohoCrmWriteClient {
    return this.getClient().writeClient;
  }

  configuredScopes(): readonly string[] {
    return process.env.ZOHO_WRITE_ENABLED === "true" ? WRITE_BACK_SCOPES : READ_ONLY_SCOPES;
  }

  async connectionStatus(): Promise<ZohoConnectionView> {
    loadEnvFile();
    const stored = readStatusFile();
    const clientIdConfigured = Boolean(process.env.ZOHO_CLIENT_ID?.trim());
    const clientSecretConfigured = Boolean(process.env.ZOHO_CLIENT_SECRET?.trim());
    const refreshTokenConfigured = Boolean(process.env.ZOHO_REFRESH_TOKEN?.trim());
    const accountsUrl = process.env.ZOHO_ACCOUNTS_URL ?? "https://accounts.zoho.com";
    const dataCentre = new URL(accountsUrl).host;
    const base: ZohoConnectionView = {
      status: "not_connected",
      dataCentre,
      capabilities: [...this.configuredScopes()],
      clientIdConfigured,
      clientSecretConfigured,
      refreshTokenConfigured,
      redirectUri: process.env.ZOHO_REDIRECT_URI,
      lastSuccessfulConnection: stored.lastSuccessfulConnection,
      readOnly: true,
      crmWrites: crmWritesMode(),
    };

    if (!clientIdConfigured || !clientSecretConfigured || !refreshTokenConfigured) {
      return { ...base, status: "not_connected", apiStatus: "Missing server-side Zoho credentials." };
    }

    try {
      const { client, oauth } = this.getClient();
      const apiDomain = await oauth.getApiDomain();
      const orgResult = await client.getOrg();
      const orgJson = asJsonObject(orgResult.json);
      const orgList = orgJson?.org;
      const org = Array.isArray(orgList) ? asJsonObject(orgList[0]) : null;
      const organisation = typeof org?.company_name === "string" ? org.company_name : undefined;
      const lastSuccessfulConnection = new Date().toISOString();
      writeStatusFile({ lastSuccessfulConnection, apiDomain, organisation });
      return {
        ...base,
        status: "connected",
        organisation: organisation ?? (orgResult.ok ? undefined : "Unavailable"),
        apiDomain,
        lastSuccessfulConnection,
        apiStatus: orgResult.ok ? "OK" : `Authenticated; org details unavailable (${orgResult.status})`,
      };
    } catch (error) {
      return {
        ...base,
        status: "connection_error",
        apiStatus: "Error",
        error: error instanceof Error ? error.message.replace(/1000\.[A-Za-z0-9.]+/g, "[redacted]") : "Connection failed",
      };
    }
  }

  async connectWithGrantCode(code: string): Promise<ZohoConnectionView> {
    loadEnvFile();
    const env = loadZohoEnv(process.env, { requireRefreshToken: false });
    const logger = createLogger();
    const oauth = new ZohoOAuth(env, logger);
    const tokens = await oauth.exchangeGrantCode(code);
    if (!tokens.refreshToken) {
      throw new Error("Zoho did not return a refresh token. Use offline access / prompt=consent.");
    }
    const envPath = resolve(process.cwd(), ".env");
    upsertEnvValue(envPath, "ZOHO_REFRESH_TOKEN", tokens.refreshToken);
    upsertEnvValue(envPath, "ZOHO_API_DOMAIN", tokens.apiDomain);
    process.env.ZOHO_REFRESH_TOKEN = tokens.refreshToken;
    process.env.ZOHO_API_DOMAIN = tokens.apiDomain;
    this.reset();
    return this.connectionStatus();
  }

  oauthStartUrl(): string {
    const { oauth } = this.getClientOrAuthOnly();
    const state = crypto.randomUUID();
    pendingOAuthState.set(state, Date.now() + 10 * 60_000);
    return oauth.authorizationUrl(state);
  }

  consumeOAuthState(state: string): boolean {
    const expires = pendingOAuthState.get(state);
    pendingOAuthState.delete(state);
    return Boolean(expires && expires > Date.now());
  }

  private getClientOrAuthOnly(): { oauth: ZohoOAuth } {
    loadEnvFile();
    const env = loadZohoEnv(process.env, { requireRefreshToken: false });
    return { oauth: new ZohoOAuth(env, createLogger()) };
  }

  async search(query: string): Promise<CrmSearchResponse> {
    if (!query.trim()) {
      return { query: "", hits: [], warnings: ["Enter an email, name, company, or Zoho record ID."] };
    }
    const { client } = this.getClient();
    return searchCrmRecords(client, query);
  }

  async discover(moduleApiName: string, recordId: string): Promise<DiscoveryDiagnostic> {
    const { client, oauth, env } = this.getClient();
    return runDiscovery(
      {
        client,
        accountsUrl: env.accountsUrl,
        apiDomain: await oauth.getApiDomain(),
        getFieldsForModule: (moduleName) => client.getFields(moduleName),
      },
      {
        module: moduleApiName,
        recordId,
        fetchEmailBodies: DEFAULT_EMAIL_BODY_FETCH_LIMIT,
        maxRelatedRecords: DEFAULT_RELATED_PAGE_SIZE,
      },
    );
  }

  async emailBody(moduleApiName: string, recordId: string, messageId: string, userId?: string) {
    const { client } = this.getClient();
    const result = await client.getEmail(moduleApiName, recordId, messageId, userId);
    const recordResult = await client.getRecord(moduleApiName, recordId);
    const recordJson = asJsonObject(recordResult.json);
    const record = Array.isArray(recordJson?.data) ? asJsonObject(recordJson.data[0]) : null;
    const emailJson = asJsonObject(result.json);
    const emailItem = Array.isArray(emailJson?.Emails) ? asJsonObject(emailJson.Emails[0]) : emailJson;
    const normalized = normalizeZohoEmail({
      listItem: emailItem,
      bodyItem: emailItem,
      prospectEmails: prospectEmailsFromRecord(record ?? undefined),
    });
    return { status: result.status, json: redactSecrets(result.json), ok: result.ok, normalized };
  }
}

const pendingOAuthState = new Map<string, number>();

export const zohoRuntime = new ZohoRuntime();
