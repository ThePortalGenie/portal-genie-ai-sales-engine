import assert from "node:assert/strict";
import test from "node:test";
import { runDiscovery } from "../src/integrations/zoho/discovery.js";
import type { ZohoCrmReader } from "../src/integrations/zoho/client.js";
import type { ZohoHttpResult } from "../src/integrations/zoho/types.js";

function ok(json: unknown, status = 200): ZohoHttpResult {
  return { ok: true, status, noContent: false, json };
}

function fail(status: number, code: string, message: string): ZohoHttpResult {
  return { ok: false, status, noContent: false, json: { code, message, status: "error" } };
}

function empty(): ZohoHttpResult {
  return { ok: true, status: 204, noContent: true, json: null };
}

function createFakeClient(overrides: Partial<ZohoCrmReader> = {}): ZohoCrmReader {
  const contact = {
    id: "111",
    Full_Name: "Jane Smith",
    Email: "jane@abcaccounting.com",
    Account_Name: { name: "ABC Accounting", id: "222" },
    Tag: [{ name: "Roadshow 2025", id: "tag1" }],
    Industry: "Accounting",
  };

  const base: ZohoCrmReader = {
    async getRecord(moduleApiName, recordId) {
      if (moduleApiName === "Contacts" && recordId === "111") {
        return ok({ data: [contact] });
      }
      if (moduleApiName === "Accounts" && recordId === "222") {
        return ok({ data: [{ id: "222", Account_Name: "ABC Accounting", Billing_Country: "Australia" }] });
      }
      return fail(400, "INVALID_DATA", "not found");
    },
    async searchByEmail(moduleApiName, email) {
      if (moduleApiName === "Contacts" && email === "jane@abcaccounting.com") {
        return ok({ data: [contact] });
      }
      return fail(204, "NO_CONTENT", "no content");
    },
    async getFields(moduleApiName) {
      if (moduleApiName === "Contacts") {
        return ok({
          fields: [
            { api_name: "Email", field_label: "Email", data_type: "email", custom_field: false },
            { api_name: "Xero_Partner", field_label: "Xero Partner", data_type: "boolean", custom_field: true },
          ],
        });
      }
      return fail(400, "INVALID_MODULE", "unsupported");
    },
    async getRelatedLists() {
      return ok({
        related_lists: [
          {
            api_name: "Notes",
            display_label: "Notes",
            href: "Contacts/{ENTITYID}/Notes",
            status: "visible",
            type: "default",
            module: { api_name: "Notes" },
          },
          {
            api_name: "Deals",
            display_label: "Deals",
            href: "Contacts/{ENTITYID}/Deals",
            status: "visible",
            type: "default",
            module: { api_name: "Deals" },
          },
          {
            api_name: "Emails",
            display_label: "Emails",
            href: "Contacts/{ENTITYID}/Emails",
            status: "visible",
            type: "default",
          },
          {
            api_name: "Activities_Chronological_View",
            display_label: "Open Activities",
            href: null,
            status: "visible",
            type: "grouped",
            fields: [{ api_name: "!Tasks.Subject" }],
          },
          {
            api_name: "Social",
            display_label: "Social",
            href: "Contacts/{ENTITYID}/Social",
            status: "visible",
            type: "default",
          },
          {
            api_name: "Voice_of_the_Customer",
            display_label: "Voice of the Customer",
            href: "Contacts/{ENTITYID}/Voice_of_the_Customer",
            status: "visible",
            type: "default",
          },
          {
            api_name: "Products",
            display_label: "Products",
            href: "Contacts/{ENTITYID}/Products",
            status: "visible",
            type: "default",
            module: { api_name: "Products" },
          },
        ],
      });
    },
    async getRelatedRecords(_module, _id, relatedListApiName) {
      if (["Products", "Social", "Voice_of_the_Customer", "Activities_Chronological_View"].includes(relatedListApiName)) {
        throw new Error(`should not retrieve ${relatedListApiName}`);
      }
      if (relatedListApiName === "Notes") {
        return ok({
          data: [{ id: "n1", Note_Title: "Roadshow follow-up", Note_Content: "Interested in client portals" }],
          info: { more_records: false },
        });
      }
      if (relatedListApiName === "Deals") {
        return empty();
      }
      if (relatedListApiName === "Activities_Chronological_View") {
        return fail(400, "INVALID_DATA", "related list not present in layout");
      }
      return empty();
    },
    async getEmails() {
      return ok({
        Emails: [
          {
            message_id: "m1",
            subject: "Thanks for visiting the stand",
            time: "2025-06-01T10:00:00+01:00",
            sent: true,
            from: { email: "sales@portalgenie.com" },
            owner: { id: "owner1" },
            has_attachment: false,
          },
        ],
        info: { more_records: false },
      });
    },
    async getEmail() {
      return ok({
        Emails: [
          {
            subject: "Thanks for visiting the stand",
            content: "<p>Great to meet you at the Xero roadshow.</p>",
          },
        ],
      });
    },
    async getTags() {
      return ok({ tags: [{ name: "Roadshow 2025", id: "tag1" }] });
    },
    async searchByWord(moduleApiName, word) {
      if (moduleApiName === "Contacts" && /jane|abc/i.test(word)) {
        return ok({ data: [contact] });
      }
      return fail(204, "NO_CONTENT", "no content");
    },
    async getOrg() {
      return ok({ org: [{ company_name: "Portal Genie", domain_name: "example" }] });
    },
    async getRecords() {
      return empty();
    },
  };

  return { ...base, ...overrides };
}

test("runDiscovery retrieves contact context, notes, emails, and account lookup", async () => {
  const diagnostic = await runDiscovery(
    {
      client: createFakeClient(),
      accountsUrl: "https://accounts.zoho.com",
      apiDomain: "https://www.zohoapis.com",
    },
    { fetchEmailBodies: 1, maxRelatedRecords: 50, recordId: "111", module: "Contacts" },
  );

  assert.equal(diagnostic.primaryRecord.retrieved, true);
  assert.equal(diagnostic.primaryRecord.module, "Contacts");
  assert.equal(diagnostic.fieldCatalog.customFields[0]?.apiName, "Xero_Partner");
  assert.equal(diagnostic.relatedLists.retrievals.find((item) => item.apiName === "Emails")?.attempted, false);
  assert.equal(diagnostic.relatedLists.retrievals.find((item) => item.apiName === "Notes")?.recordCount, 1);
  assert.equal(diagnostic.emails.count, 1);
  assert.equal(diagnostic.emails.bodies[0]?.retrieved, true);
  assert.match(diagnostic.emails.bodies[0]?.contentPreview ?? "", /Xero roadshow/);
  assert.equal(diagnostic.primaryRecord.lookupFollowUps[0]?.module, "Accounts");
  assert.equal(diagnostic.primaryRecord.lookupFollowUps[0]?.retrieved, true);
  assert.equal(diagnostic.salesContextSummary.hasNotes, true);
  assert.equal(diagnostic.salesContextSummary.hasEmailBodies, true);
  assert.equal(diagnostic.salesContextSummary.hasAccount, true);
  assert.ok(diagnostic.salesContextSummary.salesRelevantCustomFields.includes("Xero_Partner"));
  assert.equal(
    diagnostic.relatedLists.retrievals.find((item) => item.apiName === "Activities_Chronological_View")?.attempted,
    false,
  );
  assert.equal(
    diagnostic.relatedLists.retrievals.find((item) => item.apiName === "Social")?.skipCategory,
    "unsupported-api",
  );
  assert.equal(
    diagnostic.relatedLists.retrievals.find((item) => item.apiName === "Voice_of_the_Customer")?.skipCategory,
    "unsupported-api",
  );
  assert.equal(
    diagnostic.relatedLists.retrievals.find((item) => item.apiName === "Products")?.skipCategory,
    "not-sales-relevant",
  );
  assert.equal(diagnostic.emails.endpoint, "/crm/v8/Contacts/111/Emails");
  assert.ok(diagnostic.emails.typesAttempted.includes("default"));
});

test("runDiscovery can resolve a record by email search", async () => {
  const diagnostic = await runDiscovery(
    {
      client: createFakeClient(),
      accountsUrl: "https://accounts.zoho.com",
      apiDomain: "https://www.zohoapis.com",
    },
    { fetchEmailBodies: 0, maxRelatedRecords: 10, email: "jane@abcaccounting.com" },
  );
  assert.equal(diagnostic.request.resolvedFrom, "email_search");
  assert.equal(diagnostic.primaryRecord.id, "111");
  assert.equal(diagnostic.emails.bodies.length, 0);
});

test("runDiscovery records missing records without throwing", async () => {
  const diagnostic = await runDiscovery(
    {
      client: createFakeClient({
        async getRecord() {
          return fail(400, "INVALID_DATA", "invalid");
        },
      }),
      accountsUrl: "https://accounts.zoho.com",
      apiDomain: "https://www.zohoapis.com",
    },
    { fetchEmailBodies: 0, maxRelatedRecords: 10, module: "Leads", recordId: "missing" },
  );
  assert.equal(diagnostic.primaryRecord.retrieved, false);
  assert.equal(diagnostic.errors[0]?.stage, "resolve-record");
});

test("email list CANNOT_PROCESS is unavailable, not empty", async () => {
  const diagnostic = await runDiscovery(
    {
      client: createFakeClient({
        async getEmails() {
          return fail(400, "CANNOT_PROCESS", "IMAP is configured for the mailbox and sync is in process");
        },
      }),
      accountsUrl: "https://accounts.zoho.com",
      apiDomain: "https://www.zohoapis.com",
    },
    { fetchEmailBodies: 0, maxRelatedRecords: 10, recordId: "111", module: "Contacts" },
  );
  assert.equal(diagnostic.emails.success, false);
  assert.equal(diagnostic.emails.count, 0);
  assert.match(diagnostic.emails.error ?? "", /IMAP|CANNOT_PROCESS|sync/i);
});

test("empty default email list still retrieves sent_from_crm emails", async () => {
  const diagnostic = await runDiscovery(
    {
      client: createFakeClient({
        async getEmails(_module, _id, query) {
          if (!query?.type) {
            return { ok: true, status: 204, noContent: true, json: null };
          }
          if (query.type === "sent_from_crm") {
            return ok({
              Emails: [{ message_id: "crm1", subject: "CRM sent", time: "2025-06-01T10:00:00Z", sent: true }],
              info: { more_records: false },
            });
          }
          return { ok: true, status: 204, noContent: true, json: null };
        },
      }),
      accountsUrl: "https://accounts.zoho.com",
      apiDomain: "https://www.zohoapis.com",
    },
    { fetchEmailBodies: 0, maxRelatedRecords: 10, recordId: "111", module: "Contacts" },
  );
  assert.equal(diagnostic.emails.success, true);
  assert.equal(diagnostic.emails.count, 1);
  assert.equal(diagnostic.emails.headers[0]?.subject, "CRM sent");
});
