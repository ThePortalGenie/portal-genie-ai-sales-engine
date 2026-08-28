import assert from "node:assert/strict";
import test from "node:test";
import { classifyHttpRetrieval } from "../src/domain/retrieval-state.js";

test("401/403 classify as UNAVAILABLE not EMPTY", () => {
  assert.equal(classifyHttpRetrieval(401), "UNAVAILABLE");
  assert.equal(classifyHttpRetrieval(403), "UNAVAILABLE");
});

test("429 and 5xx classify as ERROR not EMPTY", () => {
  assert.equal(classifyHttpRetrieval(429), "ERROR");
  assert.equal(classifyHttpRetrieval(500), "ERROR");
  assert.equal(classifyHttpRetrieval(503), "ERROR");
});

test("successful empty collection is EMPTY", () => {
  assert.equal(classifyHttpRetrieval(200, { value: [] }), "EMPTY");
});

test("successful payload is RETRIEVED", () => {
  assert.equal(classifyHttpRetrieval(200, { value: [{ id: "1" }] }), "RETRIEVED");
  assert.equal(classifyHttpRetrieval(200, { id: "user" }), "RETRIEVED");
});

test("204 is EMPTY", () => {
  assert.equal(classifyHttpRetrieval(204), "EMPTY");
});
