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
