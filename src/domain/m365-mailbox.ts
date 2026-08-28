import type { ProductId } from "./product-relationship.js";
import type { RetrievalState } from "./retrieval-state.js";

export type MailboxProductScope = Extract<ProductId, "PORTAL_GENIE" | "NAGGING_PANDA">;

export type MailboxConnectionStatus = "connected" | "not_connected" | "connection_error";

export type MailboxConnectionConfig = {
  connection_id: string;
  product_scope: MailboxProductScope;
  /** Operator-configured mailbox address; may be filled after OAuth /me. */
  mailbox_email?: string;
  display_name?: string;
};

export type MailboxConnectionRecord = MailboxConnectionConfig & {
  status: MailboxConnectionStatus;
  authentication_status: "authenticated" | "not_authenticated" | "error";
  last_successful_connection?: string;
  last_sync_attempt?: string;
  last_successful_sync?: string;
  retrieval_state: RetrievalState;
  error?: string;
  read_only: true;
};

export type M365ConnectionOverview = {
  configured: boolean;
  clientIdConfigured: boolean;
  clientSecretConfigured: boolean;
  tenantId: string;
  redirectUri?: string;
  scopes: string[];
  readOnly: true;
  mailboxes: MailboxConnectionRecord[];
};
