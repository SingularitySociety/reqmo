import { estimateTravelMinutes } from "../../../shared/src/geo.ts";
import { createRideRequest } from "../api/functions.ts";
import { InMemoryRepository } from "../repository/inMemoryRepository.ts";
import { createTravelEstimator } from "../routing/service.ts";
import {
  addOutcomeToMetrics,
  createEmptyMetrics,
  evaluateBookingOutcome,
  mergeMetrics,
  scoreMetrics
} from "./evaluator.ts";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hasPoint(point) {
  return Boolean(point) && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng));
}

function normalizePoint(point) {
  return hasPoint(point) ? { lat: Number(point.lat), lng: Number(point.lng) } : null;
}

function pointKey(point) {
  return `${Number(point.lat).toFixed(6)},${Number(point.lng).toFixed(6)}`;
}

function addPoint(index, point) {
  const normalized = normalizePoint(point);
  if (normalized) {
    index.set(pointKey(normalized), normalized);
  }
}

function resolveLocationPoint(location, stopsById) {
  if (hasPoint(location?.resolvedPoint)) {
    return normalizePoint(location.resolvedPoint);
  }
  if (hasPoint(location?.point)) {
    return normalizePoint(location.point);
  }
  const stop = location?.stopId ? stopsById.get(location.stopId) : null;
  return normalizePoint(stop);
}

function mergedInitialState(suite, scenario) {
  const base = suite?.initialState && typeof suite.initialState === "object"
    ? suite.initialState
    : {};
  const override = scenario?.initialState && typeof scenario.initialState === "object"
    ? scenario.initialState
    : {};
  return {
    ...clone(base),
    ...clone(override)
  };
}

function collectScenarioPoints(suite, scenario) {
  const initialState = mergedInitialState(suite, scenario);
  const stops = Array.isArray(initialState.stops) ? initialState.stops : [];
  const stopsById = new Map(stops.map((stop) => [stop.id, stop]));
  const points = new Map();
  const referencedStopIds = new Set();

  for (const vehicle of initialState.vehicles ?? []) {
    addPoint(points, vehicle.currentLocation);
    addPoint(points, vehicle.officePoint ?? vehicle.homeBase);
    for (const task of vehicle.route ?? []) {
      addPoint(points, task.point);
    }
  }

  for (const request of initialState.rideRequests ?? []) {
    if (request?.pickup?.stopId) referencedStopIds.add(request.pickup.stopId);
    if (request?.dropoff?.stopId) referencedStopIds.add(request.dropoff.stopId);
    addPoint(points, resolveLocationPoint(request?.pickup, stopsById));
    addPoint(points, resolveLocationPoint(request?.dropoff, stopsById));
  }

  for (const booking of scenario?.bookings ?? []) {
    if (booking?.pickup?.stopId) referencedStopIds.add(booking.pickup.stopId);
    addPoint(points, resolveLocationPoint(booking?.pickup, stopsById));
    const dropoffs = Array.isArray(booking?.dropoffs) && booking.dropoffs.length
      ? booking.dropoffs.map((group) => group?.dropoff ?? group?.location ?? group)
      : [booking?.dropoff];
    for (const dropoff of dropoffs) {
      if (dropoff?.stopId) referencedStopIds.add(dropoff.stopId);
      addPoint(points, resolveLocationPoint(dropoff, stopsById));
    }
  }

  for (const stopId of referencedStopIds) {
    addPoint(points, stopsById.get(stopId));
  }
  return Array.from(points.values());
}

export async function buildFrozenTravelMatrices({ suite, baseProfile, routing = {} }) {
  const matrices = {};
  for (const scenario of suite.scenarios ?? []) {
    const points = collectScenarioPoints(suite, scenario);
    const estimator = await createTravelEstimator({
      points,
      context: { routing },
      speedKmh: baseProfile?.dispatchPolicy?.cruiseSpeedKmh
    });
    const entries = {};
    for (const from of points) {
      for (const to of points) {
        entries[`${pointKey(from)}|${pointKey(to)}`] = estimator.travelMinutes(from, to);
      }
    }
    matrices[scenario.id] = {
      source: estimator.source,
      speedKmh: Number(baseProfile?.dispatchPolicy?.cruiseSpeedKmh) || 25,
      entries
    };
  }
  return matrices;
}

function travelMinutesForMatrix(matrix) {
  const fallbackSpeed = Number(matrix?.speedKmh) || 25;
  return (from, to) => {
    const a = normalizePoint(from);
    const b = normalizePoint(to);
    if (!a || !b) {
      return 0;
    }
    const value = Number(matrix?.entries?.[`${pointKey(a)}|${pointKey(b)}`]);
    return Number.isFinite(value) && value >= 0
      ? value
      : estimateTravelMinutes(a, b, fallbackSpeed);
  };
}

function normalizePartition(value) {
  return String(value ?? "TRAIN").trim().toUpperCase() === "HOLDOUT"
    ? "HOLDOUT"
    : "TRAIN";
}

function positiveInteger(value, fallback = null) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

export function expandScenarioBooking(booking, bookingIndex = 0) {
  const bookingId = booking?.id ?? `booking_${bookingIndex + 1}`;
  const totalPartySize = positiveInteger(booking?.partySize, 1);
  const configuredGroups = Array.isArray(booking?.dropoffs) && booking.dropoffs.length
    ? booking.dropoffs
    : [{
        id: `${bookingId}_dropoff_1`,
        dropoff: booking?.dropoff,
        partySize: totalPartySize
      }];
  const groups = configuredGroups.map((group, groupIndex) => ({
    id: group?.id ?? `${bookingId}_dropoff_${groupIndex + 1}`,
    dropoff: clone(group?.dropoff ?? group?.location ?? group),
    partySize: positiveInteger(group?.partySize),
    expectations: group?.expectations && typeof group.expectations === "object"
      ? clone(group.expectations)
      : {}
  }));

  if (groups.some((group) => !group.partySize)) {
    throw new Error(`${bookingId}: Each dropoff group requires a positive integer partySize`);
  }
  const dropoffTotal = groups.reduce((sum, group) => sum + group.partySize, 0);
  if (dropoffTotal !== totalPartySize) {
    throw new Error(
      `${bookingId}: Pickup partySize (${totalPartySize}) must equal total dropoff partySize (${dropoffTotal})`
    );
  }

  return groups.map((group, groupIndex) => ({
    ...clone(booking),
    id: groups.length === 1 ? bookingId : `${bookingId}__${group.id}`,
    parentBookingId: bookingId,
    passengerGroupId: group.id,
    groupIndex,
    groupCount: groups.length,
    sameVehicleRequired: groups.length > 1 && booking?.sameVehicleRequired !== false,
    dropoff: group.dropoff,
    dropoffs: undefined,
    partySize: group.partySize,
    expectations: {
      ...(booking?.expectations && typeof booking.expectations === "object"
        ? clone(booking.expectations)
        : {}),
      ...group.expectations
    }
  }));
}

function validateSuite(suite) {
  if (!suite || typeof suite !== "object") {
    throw new Error("Tuning scenario suite is required");
  }
  if (!Array.isArray(suite.scenarios) || !suite.scenarios.length) {
    throw new Error("At least one tuning scenario is required");
  }
  for (const scenario of suite.scenarios) {
    if (!scenario?.id || !Array.isArray(scenario.bookings) || !scenario.bookings.length) {
      throw new Error("Each tuning scenario requires id and bookings");
    }
    scenario.bookings.forEach((booking, bookingIndex) => {
      expandScenarioBooking(booking, bookingIndex);
    });
  }
}

function seedForScenario(initialState, candidateProfile) {
  return {
    ...clone(initialState),
    serviceProfiles: [candidateProfile],
    counter: Number(initialState?.counter ?? 0)
  };
}

function evaluatePassengerGroupIntegrity(groupOutcomes) {
  if (!Array.isArray(groupOutcomes) || groupOutcomes.length <= 1) return null;
  if (groupOutcomes.some((outcome) => outcome.status !== "ASSIGNED" || !outcome.rideRequestId)) {
    return null;
  }
  const requestIds = new Set(groupOutcomes.map((outcome) => outcome.rideRequestId));
  const finalRoute = groupOutcomes.at(-1)?.routeAfter ?? [];
  const pickupIndexes = [];
  const dropoffIndexes = [];
  finalRoute.forEach((task, index) => {
    if (!requestIds.has(task?.requestId)) return;
    if (task?.type === "PICKUP") pickupIndexes.push(index);
    if (task?.type === "DROPOFF") dropoffIndexes.push(index);
  });
  const complete = pickupIndexes.length === requestIds.size && dropoffIndexes.length === requestIds.size;
  const allBoardBeforeFirstDropoff = complete && Math.max(...pickupIndexes) < Math.min(...dropoffIndexes);
  return {
    complete,
    allBoardBeforeFirstDropoff,
    pickupIndexes,
    dropoffIndexes
  };
}

export async function runScenarioSuite({
  suite,
  candidateProfile,
  frozenTravelMatrices = {},
  evaluationPolicy = suite?.evaluationPolicy ?? {}
}) {
  validateSuite(suite);
  const partitions = {
    TRAIN: createEmptyMetrics(),
    HOLDOUT: createEmptyMetrics()
  };
  const scenarioResults = [];

  for (const scenario of suite.scenarios) {
    const partition = normalizePartition(scenario.partition);
    const initialState = mergedInitialState(suite, scenario);
    const repository = new InMemoryRepository(seedForScenario(initialState, candidateProfile));
    repository.setServiceProfile(candidateProfile);
    const matrix = frozenTravelMatrices[scenario.id] ?? null;
    const travelMinutes = travelMinutesForMatrix(matrix);
    const metrics = createEmptyMetrics();
    const outcomes = [];
    const latestRouteTravelByVehicle = new Map();

    for (let bookingIndex = 0; bookingIndex < scenario.bookings.length; bookingIndex += 1) {
      const sourceBooking = scenario.bookings[bookingIndex];
      const groupedBookings = expandScenarioBooking(sourceBooking, bookingIndex);
      let groupedVehicleId = null;
      const firstGroupOutcomeIndex = outcomes.length;

      for (const booking of groupedBookings) {
        const evaluationNow = booking.at ?? booking.evaluationNowAt ?? new Date(0).toISOString();
        let result;
        try {
          if (booking.sameVehicleRequired && booking.groupIndex > 0 && !groupedVehicleId) {
            throw new Error("The first passenger group could not be assigned to a vehicle");
          }
          result = await createRideRequest({
            repository,
            tenantId: booking.tenantId ?? "tenant_default",
            requesterId: booking.requesterId ?? `tuning_user_${bookingIndex + 1}_${booking.groupIndex + 1}`,
            pickup: clone(booking.pickup),
            dropoff: clone(booking.dropoff),
            partySize: booking.partySize ?? 1,
            passenger: booking.passenger ?? null,
            channel: booking.channel,
            serviceProfileId: candidateProfile.id,
            requestType: booking.requestType ?? null,
            desiredDropoffAt: booking.desiredDropoffAt ?? null,
            desiredPickupAt: booking.desiredPickupAt ?? null,
            preferredVehicleId: booking.sameVehicleRequired ? groupedVehicleId : null,
            context: {
              now: evaluationNow,
              travelMinutes
            }
          });
        } catch (error) {
          result = {
            status: "REJECTED",
            reason: "SCENARIO_EXECUTION_ERROR",
            diagnostics: {
              summary: error instanceof Error ? error.message : String(error)
            }
          };
        }

        const outcome = evaluateBookingOutcome({
          booking,
          result,
          defaultExpectations: scenario.expectations ?? suite.defaultExpectations ?? {}
        });
        if (booking.sameVehicleRequired && !groupedVehicleId && outcome.selectedVehicleId) {
          groupedVehicleId = outcome.selectedVehicleId;
        }
        addOutcomeToMetrics(metrics, outcome);
        if (outcome.selectedVehicleId && Number.isFinite(Number(result?.simulation?.routeAfterTravelMinutes))) {
          latestRouteTravelByVehicle.set(
            outcome.selectedVehicleId,
            Number(result.simulation.routeAfterTravelMinutes)
          );
        }
        outcomes.push({
          bookingId: booking.id,
          parentBookingId: booking.parentBookingId,
          passengerGroupId: booking.passengerGroupId,
          partySize: booking.partySize,
          rideRequestId: result?.rideRequest?.id ?? null,
          status: result?.status ?? "REJECTED",
          reason: result?.reason ?? null,
          selectedVehicleId: outcome.selectedVehicleId,
          vehicleStartPoint: normalizePoint(
            repository.listVehicles().find((vehicle) => vehicle.id === outcome.selectedVehicleId)?.currentLocation
          ),
          plannedPickupAt: result?.simulation?.plannedPickupAt ?? null,
          plannedDropoffAt: result?.simulation?.plannedDropoffAt ?? null,
          selectedAlgorithm: result?.simulation?.selectedAlgorithm ?? null,
          metrics: outcome,
          routeAfter: result?.simulation?.routeAfter ?? [],
          diagnostics: result?.diagnostics ?? null
        });
      }

      const groupOutcomes = outcomes.slice(firstGroupOutcomeIndex);
      const groupIntegrity = evaluatePassengerGroupIntegrity(groupOutcomes);
      if (groupIntegrity && !groupIntegrity.allBoardBeforeFirstDropoff) {
        const targetOutcome = groupOutcomes.at(-1);
        targetOutcome.metrics.violations.push({
          code: "GROUP_PICKUP_BEFORE_DROPOFF",
          message: "同乗グループ全員が乗車する前に途中降車が始まりました。",
          expected: "ALL_PICKUPS_BEFORE_FIRST_DROPOFF",
          actual: groupIntegrity
        });
        targetOutcome.groupIntegrity = groupIntegrity;
        metrics.hardViolationCount += 1;
      } else if (groupIntegrity) {
        groupOutcomes.at(-1).groupIntegrity = groupIntegrity;
      }
    }

    metrics.totalRouteTravelMinutes = Array.from(latestRouteTravelByVehicle.values())
      .reduce((sum, value) => sum + value, 0);
    scoreMetrics(metrics, evaluationPolicy);
    mergeMetrics(partitions[partition], metrics);
    scenarioResults.push({
      scenarioId: scenario.id,
      name: scenario.name ?? scenario.id,
      partition,
      routingSource: matrix?.source ?? "STRAIGHT_LINE",
      metrics,
      outcomes
    });
  }

  scoreMetrics(partitions.TRAIN, evaluationPolicy);
  scoreMetrics(partitions.HOLDOUT, evaluationPolicy);
  const overall = createEmptyMetrics();
  mergeMetrics(overall, partitions.TRAIN);
  mergeMetrics(overall, partitions.HOLDOUT);
  scoreMetrics(overall, evaluationPolicy);

  return {
    metrics: overall,
    partitions,
    scenarioResults
  };
}

export function snapshotRepositoryForTuning(repository) {
  const vehicles = repository.listVehicles().map((vehicle) => {
    const {
      assignedDriverId: _assignedDriverId,
      driverId: _driverId,
      telemetry: _telemetry,
      ...safeVehicle
    } = vehicle;
    return safeVehicle;
  });
  const rideRequests = repository.listRideRequests().map((request) => {
    const {
      passenger: _passenger,
      requesterId: _requesterId,
      callerE164: _callerE164,
      ...safeRequest
    } = request;
    return safeRequest;
  });
  return clone({
    users: [],
    vehicles,
    stops: repository.listStops(),
    rideRequests,
    serviceProfiles: repository.listServiceProfiles(),
    farePolicies: repository.listFarePolicies(),
    telephonyConfigs: repository.listTelephonyConfigs()
  });
}
