import assert from "node:assert/strict";
import test from "node:test";
import { ZohoRuntime } from "../src/services/zoho-runtime.js";

test("getClient reuses the OAuth client across analyses", () => {
  const keys = ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN", "ZOHO_REDIRECT_URI"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.ZOHO_CLIENT_ID = "test-client";
  process.env.ZOHO_CLIENT_SECRET = "test-secret";
  process.env.ZOHO_REFRESH_TOKEN = "test-refresh";
  process.env.ZOHO_REDIRECT_URI = "http://localhost";
  try {
    const runtime = new ZohoRuntime();
    const first = runtime.getClient();
    const second = runtime.getClient();
    assert.equal(first.oauth, second.oauth);
    assert.equal(first.client, second.client);
    runtime.reset();
    const third = runtime.getClient();
    assert.notEqual(third.oauth, first.oauth);
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
