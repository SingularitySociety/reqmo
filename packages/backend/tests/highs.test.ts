import test from "node:test";
import assert from "node:assert/strict";

import { selectCandidatesByHighs } from "../src/dispatch/highs.ts";

function toIdSet(candidates) {
  return new Set(
    (Array.isArray(candidates) ? candidates : [])
      .map((candidate) => (typeof candidate?.id === "string" ? candidate.id : ""))
      .filter(Boolean)
  );
}

test("HiGHS can select multiple candidates at once", async () => {
  const candidates = [
    { id: "a", score: 8 },
    { id: "b", score: 2 },
    { id: "c", score: 3 },
    { id: "d", score: 10 }
  ];

  const selected = await selectCandidatesByHighs({
    candidates,
    selectionCount: 2,
    timeLimitSeconds: 0.5
  });

  assert.ok(Array.isArray(selected));
  assert.equal(selected.length, 2);
  const ids = toIdSet(selected);
  assert.equal(ids.has("b"), true);
  assert.equal(ids.has("c"), true);
});

test("HiGHS enforces total existing-delay cap in multi selection", async () => {
  const candidates = [
    { id: "a", score: 1, existingDelaySumMinutes: 20 },
    { id: "b", score: 1.2, existingDelaySumMinutes: 20 },
    { id: "c", score: 5, existingDelaySumMinutes: 1 }
  ];

  const selected = await selectCandidatesByHighs({
    candidates,
    selectionCount: 2,
    constraints: {
      maxTotalExistingDelayMinutes: 25
    },
    timeLimitSeconds: 0.5
  });

  assert.ok(Array.isArray(selected));
  assert.equal(selected.length, 2);
  const ids = toIdSet(selected);
  assert.equal(ids.has("a"), true);
  assert.equal(ids.has("c"), true);
  assert.equal(ids.has("b"), false);
});

test("HiGHS fairness penalty can avoid overloaded choices", async () => {
  const candidates = [
    { id: "overloaded", score: 1, fairnessPenalty: 100 },
    { id: "fair", score: 1, fairnessPenalty: 1 }
  ];

  const selected = await selectCandidatesByHighs({
    candidates,
    selectionCount: 1,
    constraints: {
      fairnessPenaltyWeight: 0.2
    },
    timeLimitSeconds: 0.5
  });

  assert.ok(Array.isArray(selected));
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, "fair");
});

test("HiGHS group cap keeps selection fair across groups", async () => {
  const candidates = [
    { id: "veh1_a", score: 1, groupKey: "veh_1" },
    { id: "veh1_b", score: 1.5, groupKey: "veh_1" },
    { id: "veh2_a", score: 2, groupKey: "veh_2" }
  ];

  const selected = await selectCandidatesByHighs({
    candidates,
    selectionCount: 2,
    constraints: {
      maxSelectedPerGroup: 1
    },
    timeLimitSeconds: 0.5
  });

  assert.ok(Array.isArray(selected));
  assert.equal(selected.length, 2);
  const ids = toIdSet(selected);
  assert.equal(ids.has("veh1_a"), true);
  assert.equal(ids.has("veh2_a"), true);
  assert.equal(ids.has("veh1_b"), false);
});
