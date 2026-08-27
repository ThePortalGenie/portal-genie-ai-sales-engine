import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/cli/args.js";

test("parseArgs reads discovery flags", () => {
  const args = parseArgs([
    "--module",
    "Contacts",
    "--id",
    "123",
    "--fetch-email-bodies",
    "1",
    "--json",
  ]);
  assert.equal(args.module, "Contacts");
  assert.equal(args.id, "123");
  assert.equal(args.fetchEmailBodies, 1);
  assert.equal(args.json, true);
});

test("parseArgs reads usage import flags", () => {
  const args = parseArgs(["--file", "data/usage.csv", "--match-crm", "ids.json"]);
  assert.equal(args.file, "data/usage.csv");
  assert.equal(args.matchCrm, "ids.json");
});

test("parseArgs rejects unknown flags", () => {
  assert.throws(() => parseArgs(["--destroy-crm"]), /Unknown argument/);
});
