import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { createDefaultServiceProfile } from "../../shared/src/defaults.ts";
import { createReqmoServer } from "../src/api/server.ts";
import { InMemoryRepository } from "../src/repository/inMemoryRepository.ts";
import { interpretTuningFeedback } from "../src/tuning/feedbackInterpreter.ts";
import { createParameterSpace } from "../src/tuning/parameterSpace.ts";
import {
  activatePendingServiceProfileIfDue,
  approveTuningRecommendation,
  createTuningScenarioSuite,
  executeTuningRun,
  rollbackServiceProfile
} from "../src/tuning/service.ts";
import {
  buildFrozenTravelMatrices,
  expandScenarioBooking,
  runScenarioSuite
} from "../src/tuning/scenarioRunner.ts";

function tuningFixture() {
  const defaults = createDefaultServiceProfile();
  const baseProfile = createDefaultServiceProfile({
    id: "tuning_base",
    operationPolicy: {
      timeZone: "Asia/Tokyo",
      businessHours: { enabled: false },
      lunchBreak: { enabled: false }
    },
    dispatchPolicy: {
      ...defaults.dispatchPolicy,
      weights: {
        ...defaults.dispatchPolicy.weights,
        dropoffPriority: 0,
        existingDelaySum: 0
      }
    },
    poolingPolicy: {
      ...defaults.poolingPolicy,
      maxDetourMinutes: 10
    }
  });
  const route = [
    {
      type: "PICKUP",
      requestId: "r1",
      point: { lat: 33.00123234077136, lng: 132.9027022653273 },
      loadChange: 1
    },
    {
      type: "DROPOFF",
      requestId: "r1",
      point: { lat: 33.004617000194514, lng: 132.90038125198956 },
      loadChange: -1
    },
    {
      type: "PICKUP",
      requestId: "r2",
      point: { lat: 33.00265903659541, lng: 132.90487605641985 },
      loadChange: 2
    },
    {
      type: "DROPOFF",
      requestId: "r2",
      point: { lat: 33.0020492158169, lng: 132.9001024799698 },
      loadChange: -2
    }
  ];
  const initialState = {
    vehicles: [
      {
        id: "veh_1",
        status: "ACTIVE",
        capacity: 4,
        onboardCount: 0,
        currentLocation: { lat: 33, lng: 132.9 },
        route
      }
    ],
    stops: [],
    rideRequests: [
      { id: "r1", status: "ASSIGNED", partySize: 1, assignment: { vehicleId: "veh_1" } },
      { id: "r2", status: "ASSIGNED", partySize: 2, assignment: { vehicleId: "veh_1" } }
    ]
  };
  const booking = {
    id: "new_request",
    at: "2026-02-22T15:00:00+09:00",
    pickup: {
      mode: "FREE_POINT",
      point: { lat: 33.00405860618066, lng: 132.90040670554254 }
    },
    dropoff: {
      mode: "FREE_POINT",
      point: { lat: 33.00488278887875, lng: 132.90207485043206 }
    },
    partySize: 1,
    expectations: {
      mustAssign: true,
      dropoffExistingPassengersBeforeNewPickup: true
    }
  };
  const suiteInput = {
    name: "dropoff-first tuning",
    initialState,
    scenarios: [
      { id: "train", partition: "TRAIN", bookings: [booking] },
      { id: "holdout", partition: "HOLDOUT", bookings: [booking] }
    ]
  };
  return { baseProfile, suiteInput };
}

test("scenario runner is deterministic and does not mutate its source snapshot", async () => {
  const { baseProfile, suiteInput } = tuningFixture();
  const suite = { id: "suite", ...suiteInput };
  const original = JSON.stringify(suite.initialState);
  const matrices = await buildFrozenTravelMatrices({ suite, baseProfile });
  const first = await runScenarioSuite({
    suite,
    candidateProfile: baseProfile,
    frozenTravelMatrices: matrices
  });
  const second = await runScenarioSuite({
    suite,
    candidateProfile: baseProfile,
    frozenTravelMatrices: matrices
  });

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(suite.initialState), original);
  assert.equal(first.metrics.hardViolationCount, 2);
});

test("one pickup can split passengers across multiple dropoffs on the same vehicle", async () => {
  const defaults = createDefaultServiceProfile();
  const baseProfile = createDefaultServiceProfile({
    id: "multi_dropoff_profile",
    operationPolicy: {
      timeZone: "Asia/Tokyo",
      businessHours: { enabled: false },
      lunchBreak: { enabled: false }
    },
    dispatchPolicy: defaults.dispatchPolicy,
    poolingPolicy: defaults.poolingPolicy
  });
  const booking = {
    id: "family_trip",
    at: "2026-07-10T10:00:00+09:00",
    pickup: { mode: "FREE_POINT", point: { lat: 33, lng: 132.9 } },
    partySize: 4,
    dropoffs: [
      {
        id: "first_two",
        partySize: 2,
        dropoff: { mode: "FREE_POINT", point: { lat: 33.01, lng: 132.91 } }
      },
      {
        id: "last_two",
        partySize: 2,
        dropoff: { mode: "FREE_POINT", point: { lat: 33.02, lng: 132.92 } }
      }
    ],
    expectations: { mustAssign: true }
  };
  const suite = {
    id: "multi_dropoff_suite",
    initialState: {
      vehicles: [{
        id: "veh_group",
        status: "ACTIVE",
        capacity: 8,
        onboardCount: 0,
        currentLocation: { lat: 33, lng: 132.9 },
        route: []
      }],
      stops: [],
      rideRequests: []
    },
    scenarios: [{ id: "train", partition: "TRAIN", bookings: [booking] }]
  };
  const matrices = await buildFrozenTravelMatrices({ suite, baseProfile });
  const result = await runScenarioSuite({
    suite,
    candidateProfile: baseProfile,
    frozenTravelMatrices: matrices
  });
  const outcomes = result.scenarioResults[0].outcomes;

  assert.equal(outcomes.length, 2);
  assert.deepEqual(outcomes.map((outcome) => outcome.partySize), [2, 2]);
  assert.equal(outcomes.every((outcome) => outcome.parentBookingId === "family_trip"), true);
  assert.equal(outcomes.every((outcome) => outcome.selectedVehicleId === "veh_group"), true);
  assert.equal(outcomes.at(-1).groupIntegrity.allBoardBeforeFirstDropoff, true);
  assert.equal(result.metrics.totalBookings, 2);
  assert.equal(result.metrics.rejectedBookings, 0);
  assert.equal(result.metrics.hardViolationCount, 0);

  const dropoffFirstProfile = createDefaultServiceProfile({
    ...baseProfile,
    id: "multi_dropoff_profile_dropoff_first",
    dispatchPolicy: {
      ...baseProfile.dispatchPolicy,
      weights: {
        ...baseProfile.dispatchPolicy.weights,
        dropoffPriority: 3
      }
    }
  });
  const dropoffFirstResult = await runScenarioSuite({
    suite,
    candidateProfile: dropoffFirstProfile,
    frozenTravelMatrices: matrices
  });
  assert.equal(dropoffFirstResult.metrics.hardViolationCount, 1);
  assert.equal(
    dropoffFirstResult.scenarioResults[0].outcomes.at(-1).metrics.violations
      .some((violation) => violation.code === "GROUP_PICKUP_BEFORE_DROPOFF"),
    true
  );
});

test("multi-dropoff passenger totals must match the pickup total", () => {
  assert.throws(
    () => expandScenarioBooking({
      id: "invalid_group",
      pickup: { mode: "FREE_POINT", point: { lat: 33, lng: 132.9 } },
      partySize: 4,
      dropoffs: [
        { partySize: 2, dropoff: { mode: "FREE_POINT", point: { lat: 33.01, lng: 132.91 } } },
        { partySize: 1, dropoff: { mode: "FREE_POINT", point: { lat: 33.02, lng: 132.92 } } }
      ]
    }),
    /must equal total dropoff partySize/
  );
});

test("parameter search finds a dropoff-priority profile and supports scheduled activation and rollback", async () => {
  const { baseProfile, suiteInput } = tuningFixture();
  const repository = new InMemoryRepository({ serviceProfiles: [baseProfile] });
  repository.setSystemConfig({ id: "dispatch", activeServiceProfileId: baseProfile.id });
  const suite = createTuningScenarioSuite({ repository, input: suiteInput });
  const requestedSpace = createParameterSpace(baseProfile).map((entry) => ({
    ...entry,
    locked: entry.path !== "dispatchPolicy.weights.dropoffPriority"
  }));

  const result = await executeTuningRun({
    repository,
    scenarioSuiteId: suite.id,
    baseProfileId: baseProfile.id,
    parameterSpace: requestedSpace,
    maxTrials: 8,
    seed: "deterministic-search"
  });

  assert.equal(result.run.status, "COMPLETED");
  assert.equal(result.recommendation.eligibility.eligible, true);
  assert.equal(result.recommendation.candidateEvaluation.metrics.hardViolationCount, 0);
  assert.deepEqual(
    result.recommendation.parameterDiff.map((entry) => entry.path),
    ["dispatchPolicy.weights.dropoffPriority"]
  );
  assert.equal(
    result.recommendation.candidateEvaluation.scenarioResults[0].outcomes
      .some((outcome) => outcome.routeAfter.some((task) => task.point?.lat && task.point?.lng)),
    true
  );

  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const approval = approveTuningRecommendation({
    repository,
    recommendationId: result.recommendation.id,
    actor: "test-operator",
    activateAt: future
  });
  assert.equal(approval.status, "SCHEDULED");
  assert.equal(repository.getSystemConfig("dispatch").activeServiceProfileId, baseProfile.id);

  repository.setSystemConfig({
    ...repository.getSystemConfig("dispatch"),
    id: "dispatch",
    pendingEffectiveAt: new Date(Date.now() - 1000).toISOString()
  });
  const activated = activatePendingServiceProfileIfDue({ repository });
  assert.equal(activated.profileId, result.recommendation.candidateProfile.id);
  assert.equal(
    repository.getSystemConfig("dispatch").activeServiceProfileId,
    result.recommendation.candidateProfile.id
  );

  const baseVersion = repository
    .listServiceProfileVersions()
    .find((version) => version.profileId === baseProfile.id);
  assert.ok(baseVersion);
  const rollback = rollbackServiceProfile({
    repository,
    versionId: baseVersion.id,
    actor: "test-operator"
  });
  assert.equal(rollback.activeServiceProfileId, baseProfile.id);
  assert.equal(repository.listAuditLogs().some((entry) => entry.action === "SERVICE_PROFILE_ROLLED_BACK"), true);
});

test("feedback interpreter converts Japanese operator feedback into reviewable expectations", async () => {
  const result = await interpretTuningFeedback({
    text: "必ず2号車に配車し、待ち時間は10分以内。乗車中のお客様を先に降ろしてください。",
    context: { vehicles: [{ id: "veh_2", name: "2" }] },
    env: { TUNING_LLM_ENABLED: "false" }
  });

  assert.equal(result.source, "RULES");
  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.expectations.mustAssign, true);
  assert.equal(result.expectations.maxPickupWaitMinutes, 10);
  assert.equal(result.expectations.dropoffExistingPassengersBeforeNewPickup, true);
});

function invokeServer({ server, method, url, body }) {
  return new Promise((resolve) => {
    const req = Readable.from([]);
    req.method = method;
    req.url = url;
    req.body = body;
    const responseState = { statusCode: 0, payload: "" };
    const res = {
      setHeader() {},
      writeHead(statusCode) {
        responseState.statusCode = statusCode;
      },
      end(payload = "") {
        responseState.payload = String(payload);
        resolve(responseState);
      }
    };
    server.emit("request", req, res);
  });
}

test("tuning HTTP API saves and lists isolated scenario suites", async () => {
  const { baseProfile } = tuningFixture();
  const repository = new InMemoryRepository({
    stops: [
      { id: "stop_a", name: "A", lat: 33, lng: 132.9 },
      { id: "stop_b", name: "B", lat: 33.01, lng: 132.91 }
    ],
    vehicles: [
      {
        id: "veh_1",
        status: "ACTIVE",
        capacity: 4,
        onboardCount: 0,
        currentLocation: { lat: 33, lng: 132.9 },
        route: []
      }
    ],
    serviceProfiles: [baseProfile]
  });
  const { server } = createReqmoServer({ repository, serviceProfileId: baseProfile.id });
  const saved = await invokeServer({
    server,
    method: "POST",
    url: "/api/tuning/scenario-suites",
    body: {
      name: "api suite",
      scenarios: [
        {
          id: "api_train",
          partition: "TRAIN",
          bookings: [
            {
              at: "2026-07-10T09:00:00+09:00",
              pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
              dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
              partySize: 1
            }
          ]
        }
      ]
    }
  });
  assert.equal(saved.statusCode, 200);
  const savedPayload = JSON.parse(saved.payload);
  assert.equal(savedPayload.status, "SAVED");
  assert.equal(savedPayload.suite.initialState.vehicles.length, 1);

  const preview = await invokeServer({
    server,
    method: "POST",
    url: "/api/tuning/preview",
    body: {
      baseProfileId: baseProfile.id,
      name: "unsaved route preview",
      scenarios: savedPayload.suite.scenarios
    }
  });
  assert.equal(preview.statusCode, 200);
  const previewPayload = JSON.parse(preview.payload);
  assert.equal(previewPayload.status, "PREVIEWED");
  assert.equal(previewPayload.evaluation.metrics.totalBookings, 1);
  assert.equal(previewPayload.evaluation.scenarioResults[0].outcomes[0].status, "ASSIGNED");
  assert.equal(
    previewPayload.evaluation.scenarioResults[0].outcomes[0].routeAfter.length >= 2,
    true
  );
  assert.equal(repository.listTuningRuns().length, 0);
  assert.equal(repository.listVehicles().find((vehicle) => vehicle.id === "veh_1").route.length, 0);

  const rejectedPreview = await invokeServer({
    server,
    method: "POST",
    url: "/api/tuning/preview",
    body: {
      baseProfileId: baseProfile.id,
      name: "rejected route preview",
      initialState: {
        vehicles: [{
          id: "tiny_vehicle",
          status: "ACTIVE",
          capacity: 1,
          onboardCount: 0,
          currentLocation: { lat: 33, lng: 132.9 },
          route: []
        }],
        stops: [
          { id: "stop_a", name: "A", lat: 33, lng: 132.9 },
          { id: "stop_b", name: "B", lat: 33.01, lng: 132.91 }
        ],
        rideRequests: []
      },
      scenarios: [{
        id: "rejected_train",
        partition: "TRAIN",
        bookings: [{
          id: "too_many_passengers",
          at: "2026-07-10T09:00:00+09:00",
          pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
          dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
          partySize: 2
        }]
      }]
    }
  });
  assert.equal(rejectedPreview.statusCode, 200);
  const rejectedOutcome = JSON.parse(rejectedPreview.payload)
    .evaluation.scenarioResults[0].outcomes[0];
  assert.equal(rejectedOutcome.status, "REJECTED");
  assert.equal(rejectedOutcome.reason, "NO_FEASIBLE_VEHICLE");
  assert.equal(rejectedOutcome.diagnostics.rejectionCounts.CAPACITY > 0, true);
  assert.equal(rejectedOutcome.diagnostics.breakdown[0].code, "CAPACITY");
  assert.equal(rejectedOutcome.diagnostics.countermeasureCandidates.length > 0, true);

  const listed = await invokeServer({
    server,
    method: "GET",
    url: "/api/tuning/scenario-suites",
    body: {}
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(JSON.parse(listed.payload).data.length, 1);
});
