import assert from "node:assert/strict";
import test from "node:test";
import { GraphHttp, assertGraphReadOnly } from "../src/integrations/m365/graph-http.js";
import { M365ReadOnlyViolationError } from "../src/integrations/m365/errors.js";
import { createLogger } from "../src/logging/logger.js";

test("assertGraphReadOnly blocks write methods and send paths", () => {
  assert.throws(
    () => assertGraphReadOnly("POST", "https://graph.microsoft.com/v1.0/me/sendMail"),
    M365ReadOnlyViolationError,
  );
  assert.throws(
    () => assertGraphReadOnly("GET", "https://graph.microsoft.com/v1.0/me/messages/abc/send"),
    M365ReadOnlyViolationError,
  );
  assert.doesNotThrow(() => assertGraphReadOnly("GET", "https://graph.microsoft.com/v1.0/me"));
});

test("GraphHttp maps auth failure to UNAVAILABLE retrieval state", async () => {
  const http = new GraphHttp({
    getAccessToken: async () => "token",
    logger: createLogger({ level: "error" }),
    fetchImpl: (async () => new Response(JSON.stringify({ error: { code: "InvalidAuthenticationToken" } }), {
      status: 401,
    })) as typeof fetch,
  });
  const result = await http.get("/me");
  assert.equal(result.retrieval, "UNAVAILABLE");
  assert.notEqual(result.retrieval, "EMPTY");
});

test("GraphHttp maps server failure to ERROR not EMPTY", async () => {
  const http = new GraphHttp({
    getAccessToken: async () => "token",
    logger: createLogger({ level: "error" }),
    fetchImpl: (async () => new Response("{}", { status: 503 })) as typeof fetch,
    maxRetries: 0,
  });
  const result = await http.get("/me");
  assert.equal(result.retrieval, "ERROR");
  assert.notEqual(result.retrieval, "EMPTY");
});

test("GraphHttp maps empty collection to EMPTY on success", async () => {
  const http = new GraphHttp({
    getAccessToken: async () => "token",
    logger: createLogger({ level: "error" }),
    fetchImpl: (async () => new Response(JSON.stringify({ value: [] }), { status: 200 })) as typeof fetch,
  });
  const result = await http.get("/me/messages");
  assert.equal(result.retrieval, "EMPTY");
});

test("GraphHttp preserves mailbox path in GET request", async () => {
  let requested = "";
  const http = new GraphHttp({
    getAccessToken: async () => "token",
    logger: createLogger({ level: "error" }),
    fetchImpl: (async (input, init) => {
      requested = String(input);
      assert.equal(init?.method ?? "GET", "GET");
      return new Response(JSON.stringify({ mail: "sales@theportalgenie.com" }), { status: 200 });
    }) as typeof fetch,
  });
  const result = await http.get("/users/sales%40theportalgenie.com");
  assert.match(requested, /\/users\/sales%40theportalgenie.com/);
  assert.equal(result.retrieval, "RETRIEVED");
});
