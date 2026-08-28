import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { loadM365MailboxConfig, loadM365RetrievalLimits, m365ConnectionStorePath } from "../src/config/m365.js";
import { m365Runtime } from "../src/services/m365-runtime.js";
import { handleRequest } from "../src/server/app.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const TEST_CONNECTION = "portal-genie-primary";

function writeTestToken(connectionId: string, refreshToken: string): void {
  const path = m365ConnectionStorePath(connectionId);
  mkdirSync(resolve(process.cwd(), "diagnostics/m365/connections"), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      connection_id: connectionId,
      product_scope: "PORTAL_GENIE",
      refresh_token: refreshToken,
      retrieval_state: "UNAVAILABLE",
    })}\n`,
    "utf8",
  );
}

function cleanupTestToken(connectionId: string): void {
  const path = m365ConnectionStorePath(connectionId);
  if (existsSync(path)) rmSync(path);
}

test("mailbox config preserves independent connection identities", () => {
  const mailboxes = loadM365MailboxConfig();
  assert.ok(mailboxes.length >= 2);
  const ids = new Set(mailboxes.map((item) => item.connection_id));
  assert.equal(ids.size, mailboxes.length);
  const scopes = new Set(mailboxes.map((item) => item.product_scope));
  assert.ok(scopes.has("PORTAL_GENIE"));
  assert.ok(scopes.has("NAGGING_PANDA"));
});

test("retrieval limits enforce positive caps with conservative defaults", () => {
  const limits = loadM365RetrievalLimits({});
  assert.ok(limits.lookbackDays > 0);
  assert.ok(limits.maxMessagesPerMailbox > 0);
  assert.ok(limits.pageSize > 0);
  assert.ok(limits.pageSize <= limits.maxMessagesPerMailbox);
});

test("connection status exposes configured mailboxes without tokens", async () => {
  const status = await m365Runtime.connectionStatus();
  assert.equal(status.readOnly, true);
  assert.match(status.scopes.join(" "), /Mail\.Read/);
  assert.doesNotMatch(status.scopes.join(" "), /Mail\.Send/);
  for (const mailbox of status.mailboxes) {
    assert.ok(mailbox.connection_id);
    assert.ok(mailbox.product_scope === "PORTAL_GENIE" || mailbox.product_scope === "NAGGING_PANDA");
    assert.equal(mailbox.read_only, true);
  }
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /refresh_token|access_token|client_secret/i);
});

test("diagnostics redacts mailbox token secrets", () => {
  cleanupTestToken(TEST_CONNECTION);
  writeTestToken(TEST_CONNECTION, "secret-refresh-token-value");
  try {
    const view = m365Runtime.diagnosticsView();
    const serialized = JSON.stringify(view);
    assert.doesNotMatch(serialized, /secret-refresh-token-value/);
    assert.doesNotMatch(serialized, /refresh_token/i);
  } finally {
    cleanupTestToken(TEST_CONNECTION);
  }
});

test("oauth start URL encodes mailbox connection_id in state", () => {
  const previousClientId = process.env.M365_CLIENT_ID;
  const previousClientSecret = process.env.M365_CLIENT_SECRET;
  process.env.M365_CLIENT_ID = "test-client-id";
  process.env.M365_CLIENT_SECRET = "test-client-secret";
  try {
    const url = m365Runtime.oauthStartUrl(TEST_CONNECTION);
    assert.match(url, /login\.microsoftonline\.com/);
    assert.match(url, /scope=.*Mail\.Read/);
    const state = new URL(url).searchParams.get("state") ?? "";
    assert.match(state, /^portal-genie-primary:/);
    assert.ok(m365Runtime.consumeOAuthState(state));
  } finally {
    if (previousClientId === undefined) delete process.env.M365_CLIENT_ID;
    else process.env.M365_CLIENT_ID = previousClientId;
    if (previousClientSecret === undefined) delete process.env.M365_CLIENT_SECRET;
    else process.env.M365_CLIENT_SECRET = previousClientSecret;
  }
});

test("unauthenticated sync remains UNAVAILABLE not EMPTY", async () => {
  cleanupTestToken("nagging-panda-primary");
  const result = await m365Runtime.syncMailbox("nagging-panda-primary");
  assert.equal(result.retrieval_state, "UNAVAILABLE");
  assert.notEqual(result.retrieval_state, "EMPTY");
  assert.match(result.error ?? "", /not authenticated/i);
});

test("GET /api/m365/status does not expose secrets", async () => {
  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/m365/status`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.doesNotMatch(JSON.stringify(body), /refresh_token|access_token|client_secret/i);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("no m365 send endpoint is exposed", async () => {
  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/m365/send`, { method: "POST", body: "{}" });
    assert.equal(response.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("gitignore excludes diagnostics/m365 connection token files", () => {
  const gitignore = readFileSync(resolve(process.cwd(), ".gitignore"), "utf8");
  assert.match(gitignore, /diagnostics\/m365\//);
});
