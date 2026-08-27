import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { handleRequest } from "../src/server/app.js";
import { zohoRuntime } from "../src/services/zoho-runtime.js";

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test("GET / serves the CRM Explorer HTML without secrets", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /CRM Explorer/);
    assert.match(html, /Settings/);
    assert.doesNotMatch(html, /ZOHO_CLIENT_SECRET|refresh_token|access_token/i);
  });
});

test("GET /api/crm/relationship rejects invalid ids", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/crm/relationship?module=Contacts&id=not-an-id`);
    assert.equal(response.status, 400);
  });
});

test("GET /api/intelligence/status does not expose secrets", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/intelligence/status`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(typeof body.configured, "boolean");
    assert.equal(typeof body.model, "string");
    assert.doesNotMatch(JSON.stringify(body), /sk-|api_key|OPENAI_API_KEY/i);
  });
});

test("GET /assets/app.js includes commercial analysis action", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/assets/app.js`);
    const js = await response.text();
    assert.match(js, /ANALYSE COMMERCIAL OPPORTUNITY/);
    assert.match(js, /POSSIBLE MATCH — REVIEW/);
    assert.match(js, /POSSIBLY RELATED ACCOUNT RECORDS/);
    assert.match(js, /Related contacts/);
    assert.match(js, /organisationGraph/);
    assert.match(js, /Record sales event/);
    assert.match(js, /Save \+ re-analyse/);
    assert.match(js, /OPERATOR EVENT/);
  });
});

test("empty CRM search does not require a live Zoho session", async () => {
  const result = await zohoRuntime.search("   ");
  assert.equal(result.hits.length, 0);
  assert.match(result.warnings[0] ?? "", /email|name|company|id/i);
});
