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
    assert.match(html, /Usage Intelligence/);
    assert.match(html, /Pipeline Intelligence/);
    assert.match(html, /Command Centre/);
    assert.match(html, /Sales Command Centre/);
    assert.match(html, /The Portal Genie/);
    assert.doesNotMatch(html, /ZOHO_CLIENT_SECRET|refresh_token|access_token/i);
    assert.match(html, /m365-connection-card/);
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
    assert.match(js, /Record real-world event/);
    assert.match(js, /Save \+ re-analyse/);
    assert.match(js, /OPERATOR EVENT/);
    assert.match(js, /Why this action/);
    assert.match(js, /Organisation snapshot/);
    assert.match(js, /Related accounts/);
    assert.match(js, /Confirmed CRM activity/);
    assert.match(js, /Inferred real-world activity/);
    assert.match(js, /Opportunities \/ deal context/);
    assert.match(js, /Evidence \/ CRM details/);
    assert.match(js, /People in this organisation/);
    assert.match(js, /Commercial story/);
    assert.match(js, /CRM structure review/);
    assert.match(js, /Product relationships/);
    assert.match(js, /Portal visits = visits by the subscriber's clients/);
    assert.match(js, /USAGE DATA UPDATED — ANALYSIS MAY BE STALE/);
    assert.match(js, /Portal Genie usage/);
    assert.match(js, /No Sales Command Centre snapshot yet/);
    assert.match(js, /Scan CRM/);
    assert.match(js, /renderDailyBrief/);
    assert.match(js, /Do first/);
    assert.match(js, /Research \/ data required/);
    assert.match(js, /Commercial watch/);
    assert.match(js, /data-watch-id/);
    assert.match(js, /focusWatchItem/);
    assert.match(js, /Nothing requires immediate customer contact/);
    assert.match(js, /appendKv\(card, "When"/);
    assert.doesNotMatch(js, /Opportunities worth re-engaging/);
    assert.match(js, /el\("article", \{ class: "cc-item"/);
    assert.match(js, /\/api\/command-centre\/snapshot/);
    assert.match(js, /confirm: true/);
    assert.match(js, /maxOrganisations: 5/);
    assert.match(js, /full_rebuild/);
    assert.match(js, /async function loadCommandCentre/);
    assert.match(js, /ccSnapshot = null/);
    assert.match(js, /\/not found\/i.test\(message\)/);
    assert.match(js, /async function runCcScan/);
    assert.doesNotMatch(js, /async function loadCommandCentre[\s\S]{0,400}\/api\/intelligence\/analyse/);
    assert.doesNotMatch(js, /async function runCcScan[\s\S]{0,500}\/api\/intelligence\/analyse/);
    assert.match(js, /renderM365Connections/);
    assert.match(js, /\/api\/m365\/status/);
    assert.match(js, /Microsoft 365 mailboxes/);
    assert.match(js, /cc-manage-btn/);
    assert.match(js, /openManageDialog/);
    assert.match(js, /decisionPayloadFromWatchItem/);
    assert.match(js, /recommendation_fingerprint/);
    assert.match(js, /evidence_snapshot_ref/);
    assert.match(js, /Not an opportunity for:/);
    assert.match(js, /This will NOT suppress/);
    assert.match(js, /Save dismiss/);
    assert.match(js, /Customer interaction/);
    assert.match(js, /Internal \/ review only/);
    assert.match(js, /linked_sales_event_id/);
    assert.match(js, /operatorControlBadgeText/);
    assert.match(js, /\/api\/command-centre\/refresh-control/);
    assert.match(js, /Control history/);
    assert.match(js, /Undo \/ Reopen/);
  });
});

test("GET /assets/app.css lets the workspace scroll past the analysis hero", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/assets/app.css`);
    const css = await response.text();
    assert.equal(response.status, 200);
    assert.match(css, /\.app-shell\s*\{[^}]*overflow:\s*hidden/s);
    assert.match(css, /\.workspace\s*\{[^}]*overflow:\s*auto/s);
    assert.match(css, /\.cc-queue/);
    assert.match(css, /\.cc-brief-row/);
    assert.match(css, /\.cc-brief-watch/);
    assert.match(css, /\.cc-item\s*\{[^}]*color:\s*var\(--ink\)/s);
    assert.match(css, /\.cc-manage-dialog/);
    assert.match(css, /\.cc-operator-badge/);
    assert.doesNotMatch(css, /\.workspace\s*\{[^}]*display:\s*flex/s);
  });
});

test("GET /api/m365/status does not expose secrets", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/m365/status`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.readOnly, true);
    assert.doesNotMatch(JSON.stringify(body), /refresh_token|access_token|client_secret/i);
    assert.match((body.scopes ?? []).join(" "), /Mail\.Read/);
    assert.doesNotMatch((body.scopes ?? []).join(" "), /Mail\.Send/);
  });
});

test("empty CRM search does not require a live Zoho session", async () => {
  const result = await zohoRuntime.search("   ");
  assert.equal(result.hits.length, 0);
  assert.match(result.warnings[0] ?? "", /email|name|company|id/i);
});
