import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultServiceProfile } from "../../shared/src/defaults.ts";
import { ADAPTER_TYPES } from "../../shared/src/constants.ts";
import { InMemoryRepository } from "../src/repository/inMemoryRepository.ts";
import {
  linkPhoneIdentity,
  ingestCall,
  createPhoneRideRequest,
  listPhoneRideOptions,
  previewFare
} from "../src/api/functions.ts";
import { normalizePhoneNumber } from "../src/telephony/phoneNumber.ts";

function seedForTelephony() {
  const repository = new InMemoryRepository();
  repository.addUser({ id: "user_100", name: "Caller" });
  repository.addVehicle({
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: { lat: 33.0, lng: 132.9 },
    route: []
  });
  repository.addStop({ id: "stop_a", name: "Stop A", lat: 33.0, lng: 132.9 });
  repository.addStop({ id: "stop_b", name: "Stop B", lat: 33.01, lng: 132.905 });
  return repository;
}

test("normalizePhoneNumber converts JP local phone to E.164", () => {
  assert.equal(normalizePhoneNumber("080-1234-5678", "+81"), "+818012345678");
  assert.equal(normalizePhoneNumber("+81 80 1234 5678", "+81"), "+818012345678");
});

test("ingestCall links registered user", () => {
  const repository = seedForTelephony();
  const profile = createDefaultServiceProfile();
  repository.setServiceProfile(profile);

  linkPhoneIdentity({
    repository,
    serviceProfileId: profile.id,
    userId: "user_100",
    phoneNumber: "080-1234-5678"
  });

  const result = ingestCall({
    repository,
    serviceProfileId: profile.id,
    provider: "asterisk",
    adapterType: ADAPTER_TYPES.WEBHOOK,
    payload: {
      from: "08012345678",
      to: "0880111222"
    }
  });

  assert.equal(result.identity.status, "LINKED");
  assert.equal(result.event.linkedUserId, "user_100");
});

test("createPhoneRideRequest dispatches phone channel request", async () => {
  const repository = seedForTelephony();
  const profile = createDefaultServiceProfile();
  repository.setServiceProfile(profile);

  linkPhoneIdentity({
    repository,
    serviceProfileId: profile.id,
    userId: "user_100",
    phoneNumber: "08012345678"
  });

  const result = await createPhoneRideRequest({
    repository,
    serviceProfileId: profile.id,
    callerRaw: "08012345678",
    pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
    dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
    partySize: 1
  });

  assert.equal(result.status, "ASSIGNED");
  assert.equal(result.rideRequest.channel, "PHONE_OPERATOR");
  assert.equal(result.rideRequest.assignment.vehicleId, "veh_1");
  assert.equal(result.rideRequest.passenger?.phoneNumber, "+818012345678");
});

test("phone operator flow returns options and can confirm selected vehicle", async () => {
  const repository = seedForTelephony();
  const profile = createDefaultServiceProfile();
  repository.setServiceProfile(profile);
  repository.addVehicle({
    id: "veh_2",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: { lat: 33.02, lng: 132.91 },
    route: []
  });

  linkPhoneIdentity({
    repository,
    serviceProfileId: profile.id,
    userId: "user_100",
    phoneNumber: "08012345678"
  });

  const desiredDropoffAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const options = await listPhoneRideOptions({
    repository,
    serviceProfileId: profile.id,
    callerRaw: "08012345678",
    pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
    dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
    partySize: 2,
    desiredDropoffAt
  });

  assert.equal(options.status, "ASSIGNABLE");
  assert.equal(options.desiredDropoffAt, desiredDropoffAt);
  assert.ok(options.options.length >= 2);
  assert.equal(
    options.options.some((option) => option.vehicleId === "veh_2"),
    true
  );

  const confirmed = await createPhoneRideRequest({
    repository,
    serviceProfileId: profile.id,
    callerRaw: "08012345678",
    pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
    dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
    partySize: 2,
    desiredDropoffAt,
    preferredVehicleId: "veh_2"
  });

  assert.equal(confirmed.status, "ASSIGNED");
  assert.equal(confirmed.rideRequest.assignment.vehicleId, "veh_2");
  assert.equal(confirmed.rideRequest.timeWindow?.desiredDropoffAt, desiredDropoffAt);
  assert.equal(confirmed.rideRequest.timeWindow?.requestType, "ARRIVE_BY");
});

test("phone operator flow supports desired pickup time", async () => {
  const repository = seedForTelephony();
  const profile = createDefaultServiceProfile();
  repository.setServiceProfile(profile);

  linkPhoneIdentity({
    repository,
    serviceProfileId: profile.id,
    userId: "user_100",
    phoneNumber: "08012345678"
  });

  const desiredPickupAt = new Date(Date.now() + 20 * 60 * 1000).toISOString();
  const options = await listPhoneRideOptions({
    repository,
    serviceProfileId: profile.id,
    callerRaw: "08012345678",
    pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
    dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
    partySize: 1,
    desiredPickupAt
  });

  assert.equal(options.status, "ASSIGNABLE");
  assert.equal(options.desiredPickupAt, desiredPickupAt);
  assert.equal(Array.isArray(options.options), true);
  assert.equal(options.options.length > 0, true);

  const confirmed = await createPhoneRideRequest({
    repository,
    serviceProfileId: profile.id,
    callerRaw: "08012345678",
    pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
    dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
    partySize: 1,
    desiredPickupAt
  });

  assert.equal(confirmed.status, "ASSIGNED");
  assert.equal(confirmed.rideRequest.timeWindow?.desiredPickupAt, desiredPickupAt);
  assert.equal(confirmed.rideRequest.timeWindow?.desiredDropoffAt ?? null, null);
  assert.equal(confirmed.rideRequest.timeWindow?.requestType, "DEPART_AT");
});

test("previewFare computes hybrid fare", () => {
  const profile = createDefaultServiceProfile();
  const fare = previewFare({
    serviceProfile: profile,
    distanceKm: 2.5,
    durationMinutes: 12,
    pooled: true
  });

  assert.equal(fare.currency, "JPY");
  assert.ok(fare.amount >= profile.farePolicy.params.minFare);
});
