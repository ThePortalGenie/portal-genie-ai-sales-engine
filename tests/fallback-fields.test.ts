import assert from "node:assert/strict";
import test from "node:test";
import {
  fieldsForRelatedList,
  stripRelatedListFieldPrefix,
  uniqueFields,
} from "../src/integrations/zoho/fallback-fields.js";

test("stripRelatedListFieldPrefix removes chronological-view module prefixes", () => {
  assert.equal(stripRelatedListFieldPrefix("!Calls.Subject"), "Subject");
  assert.equal(stripRelatedListFieldPrefix("Note_Title"), "Note_Title");
});

test("fieldsForRelatedList prefers related-list metadata, then module fields, then fallbacks", () => {
  const fromMeta = fieldsForRelatedList({
    relatedListApiName: "Activities_Chronological_View",
    relatedModuleApiName: null,
    relatedListFields: ["!Calls.Subject", "!Tasks.Status"],
    moduleFieldApiNames: new Map(),
  });
  assert.deepEqual(fromMeta, ["Subject", "Status"]);

  const fromModule = fieldsForRelatedList({
    relatedListApiName: "Deals",
    relatedModuleApiName: "Deals",
    relatedListFields: [],
    moduleFieldApiNames: new Map([["Deals", ["Deal_Name", "Stage"]]]),
  });
  assert.deepEqual(fromModule, ["Deal_Name", "Stage"]);

  const fallback = fieldsForRelatedList({
    relatedListApiName: "Notes",
    relatedModuleApiName: "Notes",
    relatedListFields: [],
    moduleFieldApiNames: new Map(),
  });
  assert.ok(fallback.includes("Note_Content"));
});

test("uniqueFields caps at 50", () => {
  const fields = uniqueFields(Array.from({ length: 60 }, (_, index) => `Field_${index}`));
  assert.equal(fields.length, 50);
});
