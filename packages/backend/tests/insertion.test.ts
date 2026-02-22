import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultServiceProfile } from "../../shared/src/defaults.ts";
import { findBestInsertionPlan } from "../src/dispatch/insertion.ts";

test("insertion penalizes in-vehicle detour and prefers A->B->C->D in this corridor case", () => {
  const points = {
    X: { lat: 0, lng: 0 },
    A: { lat: 1, lng: 0 },
    B: { lat: 2, lng: 0 },
    C: { lat: 3, lng: 0 },
    D: { lat: 4, lng: 0 }
  };
  const pointToLabel = new Map(
    Object.entries(points).map(([label, point]) => [point, label])
  );

  const matrix = {
    X: { X: 0, A: 5.744477388352156, B: 2.145782132511366, C: 11.706069279799276, D: 7.418110986046821 },
    A: { X: 5.758301389093777, A: 0, B: 1.4522817451775265, C: 11.488628417281555, D: 11.797574670776376 },
    B: { X: 2.552663231330884, A: 1.4522817451775265, B: 0, C: 9.608695125217134, D: 10.52807345162462 },
    C: { X: 11.290088110437068, A: 11.488628417281555, B: 9.608695125217134, C: 0, D: 0.784833426956629 },
    D: { X: 7.114259632673155, A: 11.797574670776376, B: 10.52807345162462, C: 0.784833426956629, D: 0 }
  };
  const travelMinutes = (from, to) => {
    const fromLabel = pointToLabel.get(from);
    const toLabel = pointToLabel.get(to);
    if (!fromLabel || !toLabel) {
      return 0;
    }
    return matrix[fromLabel][toLabel];
  };

  const now = new Date("2026-02-22T14:35:00+09:00");
  const serviceProfile = createDefaultServiceProfile();
  const vehicle = {
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: points.X,
    route: [
      { type: "PICKUP", requestId: "req_existing", point: points.A, loadChange: 1 },
      { type: "DROPOFF", requestId: "req_existing", point: points.D, loadChange: -1 }
    ]
  };
  const request = {
    id: "req_new",
    partySize: 1,
    pickupPoint: points.B,
    dropoffPoint: points.C,
    requestType: "ARRIVE_BY",
    desiredDropoffAt: new Date(now.getTime() + 25 * 60 * 1000).toISOString(),
    evaluationNowAt: now.toISOString()
  };

  const plan = findBestInsertionPlan({
    vehicle,
    request,
    serviceProfile,
    travelMinutes
  });

  assert.ok(plan);
  assert.deepEqual(
    plan.route.map((task) => `${task.type}:${pointToLabel.get(task.point)}`),
    ["PICKUP:A", "PICKUP:B", "DROPOFF:C", "DROPOFF:D"]
  );

  const directRideMinutes = travelMinutes(points.B, points.C);
  let plannedRideMinutes = 0;
  let inVehicle = false;
  let previousPoint = null;
  for (const task of plan.route) {
    if (task.requestId !== request.id) {
      if (inVehicle && previousPoint) {
        plannedRideMinutes += travelMinutes(previousPoint, task.point);
      }
      previousPoint = task.point;
      continue;
    }

    if (task.type === "PICKUP") {
      inVehicle = true;
      previousPoint = task.point;
      continue;
    }

    if (task.type === "DROPOFF" && inVehicle && previousPoint) {
      plannedRideMinutes += travelMinutes(previousPoint, task.point);
      break;
    }
  }
  const newRideDetourMinutes = plannedRideMinutes - directRideMinutes;

  assert.equal(newRideDetourMinutes < 1, true);
  assert.equal(plan.detourMinutes < 1, true);
  assert.equal(plan.detourMinutes <= serviceProfile.poolingPolicy.maxDetourMinutes, true);
});

test("insertion can penalize cumulative existing delay (passenger-weighted sum)", () => {
  const labels = ["X", "P", "Q", "B", "C", "D"];
  const points = {
    X: { lat: 0, lng: 0 },
    P: { lat: 1, lng: 0 },
    Q: { lat: 1.5, lng: 0 },
    B: { lat: 2, lng: 0 },
    C: { lat: 3, lng: 0 },
    D: { lat: 4, lng: 0 }
  };
  const pointToLabel = new Map(
    Object.entries(points).map(([label, point]) => [point, label])
  );

  const matrix = {};
  for (const from of labels) {
    matrix[from] = {};
    for (const to of labels) {
      matrix[from][to] = from === to ? 0 : 20;
    }
  }
  const connect = (a, b, minutes) => {
    matrix[a][b] = minutes;
    matrix[b][a] = minutes;
  };
  connect("X", "B", 1);
  connect("X", "C", 2);
  connect("X", "D", 3);
  connect("X", "P", 1.2);
  connect("X", "Q", 2);
  connect("B", "C", 1);
  connect("C", "D", 1);
  connect("B", "D", 2);
  connect("B", "P", 2.5);
  connect("C", "P", 1.5);
  connect("D", "P", 2);
  connect("P", "Q", 0.8);
  connect("Q", "B", 1);
  connect("Q", "C", 1);
  connect("Q", "D", 2);

  const travelMinutes = (from, to) => {
    const fromLabel = pointToLabel.get(from);
    const toLabel = pointToLabel.get(to);
    if (!fromLabel || !toLabel) {
      return 0;
    }
    return matrix[fromLabel][toLabel];
  };

  const baseProfile = createDefaultServiceProfile();
  const profileWithoutSumPenalty = createDefaultServiceProfile({
    dispatchPolicy: {
      ...baseProfile.dispatchPolicy,
      maxWaitMinutes: 4,
      weights: {
        ...baseProfile.dispatchPolicy.weights,
        existingDelaySum: 0
      }
    },
    poolingPolicy: {
      ...baseProfile.poolingPolicy,
      maxDetourMinutes: 4
    }
  });
  const profileWithSumPenalty = createDefaultServiceProfile({
    dispatchPolicy: {
      ...baseProfile.dispatchPolicy,
      maxWaitMinutes: 4,
      weights: {
        ...baseProfile.dispatchPolicy.weights,
        existingDelaySum: 0.8
      }
    },
    poolingPolicy: {
      ...baseProfile.poolingPolicy,
      maxDetourMinutes: 4
    }
  });

  const vehicle = {
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 3,
    currentLocation: points.X,
    route: [
      { type: "DROPOFF", requestId: "r1", point: points.B, loadChange: -1 },
      { type: "DROPOFF", requestId: "r2", point: points.C, loadChange: -1 },
      { type: "DROPOFF", requestId: "r3", point: points.D, loadChange: -1 }
    ]
  };
  const request = {
    id: "req_new",
    partySize: 1,
    pickupPoint: points.P,
    dropoffPoint: points.Q,
    requestType: "ASAP",
    evaluationNowAt: new Date("2026-02-22T15:00:00+09:00").toISOString()
  };

  const planWithoutSumPenalty = findBestInsertionPlan({
    vehicle,
    request,
    serviceProfile: profileWithoutSumPenalty,
    travelMinutes
  });
  const planWithSumPenalty = findBestInsertionPlan({
    vehicle,
    request,
    serviceProfile: profileWithSumPenalty,
    travelMinutes
  });

  assert.ok(planWithoutSumPenalty);
  assert.ok(planWithSumPenalty);
  assert.equal(
    Number(planWithSumPenalty.detourSumMinutes) < Number(planWithoutSumPenalty.detourSumMinutes),
    true
  );
  assert.equal(
    Number(planWithSumPenalty.etaPickupMinutes) > Number(planWithoutSumPenalty.etaPickupMinutes),
    true
  );
});
