import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultServiceProfile } from "../../shared/src/defaults.ts";
import { estimateTravelMinutes } from "../../shared/src/geo.ts";
import { InMemoryRepository } from "../src/repository/inMemoryRepository.ts";
import {
  cancelRideRequest,
  createRideRequest,
  previewRideRequest,
  updateVehicleLocation,
  upsertServiceProfile
} from "../src/api/functions.ts";

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

function plannedRideMinutes(rideRequest) {
  const pickupAt = Date.parse(rideRequest?.assignment?.plannedPickupAt ?? "");
  const dropoffAt = Date.parse(rideRequest?.assignment?.plannedDropoffAt ?? "");
  assert.equal(Number.isFinite(pickupAt), true);
  assert.equal(Number.isFinite(dropoffAt), true);
  return (dropoffAt - pickupAt) / (60 * 1000);
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

test("dispatch works when HIGHS is configured as primary algorithm", async () => {
  const repository = seedRepository();
  const baseProfile = createDefaultServiceProfile();
  const highsProfile = createDefaultServiceProfile({
    id: "highs_primary_profile",
    dispatchPolicy: {
      ...baseProfile.dispatchPolicy,
      algorithmPrimary: "HIGHS",
      algorithmFallback: "INSERTION"
    }
  });
  upsertServiceProfile({ repository, profile: highsProfile });

  const result = await createRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_highs_primary",
    pickup: { mode: "FREE_POINT", point: { lat: 33.0002, lng: 132.9002 } },
    dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
    partySize: 1,
    serviceProfileId: highsProfile.id
  });

  assert.equal(result.status, "ASSIGNED");
  assert.equal(result.rideRequest.assignment?.vehicleId, "veh_1");
});

test("dispatch falls back when HIGHS solver is disabled", async () => {
  const previous = process.env.REQMO_DISABLE_HIGHS_SOLVER;
  process.env.REQMO_DISABLE_HIGHS_SOLVER = "1";
  try {
    const repository = seedRepository();
    const baseProfile = createDefaultServiceProfile();
    const highsProfile = createDefaultServiceProfile({
      id: "highs_disabled_profile",
      dispatchPolicy: {
        ...baseProfile.dispatchPolicy,
        algorithmPrimary: "HIGHS",
        algorithmFallback: "INSERTION"
      }
    });
    upsertServiceProfile({ repository, profile: highsProfile });

    const result = await createRideRequest({
      repository,
      tenantId: "tenant_default",
      requesterId: "user_highs_disabled",
      pickup: { mode: "FREE_POINT", point: { lat: 33.0002, lng: 132.9002 } },
      dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
      partySize: 1,
      serviceProfileId: highsProfile.id
    });

    assert.equal(result.status, "ASSIGNED");
    assert.equal(result.rideRequest.assignment?.vehicleId, "veh_1");
  } finally {
    if (previous === undefined) {
      delete process.env.REQMO_DISABLE_HIGHS_SOLVER;
    } else {
      process.env.REQMO_DISABLE_HIGHS_SOLVER = previous;
    }
  }
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

test("arrive-by preview allows pickup ETA beyond maxWait when desired dropoff is in the future", async () => {
  const repository = new InMemoryRepository();
  repository.addVehicle({
    id: "veh_future",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: { lat: 33.0, lng: 132.9 },
    route: []
  });

  const preview = await previewRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_future_arrive_by",
    pickup: { mode: "FREE_POINT", point: { lat: 33.09, lng: 132.99 } },
    dropoff: { mode: "FREE_POINT", point: { lat: 33.1, lng: 133.0 } },
    partySize: 1,
    desiredDropoffAt: "2026-02-01T13:00:00+09:00",
    context: {
      now: "2026-02-01T10:00:00+09:00"
    }
  });

  assert.equal(preview.status, "ASSIGNABLE");
  assert.equal(Number.isFinite(Number(preview.simulation?.etaPickupMinutes)), true);
  assert.equal(Number(preview.simulation?.etaPickupMinutes) >= 120, true);
});

test("far-future reservation is handled as separate route without impacting active trip", async () => {
  const repository = seedRepository();

  const first = await createRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_existing_trip",
    pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
    dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
    partySize: 1,
    context: {
      now: "2026-02-01T09:00:00+09:00"
    }
  });
  assert.equal(first.status, "ASSIGNED");
  assert.equal(first.rideRequest.assignment?.vehicleId, "veh_1");

  const preview = await previewRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_future_reservation",
    pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
    dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
    partySize: 1,
    desiredDropoffAt: "2026-02-01T12:00:00+09:00",
    context: {
      now: "2026-02-01T09:00:00+09:00"
    }
  });

  assert.equal(preview.status, "ASSIGNABLE");
  assert.equal(Number(preview.simulation?.etaPickupMinutes) >= 120, true);

  const existingDropoffIndex = preview.simulation?.routeAfter.findIndex(
    (task) => task.requestId === first.rideRequest.id && task.type === "DROPOFF"
  );
  const newPickupIndex = preview.simulation?.routeAfter.findIndex(
    (task) => task.requestLabel === "新規予約" && task.type === "PICKUP"
  );
  assert.equal(Number(existingDropoffIndex) >= 0, true);
  assert.equal(Number(newPickupIndex) >= 0, true);
  assert.equal(newPickupIndex > existingDropoffIndex, true);

  const existingImpact = preview.simulation?.impactedRequests.find(
    (impact) => impact.requestId === first.rideRequest.id
  );
  assert.ok(existingImpact);
  assert.equal(existingImpact.pickupDeltaMinutes, 0);
  assert.equal(existingImpact.dropoffDeltaMinutes, 0);
});

test("future reservations on the same date can be reordered by requested time", async () => {
  const repository = new InMemoryRepository();
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
  const evaluationNow = "2026-02-20T09:00:00+09:00";

  const noonReservation = await createRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_same_date_noon",
    pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
    dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
    partySize: 1,
    desiredDropoffAt: "2026-02-21T12:00:00+09:00",
    context: {
      now: evaluationNow
    }
  });

  assert.equal(noonReservation.status, "ASSIGNED");
  assert.equal(noonReservation.rideRequest.assignment?.vehicleId, "veh_1");

  const preview = await previewRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_same_date_morning",
    pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
    dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
    partySize: 1,
    desiredDropoffAt: "2026-02-21T10:00:00+09:00",
    context: {
      now: evaluationNow
    }
  });

  assert.equal(preview.status, "ASSIGNABLE");
  const routeAfter = preview.simulation?.routeAfter ?? [];
  const morningPickupIndex = routeAfter.findIndex(
    (task) => task.requestLabel === "新規予約" && task.type === "PICKUP"
  );
  const noonPickupIndex = routeAfter.findIndex(
    (task) => task.requestId === noonReservation.rideRequest.id && task.type === "PICKUP"
  );
  assert.equal(morningPickupIndex >= 0, true);
  assert.equal(noonPickupIndex >= 0, true);
  assert.equal(morningPickupIndex < noonPickupIndex, true);
});

test("preview returns suggested dropoff time when planned dropoff exceeds desired time", async () => {
  const repository = seedRepository();
  const desiredDropoffAt = "2026-02-01T10:01:00+09:00";

  const preview = await previewRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_desired_dropoff_suggestion",
    pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
    dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
    partySize: 1,
    desiredDropoffAt,
    context: {
      now: "2026-02-01T10:00:00+09:00"
    }
  });

  assert.equal(preview.status, "ASSIGNABLE");
  assert.equal(typeof preview.simulation?.plannedDropoffAt, "string");
  assert.equal(preview.simulation?.desiredDropoffSuggestion?.requestedDropoffAt, new Date(desiredDropoffAt).toISOString());
  assert.equal(
    preview.simulation?.desiredDropoffSuggestion?.suggestedDropoffAt,
    preview.simulation?.plannedDropoffAt
  );
  assert.equal(Number(preview.simulation?.desiredDropoffSuggestion?.exceededByMinutes) > 0, true);
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

test("dispatch accepts when vehicle is full now but can drop off before new pickup", async () => {
  const repository = new InMemoryRepository();
  repository.addVehicle({
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 4,
    currentLocation: { lat: 33.0, lng: 132.9 },
    route: [
      {
        type: "DROPOFF",
        requestId: "req_existing_dropoff_only",
        point: { lat: 33.0003, lng: 132.9003 },
        loadChange: -4
      }
    ]
  });

  const preview = await previewRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_capacity_after_dropoff",
    pickup: { mode: "FREE_POINT", point: { lat: 33.0004, lng: 132.9004 } },
    dropoff: { mode: "FREE_POINT", point: { lat: 33.0012, lng: 132.9012 } },
    partySize: 1
  });

  assert.equal(preview.status, "ASSIGNABLE");

  const existingDropoffIndex = preview.simulation.routeAfter.findIndex(
    (task) => task.requestId === "req_existing_dropoff_only" && task.type === "DROPOFF"
  );
  const newPickupIndex = preview.simulation.routeAfter.findIndex(
    (task) => task.requestLabel === "新規予約" && task.type === "PICKUP"
  );
  assert.ok(existingDropoffIndex >= 0);
  assert.ok(newPickupIndex >= 0);
  assert.equal(existingDropoffIndex < newPickupIndex, true);

  let onboard = 4;
  preview.simulation.routeAfter.forEach((task) => {
    onboard += task.loadChange ?? 0;
    assert.equal(onboard >= 0 && onboard <= 4, true);
  });
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
  assert.ok(preview.diagnostics);
  assert.equal(typeof preview.diagnostics.summary, "string");
  assert.equal(Array.isArray(preview.diagnostics.countermeasureCandidates), true);
  assert.equal(Array.isArray(preview.diagnostics.breakdown), true);
  assert.equal(typeof preview.diagnostics.rejectionCounts, "object");
  assert.equal(typeof preview.diagnostics.constraints, "object");
  assert.equal(typeof preview.diagnostics.observed, "object");
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

test("arrive-by reservations prioritize lower in-vehicle detour for the newer rider", async () => {
  const now = "2026-02-22T14:35:00+09:00";
  const satoDropoffAt = "2026-02-22T15:05:00+09:00";
  const suzukiDropoffAt = "2026-02-22T15:00:00+09:00";

  const stops = {
    a: { lat: 33.10848974888167, lng: 132.9 },
    b: { lat: 33.1, lng: 132.9 },
    c: { lat: 33.06440584605662, lng: 132.9 },
    d: { lat: 33.06000027403387, lng: 132.9 }
  };
  const vehiclePoint = { lat: 33.107419605806626, lng: 132.9 };

  const singleSatoRepo = new InMemoryRepository();
  singleSatoRepo.addVehicle({
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: vehiclePoint,
    route: []
  });
  singleSatoRepo.addStop({ id: "stop_a", name: "安並団地入口", ...stops.a });
  singleSatoRepo.addStop({ id: "stop_d", name: "サンリバー四万十", ...stops.d });

  const singleSato = await createRideRequest({
    repository: singleSatoRepo,
    tenantId: "tenant_default",
    requesterId: "user_sato_single",
    passenger: { name: "佐藤さん" },
    pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
    dropoff: { mode: "FIXED_STOP", stopId: "stop_d" },
    partySize: 1,
    desiredDropoffAt: satoDropoffAt,
    context: { now }
  });
  assert.equal(singleSato.status, "ASSIGNED");
  const singleSatoRideMinutes = plannedRideMinutes(singleSato.rideRequest);
  assert.equal(singleSatoRideMinutes > 12 && singleSatoRideMinutes < 13.5, true);

  const singleSuzukiRepo = new InMemoryRepository();
  singleSuzukiRepo.addVehicle({
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: vehiclePoint,
    route: []
  });
  singleSuzukiRepo.addStop({ id: "stop_b", name: "京町五丁目", ...stops.b });
  singleSuzukiRepo.addStop({ id: "stop_c", name: "中村駅", ...stops.c });

  const singleSuzuki = await createRideRequest({
    repository: singleSuzukiRepo,
    tenantId: "tenant_default",
    requesterId: "user_suzuki_single",
    passenger: { name: "鈴木さん" },
    pickup: { mode: "FIXED_STOP", stopId: "stop_b" },
    dropoff: { mode: "FIXED_STOP", stopId: "stop_c" },
    partySize: 1,
    desiredDropoffAt: suzukiDropoffAt,
    context: { now }
  });
  assert.equal(singleSuzuki.status, "ASSIGNED");
  const singleSuzukiRideMinutes = plannedRideMinutes(singleSuzuki.rideRequest);
  assert.equal(singleSuzukiRideMinutes > 9 && singleSuzukiRideMinutes < 10.5, true);

  const combinedRepo = new InMemoryRepository();
  combinedRepo.addVehicle({
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: vehiclePoint,
    route: []
  });
  combinedRepo.addStop({ id: "stop_a", name: "安並団地入口", ...stops.a });
  combinedRepo.addStop({ id: "stop_b", name: "京町五丁目", ...stops.b });
  combinedRepo.addStop({ id: "stop_c", name: "中村駅", ...stops.c });
  combinedRepo.addStop({ id: "stop_d", name: "サンリバー四万十", ...stops.d });

  const satoCombined = await createRideRequest({
    repository: combinedRepo,
    tenantId: "tenant_default",
    requesterId: "user_sato_combined",
    passenger: { name: "佐藤さん" },
    pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
    dropoff: { mode: "FIXED_STOP", stopId: "stop_d" },
    partySize: 1,
    desiredDropoffAt: satoDropoffAt,
    context: { now }
  });
  assert.equal(satoCombined.status, "ASSIGNED");

  const suzukiCombined = await createRideRequest({
    repository: combinedRepo,
    tenantId: "tenant_default",
    requesterId: "user_suzuki_combined",
    passenger: { name: "鈴木さん" },
    pickup: { mode: "FIXED_STOP", stopId: "stop_b" },
    dropoff: { mode: "FIXED_STOP", stopId: "stop_c" },
    partySize: 1,
    desiredDropoffAt: suzukiDropoffAt,
    context: { now }
  });

  assert.equal(suzukiCombined.status, "ASSIGNED");
  assert.deepEqual(
    suzukiCombined.simulation.routeAfter.map(
      (task) => `${task.requestLabel}:${task.type}:${task.locationLabel}`
    ),
    [
      "佐藤さん:PICKUP:安並団地入口",
      "新規予約:PICKUP:京町五丁目",
      "新規予約:DROPOFF:中村駅",
      "佐藤さん:DROPOFF:サンリバー四万十"
    ]
  );

  const combinedSuzukiRideMinutes = plannedRideMinutes(suzukiCombined.rideRequest);
  assert.equal(combinedSuzukiRideMinutes <= singleSuzukiRideMinutes + 0.5, true);

  const impactedSato = suzukiCombined.simulation.impactedRequests.find(
    (impact) => impact.requestId === satoCombined.rideRequest.id
  );
  assert.ok(impactedSato);
  assert.equal(Math.abs(Number(impactedSato.pickupDeltaMinutes ?? 0)) <= 0.01, true);
  assert.equal(Math.abs(Number(impactedSato.dropoffDeltaMinutes ?? 0)) <= 0.01, true);
});

test("dispatch can accept feasible plans that include consecutive pickups", async () => {
  const repository = new InMemoryRepository();
  const baseProfile = createDefaultServiceProfile();
  const profile = createDefaultServiceProfile({
    id: "consecutive_pickup_profile",
    dispatchPolicy: {
      ...baseProfile.dispatchPolicy,
      maxWaitMinutes: 1.2
    },
    poolingPolicy: {
      ...baseProfile.poolingPolicy,
      maxDetourMinutes: 0.6,
      maxOnboardPerVehicle: 4,
      maxAdditionalStops: 4
    }
  });
  upsertServiceProfile({ repository, profile });

  repository.addVehicle({
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: { lat: 33.0, lng: 132.9 },
    route: [
      { type: "PICKUP", requestId: "r1", point: { lat: 33.0002, lng: 132.9002 }, loadChange: 1 },
      { type: "DROPOFF", requestId: "r1", point: { lat: 33.0009, lng: 132.9009 }, loadChange: -1 },
      { type: "PICKUP", requestId: "r2", point: { lat: 33.001, lng: 132.901 }, loadChange: 3 },
      { type: "DROPOFF", requestId: "r2", point: { lat: 33.004, lng: 132.904 }, loadChange: -3 }
    ]
  });

  const preview = await previewRideRequest({
    repository,
    serviceProfileId: profile.id,
    tenantId: "tenant_default",
    requesterId: "user_consecutive_pickup",
    pickup: {
      mode: "FREE_POINT",
      point: { lat: 33.00089232296793, lng: 132.90086842753976 }
    },
    dropoff: {
      mode: "FREE_POINT",
      point: { lat: 33.00404704691556, lng: 132.90391928939525 }
    },
    partySize: 1
  });

  assert.equal(preview.status, "ASSIGNABLE");
  const hasConsecutivePickup = preview.simulation.routeAfter.some(
    (task, index, route) => index > 0 && route[index - 1].type === "PICKUP" && task.type === "PICKUP"
  );
  assert.equal(hasConsecutivePickup, true);
});

test("dispatch prefers dropoff-first plan when dropoffPriority is enabled", async () => {
  const repository = new InMemoryRepository();
  const baseProfile = createDefaultServiceProfile();
  const profileNoPriority = createDefaultServiceProfile({
    id: "dropoff_priority_off",
    dispatchPolicy: {
      ...baseProfile.dispatchPolicy,
      weights: {
        ...baseProfile.dispatchPolicy.weights,
        dropoffPriority: 0
      }
    }
  });
  const profileWithPriority = createDefaultServiceProfile({
    id: "dropoff_priority_on",
    dispatchPolicy: {
      ...baseProfile.dispatchPolicy,
      weights: {
        ...baseProfile.dispatchPolicy.weights,
        dropoffPriority: 1
      }
    }
  });
  upsertServiceProfile({ repository, profile: profileNoPriority });
  upsertServiceProfile({ repository, profile: profileWithPriority });

  repository.addVehicle({
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: { lat: 33, lng: 132.9 },
    route: [
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
    ]
  });

  const input = {
    tenantId: "tenant_default",
    requesterId: "user_dropoff_priority",
    pickup: {
      mode: "FREE_POINT",
      point: { lat: 33.00405860618066, lng: 132.90040670554254 }
    },
    dropoff: {
      mode: "FREE_POINT",
      point: { lat: 33.00488278887875, lng: 132.90207485043206 }
    },
    partySize: 1
  };

  const withoutPriority = await previewRideRequest({
    repository,
    serviceProfileId: profileNoPriority.id,
    ...input
  });
  const withPriority = await previewRideRequest({
    repository,
    serviceProfileId: profileWithPriority.id,
    ...input
  });

  assert.equal(withoutPriority.status, "ASSIGNABLE");
  assert.equal(withPriority.status, "ASSIGNABLE");

  const countConsecutivePickupPairs = (route) =>
    route.reduce((count, task, index) => {
      if (index === 0) {
        return count;
      }
      return route[index - 1].type === "PICKUP" && task.type === "PICKUP"
        ? count + 1
        : count;
    }, 0);

  const withoutPairs = countConsecutivePickupPairs(withoutPriority.simulation.routeAfter);
  const withPairs = countConsecutivePickupPairs(withPriority.simulation.routeAfter);
  assert.equal(withoutPairs > withPairs, true);

  const dropoffR1WithPriority = withPriority.simulation.routeAfter.findIndex(
    (task) => task.requestId === "r1" && task.type === "DROPOFF"
  );
  const pickupNewWithPriority = withPriority.simulation.routeAfter.findIndex(
    (task) => task.requestLabel === "新規予約" && task.type === "PICKUP"
  );
  assert.ok(dropoffR1WithPriority >= 0);
  assert.ok(pickupNewWithPriority >= 0);
  assert.equal(dropoffR1WithPriority < pickupNewWithPriority, true);
});

test("dispatch interleaves overlapping requests without completing the newer request first", async () => {
  const repository = new InMemoryRepository();
  repository.addVehicle({
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: { lat: 33.01, lng: 132.9 },
    route: []
  });

  const first = await createRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_existing_corridor",
    pickup: {
      mode: "FREE_POINT",
      point: { lat: 33.011604013315605, lng: 132.90239775606 }
    },
    dropoff: {
      mode: "FREE_POINT",
      point: { lat: 32.98615132547738, lng: 132.9185428086945 }
    },
    partySize: 1
  });
  assert.equal(first.status, "ASSIGNED");

  const preview = await previewRideRequest({
    repository,
    tenantId: "tenant_default",
    requesterId: "user_new_corridor",
    pickup: {
      mode: "FREE_POINT",
      point: { lat: 33.000542261145355, lng: 132.90294134334644 }
    },
    dropoff: {
      mode: "FREE_POINT",
      point: { lat: 32.999845587959555, lng: 132.90546891401067 }
    },
    partySize: 1
  });

  assert.equal(preview.status, "ASSIGNABLE");

  const existingPickupIndex = preview.simulation.routeAfter.findIndex(
    (task) => task.requestId === first.rideRequest.id && task.type === "PICKUP"
  );
  const existingDropoffIndex = preview.simulation.routeAfter.findIndex(
    (task) => task.requestId === first.rideRequest.id && task.type === "DROPOFF"
  );
  const newPickupIndex = preview.simulation.routeAfter.findIndex(
    (task) => task.requestLabel === "新規予約" && task.type === "PICKUP"
  );
  const newDropoffIndex = preview.simulation.routeAfter.findIndex(
    (task) => task.requestLabel === "新規予約" && task.type === "DROPOFF"
  );

  assert.ok(existingPickupIndex >= 0);
  assert.ok(existingDropoffIndex >= 0);
  assert.ok(newPickupIndex >= 0);
  assert.ok(newDropoffIndex >= 0);
  assert.equal(existingPickupIndex < newPickupIndex, true);
  assert.equal(newPickupIndex < newDropoffIndex, true);
  assert.equal(newDropoffIndex < existingDropoffIndex, true);
});

test("dispatch rejects request when vehicle cannot return to office before lunch break", async () => {
  const repository = new InMemoryRepository();
  const baseProfile = createDefaultServiceProfile();
  const profile = createDefaultServiceProfile({
    id: "office_break_return_guard",
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
  upsertServiceProfile({ repository, profile });

  repository.addVehicle({
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: { lat: 33.1, lng: 132.9 },
    route: []
  });

  const preview = await previewRideRequest({
    repository,
    serviceProfileId: profile.id,
    tenantId: "tenant_default",
    requesterId: "user_break_guard",
    pickup: {
      mode: "FREE_POINT",
      point: { lat: 33.1, lng: 132.9 }
    },
    dropoff: {
      mode: "FREE_POINT",
      point: { lat: 33.2, lng: 132.9 }
    },
    partySize: 1,
    context: {
      now: "2026-02-01T10:50:00+09:00"
    }
  });

  assert.equal(preview.status, "REJECTED");
  assert.equal(preview.reason, "NO_FEASIBLE_VEHICLE");
  assert.equal(preview.diagnostics?.rejectionCounts?.OFFICE_BREAK_POLICY, 1);
  assert.equal(preview.diagnostics?.details?.type, "RETURN_BEFORE_BREAK");
});

test("dispatch rejects future reservation when pre-break office return is impossible", async () => {
  const repository = new InMemoryRepository();
  const baseProfile = createDefaultServiceProfile();
  const profile = createDefaultServiceProfile({
    id: "office_break_future_return_guard",
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
        requireReturnToOffice: true,
        departFromOfficeAtEnd: true
      }
    }
  });
  upsertServiceProfile({ repository, profile });

  repository.addVehicle({
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: { lat: 33.1, lng: 132.9 },
    route: []
  });

  const preview = await previewRideRequest({
    repository,
    serviceProfileId: profile.id,
    tenantId: "tenant_default",
    requesterId: "user_break_guard_future",
    pickup: {
      mode: "FREE_POINT",
      point: { lat: 33.1, lng: 132.9 }
    },
    dropoff: {
      mode: "FREE_POINT",
      point: { lat: 33.2, lng: 132.9 }
    },
    partySize: 1,
    desiredDropoffAt: "2026-02-23T11:55:00+09:00",
    context: {
      now: "2026-02-20T10:50:00+09:00"
    }
  });

  assert.equal(preview.status, "REJECTED");
  assert.equal(preview.reason, "NO_FEASIBLE_VEHICLE");
  assert.equal(preview.diagnostics?.rejectionCounts?.OFFICE_BREAK_POLICY, 1);
  assert.equal(preview.diagnostics?.details?.type, "RETURN_BEFORE_BREAK");
});

test("dispatch does not require pre-break office return for afternoon reservation", async () => {
  const repository = new InMemoryRepository();
  const baseProfile = createDefaultServiceProfile();
  const profile = createDefaultServiceProfile({
    id: "office_break_afternoon_reservation",
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
  upsertServiceProfile({ repository, profile });

  repository.addVehicle({
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: { lat: 33.1, lng: 132.9 },
    route: []
  });

  const preview = await previewRideRequest({
    repository,
    serviceProfileId: profile.id,
    tenantId: "tenant_default",
    requesterId: "user_break_afternoon",
    pickup: {
      mode: "FREE_POINT",
      point: { lat: 33.1, lng: 132.9 }
    },
    dropoff: {
      mode: "FREE_POINT",
      point: { lat: 33.11, lng: 132.9 }
    },
    partySize: 1,
    desiredDropoffAt: "2026-02-01T13:20:00+09:00",
    context: {
      now: "2026-02-01T10:50:00+09:00"
    }
  });

  assert.equal(preview.status, "ASSIGNABLE");
  assert.equal(preview.diagnostics?.details?.type === "RETURN_BEFORE_BREAK", false);
});

test("dispatch suggests post-break operation when requested time falls within lunch break", async () => {
  const repository = new InMemoryRepository();
  const baseProfile = createDefaultServiceProfile();
  const profile = createDefaultServiceProfile({
    id: "office_break_future_day_guard",
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
  upsertServiceProfile({ repository, profile });

  repository.addVehicle({
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: { lat: 33.0, lng: 132.9 },
    route: []
  });

  const preview = await previewRideRequest({
    repository,
    serviceProfileId: profile.id,
    tenantId: "tenant_default",
    requesterId: "user_break_future_day",
    pickup: {
      mode: "FREE_POINT",
      point: { lat: 33.0, lng: 132.9 }
    },
    dropoff: {
      mode: "FREE_POINT",
      point: { lat: 33.001, lng: 132.9 }
    },
    partySize: 1,
    desiredDropoffAt: "2026-02-23T11:20:00+09:00",
    context: {
      now: "2026-02-20T10:50:00+09:00"
    }
  });

  assert.equal(preview.status, "ASSIGNABLE");
  const pickupAt = Date.parse(preview.simulation?.plannedPickupAt ?? "");
  const dropoffAt = Date.parse(preview.simulation?.plannedDropoffAt ?? "");
  const breakEndAt = Date.parse("2026-02-23T12:00:00+09:00");
  assert.equal(Number.isFinite(pickupAt), true);
  assert.equal(Number.isFinite(dropoffAt), true);
  assert.equal(pickupAt >= breakEndAt, true);
  assert.equal(dropoffAt >= breakEndAt, true);
  assert.equal(
    typeof preview.simulation?.desiredDropoffSuggestion?.suggestedDropoffAt === "string",
    true
  );
});

test("dispatch applies lunch-break constraints when enabled flag is omitted", async () => {
  const repository = new InMemoryRepository();
  const baseProfile = createDefaultServiceProfile();
  const profile = createDefaultServiceProfile({
    id: "office_break_enabled_default_guard",
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
        startLocalTime: "11:00",
        endLocalTime: "12:00",
        requireReturnToOffice: true,
        departFromOfficeAtEnd: true
      }
    }
  });
  upsertServiceProfile({ repository, profile });

  repository.addVehicle({
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: { lat: 33.0, lng: 132.9 },
    route: []
  });

  const preview = await previewRideRequest({
    repository,
    serviceProfileId: profile.id,
    tenantId: "tenant_default",
    requesterId: "user_break_enabled_default",
    pickup: {
      mode: "FREE_POINT",
      point: { lat: 33.0, lng: 132.9 }
    },
    dropoff: {
      mode: "FREE_POINT",
      point: { lat: 33.001, lng: 132.9 }
    },
    partySize: 1,
    desiredDropoffAt: "2026-02-23T11:39:00+09:00",
    context: {
      now: "2026-02-20T10:50:00+09:00"
    }
  });

  assert.equal(preview.status, "ASSIGNABLE");
  const pickupAt = Date.parse(preview.simulation?.plannedPickupAt ?? "");
  const breakEndAt = Date.parse("2026-02-23T12:00:00+09:00");
  assert.equal(Number.isFinite(pickupAt), true);
  assert.equal(pickupAt >= breakEndAt, true);
});

test("dispatch does not apply lunch-break constraints when operation policy is missing", async () => {
  const repository = new InMemoryRepository();
  const baseProfile = createDefaultServiceProfile();
  const profile = createDefaultServiceProfile({
    id: "office_break_missing_policy_guard",
    dispatchPolicy: {
      ...baseProfile.dispatchPolicy,
      maxWaitMinutes: 240
    },
    operationPolicy: undefined
  });
  upsertServiceProfile({ repository, profile });

  repository.addVehicle({
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: { lat: 33.0, lng: 132.9 },
    route: []
  });

  const preview = await previewRideRequest({
    repository,
    serviceProfileId: profile.id,
    tenantId: "tenant_default",
    requesterId: "user_break_missing_policy",
    pickup: {
      mode: "FREE_POINT",
      point: { lat: 33.0, lng: 132.9 }
    },
    dropoff: {
      mode: "FREE_POINT",
      point: { lat: 33.001, lng: 132.9 }
    },
    partySize: 1,
    desiredDropoffAt: "2026-02-23T11:39:00+09:00",
    context: {
      now: "2026-02-20T10:50:00+09:00"
    }
  });

  assert.equal(preview.status, "ASSIGNABLE");
  const pickupAt = Date.parse(preview.simulation?.plannedPickupAt ?? "");
  const breakEndAt = Date.parse("2026-02-23T12:00:00+09:00");
  assert.equal(Number.isFinite(pickupAt), true);
  assert.equal(pickupAt < breakEndAt, true);
});

test("dispatch evaluates lunch break using operation policy timezone", async () => {
  const repository = new InMemoryRepository();
  const baseProfile = createDefaultServiceProfile();
  const profile = createDefaultServiceProfile({
    id: "office_break_timezone_guard",
    dispatchPolicy: {
      ...baseProfile.dispatchPolicy,
      maxWaitMinutes: 240
    },
    operationPolicy: {
      office: {
        name: "本社",
        point: { lat: 33.0, lng: 132.9 }
      },
      timeZone: "UTC",
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
  upsertServiceProfile({ repository, profile });

  repository.addVehicle({
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: { lat: 33.0, lng: 132.9 },
    route: []
  });

  const preview = await previewRideRequest({
    repository,
    serviceProfileId: profile.id,
    tenantId: "tenant_default",
    requesterId: "user_break_timezone",
    pickup: {
      mode: "FREE_POINT",
      point: { lat: 33.0, lng: 132.9 }
    },
    dropoff: {
      mode: "FREE_POINT",
      point: { lat: 33.001, lng: 132.9 }
    },
    partySize: 1,
    desiredDropoffAt: "2026-02-23T11:39:00+09:00",
    context: {
      now: "2026-02-20T10:50:00+09:00"
    }
  });

  assert.equal(preview.status, "ASSIGNABLE");
  const pickupAt = Date.parse(preview.simulation?.plannedPickupAt ?? "");
  const breakEndAtTokyo = Date.parse("2026-02-23T12:00:00+09:00");
  assert.equal(Number.isFinite(pickupAt), true);
  assert.equal(pickupAt < breakEndAtTokyo, true);
});

test("dispatch rejects request when 12:00 office departure cannot reach pickup in time", async () => {
  const repository = new InMemoryRepository();
  const baseProfile = createDefaultServiceProfile();
  const profile = createDefaultServiceProfile({
    id: "office_break_departure_guard",
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
        requireReturnToOffice: false,
        departFromOfficeAtEnd: true
      }
    }
  });
  upsertServiceProfile({ repository, profile });

  repository.addVehicle({
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: { lat: 33.0, lng: 132.9 },
    route: []
  });

  const preview = await previewRideRequest({
    repository,
    serviceProfileId: profile.id,
    tenantId: "tenant_default",
    requesterId: "user_departure_guard",
    pickup: {
      mode: "FREE_POINT",
      point: { lat: 33.05, lng: 132.9 }
    },
    dropoff: {
      mode: "FREE_POINT",
      point: { lat: 33.051, lng: 132.901 }
    },
    partySize: 1,
    context: {
      now: "2026-02-01T11:59:00+09:00"
    }
  });

  assert.equal(preview.status, "REJECTED");
  assert.equal(preview.reason, "NO_FEASIBLE_VEHICLE");
  assert.equal(preview.diagnostics?.rejectionCounts?.OFFICE_BREAK_POLICY, 1);
  assert.equal(preview.diagnostics?.details?.type, "DEPART_AFTER_BREAK");
});

test("dispatch rejects future reservation when 13:00 office departure cannot reach pickup in time", async () => {
  const repository = new InMemoryRepository();
  const baseProfile = createDefaultServiceProfile();
  const profile = createDefaultServiceProfile({
    id: "office_break_future_departure_guard",
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
  upsertServiceProfile({ repository, profile });

  repository.addVehicle({
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: { lat: 33.0, lng: 132.9 },
    route: []
  });

  const preview = await previewRideRequest({
    repository,
    serviceProfileId: profile.id,
    tenantId: "tenant_default",
    requesterId: "user_departure_guard_future",
    pickup: {
      mode: "FREE_POINT",
      point: { lat: 33.05, lng: 132.9 }
    },
    dropoff: {
      mode: "FREE_POINT",
      point: { lat: 33.051, lng: 132.901 }
    },
    partySize: 1,
    desiredDropoffAt: "2026-02-23T13:05:00+09:00",
    context: {
      now: "2026-02-20T10:50:00+09:00"
    }
  });

  assert.equal(preview.status, "REJECTED");
  assert.equal(preview.reason, "NO_FEASIBLE_VEHICLE");
  assert.equal(preview.diagnostics?.rejectionCounts?.OFFICE_BREAK_POLICY, 1);
  assert.equal(preview.diagnostics?.details?.type, "DEPART_AFTER_BREAK");
});

test("dispatch lunch-break checks prioritize vehicle office point over shared office point", async () => {
  const repository = new InMemoryRepository();
  const baseProfile = createDefaultServiceProfile();
  const profile = createDefaultServiceProfile({
    id: "vehicle_office_priority_profile",
    dispatchPolicy: {
      ...baseProfile.dispatchPolicy,
      maxWaitMinutes: 240
    },
    operationPolicy: {
      office: {
        name: "共通本社",
        point: { lat: 33.05, lng: 132.9 }
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
  upsertServiceProfile({ repository, profile });

  repository.addVehicle({
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: { lat: 33.0, lng: 132.9 },
    officePoint: { lat: 33.005, lng: 132.9 },
    route: []
  });

  const preview = await previewRideRequest({
    repository,
    serviceProfileId: profile.id,
    tenantId: "tenant_default",
    requesterId: "user_vehicle_office_priority",
    pickup: {
      mode: "FREE_POINT",
      point: { lat: 33.0, lng: 132.9 }
    },
    dropoff: {
      mode: "FREE_POINT",
      point: { lat: 33.005, lng: 132.9 }
    },
    partySize: 1,
    context: {
      now: "2026-02-01T10:50:00+09:00"
    }
  });

  assert.equal(preview.status, "ASSIGNABLE");
});

test("dispatch rejects request when office departure would be before business hours", async () => {
  const repository = new InMemoryRepository();
  const baseProfile = createDefaultServiceProfile();
  const profile = createDefaultServiceProfile({
    id: "business_hours_departure_guard",
    dispatchPolicy: {
      ...baseProfile.dispatchPolicy,
      maxWaitMinutes: 240
    },
    operationPolicy: {
      office: {
        name: "本社",
        point: { lat: 33.0, lng: 132.9 }
      },
      businessHours: {
        enabled: true,
        startLocalTime: "08:00",
        endLocalTime: "18:00",
        requireDepartFromOffice: true,
        requireReturnToOffice: true
      },
      lunchBreak: {
        enabled: false
      }
    }
  });
  upsertServiceProfile({ repository, profile });

  repository.addVehicle({
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: { lat: 33.0, lng: 132.9 },
    officePoint: { lat: 33.0, lng: 132.9 },
    route: []
  });

  const preview = await previewRideRequest({
    repository,
    serviceProfileId: profile.id,
    tenantId: "tenant_default",
    requesterId: "user_business_departure_guard",
    pickup: {
      mode: "FREE_POINT",
      point: { lat: 33.04, lng: 132.9 }
    },
    dropoff: {
      mode: "FREE_POINT",
      point: { lat: 33.041, lng: 132.901 }
    },
    partySize: 1,
    context: {
      now: "2026-02-01T07:50:00+09:00"
    }
  });

  assert.equal(preview.status, "REJECTED");
  assert.equal(preview.reason, "NO_FEASIBLE_VEHICLE");
  assert.equal(preview.diagnostics?.rejectionCounts?.OFFICE_BREAK_POLICY, 1);
  assert.equal(preview.diagnostics?.details?.type, "DEPART_BEFORE_BUSINESS_HOURS");
});

test("dispatch rejects request when office return would exceed business hours", async () => {
  const repository = new InMemoryRepository();
  const baseProfile = createDefaultServiceProfile();
  const profile = createDefaultServiceProfile({
    id: "business_hours_return_guard",
    dispatchPolicy: {
      ...baseProfile.dispatchPolicy,
      maxWaitMinutes: 240
    },
    operationPolicy: {
      office: {
        name: "本社",
        point: { lat: 33.0, lng: 132.9 }
      },
      businessHours: {
        enabled: true,
        startLocalTime: "08:00",
        endLocalTime: "18:00",
        requireDepartFromOffice: true,
        requireReturnToOffice: true
      },
      lunchBreak: {
        enabled: false
      }
    }
  });
  upsertServiceProfile({ repository, profile });

  repository.addVehicle({
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: { lat: 33.0, lng: 132.9 },
    officePoint: { lat: 33.0, lng: 132.9 },
    route: []
  });

  const preview = await previewRideRequest({
    repository,
    serviceProfileId: profile.id,
    tenantId: "tenant_default",
    requesterId: "user_business_return_guard",
    pickup: {
      mode: "FREE_POINT",
      point: { lat: 33.0, lng: 132.9 }
    },
    dropoff: {
      mode: "FREE_POINT",
      point: { lat: 33.05, lng: 132.9 }
    },
    partySize: 1,
    context: {
      now: "2026-02-01T17:45:00+09:00"
    }
  });

  assert.equal(preview.status, "REJECTED");
  assert.equal(preview.reason, "NO_FEASIBLE_VEHICLE");
  assert.equal(preview.diagnostics?.rejectionCounts?.OFFICE_BREAK_POLICY, 1);
  assert.equal(preview.diagnostics?.details?.type, "RETURN_AFTER_BUSINESS_HOURS");
});
