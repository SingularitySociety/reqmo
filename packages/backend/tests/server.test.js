import test from "node:test";
import assert from "node:assert/strict";

import { createReqmoServer } from "../src/api/server.js";

test("server bootstrap seeds repository for standalone operation", () => {
  const { repository, serviceProfileId, server } = createReqmoServer();

  assert.ok(serviceProfileId);
  assert.ok(repository.getServiceProfile(serviceProfileId));
  assert.ok(repository.listStops().length >= 2);
  assert.ok(repository.listVehicles().length >= 1);

  // Ensure server instance is valid without opening sockets in sandboxed tests.
  assert.equal(typeof server.listen, "function");
});
