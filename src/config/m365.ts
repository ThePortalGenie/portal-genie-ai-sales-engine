import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigurationError } from "./env.js";
import {
  DEFAULT_M365_LOOKBACK_DAYS,
  DEFAULT_M365_MAX_MESSAGES_PER_MAILBOX,
  DEFAULT_M365_PAGE_SIZE,
} from "../integrations/m365/constants.js";
import type { MailboxConnectionConfig } from "../domain/m365-mailbox.js";

export type M365Env = {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  redirectUri: string;
};

export type M365RetrievalLimits = {
  lookbackDays: number;
  maxMessagesPerMailbox: number;
  pageSize: number;
};

function required(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new ConfigurationError(
      `Missing ${name}. Copy .env.example to .env and fill in Microsoft Entra app values.`,
    );
  }
  return trimmed;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function positiveInt(name: string, value: string | undefined, fallback: number): number {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigurationError(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function loadM365Env(
  source: NodeJS.ProcessEnv = process.env,
  options: { requireCredentials?: boolean } = {},
): M365Env {
  const requireCredentials = options.requireCredentials ?? false;
  const clientId = source.M365_CLIENT_ID?.trim() ?? "";
  const clientSecret = source.M365_CLIENT_SECRET?.trim() ?? "";
  const tenantId = optional(source.M365_TENANT_ID) ?? "common";
  const redirectUri =
    optional(source.M365_REDIRECT_URI) ??
    `http://127.0.0.1:${optional(source.APP_PORT) ?? "8787"}/api/m365/oauth/callback`;

  if (requireCredentials) {
    return {
      clientId: required("M365_CLIENT_ID", clientId),
      clientSecret: required("M365_CLIENT_SECRET", clientSecret),
      tenantId,
      redirectUri,
    };
  }

  return { clientId, clientSecret, tenantId, redirectUri };
}

export function loadM365RetrievalLimits(source: NodeJS.ProcessEnv = process.env): M365RetrievalLimits {
  return {
    lookbackDays: positiveInt("M365_LOOKBACK_DAYS", source.M365_LOOKBACK_DAYS, DEFAULT_M365_LOOKBACK_DAYS),
    maxMessagesPerMailbox: positiveInt(
      "M365_MAX_MESSAGES_PER_MAILBOX",
      source.M365_MAX_MESSAGES_PER_MAILBOX,
      DEFAULT_M365_MAX_MESSAGES_PER_MAILBOX,
    ),
    pageSize: positiveInt("M365_PAGE_SIZE", source.M365_PAGE_SIZE, DEFAULT_M365_PAGE_SIZE),
  };
}

type MailboxConfigFile = {
  mailboxes?: MailboxConnectionConfig[];
};

export function loadM365MailboxConfig(
  configPath = resolve(process.cwd(), "config/m365-mailboxes.json"),
): MailboxConnectionConfig[] {
  if (!existsSync(configPath)) {
    return [];
  }
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as MailboxConfigFile;
  const mailboxes = raw.mailboxes ?? [];
  const seen = new Set<string>();
  const output: MailboxConnectionConfig[] = [];
  for (const mailbox of mailboxes) {
    if (!mailbox.connection_id || !mailbox.product_scope) continue;
    if (seen.has(mailbox.connection_id)) continue;
    seen.add(mailbox.connection_id);
    if (mailbox.product_scope !== "PORTAL_GENIE" && mailbox.product_scope !== "NAGGING_PANDA") {
      continue;
    }
    output.push({
      connection_id: mailbox.connection_id,
      product_scope: mailbox.product_scope,
      mailbox_email: mailbox.mailbox_email?.trim() || undefined,
      display_name: mailbox.display_name?.trim() || undefined,
    });
  }
  return output;
}

export function m365StoreRoot(): string {
  return resolve(process.cwd(), "diagnostics/m365");
}

export function m365ConnectionStorePath(connectionId: string): string {
  return resolve(m365StoreRoot(), "connections", `${connectionId}.json`);
}
