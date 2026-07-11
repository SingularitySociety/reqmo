import test from "node:test";
import assert from "node:assert/strict";

import { FirestoreRepository } from "../src/repository/firestoreRepository.ts";
import { FakeFirestore } from "./helpers/fakeFirestore.ts";
import { createDefaultServiceProfile } from "../../shared/src/defaults.ts";

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

test("FirestoreRepository persists operation settings and vehicle display fields", async () => {
  const firestore = new FakeFirestore();
  const repository = await FirestoreRepository.create({
    firestore,
    tenantId: "tenant_y"
  });

  const profile = createDefaultServiceProfile({
    id: "weekday_ops_v1",
    operationPolicy: {
      office: {
        name: "本社",
        point: { lat: 33.01, lng: 132.91 }
      },
      businessHours: {
        enabled: true,
        startLocalTime: "08:00",
        endLocalTime: "18:00",
        requireDepartFromOffice: true,
        requireReturnToOffice: true
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
  repository.setServiceProfile(profile);
  repository.addVehicle({
    id: "veh_settings_1",
    name: "本庁号",
    iconColor: "#0ea5e9",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    officePoint: { lat: 33.02, lng: 132.92 },
    currentLocation: { lat: 33.01, lng: 132.91 },
    route: []
  });

  await repository.flush();

  assert.equal(
    firestore.get("tenants/tenant_y/serviceProfiles/weekday_ops_v1")?.operationPolicy?.office?.name,
    "本社"
  );
  assert.deepEqual(
    firestore.get("tenants/tenant_y/serviceProfiles/weekday_ops_v1")?.operationPolicy?.office?.point,
    { lat: 33.01, lng: 132.91 }
  );
  assert.equal(
    firestore.get("tenants/tenant_y/serviceProfiles/weekday_ops_v1")?.operationPolicy?.businessHours?.enabled,
    true
  );
  assert.equal(
    firestore.get("tenants/tenant_y/serviceProfiles/weekday_ops_v1")?.operationPolicy?.businessHours?.startLocalTime,
    "08:00"
  );
  assert.equal(
    firestore.get("tenants/tenant_y/serviceProfiles/weekday_ops_v1")?.operationPolicy?.businessHours?.endLocalTime,
    "18:00"
  );
  assert.equal(
    firestore.get("tenants/tenant_y/vehicles/veh_settings_1")?.name,
    "本庁号"
  );
  assert.equal(
    firestore.get("tenants/tenant_y/vehicles/veh_settings_1")?.iconColor,
    "#0ea5e9"
  );
  assert.deepEqual(
    firestore.get("tenants/tenant_y/vehicles/veh_settings_1")?.officePoint,
    { lat: 33.02, lng: 132.92 }
  );
});

test("FirestoreRepository refreshes service profiles changed by another Functions instance", async () => {
  const firestore = new FakeFirestore({
    "tenants/tenant_refresh/serviceProfiles/shimanto_weekday_v1": {
      id: "shimanto_weekday_v1",
      dispatchPolicy: {
        weights: { detour: 0.25 }
      }
    }
  });
  const repository = await FirestoreRepository.create({
    firestore,
    tenantId: "tenant_refresh"
  });

  await firestore
    .collection("tenants")
    .doc("tenant_refresh")
    .collection("serviceProfiles")
    .doc("shimanto_weekday_v1")
    .set({
      id: "shimanto_weekday_v1",
      dispatchPolicy: {
        weights: { detour: 1.65 }
      }
    });

  assert.equal(
    repository.getServiceProfile("shimanto_weekday_v1")?.dispatchPolicy?.weights?.detour,
    0.25
  );
  await repository.refreshConfiguration();
  assert.equal(
    repository.getServiceProfile("shimanto_weekday_v1")?.dispatchPolicy?.weights?.detour,
    1.65
  );
});
