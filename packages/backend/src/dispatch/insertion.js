import { estimateTravelMinutes } from "../../../shared/src/geo.js";

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

function routeIsCapacitySafe({ vehicle, route, partySize, maxOnboardPerVehicle }) {
  const hardCapacity = vehicle.capacity ?? maxOnboardPerVehicle;
  const cappedCapacity = Math.min(hardCapacity, maxOnboardPerVehicle);
  let onboard = vehicle.onboardCount ?? 0;

  for (const task of route) {
    onboard += task.loadChange ?? 0;
    if (onboard < 0 || onboard > cappedCapacity) {
      return false;
    }
  }

  if ((vehicle.onboardCount ?? 0) + partySize > cappedCapacity) {
    return false;
  }

  return true;
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

function insertionCost({ etaPickupMinutes, detourMinutes, deadheadMinutes, serviceProfile }) {
  const weights = serviceProfile.dispatchPolicy.weights;
  return (
    weights.pickupDelay * etaPickupMinutes +
    weights.detour * detourMinutes +
    weights.deadhead * deadheadMinutes +
    weights.lateness * Math.max(0, etaPickupMinutes - serviceProfile.dispatchPolicy.maxWaitMinutes)
  );
}

function insertTasks(route, pickupTask, dropoffTask, pickupIndex, dropoffIndex) {
  const withPickup = [...route.slice(0, pickupIndex), pickupTask, ...route.slice(pickupIndex)];
  return [...withPickup.slice(0, dropoffIndex), dropoffTask, ...withPickup.slice(dropoffIndex)];
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
      const score = insertionCost({
        etaPickupMinutes,
        detourMinutes,
        deadheadMinutes,
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
