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
