import assert from "node:assert/strict";
import test from "node:test";
import { loadEnvFile } from "../src/config/load-env.js";
import { ConfigurationError, loadZohoEnv } from "../src/config/env.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("loadZohoEnv rejects missing required values", () => {
  assert.throws(
    () => loadZohoEnv({}, { requireRefreshToken: true }),
    (error: unknown) => error instanceof ConfigurationError && error.message.includes("ZOHO_CLIENT_ID"),
  );
});

test("loadZohoEnv reads refresh token and default accounts URL", () => {
  const env = loadZohoEnv({
    ZOHO_CLIENT_ID: "id",
    ZOHO_CLIENT_SECRET: "secret",
    ZOHO_REFRESH_TOKEN: "refresh",
    ZOHO_REDIRECT_URI: "http://localhost",
  });
  assert.equal(env.clientId, "id");
  assert.equal(env.accountsUrl, "https://accounts.zoho.com");
  assert.equal(env.refreshToken, "refresh");
});

test("loadEnvFile does not override existing process env", () => {
  const dir = mkdtempSync(join(tmpdir(), "pg-env-"));
  const file = join(dir, ".env");
  writeFileSync(file, "ZOHO_CLIENT_ID=from-file\n", "utf8");
  const previous = process.env.ZOHO_CLIENT_ID;
  process.env.ZOHO_CLIENT_ID = "from-process";
  loadEnvFile(file);
  assert.equal(process.env.ZOHO_CLIENT_ID, "from-process");
  if (previous === undefined) {
    delete process.env.ZOHO_CLIENT_ID;
  } else {
    process.env.ZOHO_CLIENT_ID = previous;
  }
});
