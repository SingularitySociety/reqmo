import { estimateTravelMinutes } from "../../../shared/src/geo.ts";

const DEFAULT_ARRIVE_BY_EARLY_PICKUP_TOLERANCE_MINUTES = 10;

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

function normalizeDateInput(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function resolveRequestEvaluationNow(request) {
  return normalizeDateInput(request?.evaluationNowAt) ?? new Date();
}

function resolveArriveByPickupEtaMinutes({
  request,
  serviceProfile,
  travelMinutes = defaultTravelMinutes
}) {
  const requestType =
    typeof request?.requestType === "string" ? request.requestType.trim().toUpperCase() : "";
  if (requestType !== "ARRIVE_BY" && !request?.desiredPickupAt && !request?.desiredDropoffAt) {
    return null;
  }

  const now = resolveRequestEvaluationNow(request);
  const desiredPickupAt = normalizeDateInput(request?.desiredPickupAt);
  if (desiredPickupAt) {
    return Math.max(0, (desiredPickupAt.getTime() - now.getTime()) / (60 * 1000));
  }

  const desiredDropoffAt = normalizeDateInput(request?.desiredDropoffAt);
  if (!desiredDropoffAt) {
    return null;
  }

  const directRideMinutes = travelMinutes(request?.pickupPoint, request?.dropoffPoint);
  const safeDirectRideMinutes =
    Number.isFinite(directRideMinutes) && directRideMinutes >= 0 ? directRideMinutes : 0;
  const pickupServiceMinutes = normalizeNonNegative(
    serviceProfile?.dispatchPolicy?.pickupServiceMinutes,
    0
  );
  const dropoffServiceMinutes = normalizeNonNegative(
    serviceProfile?.dispatchPolicy?.dropoffServiceMinutes,
    0
  );
  const desiredPickupEtaMinutes =
    (desiredDropoffAt.getTime() - now.getTime()) / (60 * 1000) -
    safeDirectRideMinutes -
    pickupServiceMinutes -
    dropoffServiceMinutes;
  if (!Number.isFinite(desiredPickupEtaMinutes)) {
    return null;
  }
  return Math.max(0, desiredPickupEtaMinutes);
}

export function findGreedyVehicle({ request, vehicles, serviceProfile, travelMinutes = defaultTravelMinutes }) {
  const limit = serviceProfile.dispatchPolicy.candidateVehicleLimit;
  const maxOnboard = serviceProfile.poolingPolicy.maxOnboardPerVehicle;
  const requestEvaluationNow = resolveRequestEvaluationNow(request);
  const desiredPickupEtaMinutes = resolveArriveByPickupEtaMinutes({
    request,
    serviceProfile,
    travelMinutes
  });
  const configuredMaxWait = normalizeNonNegative(serviceProfile.dispatchPolicy.maxWaitMinutes, 0);
  const maxWait = Number.isFinite(desiredPickupEtaMinutes)
    ? Math.max(configuredMaxWait, desiredPickupEtaMinutes)
    : configuredMaxWait;
  const arriveByEarlyPickupToleranceMinutes = normalizeNonNegative(
    serviceProfile?.dispatchPolicy?.arriveByEarlyPickupToleranceMinutes,
    DEFAULT_ARRIVE_BY_EARLY_PICKUP_TOLERANCE_MINUTES
  );
  const earliestPickupEtaMinutes = Number.isFinite(desiredPickupEtaMinutes)
    ? Math.max(0, desiredPickupEtaMinutes - arriveByEarlyPickupToleranceMinutes)
    : null;

  let best = null;
  let inspected = 0;

  for (const vehicle of vehicles) {
    if (vehicle.status !== "ACTIVE") {
      continue;
    }

    if (inspected >= limit) {
      break;
    }
    inspected += 1;

    const existingRoute = Array.isArray(vehicle.route) ? vehicle.route : [];
    if (existingRoute.length > 0) {
      continue;
    }

    const capacity = Math.min(vehicle.capacity ?? maxOnboard, maxOnboard);
    const onboard = vehicle.onboardCount ?? 0;
    if (onboard > 0) {
      continue;
    }
    if (onboard + request.partySize > capacity) {
      continue;
    }

    const rawEtaPickupMinutes = travelMinutes(vehicle.currentLocation, request.pickupPoint);
    let etaPickupMinutes = rawEtaPickupMinutes;
    let pickupNotBeforeAt = null;
    if (
      Number.isFinite(earliestPickupEtaMinutes) &&
      Number.isFinite(rawEtaPickupMinutes) &&
      rawEtaPickupMinutes < earliestPickupEtaMinutes
    ) {
      etaPickupMinutes = earliestPickupEtaMinutes;
      pickupNotBeforeAt = new Date(
        requestEvaluationNow.getTime() + earliestPickupEtaMinutes * 60 * 1000
      ).toISOString();
    }
    if (etaPickupMinutes > maxWait) {
      continue;
    }

    if (!best || etaPickupMinutes < best.etaPickupMinutes) {
      best = {
        vehicleId: vehicle.id,
        etaPickupMinutes,
        score: etaPickupMinutes,
        route: [
          {
            type: "PICKUP",
            requestId: request.id,
            point: request.pickupPoint,
            loadChange: request.partySize,
            ...(pickupNotBeforeAt ? { notBeforeAt: pickupNotBeforeAt } : {})
          },
          {
            type: "DROPOFF",
            requestId: request.id,
            point: request.dropoffPoint,
            loadChange: -request.partySize
          }
        ]
      };
    }
  }

  return best;
}
