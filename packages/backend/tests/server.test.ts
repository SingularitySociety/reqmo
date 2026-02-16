import test from "node:test";
import assert from "node:assert/strict";

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
