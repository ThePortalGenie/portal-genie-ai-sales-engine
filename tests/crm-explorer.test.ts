import assert from "node:assert/strict";
import test from "node:test";
import { searchCrmRecords } from "../src/services/crm-search.js";
import { buildTimeline } from "../src/web/timeline.js";
import { buildRelationshipView } from "../src/web/relationship-view.js";
import { redactSecrets } from "../src/security/redact.js";
import type { ZohoCrmReader } from "../src/integrations/zoho/client.js";
import type { DiscoveryDiagnostic, ZohoHttpResult } from "../src/integrations/zoho/types.js";

function ok(json: unknown): ZohoHttpResult {
  return { ok: true, status: 200, noContent: false, json };
}

function empty(): ZohoHttpResult {
  return { ok: true, status: 204, noContent: true, json: null };
}

const contact = { id: "111", Full_Name: "Jane Smith", Email: "jane@abc.com", Account_Name: { name: "ABC Accounting" } };
const lead = { id: "333", Full_Name: "Jane Smith", Email: "jane@abc.com", Company: "ABC Accounting" };

function fakeSearchClient(): ZohoCrmReader {
  return {
    async getRecord(moduleApiName, recordId) {
      if (moduleApiName === "Contacts" && recordId === "111") return ok({ data: [contact] });
      return { ok: false, status: 400, noContent: false, json: { code: "INVALID_DATA" } };
    },
    async searchByEmail(moduleApiName, email) {
      if (email === "jane@abc.com" && moduleApiName === "Contacts") return ok({ data: [contact] });
      if (email === "jane@abc.com" && moduleApiName === "Leads") return ok({ data: [lead] });
      return empty();
    },
    async searchByWord(moduleApiName, word) {
      if (word === "ABC" && moduleApiName === "Contacts") return ok({ data: [contact] });
      if (word === "ABC" && moduleApiName === "Accounts") {
        return ok({ data: [{ id: "222", Account_Name: "ABC Accounting" }] });
      }
      return empty();
    },
    async getFields() { return empty(); },
    async getRelatedLists() { return empty(); },
    async getRelatedRecords() { return empty(); },
    async getEmails() { return empty(); },
    async getEmail() { return empty(); },
    async getTags() { return empty(); },
    async getOrg() { return ok({ org: [{ company_name: "Test Org" }] }); },
  };
}

test("search lists Contacts and Leads separately instead of merging", async () => {
  const modules: string[] = [];
  const client = fakeSearchClient();
  const result = await searchCrmRecords(
    {
      ...client,
      async searchByEmail(moduleApiName, email) {
        modules.push(moduleApiName);
        return client.searchByEmail(moduleApiName, email);
      },
    },
    "jane@abc.com",
  );
  assert.equal(result.hits.length, 2);
  assert.deepEqual(result.hits.map((hit) => hit.module).sort(), ["Contacts", "Leads"]);
  assert.deepEqual(modules, ["Contacts", "Leads"]);
  assert.equal(result.warnings.length, 0);
});

test("word search can return Account and Contact without merging", async () => {
  const result = await searchCrmRecords(fakeSearchClient(), "ABC");
  assert.ok(result.hits.some((hit) => hit.module === "Contacts"));
  assert.ok(result.hits.some((hit) => hit.module === "Accounts"));
});

test("timeline omits events that have no usable timestamp", () => {
  const diagnostic = {
    emails: {
      headers: [{ subject: "No date", time: null, sent: true, messageId: "x", from: null, to: null, ownerId: null, hasAttachment: false }],
      bodies: [],
    },
    relatedLists: {
      available: [],
      retrievals: [
        {
          apiName: "Notes",
          displayLabel: "Notes",
          attempted: true,
          success: true,
          recordCount: 2,
          moreRecords: false,
          fieldsUsed: [],
          records: [
            { id: "n1", Note_Title: "Dated", Note_Content: "Hello", Created_Time: "2025-03-12T10:00:00Z" },
            { id: "n2", Note_Title: "No date", Note_Content: "Skip me" },
          ],
        },
      ],
    },
  } as unknown as DiscoveryDiagnostic;
  const events = buildTimeline(diagnostic);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.title, "Dated");
});

test("emails unavailable is not presented as empty history", () => {
  const diagnostic = {
    primaryRecord: { module: "Contacts", id: "111", record: { Full_Name: "Jane" }, tags: null, retrieved: true, lookupFollowUps: [] },
    fieldCatalog: { standardFields: [], customFields: [] },
    relatedLists: { retrievals: [] },
    emails: { listAttempted: true, success: false, count: 0, headers: [], bodies: [], error: "NO_PERMISSION", moreRecords: false, note: "" },
    warnings: [],
    errors: [],
  } as unknown as DiscoveryDiagnostic;
  const view = buildRelationshipView(diagnostic);
  const emails = view.capabilities.find((item) => item.key === "Emails");
  assert.equal(emails?.status, "unavailable");
  assert.match(emails?.message ?? "", /NO_PERMISSION|did not provide|access/i);
});

test("redactSecrets removes tokens from diagnostic payloads", () => {
  const redacted = redactSecrets({ refresh_token: "secret", nested: { access_token: "nope" }, id: "111" });
  assert.equal(redacted.refresh_token, "[redacted]");
  assert.equal(redacted.nested.access_token, "[redacted]");
  assert.equal(redacted.id, "111");
});

test("relationship header falls back to account name", () => {
  const diagnostic = {
    primaryRecord: {
      module: "Accounts",
      id: "222",
      record: { Account_Name: { name: "ABC Accounting", id: "222" } },
      tags: null,
      retrieved: true,
      lookupFollowUps: [],
    },
    fieldCatalog: { standardFields: [], customFields: [] },
    relatedLists: { retrievals: [], available: [] },
    emails: { listAttempted: false, success: false, count: 0, headers: [], bodies: [], error: undefined, moreRecords: false, note: "" },
    warnings: [],
    errors: [],
  } as unknown as DiscoveryDiagnostic;
  const view = buildRelationshipView(diagnostic);
  assert.equal(view.header.name, "ABC Accounting");
});

test("Deals capability matches Potentials related-list api name", () => {
  const diagnostic = {
    primaryRecord: {
      module: "Contacts",
      id: "111",
      record: { Full_Name: "Jane" },
      tags: null,
      retrieved: true,
      lookupFollowUps: [],
    },
    fieldCatalog: { standardFields: [], customFields: [] },
    relatedLists: {
      available: [{ apiName: "Potentials", displayLabel: "Deals", relatedModuleApiName: "Deals" }],
      retrievals: [
        {
          apiName: "Potentials",
          displayLabel: "Deals",
          attempted: true,
          success: true,
          recordCount: 2,
          records: [{ id: "d1", Deal_Name: "Pilot", Created_Time: "2025-03-18T10:00:00Z" }],
        },
      ],
    },
    emails: { listAttempted: true, success: true, count: 0, headers: [], bodies: [], moreRecords: false, note: "" },
    warnings: [],
    errors: [],
  } as unknown as DiscoveryDiagnostic;
  const view = buildRelationshipView(diagnostic);
  const deals = view.capabilities.find((item) => item.key === "Deals");
  assert.equal(deals?.status, "retrieved");
  assert.equal(deals?.count, 2);
});
