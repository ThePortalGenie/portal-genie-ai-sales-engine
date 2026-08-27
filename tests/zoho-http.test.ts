import assert from "node:assert/strict";
import test from "node:test";
import { ReadOnlyViolationError } from "../src/integrations/zoho/errors.js";
import { ZohoHttp, assertCrmReadOnly } from "../src/integrations/zoho/http.js";
import { createLogger } from "../src/logging/logger.js";

test("assertCrmReadOnly blocks write methods", () => {
  assert.throws(
    () => assertCrmReadOnly("POST", "https://www.zohoapis.com/crm/v8/Contacts"),
    ReadOnlyViolationError,
  );
  assert.throws(
    () => assertCrmReadOnly("PUT", "https://www.zohoapis.com/crm/v8/Contacts/1"),
    ReadOnlyViolationError,
  );
  assert.doesNotThrow(() => assertCrmReadOnly("GET", "https://www.zohoapis.com/crm/v8/Contacts/1"));
});

test("ZohoHttp GET sends Zoho-oauthtoken and parses JSON", async () => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const http = new ZohoHttp({
    getAccessToken: async () => "test-token",
    getApiDomain: async () => "https://www.zohoapis.com",
    logger: createLogger({ level: "error" }),
    fetchImpl: (async (input) => {
      const url = String(input);
      calls.push({ url, authorization: "Zoho-oauthtoken test-token" });
      return new Response(JSON.stringify({ data: [{ id: "1" }] }), { status: 200 });
    }) as typeof fetch,
  });

  const result = await http.get("/crm/v8/Contacts/1");
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { data: [{ id: "1" }] });
  assert.match(calls[0]?.url ?? "", /\/crm\/v8\/Contacts\/1$/);
});

test("ZohoHttp treats HTTP 204 as successful empty content", async () => {
  const http = new ZohoHttp({
    getAccessToken: async () => "test-token",
    getApiDomain: async () => "https://www.zohoapis.com",
    logger: createLogger({ level: "error" }),
    fetchImpl: (async () => new Response(null, { status: 204 })) as typeof fetch,
  });
  const result = await http.get("/crm/v8/Contacts/1/Notes");
  assert.equal(result.ok, true);
  assert.equal(result.noContent, true);
});
