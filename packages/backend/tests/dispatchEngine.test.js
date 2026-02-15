import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultServiceProfile } from "../../shared/src/defaults.js";
import { estimateTravelMinutes } from "../../shared/src/geo.js";
import { InMemoryRepository } from "../src/repository/inMemoryRepository.js";
import {
  cancelRideRequest,
  createRideRequest,
  previewRideRequest,
  updateVehicleLocation,
  upsertServiceProfile
} from "../src/api/functions.js";

function seedRepository() {
  const repository = new InMemoryRepository();

  repository.addVehicle({
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: { lat: 33.0, lng: 132.9 },
    route: []
  });

  repository.addVehicle({
    id: "veh_2",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: { lat: 33.09, lng: 132.99 },
    route: []
  });

  repository.addStop({ id: "stop_a", name: "Stop A", lat: 33.0, lng: 132.9 });
  repository.addStop({ id: "stop_b", name: "Stop B", lat: 33.01, lng: 132.905 });

  return repository;
}

function seedRepositoryWithOnboardDropoff({
  existingRequestId = "req_existing_1",
  vehicleLocation = { lat: 33.0, lng: 132.9 },
  existingDropoffPoint = { lat: 33.01, lng: 132.91 }
} = {}) {
  const repository = new InMemoryRepository();
  repository.addVehicle({
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 1,
    currentLocation: vehicleLocation,
    route: [
      {
        type: "DROPOFF",
        requestId: existingRequestId,
        point: existingDropoffPoint,
        loadChange: -1
      }
    ]
  });
  return {
    repository,
    existingRequestId
  };
}

test("dispatch assigns nearest feasible vehicle", async () => {
  const repository = seedRepository();

  const result = await createRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_1",
    pickup: { mode: "FREE_POINT", point: { lat: 33.0002, lng: 132.9002 } },
    dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
    partySize: 1
  });

  assert.equal(result.status, "ASSIGNED");
  assert.equal(result.rideRequest.assignment.vehicleId, "veh_1");
});

test("dispatch reflects configured cruise speed and pickup service time in ETA", async () => {
  const repository = seedRepository();
  const baseProfile = createDefaultServiceProfile();
  const timingProfile = createDefaultServiceProfile({
    id: "timing_profile",
    dispatchPolicy: {
      ...baseProfile.dispatchPolicy,
      cruiseSpeedKmh: 10,
      pickupServiceMinutes: 2,
      dropoffServiceMinutes: 1
    }
  });
  upsertServiceProfile({ repository, profile: timingProfile });

  const result = await createRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_timing",
    pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
    dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
    partySize: 1,
    serviceProfileId: timingProfile.id
  });

  assert.equal(result.status, "ASSIGNED");
  assert.equal(result.rideRequest.assignment?.vehicleId, "veh_1");
  assert.equal(result.rideRequest.assignment?.etaPickupMinutes, 0);

  const expectedTravelMinutes = estimateTravelMinutes(
    { lat: 33.0, lng: 132.9 },
    { lat: 33.01, lng: 132.905 },
    10
  );
  const expectedDropoffMinutes = expectedTravelMinutes + 2;
  const actualDropoffMinutes = Number(result.rideRequest.assignment?.etaDropoffMinutes);
  assert.equal(Number.isFinite(actualDropoffMinutes), true);
  assert.equal(Math.abs(actualDropoffMinutes - expectedDropoffMinutes) < 0.1, true);
});

test("dispatch keeps optional passenger profile fields", async () => {
  const repository = seedRepository();

  const result = await createRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_3",
    pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
    dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
    partySize: 1,
    passenger: {
      name: "山田 太郎",
      phoneNumber: "08012345678"
    }
  });

  assert.equal(result.status, "ASSIGNED");
  assert.equal(result.rideRequest.passenger?.name, "山田 太郎");
  assert.equal(result.rideRequest.passenger?.phoneNumber, "08012345678");
});

test("dispatch keeps operator edited free-point titles", async () => {
  const repository = seedRepository();

  const result = await createRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_title",
    pickup: {
      mode: "FREE_POINT",
      point: { lat: 33.0002, lng: 132.9002 },
      title: "中村駅前"
    },
    dropoff: {
      mode: "FREE_POINT",
      point: { lat: 33.0007, lng: 132.9007 },
      title: "市役所近く"
    },
    partySize: 1
  });

  assert.equal(result.status, "ASSIGNED");
  assert.equal(result.rideRequest.pickup?.title, "中村駅前");
  assert.equal(result.rideRequest.dropoff?.title, "市役所近く");
});

test("preview simulation uses free-point titles in timeline labels", async () => {
  const repository = seedRepository();

  const preview = await previewRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_preview_title",
    pickup: {
      mode: "FREE_POINT",
      point: { lat: 33.0003, lng: 132.9004 },
      title: "中村駅前"
    },
    dropoff: {
      mode: "FREE_POINT",
      point: { lat: 33.0004, lng: 132.9006 },
      title: "文化センター近く"
    },
    partySize: 1
  });

  assert.equal(preview.status, "ASSIGNABLE");
  const pickupTask = preview.simulation.routeAfter.find(
    (task) => task.requestLabel === "新規予約" && task.type === "PICKUP"
  );
  const dropoffTask = preview.simulation.routeAfter.find(
    (task) => task.requestLabel === "新規予約" && task.type === "DROPOFF"
  );
  assert.ok(pickupTask);
  assert.ok(dropoffTask);
  assert.equal(pickupTask.locationLabel, "中村駅前");
  assert.equal(dropoffTask.locationLabel, "文化センター近く");
});

test("dispatch rejects when pooling cap exceeded", async () => {
  const repository = seedRepository();
  const strictProfile = createDefaultServiceProfile({
    id: "strict_profile",
    poolingPolicy: {
      ...createDefaultServiceProfile().poolingPolicy,
      maxOnboardPerVehicle: 1
    }
  });

  upsertServiceProfile({ repository, profile: strictProfile });

  repository.updateVehicle("veh_1", { onboardCount: 1 });
  repository.updateVehicle("veh_2", { onboardCount: 1 });

  const result = await createRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_2",
    pickup: { mode: "FREE_POINT", point: { lat: 33.0002, lng: 132.9002 } },
    dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
    partySize: 1,
    serviceProfileId: "strict_profile"
  });

  assert.equal(result.status, "REJECTED");
  assert.equal(result.rideRequest.status, "REJECTED");
});

test("preview simulation returns route and impact without persisting request", async () => {
  const repository = seedRepository();
  const first = await createRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_existing",
    pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
    dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
    partySize: 1
  });

  const beforeCount = repository.listRideRequests().length;

  const preview = await previewRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_preview",
    pickup: { mode: "FREE_POINT", point: { lat: 33.0003, lng: 132.9004 } },
    dropoff: { mode: "FREE_POINT", point: { lat: 33.0004, lng: 132.9006 } },
    partySize: 1
  });

  assert.equal(preview.status, "ASSIGNABLE");
  assert.equal(preview.simulation.vehicleId, "veh_1");
  assert.ok(preview.simulation.routeAfter.length >= preview.simulation.routeBefore.length);
  assert.equal(repository.listRideRequests().length, beforeCount);
  assert.equal(
    preview.simulation.impactedRequests.some((impact) => impact.requestId === first.rideRequest.id),
    true
  );
});

test("dispatch updates existing request eta after re-optimization", async () => {
  const repository = seedRepository();
  const first = await createRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_first",
    pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
    dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
    partySize: 1
  });
  const beforeEtaDropoff = first.rideRequest.assignment?.etaDropoffMinutes;

  const second = await createRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_second",
    pickup: { mode: "FREE_POINT", point: { lat: 33.0003, lng: 132.9004 } },
    dropoff: { mode: "FREE_POINT", point: { lat: 33.0004, lng: 132.9006 } },
    partySize: 1
  });

  assert.equal(second.status, "ASSIGNED");
  assert.equal(second.rideRequest.assignment?.vehicleId, "veh_1");

  const updatedFirst = repository.getRideRequest(first.rideRequest.id);
  const afterEtaDropoff = updatedFirst?.assignment?.etaDropoffMinutes;

  assert.equal(Number.isFinite(beforeEtaDropoff), true);
  assert.equal(Number.isFinite(afterEtaDropoff), true);
  assert.notEqual(afterEtaDropoff, beforeEtaDropoff);
});

test("cancel removes request from vehicle route and updates remaining etas", async () => {
  const repository = seedRepository();

  const first = await createRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_first",
    pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
    dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
    partySize: 1
  });

  const second = await createRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_second",
    pickup: { mode: "FREE_POINT", point: { lat: 33.0003, lng: 132.9004 } },
    dropoff: { mode: "FREE_POINT", point: { lat: 33.0004, lng: 132.9006 } },
    partySize: 1
  });

  const secondBefore = repository.getRideRequest(second.rideRequest.id);
  const beforePickup = secondBefore?.assignment?.etaPickupMinutes;
  const beforeDropoff = secondBefore?.assignment?.etaDropoffMinutes;

  const cancelled = await cancelRideRequest({
    repository,
    requestId: first.rideRequest.id,
    reason: "TEST_CANCEL"
  });

  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(cancelled.rideRequest.status, "CANCELLED");

  const vehicle = repository.listVehicles().find((entry) => entry.id === first.rideRequest.assignment.vehicleId);
  assert.equal(vehicle.route.some((task) => task.requestId === first.rideRequest.id), false);

  const secondAfter = repository.getRideRequest(second.rideRequest.id);
  assert.equal(Number.isFinite(secondAfter?.assignment?.etaPickupMinutes), true);
  assert.equal(Number.isFinite(secondAfter?.assignment?.etaDropoffMinutes), true);

  const secondImpact = cancelled.simulation?.impactedRequests?.find(
    (impact) => impact.requestId === second.rideRequest.id
  );
  assert.ok(secondImpact);
  assert.equal(secondAfter?.assignment?.etaPickupMinutes, secondImpact.pickupAfterMinutes);
  assert.equal(secondAfter?.assignment?.etaDropoffMinutes, secondImpact.dropoffAfterMinutes);
  assert.equal(Number.isFinite(beforePickup), true);
  assert.equal(Number.isFinite(beforeDropoff), true);
});

test("vehicle location update reoptimizes route and eta from new position", async () => {
  const repository = seedRepository();

  await createRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_first",
    pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
    dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
    partySize: 1
  });

  await createRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_second",
    pickup: { mode: "FREE_POINT", point: { lat: 33.0006, lng: 132.9005 } },
    dropoff: { mode: "FREE_POINT", point: { lat: 33.001, lng: 132.901 } },
    partySize: 1
  });

  const result = await updateVehicleLocation({
    repository,
    vehicleId: "veh_1",
    point: { lat: 33.0004, lng: 132.9003 },
    source: "DRIVER_APP",
    heading: 85,
    speedKmh: 24
  });

  assert.equal(result.status, "UPDATED");
  assert.equal(result.vehicle.id, "veh_1");
  assert.equal(result.vehicle.currentLocation.lat, 33.0004);
  assert.equal(result.vehicle.currentLocation.lng, 132.9003);
  assert.ok(result.reoptimization);
  assert.equal(result.reoptimization.simulation.vehicleId, "veh_1");
  assert.equal(Array.isArray(result.reoptimization.simulation.routeAfter), true);

  const assignedOnVeh1 = repository
    .listRideRequests()
    .filter((request) => request.assignment?.vehicleId === "veh_1" && request.status === "ASSIGNED");
  assert.ok(assignedOnVeh1.length >= 1);
  assignedOnVeh1.forEach((request) => {
    assert.equal(Number.isFinite(request.assignment?.etaPickupMinutes), true);
    assert.equal(Number.isFinite(request.assignment?.etaDropoffMinutes), true);
  });
});

test("dispatch rejects excessive detour that would keep onboard passenger riding too long", async () => {
  const { repository } = seedRepositoryWithOnboardDropoff({
    existingDropoffPoint: { lat: 33.02, lng: 132.92 }
  });

  const preview = await previewRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_detour_guard",
    pickup: { mode: "FREE_POINT", point: { lat: 32.98, lng: 132.88 } },
    dropoff: { mode: "FREE_POINT", point: { lat: 32.981, lng: 132.881 } },
    partySize: 1
  });

  assert.equal(preview.status, "REJECTED");
  assert.equal(preview.reason, "NO_FEASIBLE_VEHICLE");
});

test("dispatch accepts additional reservation when existing route delay stays zero", async () => {
  const { repository, existingRequestId } = seedRepositoryWithOnboardDropoff({
    existingDropoffPoint: { lat: 33.01, lng: 132.91 }
  });

  const preview = await previewRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_append_reservation",
    pickup: { mode: "FREE_POINT", point: { lat: 33.0102, lng: 132.9102 } },
    dropoff: { mode: "FREE_POINT", point: { lat: 33.05, lng: 132.95 } },
    partySize: 1
  });

  assert.equal(preview.status, "ASSIGNABLE");
  assert.equal(preview.simulation.vehicleId, "veh_1");

  const existingDropoffIndex = preview.simulation.routeAfter.findIndex(
    (task) => task.requestId === existingRequestId && task.type === "DROPOFF"
  );
  const newPickupIndex = preview.simulation.routeAfter.findIndex(
    (task) => task.requestLabel === "新規予約" && task.type === "PICKUP"
  );
  assert.ok(existingDropoffIndex >= 0);
  assert.ok(newPickupIndex >= 0);
  assert.equal(existingDropoffIndex < newPickupIndex, true);

  const impactedExisting = preview.simulation.impactedRequests.find(
    (impact) => impact.requestId === existingRequestId
  );
  assert.ok(impactedExisting);
  assert.equal(impactedExisting.dropoffDeltaMinutes, 0);
});

test("dispatch can backtrack slightly to pick up another customer en route", async () => {
  const { repository, existingRequestId } = seedRepositoryWithOnboardDropoff({
    existingDropoffPoint: { lat: 33.01, lng: 132.91 }
  });

  const preview = await previewRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_backtrack_pickup",
    pickup: { mode: "FREE_POINT", point: { lat: 32.999, lng: 132.899 } },
    dropoff: { mode: "FREE_POINT", point: { lat: 33.011, lng: 132.911 } },
    partySize: 1
  });

  assert.equal(preview.status, "ASSIGNABLE");

  const newPickupIndex = preview.simulation.routeAfter.findIndex(
    (task) => task.requestLabel === "新規予約" && task.type === "PICKUP"
  );
  const existingDropoffIndex = preview.simulation.routeAfter.findIndex(
    (task) => task.requestId === existingRequestId && task.type === "DROPOFF"
  );
  assert.ok(newPickupIndex >= 0);
  assert.ok(existingDropoffIndex >= 0);
  assert.equal(newPickupIndex < existingDropoffIndex, true);

  const impactedExisting = preview.simulation.impactedRequests.find(
    (impact) => impact.requestId === existingRequestId
  );
  assert.ok(impactedExisting);
  assert.equal(Number.isFinite(impactedExisting.dropoffDeltaMinutes), true);
  assert.equal(impactedExisting.dropoffDeltaMinutes > 0, true);
  assert.equal(
    impactedExisting.dropoffDeltaMinutes <= createDefaultServiceProfile().poolingPolicy.maxDetourMinutes,
    true
  );
});
