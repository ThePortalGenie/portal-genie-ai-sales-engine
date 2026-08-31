import assert from "node:assert/strict";
import test from "node:test";
import {
  ccFocusNowItems,
  ccItemsForBucket,
  ccNextItems,
  ccPresentationBucket,
  ccQueueInsightCounts,
  ccUrgencyLabel,
  type CcPresentationItem,
} from "../src/web/command-centre-presentation.js";

function item(overrides: Partial<CcPresentationItem> = {}): CcPresentationItem {
  return {
    priority: "P2",
    effective_queue_state: "ACTIONABLE",
    next_best_action: "PHONE_CALL",
    action_timing: "ACT_NOW",
    executability: "EXECUTABLE_NOW",
    actionability_kind: "CUSTOMER_ACTION",
    customer_queue: true,
    ...overrides,
  };
}

test("P1 executable customer action is focus_now with NOW label", () => {
  const row = item({ priority: "P1", action_timing: "ACT_NOW" });
  assert.equal(ccPresentationBucket(row), "focus_now");
  assert.equal(ccUrgencyLabel(row), "NOW");
});

test("P2 executable customer action is next with NEXT label not NOW", () => {
  const row = item({ priority: "P2", action_timing: "ACT_NOW" });
  assert.equal(ccPresentationBucket(row), "next");
  assert.equal(ccUrgencyLabel(row), "NEXT");
  assert.notEqual(ccUrgencyLabel(row), "NOW");
});

test("WAIT items count as waiting and are excluded from primary sections", () => {
  const row = item({
    priority: "P4",
    next_best_action: "WAIT",
    action_timing: "WAIT_UNTIL",
    executability: "WAITING_FOR_TIME",
    effective_queue_state: "WAIT",
  });
  assert.equal(ccPresentationBucket(row), "waiting");
  assert.equal(ccUrgencyLabel(row), "WAITING");
  assert.equal(ccFocusNowItems([row]).length, 0);
  assert.equal(ccNextItems([row]).length, 0);
});

test("P5 and system no-action are excluded from counts and queues", () => {
  const p5 = item({ priority: "P5" });
  const noAction = item({
    effective_queue_state: "SYSTEM_NO_ACTION",
    next_best_action: "NO_ACTION",
    action_timing: "NO_ACTION_REQUIRED",
  });
  const counts = ccQueueInsightCounts([p5, noAction]);
  assert.deepEqual(counts, { actNow: 0, next: 0, later: 0, waiting: 0 });
  assert.equal(ccFocusNowItems([p5, noAction]).length, 0);
  assert.equal(ccNextItems([p5, noAction]).length, 0);
});

test("header counts reconcile with focus now and next sections", () => {
  const rows = [
    item({ priority: "P1", action_timing: "ACT_NOW" }),
    item({ priority: "P0", action_timing: "OVERDUE" }),
    item({ priority: "P2", action_timing: "ACT_NOW" }),
    item({ priority: "P3", action_timing: "SCHEDULED_DATE", executability: "EXECUTABLE_NOW" }),
    item({
      priority: "P4",
      next_best_action: "WAIT",
      action_timing: "WAIT_UNTIL",
      executability: "WAITING_FOR_CUSTOMER",
      effective_queue_state: "WAIT",
    }),
    item({ priority: "P5" }),
    item({
      effective_queue_state: "RESEARCH",
      actionability_kind: "INTERNAL_RESEARCH",
      next_best_action: "HUMAN_REVIEW",
      executability: "EXECUTABLE_NOW",
    }),
  ];

  const counts = ccQueueInsightCounts(rows);
  const focusNow = ccFocusNowItems(rows);
  const next = ccNextItems(rows);

  assert.equal(counts.actNow, focusNow.length);
  assert.equal(counts.next, next.length);
  assert.equal(counts.waiting, 1);
  assert.equal(counts.later, 0);

  for (const row of next) {
    assert.notEqual(ccUrgencyLabel(row), "NOW");
  }
  for (const row of focusNow) {
    assert.ok(ccUrgencyLabel(row) === "NOW" || ccUrgencyLabel(row) === "TODAY");
  }
});

test("later bucket counts separately and does not appear in primary sections", () => {
  const row = item({
    priority: "P4",
    executability: "EXECUTABLE_NOW",
    actionability_kind: "CUSTOMER_ACTION",
    effective_queue_state: "ACTIONABLE",
  });
  assert.equal(ccPresentationBucket(row), "later");
  assert.equal(ccUrgencyLabel(row), "LATER");
  const counts = ccQueueInsightCounts([row]);
  assert.equal(counts.later, 1);
  assert.equal(ccFocusNowItems([row]).length, 0);
  assert.equal(ccNextItems([row]).length, 0);
  assert.equal(ccItemsForBucket([row], "later").length, 1);
});

test("snapshot category count equals filtered recommendations for each bucket", () => {
  const rows = [
    item({ priority: "P1", action_timing: "ACT_NOW" }),
    item({ priority: "P2", action_timing: "ACT_NOW" }),
    item({
      priority: "P4",
      next_best_action: "WAIT",
      action_timing: "WAIT_UNTIL",
      executability: "WAITING_FOR_CUSTOMER",
      effective_queue_state: "WAIT",
    }),
    item({
      priority: "P4",
      executability: "EXECUTABLE_NOW",
      actionability_kind: "CUSTOMER_ACTION",
      effective_queue_state: "ACTIONABLE",
    }),
  ];
  const counts = ccQueueInsightCounts(rows);
  assert.equal(ccItemsForBucket(rows, "focus_now").length, counts.actNow);
  assert.equal(ccItemsForBucket(rows, "next").length, counts.next);
  assert.equal(ccItemsForBucket(rows, "later").length, counts.later);
  assert.equal(ccItemsForBucket(rows, "waiting").length, counts.waiting);
});
