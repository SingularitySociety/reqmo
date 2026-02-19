import { estimateTravelMinutes } from "../../../shared/src/geo.ts";

function defaultTravelMinutes(a, b) {
  return estimateTravelMinutes(a, b);
}

function normalizeNonNegative(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }
  return numeric;
}

function taskServiceMinutes(task, serviceProfile) {
  const dispatchPolicy = serviceProfile?.dispatchPolicy ?? {};
  const pickupServiceMinutes = normalizeNonNegative(dispatchPolicy.pickupServiceMinutes, 0);
  const dropoffServiceMinutes = normalizeNonNegative(dispatchPolicy.dropoffServiceMinutes, 0);

  if (task?.type === "PICKUP") {
    return pickupServiceMinutes;
  }
  if (task?.type === "DROPOFF") {
    return dropoffServiceMinutes;
  }
  return 0;
}

function travelMinutesUntilTask(startPoint, route, taskIndex, travelMinutes, serviceProfile) {
  let minutes = 0;
  let current = startPoint;
  for (let i = 0; i <= taskIndex; i += 1) {
    const task = route[i];
    minutes += travelMinutes(current, task.point);
    current = task.point;
    if (i < taskIndex) {
      minutes += taskServiceMinutes(task, serviceProfile);
    }
  }
  return minutes;
}

function evaluateRouteSafety({ vehicle, route, partySize, maxOnboardPerVehicle }) {
  const hardCapacity = vehicle.capacity ?? maxOnboardPerVehicle;
  const cappedCapacity = Math.min(hardCapacity, maxOnboardPerVehicle);
  let onboard = vehicle.onboardCount ?? 0;

  for (const task of route) {
    onboard += task.loadChange ?? 0;
    if (onboard < 0 || onboard > cappedCapacity) {
      return { ok: false, reason: "CAPACITY" };
    }
  }

  return { ok: true };
}

function routeIsCapacitySafe(args) {
  return evaluateRouteSafety(args).ok;
}

function taskEtasFromStart(startPoint, route, travelMinutes, serviceProfile) {
  const etas = [];
  let minutes = 0;
  let current = startPoint;

  for (const task of route) {
    minutes += travelMinutes(current, task.point);
    etas.push(minutes);
    minutes += taskServiceMinutes(task, serviceProfile);
    current = task.point;
  }

  return etas;
}

function existingTaskDelayMinutes({
  startPoint,
  existingRoute,
  candidateRoute,
  newRequestId,
  travelMinutes,
  serviceProfile
}) {
  if (!existingRoute.length) {
    return 0;
  }

  const baselineEtas = taskEtasFromStart(startPoint, existingRoute, travelMinutes, serviceProfile);
  let current = startPoint;
  let elapsed = 0;
  let existingTaskIndex = 0;
  let maxDelay = 0;

  for (const task of candidateRoute) {
    elapsed += travelMinutes(current, task.point);
    current = task.point;

    if (task.requestId !== newRequestId) {
      const baselineEta = baselineEtas[existingTaskIndex];
      if (Number.isFinite(baselineEta)) {
        maxDelay = Math.max(maxDelay, elapsed - baselineEta);
      }
      existingTaskIndex += 1;
    }
    elapsed += taskServiceMinutes(task, serviceProfile);
  }

  return Math.max(0, maxDelay);
}

function requestRideMinutes({
  startPoint,
  route,
  requestId,
  travelMinutes,
  serviceProfile
}) {
  let current = startPoint;
  let elapsed = 0;
  let pickupElapsed = null;

  for (const task of route) {
    elapsed += travelMinutes(current, task.point);
    current = task.point;

    if (task.requestId === requestId) {
      if (task.type === "PICKUP" && pickupElapsed === null) {
        pickupElapsed = elapsed;
      } else if (task.type === "DROPOFF" && pickupElapsed !== null) {
        return Math.max(0, elapsed - pickupElapsed);
      }
    }

    elapsed += taskServiceMinutes(task, serviceProfile);
  }

  return 0;
}

function insertionCost({
  etaPickupMinutes,
  detourMinutes,
  deadheadMinutes,
  newRideDetourMinutes = 0,
  consecutivePickupPairs = 0,
  serviceProfile
}) {
  const weights = serviceProfile.dispatchPolicy.weights ?? {};
  const pickupDelayWeight = normalizeNonNegative(weights.pickupDelay, 0.4);
  const detourWeight = normalizeNonNegative(weights.detour, 0.25);
  const deadheadWeight = normalizeNonNegative(weights.deadhead, 0.2);
  const rideDetourWeight = normalizeNonNegative(weights.rideTimeDetour, 0.1);
  const latenessWeight = normalizeNonNegative(weights.lateness, 0.15);
  const dropoffPriorityWeight = normalizeNonNegative(weights.dropoffPriority, 0);
  const normalizedNewRideDetourMinutes = normalizeNonNegative(newRideDetourMinutes, 0);
  const normalizedConsecutivePickupPairs = normalizeNonNegative(consecutivePickupPairs, 0);
  return (
    pickupDelayWeight * etaPickupMinutes +
    detourWeight * detourMinutes +
    deadheadWeight * deadheadMinutes +
    rideDetourWeight * normalizedNewRideDetourMinutes +
    latenessWeight * Math.max(0, etaPickupMinutes - serviceProfile.dispatchPolicy.maxWaitMinutes) +
    dropoffPriorityWeight * normalizedConsecutivePickupPairs
  );
}

function insertTasks(route, pickupTask, dropoffTask, pickupIndex, dropoffIndex) {
  const withPickup = [...route.slice(0, pickupIndex), pickupTask, ...route.slice(pickupIndex)];
  return [...withPickup.slice(0, dropoffIndex), dropoffTask, ...withPickup.slice(dropoffIndex)];
}

function countConsecutivePickupPairs(route) {
  let consecutivePairs = 0;
  let previousWasPickup = false;

  for (const task of route) {
    const type = typeof task?.type === "string" ? task.type.trim().toUpperCase() : "";
    const isPickup = type === "PICKUP";
    if (isPickup && previousWasPickup) {
      consecutivePairs += 1;
    }
    previousWasPickup = isPickup;
  }

  return consecutivePairs;
}

export function analyzeInsertionCandidateFailures({
  vehicle,
  request,
  serviceProfile,
  travelMinutes = defaultTravelMinutes
}) {
  const rejectionCounts = {
    CONSECUTIVE_PICKUP: 0,
    CAPACITY: 0,
    MAX_WAIT: 0,
    MAX_DETOUR: 0,
    MAX_ADDITIONAL_STOPS: 0
  };

  if (vehicle.status !== "ACTIVE") {
    return {
      vehicleId: vehicle.id,
      vehicleStatus: vehicle.status,
      candidateCount: 0,
      feasibleCount: 0,
      rejectionCounts,
      minEtaPickupMinutes: null,
      minDetourMinutes: null
    };
  }

  const existingRoute = vehicle.route ?? [];
  const pickupTask = {
    type: "PICKUP",
    requestId: request.id,
    point: request.pickupPoint,
    loadChange: request.partySize
  };
  const dropoffTask = {
    type: "DROPOFF",
    requestId: request.id,
    point: request.dropoffPoint,
    loadChange: -request.partySize
  };

  const maxDetour = serviceProfile.poolingPolicy.maxDetourMinutes;
  const maxWait = serviceProfile.dispatchPolicy.maxWaitMinutes;
  const maxAdditionalStops = serviceProfile.poolingPolicy.maxAdditionalStops;

  let candidateCount = 0;
  let feasibleCount = 0;
  let minEtaPickupMinutes = null;
  let minDetourMinutes = null;

  for (let pickupIndex = 0; pickupIndex <= existingRoute.length; pickupIndex += 1) {
    for (let dropoffIndex = pickupIndex + 1; dropoffIndex <= existingRoute.length + 1; dropoffIndex += 1) {
      candidateCount += 1;
      const candidateRoute = insertTasks(existingRoute, pickupTask, dropoffTask, pickupIndex, dropoffIndex);

      const safety = evaluateRouteSafety({
        vehicle,
        route: candidateRoute,
        partySize: request.partySize,
        maxOnboardPerVehicle: serviceProfile.poolingPolicy.maxOnboardPerVehicle
      });
      if (!safety.ok) {
        rejectionCounts[safety.reason] += 1;
        continue;
      }

      const etaPickupMinutes = travelMinutesUntilTask(
        vehicle.currentLocation,
        candidateRoute,
        pickupIndex,
        travelMinutes,
        serviceProfile
      );
      if (minEtaPickupMinutes === null || etaPickupMinutes < minEtaPickupMinutes) {
        minEtaPickupMinutes = etaPickupMinutes;
      }
      if (etaPickupMinutes > maxWait) {
        rejectionCounts.MAX_WAIT += 1;
        continue;
      }

      const detourMinutes = existingTaskDelayMinutes({
        startPoint: vehicle.currentLocation,
        existingRoute,
        candidateRoute,
        newRequestId: request.id,
        travelMinutes,
        serviceProfile
      });
      if (minDetourMinutes === null || detourMinutes < minDetourMinutes) {
        minDetourMinutes = detourMinutes;
      }
      if (detourMinutes > maxDetour) {
        rejectionCounts.MAX_DETOUR += 1;
        continue;
      }

      const addedStops = candidateRoute.length - existingRoute.length;
      if (addedStops > maxAdditionalStops) {
        rejectionCounts.MAX_ADDITIONAL_STOPS += 1;
        continue;
      }

      feasibleCount += 1;
    }
  }

  return {
    vehicleId: vehicle.id,
    vehicleStatus: vehicle.status,
    candidateCount,
    feasibleCount,
    rejectionCounts,
    minEtaPickupMinutes,
    minDetourMinutes
  };
}

export function findBestInsertionPlan({ vehicle, request, serviceProfile, travelMinutes = defaultTravelMinutes }) {
  if (vehicle.status !== "ACTIVE") {
    return null;
  }

  const existingRoute = vehicle.route ?? [];

  const pickupTask = {
    type: "PICKUP",
    requestId: request.id,
    point: request.pickupPoint,
    loadChange: request.partySize
  };
  const dropoffTask = {
    type: "DROPOFF",
    requestId: request.id,
    point: request.dropoffPoint,
    loadChange: -request.partySize
  };

  let best = null;
  const maxDetour = serviceProfile.poolingPolicy.maxDetourMinutes;
  const maxWait = serviceProfile.dispatchPolicy.maxWaitMinutes;
  const maxAdditionalStops = serviceProfile.poolingPolicy.maxAdditionalStops;

  for (let pickupIndex = 0; pickupIndex <= existingRoute.length; pickupIndex += 1) {
    for (let dropoffIndex = pickupIndex + 1; dropoffIndex <= existingRoute.length + 1; dropoffIndex += 1) {
      const candidateRoute = insertTasks(existingRoute, pickupTask, dropoffTask, pickupIndex, dropoffIndex);

      if (
        !routeIsCapacitySafe({
          vehicle,
          route: candidateRoute,
          partySize: request.partySize,
          maxOnboardPerVehicle: serviceProfile.poolingPolicy.maxOnboardPerVehicle
        })
      ) {
        continue;
      }

      const etaPickupMinutes = travelMinutesUntilTask(
        vehicle.currentLocation,
        candidateRoute,
        pickupIndex,
        travelMinutes,
        serviceProfile
      );
      if (etaPickupMinutes > maxWait) {
        continue;
      }

      const detourMinutes = existingTaskDelayMinutes({
        startPoint: vehicle.currentLocation,
        existingRoute,
        candidateRoute,
        newRequestId: request.id,
        travelMinutes,
        serviceProfile
      });
      if (detourMinutes > maxDetour) {
        continue;
      }

      const addedStops = candidateRoute.length - existingRoute.length;
      if (addedStops > maxAdditionalStops) {
        continue;
      }

      const deadheadMinutes = travelMinutes(vehicle.currentLocation, request.pickupPoint);
      const newRideMinutes = requestRideMinutes({
        startPoint: vehicle.currentLocation,
        route: candidateRoute,
        requestId: request.id,
        travelMinutes,
        serviceProfile
      });
      const directRideMinutes = travelMinutes(request.pickupPoint, request.dropoffPoint);
      const newRideDetourMinutes = Math.max(0, newRideMinutes - directRideMinutes);
      const consecutivePickupPairs = countConsecutivePickupPairs(candidateRoute);
      const score = insertionCost({
        etaPickupMinutes,
        detourMinutes,
        deadheadMinutes,
        newRideDetourMinutes,
        consecutivePickupPairs,
        serviceProfile
      });

      if (!best || score < best.score) {
        best = {
          vehicleId: vehicle.id,
          route: candidateRoute,
          etaPickupMinutes,
          detourMinutes,
          score
        };
      }
    }
  }

  return best;
}

export function findBestInsertionAcrossVehicles({ request, vehicles, serviceProfile, travelMinutes = defaultTravelMinutes }) {
  const limit = serviceProfile.dispatchPolicy.candidateVehicleLimit;
  let inspected = 0;
  let globalBest = null;

  for (const vehicle of vehicles) {
    if (inspected >= limit) {
      break;
    }

    const bestForVehicle = findBestInsertionPlan({ vehicle, request, serviceProfile, travelMinutes });
    inspected += 1;

    if (!bestForVehicle) {
      continue;
    }

    if (!globalBest || bestForVehicle.score < globalBest.score) {
      globalBest = bestForVehicle;
    }
  }

  return globalBest;
}
