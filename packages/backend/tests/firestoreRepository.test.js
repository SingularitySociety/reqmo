import test from "node:test";
import assert from "node:assert/strict";

import { FirestoreRepository } from "../src/repository/firestoreRepository.js";
import { FakeFirestore } from "./helpers/fakeFirestore.js";

test("FirestoreRepository loads tenant data and persists updates", async () => {
  const firestore = new FakeFirestore({
    "tenants/tenant_x/stops/seed_stop": {
      name: "Seed Stop",
      lat: 35.0,
      lng: 139.0
    },
    "tenants/tenant_x/serviceProfiles/weekday_city_v1": {
      id: "weekday_city_v1",
      dispatchPolicy: {
        algorithmPrimary: "INSERTION",
        algorithmFallback: "GREEDY"
      },
      telephonyPolicy: {
        defaultCountryCode: "+81",
        allowAnonymousCaller: false,
        requireAdditionalIdentityCheck: true,
        denyList: []
      },
      farePolicy: {
        model: "HYBRID",
        currency: "JPY",
        params: {
          baseFare: 300,
          perKm: 80,
          perMinute: 10,
          sharedDiscountRate: 0.2,
          minFare: 300
        }
      }
    },
    "tenants/tenant_x/__meta/counters": {
      counter: 7
    }
  });

  const repository = await FirestoreRepository.create({
    firestore,
    tenantId: "tenant_x"
  });

  assert.equal(repository.listStops().length, 1);

  const requestId = repository.nextId("req");
  assert.equal(requestId, "req_000008");

  repository.addUser({ id: "user_001", name: "Alice" });
  const created = repository.createRideRequest({
    id: requestId,
    tenantId: "tenant_x",
    requesterId: "user_001",
    pickup: { mode: "FIXED_STOP", stopId: "seed_stop" },
    dropoff: { mode: "FIXED_STOP", stopId: "seed_stop" }
  });
  assert.equal(created.id, "req_000008");

  await repository.flush();

  assert.equal(firestore.get("tenants/tenant_x/users/user_001")?.name, "Alice");
  assert.equal(firestore.get("tenants/tenant_x/rideRequests/req_000008")?.tenantId, "tenant_x");
  assert.equal(firestore.get("tenants/tenant_x/__meta/counters")?.counter, 8);
});
