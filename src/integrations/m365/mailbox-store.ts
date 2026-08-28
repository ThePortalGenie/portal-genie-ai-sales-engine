import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { m365ConnectionStorePath, m365StoreRoot } from "../../config/m365.js";
import type { MailboxConnectionConfig } from "../../domain/m365-mailbox.js";
import type { RetrievalState } from "../../domain/retrieval-state.js";

export type MailboxTokenRecord = {
  connection_id: string;
  product_scope: MailboxConnectionConfig["product_scope"];
  mailbox_email?: string;
  display_name?: string;
  refresh_token?: string;
  last_successful_connection?: string;
  last_sync_attempt?: string;
  last_successful_sync?: string;
  retrieval_state: RetrievalState;
  error?: string;
};

function ensureStoreDir(): void {
  mkdirSync(m365StoreRoot(), { recursive: true });
  mkdirSync(`${m365StoreRoot()}/connections`, { recursive: true });
}

export function readMailboxToken(connectionId: string): MailboxTokenRecord | null {
  const path = m365ConnectionStorePath(connectionId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as MailboxTokenRecord;
  } catch {
    return null;
  }
}

export function writeMailboxToken(record: MailboxTokenRecord): void {
  ensureStoreDir();
  const path = m365ConnectionStorePath(record.connection_id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export function deleteMailboxToken(connectionId: string): void {
  const path = m365ConnectionStorePath(connectionId);
  if (!existsSync(path)) return;
  writeFileSync(path, "", "utf8");
}

export function listMailboxTokenIds(): string[] {
  const dir = `${m365StoreRoot()}/connections`;
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}
