import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { createReqmoServer } from "../src/api/server.ts";
import { InMemoryRepository } from "../src/repository/inMemoryRepository.ts";
import { createDefaultServiceProfile } from "../../shared/src/defaults.ts";

test("server bootstrap seeds repository for standalone operation", () => {
  const { repository, serviceProfileId, server } = createReqmoServer();

  assert.ok(serviceProfileId);
  assert.ok(repository.getServiceProfile(serviceProfileId));
  assert.ok(repository.listStops().length >= 2);
  assert.ok(repository.listVehicles().length >= 1);

  // Ensure server instance is valid without opening sockets in sandboxed tests.
  assert.equal(typeof server.listen, "function");
});

test("api health exposes dispatch profile and highs diagnostics", async () => {
  const { server, serviceProfileId } = createReqmoServer();
  const response = await invokeServer({
    server,
    method: "GET",
    url: "/api/health",
    body: {}
  });

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.payload);
  assert.equal(payload.ok, true);
  assert.equal(payload.activeServiceProfileId, serviceProfileId);
  assert.equal(typeof payload.dispatchPolicy?.algorithmPrimary, "string");
  assert.equal(typeof payload.dispatchPolicy?.algorithmFallback, "string");
  assert.equal(typeof payload.highs?.disabledByEnv, "boolean");
  assert.equal(typeof payload.highs?.loadAttempted, "boolean");
});

test("server bootstrap does not inject demo stops when repository already has stops", () => {
  const repository = new InMemoryRepository({
    stops: [{ id: "shimanto_stop_1", name: "Shimanto Stop", lat: 32.99, lng: 132.93 }],
    serviceProfiles: [createDefaultServiceProfile()]
  });

  createReqmoServer({ repository });

  const stopIds = repository.listStops().map((stop) => stop.id);
  assert.ok(stopIds.includes("shimanto_stop_1"));
  assert.equal(stopIds.includes("stop_a"), false);
  assert.equal(stopIds.includes("stop_b"), false);
});

test("server defaults active profile to shimanto_weekday_v1 when present", async () => {
  const baseProfile = createDefaultServiceProfile();
  const insertionProfile = createDefaultServiceProfile({
    id: "legacy_profile",
    dispatchPolicy: {
      ...baseProfile.dispatchPolicy,
      algorithmPrimary: "INSERTION",
      algorithmFallback: "INSERTION"
    }
  });
  const shimantoProfile = createDefaultServiceProfile({
    id: "shimanto_weekday_v1",
    dispatchPolicy: {
      ...baseProfile.dispatchPolicy,
      algorithmPrimary: "GREEDY",
      algorithmFallback: "GREEDY"
    }
  });
  const repository = new InMemoryRepository({
    stops: [
      { id: "stop_a", name: "Stop A", lat: 33.0, lng: 132.9 },
      { id: "stop_b", name: "Stop B", lat: 33.01, lng: 132.905 }
    ],
    vehicles: [
      {
        id: "veh_1",
        status: "ACTIVE",
        capacity: 4,
        onboardCount: 0,
        currentLocation: { lat: 33.0, lng: 132.9 },
        route: []
      }
    ],
    serviceProfiles: [insertionProfile, shimantoProfile]
  });
  const { server } = createReqmoServer({ repository });

  const profileResponse = await invokeServer({
    server,
    method: "GET",
    url: "/api/service-profiles",
    body: {}
  });
  assert.equal(profileResponse.statusCode, 200);
  const profilePayload = JSON.parse(profileResponse.payload);
  assert.equal(profilePayload.activeServiceProfileId, "shimanto_weekday_v1");

  const optionsResponse = await invokeServer({
    server,
    method: "POST",
    url: "/api/ride-requests/options",
    body: {
      pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
      dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
      partySize: 1,
      desiredDropoffAt: buildNextLocalDateAt(12, 0).toISOString(),
      optionLimit: 1
    }
  });
  assert.equal(optionsResponse.statusCode, 200);
  const optionsPayload = JSON.parse(optionsResponse.payload);
  assert.equal(optionsPayload.status, "ASSIGNABLE");
  assert.equal(Array.isArray(optionsPayload.options), true);
  assert.equal(optionsPayload.options.length > 0, true);
  assert.equal(optionsPayload.options[0].primaryAlgorithm, "GREEDY");
});

function invokeServer({ server, method, url, body }) {
  return new Promise((resolve) => {
    const req = Readable.from([]);
    req.method = method;
    req.url = url;
    req.body = body;

    const responseState = {
      statusCode: 0,
      headers: {},
      payload: ""
    };

    const res = {
      setHeader(name, value) {
        responseState.headers[name] = value;
      },
      writeHead(status, headers = {}) {
        responseState.statusCode = status;
        responseState.headers = {
          ...responseState.headers,
          ...headers
        };
      },
      end(chunk = "") {
        responseState.payload += String(chunk ?? "");
        resolve(responseState);
      }
    };

    server.emit("request", req, res);
  });
}

function buildNextLocalDateAt(hour, minute = 0) {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(hour, minute, 0, 0);
  return date;
}

test("api accepts JSON payload from pre-parsed req.body", async () => {
  const { server } = createReqmoServer();
  const response = await invokeServer({
    server,
    method: "POST",
    url: "/api/ride-requests/preview",
    body: {
      pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
      dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
      partySize: 1
    }
  });

  assert.equal(response.statusCode, 200);
  const parsed = JSON.parse(response.payload);
  assert.equal(typeof parsed.status, "string");
  assert.equal(parsed.status.length > 0, true);
  assert.equal(Object.hasOwn(parsed, "error"), false);
});

test("api ride-request endpoints preserve desired time window fields", async () => {
  const { server, repository } = createReqmoServer();
  const desiredDropoffAt = "2026-02-01T04:20:00.000Z";
  const response = await invokeServer({
    server,
    method: "POST",
    url: "/api/ride-requests",
    body: {
      pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
      dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
      partySize: 1,
      desiredDropoffAt
    }
  });

  assert.equal(response.statusCode, 200);
  const requests = repository.listRideRequests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].timeWindow?.desiredDropoffAt, desiredDropoffAt);
  assert.equal(requests[0].timeWindow?.requestType, "ARRIVE_BY");
});

test("api ride-request options can propose multiple strategies and confirm selected option", async () => {
  const repository = new InMemoryRepository({
    stops: [
      { id: "stop_a", name: "Stop A", lat: 33.0, lng: 132.9 },
      { id: "stop_b", name: "Stop B", lat: 33.01, lng: 132.905 }
    ],
    vehicles: [
      {
        id: "veh_1",
        status: "ACTIVE",
        capacity: 4,
        onboardCount: 0,
        currentLocation: { lat: 33.0, lng: 132.9 },
        route: []
      },
      {
        id: "veh_2",
        status: "ACTIVE",
        capacity: 4,
        onboardCount: 0,
        currentLocation: { lat: 33.005, lng: 132.901 },
        route: []
      }
    ],
    serviceProfiles: [createDefaultServiceProfile()]
  });
  const { server } = createReqmoServer({ repository });

  const desiredDropoffAt = new Date(Date.now() + 120 * 60 * 1000).toISOString();
  const optionsResponse = await invokeServer({
    server,
    method: "POST",
    url: "/api/ride-requests/options",
    body: {
      pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
      dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
      partySize: 1,
      desiredDropoffAt,
      optionLimit: 6
    }
  });

  assert.equal(optionsResponse.statusCode, 200);
  const optionsPayload = JSON.parse(optionsResponse.payload);
  assert.equal(optionsPayload.status, "ASSIGNABLE");
  assert.equal(Array.isArray(optionsPayload.options), true);
  assert.equal(optionsPayload.options.length > 0, true);
  const expectedFastest =
    new Date(desiredDropoffAt).toDateString() === new Date().toDateString();
  assert.equal(
    optionsPayload.options.some((option) => option.strategyKey === "FASTEST"),
    expectedFastest
  );
  assert.equal(
    optionsPayload.options.some((option) => option.strategyKey === "REQUESTED_TIME"),
    true
  );

  const selectedOption =
    optionsPayload.options.find((option) => option.strategyKey === "REQUESTED_TIME") ??
    optionsPayload.options[0];
  const createResponse = await invokeServer({
    server,
    method: "POST",
    url: "/api/ride-requests",
    body: {
      pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
      dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
      partySize: 1,
      desiredDropoffAt: selectedOption.desiredDropoffAt,
      requestType: selectedOption.requestType,
      preferredVehicleId: selectedOption.vehicleId
    }
  });

  assert.equal(createResponse.statusCode, 200);
  const createPayload = JSON.parse(createResponse.payload);
  assert.equal(createPayload.status, "ASSIGNED");
  assert.equal(createPayload.rideRequest.assignment?.vehicleId, selectedOption.vehicleId);
  assert.equal(createPayload.rideRequest.timeWindow?.requestType, selectedOption.requestType);
  assert.equal(
    createPayload.rideRequest.timeWindow?.desiredDropoffAt ?? null,
    selectedOption.desiredDropoffAt ?? null
  );
});

test("api ride-request options omits requested-time strategy when it is not closer", async () => {
  const repository = new InMemoryRepository({
    stops: [
      { id: "stop_a", name: "Stop A", lat: 33.0, lng: 132.9 },
      { id: "stop_b", name: "Stop B", lat: 33.01, lng: 132.905 }
    ],
    vehicles: [
      {
        id: "veh_1",
        status: "ACTIVE",
        capacity: 4,
        onboardCount: 0,
        currentLocation: { lat: 33.0, lng: 132.9 },
        route: []
      }
    ],
    serviceProfiles: [createDefaultServiceProfile()]
  });
  const { server } = createReqmoServer({ repository });

  const desiredDropoffAt = new Date(Date.now() + 60 * 1000).toISOString();
  const response = await invokeServer({
    server,
    method: "POST",
    url: "/api/ride-requests/options",
    body: {
      pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
      dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
      partySize: 1,
      desiredDropoffAt,
      optionLimit: 5
    }
  });

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.payload);
  assert.equal(payload.status, "ASSIGNABLE");
  assert.equal(Array.isArray(payload.options), true);
  assert.equal(payload.options.length > 0, true);
  const expectedFastest =
    new Date(desiredDropoffAt).toDateString() === new Date().toDateString();
  if (expectedFastest) {
    assert.equal(
      payload.options.some((option) => option.strategyKey === "REQUESTED_TIME"),
      false
    );
    assert.equal(
      payload.options.some((option) => option.strategyKey === "FASTEST"),
      true
    );
  } else {
    assert.equal(
      payload.options.some((option) => option.strategyKey === "REQUESTED_TIME"),
      true
    );
    assert.equal(
      payload.options.some((option) => option.strategyKey === "FASTEST"),
      false
    );
  }
});

test("api ride-request options for future reservation date prioritize reservation-time strategy", async () => {
  const repository = new InMemoryRepository({
    stops: [
      { id: "stop_a", name: "Stop A", lat: 33.0, lng: 132.9 },
      { id: "stop_b", name: "Stop B", lat: 33.01, lng: 132.905 }
    ],
    vehicles: [
      {
        id: "veh_1",
        status: "ACTIVE",
        capacity: 4,
        onboardCount: 0,
        currentLocation: { lat: 33.0, lng: 132.9 },
        route: []
      }
    ],
    serviceProfiles: [createDefaultServiceProfile()]
  });
  const { server } = createReqmoServer({ repository });

  const desiredDropoffAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const response = await invokeServer({
    server,
    method: "POST",
    url: "/api/ride-requests/options",
    body: {
      pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
      dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
      partySize: 1,
      desiredDropoffAt,
      optionLimit: 5
    }
  });

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.payload);
  assert.equal(payload.status, "ASSIGNABLE");
  assert.equal(Array.isArray(payload.options), true);
  assert.equal(payload.options.length > 0, true);
  assert.equal(
    payload.options.some((option) => option.strategyKey === "FASTEST"),
    false
  );
  assert.equal(
    payload.options.some((option) => option.strategyKey === "REQUESTED_TIME"),
    true
  );
  payload.options.forEach((option) => {
    assert.equal(option.requestType, "ARRIVE_BY");
    assert.equal(option.desiredDropoffAt, desiredDropoffAt);
  });
});

test("api ride-request options suggest post-break pickup when desired time is within lunch break", async () => {
  const baseProfile = createDefaultServiceProfile();
  const profile = createDefaultServiceProfile({
    id: "server_lunch_break_option_profile",
    dispatchPolicy: {
      ...baseProfile.dispatchPolicy,
      maxWaitMinutes: 240
    },
    operationPolicy: {
      office: {
        name: "本社",
        point: { lat: 33.0, lng: 132.9 }
      },
      idleReturnThresholdMinutes: 40,
      lunchBreak: {
        enabled: true,
        startLocalTime: "11:00",
        endLocalTime: "12:00",
        requireReturnToOffice: true,
        departFromOfficeAtEnd: true
      }
    }
  });
  const repository = new InMemoryRepository({
    stops: [
      { id: "stop_a", name: "Stop A", lat: 33.0, lng: 132.9 },
      { id: "stop_b", name: "Stop B", lat: 33.01, lng: 132.905 }
    ],
    vehicles: [
      {
        id: "veh_1",
        status: "ACTIVE",
        capacity: 4,
        onboardCount: 0,
        currentLocation: { lat: 33.0, lng: 132.9 },
        route: []
      }
    ],
    serviceProfiles: [profile]
  });
  const { server } = createReqmoServer({ repository });

  const desiredDropoffAt = buildNextLocalDateAt(11, 20).toISOString();
  const breakEndAt = buildNextLocalDateAt(12, 0);

  const response = await invokeServer({
    server,
    method: "POST",
    url: "/api/ride-requests/options",
    body: {
      serviceProfileId: profile.id,
      pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
      dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
      partySize: 1,
      desiredDropoffAt,
      optionLimit: 5
    }
  });

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.payload);
  assert.equal(payload.status, "ASSIGNABLE");
  assert.equal(Array.isArray(payload.options), true);
  assert.equal(payload.options.length > 0, true);
  payload.options.forEach((option) => {
    const pickupAt = new Date(option.plannedPickupAt);
    assert.equal(Number.isFinite(pickupAt.getTime()), true);
    assert.equal(pickupAt.getTime() >= breakEndAt.getTime(), true);
  });
});

test("api ride-request options do not apply lunch break when operation policy is missing", async () => {
  const baseProfile = createDefaultServiceProfile();
  const profile = createDefaultServiceProfile({
    id: "server_missing_operation_policy_profile",
    dispatchPolicy: {
      ...baseProfile.dispatchPolicy,
      maxWaitMinutes: 240
    },
    operationPolicy: undefined
  });
  const repository = new InMemoryRepository({
    stops: [
      { id: "stop_a", name: "Stop A", lat: 33.0, lng: 132.9 },
      { id: "stop_b", name: "Stop B", lat: 33.01, lng: 132.905 }
    ],
    vehicles: [
      {
        id: "veh_1",
        status: "ACTIVE",
        capacity: 4,
        onboardCount: 0,
        currentLocation: { lat: 33.0, lng: 132.9 },
        route: []
      }
    ],
    serviceProfiles: [profile]
  });
  const { server } = createReqmoServer({ repository });

  const desiredDropoffAt = "2026-02-23T11:30:00+09:00";
  const breakEndAt = new Date("2026-02-23T12:00:00+09:00");

  const response = await invokeServer({
    server,
    method: "POST",
    url: "/api/ride-requests/options",
    body: {
      serviceProfileId: profile.id,
      pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
      dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
      partySize: 1,
      desiredDropoffAt,
      optionLimit: 5
    }
  });

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.payload);
  assert.equal(payload.status, "ASSIGNABLE");
  assert.equal(Array.isArray(payload.options), true);
  assert.equal(payload.options.length > 0, true);
  const hasBeforeBreakOption = payload.options.some((option) => {
    const pickupAt = new Date(option.plannedPickupAt);
    return Number.isFinite(pickupAt.getTime()) && pickupAt.getTime() < breakEndAt.getTime();
  });
  assert.equal(hasBeforeBreakOption, true);
});

test("api ride-request options reject future reservation when 13:00 office departure cannot reach pickup", async () => {
  const baseProfile = createDefaultServiceProfile();
  const profile = createDefaultServiceProfile({
    id: "server_lunch_break_future_departure_guard",
    dispatchPolicy: {
      ...baseProfile.dispatchPolicy,
      maxWaitMinutes: 240
    },
    operationPolicy: {
      office: {
        name: "本社",
        point: { lat: 33.0, lng: 132.9 }
      },
      idleReturnThresholdMinutes: 40,
      lunchBreak: {
        enabled: true,
        startLocalTime: "12:00",
        endLocalTime: "13:00",
        requireReturnToOffice: false,
        departFromOfficeAtEnd: true
      }
    }
  });
  const repository = new InMemoryRepository({
    stops: [
      { id: "stop_office", name: "Office", lat: 33.0, lng: 132.9 },
      { id: "stop_far", name: "Far Pickup", lat: 33.05, lng: 132.9 },
      { id: "stop_far_drop", name: "Far Dropoff", lat: 33.051, lng: 132.901 }
    ],
    vehicles: [
      {
        id: "veh_1",
        status: "ACTIVE",
        capacity: 4,
        onboardCount: 0,
        currentLocation: { lat: 33.0, lng: 132.9 },
        route: []
      }
    ],
    serviceProfiles: [profile]
  });
  const { server } = createReqmoServer({ repository });

  const response = await invokeServer({
    server,
    method: "POST",
    url: "/api/ride-requests/options",
    body: {
      serviceProfileId: profile.id,
      pickup: { mode: "FIXED_STOP", stopId: "stop_far" },
      dropoff: { mode: "FIXED_STOP", stopId: "stop_far_drop" },
      partySize: 1,
      desiredDropoffAt: buildNextLocalDateAt(13, 5).toISOString(),
      optionLimit: 5
    }
  });

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.payload);
  assert.equal(payload.status, "REJECTED");
  assert.equal(payload.reason, "NO_FEASIBLE_VEHICLE");
  assert.equal(payload.diagnostics?.details?.type, "DEPART_AFTER_BREAK");
});

test("api can reset ride requests and clear vehicle routes", async () => {
  const repository = new InMemoryRepository({
    stops: [{ id: "shimanto_stop_1", name: "Shimanto Stop", lat: 32.99, lng: 132.93 }],
    vehicles: [
      {
        id: "veh_1",
        status: "ACTIVE",
        capacity: 4,
        onboardCount: 2,
        currentLocation: { lat: 32.99, lng: 132.93 },
        route: [
          {
            type: "PICKUP",
            requestId: "req_1",
            point: { lat: 32.991, lng: 132.931 },
            loadChange: 1
          }
        ]
      }
    ],
    rideRequests: [
      {
        id: "req_1",
        status: "ASSIGNED",
        pickup: { mode: "FIXED_STOP", stopId: "shimanto_stop_1" },
        dropoff: { mode: "FIXED_STOP", stopId: "shimanto_stop_1" }
      },
      {
        id: "req_2",
        status: "CANCELLED",
        pickup: { mode: "FIXED_STOP", stopId: "shimanto_stop_1" },
        dropoff: { mode: "FIXED_STOP", stopId: "shimanto_stop_1" }
      }
    ]
  });

  const { server } = createReqmoServer({ repository });
  const response = await invokeServer({
    server,
    method: "POST",
    url: "/api/ride-requests/reset",
    body: {}
  });

  assert.equal(response.statusCode, 200);
  const parsed = JSON.parse(response.payload);
  assert.equal(parsed.status, "RESET");
  assert.equal(parsed.clearedRideRequests, 2);
  assert.equal(repository.listRideRequests().length, 0);
  const vehicle = repository.listVehicles()[0];
  assert.equal(vehicle.onboardCount, 0);
  assert.deepEqual(vehicle.route, []);
});

test("vehicle location API can skip dispatch reoptimization", async () => {
  const repository = new InMemoryRepository({
    stops: [{ id: "stop_1", name: "Stop 1", lat: 32.99, lng: 132.93 }],
    vehicles: [
      {
        id: "veh_1",
        status: "ACTIVE",
        capacity: 4,
        onboardCount: 1,
        currentLocation: { lat: 32.99, lng: 132.93 },
        route: [
          {
            type: "PICKUP",
            requestId: "req_1",
            point: { lat: 32.991, lng: 132.931 },
            loadChange: 1
          }
        ]
      }
    ],
    rideRequests: [
      {
        id: "req_1",
        status: "ASSIGNED",
        pickup: { mode: "FIXED_STOP", stopId: "stop_1" },
        dropoff: { mode: "FIXED_STOP", stopId: "stop_1" },
        assignment: { vehicleId: "veh_1" }
      }
    ]
  });

  const { server } = createReqmoServer({ repository });
  const response = await invokeServer({
    server,
    method: "POST",
    url: "/api/vehicles/veh_1/location",
    body: {
      point: { lat: 32.995, lng: 132.935 },
      speedKmh: 28,
      source: "SIMULATION_TEST",
      skipReoptimization: true
    }
  });

  assert.equal(response.statusCode, 200);
  const parsed = JSON.parse(response.payload);
  assert.equal(parsed.status, "UPDATED");
  assert.equal(parsed.reoptimization, null);
  assert.deepEqual(parsed.vehicle.currentLocation, { lat: 32.995, lng: 132.935 });
  assert.equal(parsed.vehicle.route.length, 1);
});

test("vehicle passenger-event API updates onboard and request completion", async () => {
  const repository = new InMemoryRepository({
    stops: [{ id: "stop_1", name: "Stop 1", lat: 32.99, lng: 132.93 }],
    vehicles: [
      {
        id: "veh_1",
        status: "ACTIVE",
        capacity: 8,
        onboardCount: 1,
        currentLocation: { lat: 32.99, lng: 132.93 },
        route: [
          {
            type: "PICKUP",
            requestId: "req_1",
            point: { lat: 32.991, lng: 132.931 },
            loadChange: 2
          },
          {
            type: "DROPOFF",
            requestId: "req_1",
            point: { lat: 32.995, lng: 132.935 },
            loadChange: -2
          }
        ]
      }
    ],
    rideRequests: [
      {
        id: "req_1",
        status: "ASSIGNED",
        pickup: { mode: "FIXED_STOP", stopId: "stop_1" },
        dropoff: { mode: "FIXED_STOP", stopId: "stop_1" },
        assignment: { vehicleId: "veh_1" }
      }
    ]
  });

  const { server } = createReqmoServer({ repository });
  const pickupResponse = await invokeServer({
    server,
    method: "POST",
    url: "/api/vehicles/veh_1/passenger-events",
    body: {
      requestId: "req_1",
      taskType: "PICKUP",
      source: "SIMULATION_TEST"
    }
  });

  assert.equal(pickupResponse.statusCode, 200);
  const pickupPayload = JSON.parse(pickupResponse.payload);
  assert.equal(pickupPayload.status, "RECORDED");
  assert.equal(pickupPayload.event.boardedCount, 2);
  assert.equal(pickupPayload.event.alightedCount, 0);
  assert.equal(pickupPayload.vehicle.onboardCount, 3);
  assert.equal(pickupPayload.vehicle.route.length, 1);
  assert.equal(typeof pickupPayload.rideRequest.assignment.actualPickupAt, "string");

  const dropoffResponse = await invokeServer({
    server,
    method: "POST",
    url: "/api/vehicles/veh_1/passenger-events",
    body: {
      requestId: "req_1",
      taskType: "DROPOFF",
      source: "SIMULATION_TEST"
    }
  });

  assert.equal(dropoffResponse.statusCode, 200);
  const dropoffPayload = JSON.parse(dropoffResponse.payload);
  assert.equal(dropoffPayload.status, "RECORDED");
  assert.equal(dropoffPayload.event.boardedCount, 0);
  assert.equal(dropoffPayload.event.alightedCount, 2);
  assert.equal(dropoffPayload.vehicle.onboardCount, 1);
  assert.equal(dropoffPayload.vehicle.route.length, 0);
  assert.equal(dropoffPayload.vehicle.telemetry.totalBoarded, 2);
  assert.equal(dropoffPayload.vehicle.telemetry.totalAlighted, 2);
  assert.equal(dropoffPayload.rideRequest.status, "COMPLETED");
  assert.equal(typeof dropoffPayload.rideRequest.assignment.actualDropoffAt, "string");
});

test("vehicle settings API can create and update vehicles", async () => {
  const repository = new InMemoryRepository({
    stops: [{ id: "stop_1", name: "Stop 1", lat: 32.99, lng: 132.93 }]
  });
  const { server } = createReqmoServer({ repository });

  const createResponse = await invokeServer({
    server,
    method: "POST",
    url: "/api/vehicles",
    body: {
      id: "veh_cfg_1",
      name: "1号車",
      iconColor: "#10b981",
      currentLocation: { lat: 32.99, lng: 132.93 },
      capacity: 6
    }
  });
  assert.equal(createResponse.statusCode, 200);
  const createPayload = JSON.parse(createResponse.payload);
  assert.equal(createPayload.status, "CREATED");
  assert.equal(createPayload.vehicle.id, "veh_cfg_1");
  assert.equal(createPayload.vehicle.name, "1号車");
  assert.equal(createPayload.vehicle.iconColor, "#10b981");
  assert.equal(createPayload.vehicle.capacity, 6);

  const updateResponse = await invokeServer({
    server,
    method: "POST",
    url: "/api/vehicles/veh_cfg_1",
    body: {
      name: "1号車(更新)",
      iconColor: "#f97316",
      officePoint: { lat: 32.991, lng: 132.931 }
    }
  });
  assert.equal(updateResponse.statusCode, 200);
  const updatePayload = JSON.parse(updateResponse.payload);
  assert.equal(updatePayload.status, "UPDATED");
  assert.equal(updatePayload.vehicle.id, "veh_cfg_1");
  assert.equal(updatePayload.vehicle.name, "1号車(更新)");
  assert.equal(updatePayload.vehicle.iconColor, "#f97316");
  assert.deepEqual(updatePayload.vehicle.officePoint, { lat: 32.991, lng: 132.931 });
  assert.deepEqual(updatePayload.vehicle.homeBase, { lat: 32.991, lng: 132.931 });
});

test("vehicle create API uses vehicle office point as fallback location", async () => {
  const profile = createDefaultServiceProfile({
    id: "office_profile"
  });
  const repository = new InMemoryRepository({
    serviceProfiles: [profile]
  });
  const { server } = createReqmoServer({
    repository,
    serviceProfileId: profile.id
  });

  const response = await invokeServer({
    server,
    method: "POST",
    url: "/api/vehicles",
    body: {
      name: "新規車両",
      officePoint: { lat: 33.01, lng: 132.91 },
      serviceProfileId: profile.id
    }
  });

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.payload);
  assert.equal(payload.status, "CREATED");
  assert.deepEqual(payload.vehicle.officePoint, { lat: 33.01, lng: 132.91 });
  assert.deepEqual(payload.vehicle.currentLocation, { lat: 33.01, lng: 132.91 });
});
