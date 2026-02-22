import { estimateTravelMinutes } from "../../../shared/src/geo.ts";

const DEFAULT_ARRIVE_BY_EARLY_PICKUP_TOLERANCE_MINUTES = 10;
const DEFAULT_OPERATION_TIME_ZONE = "Asia/Tokyo";

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

function pad2(value) {
  return String(value).padStart(2, "0");
}

function resolveOperationTimeZone(serviceProfile) {
  const configured =
    typeof serviceProfile?.operationPolicy?.timeZone === "string"
      ? serviceProfile.operationPolicy.timeZone.trim()
      : "";
  const candidate = configured || DEFAULT_OPERATION_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch (_error) {
    return DEFAULT_OPERATION_TIME_ZONE;
  }
}

function extractTimeZoneDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const asNumber = (type, fallback = 0) => {
    const raw = parts.find((part) => part.type === type)?.value;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    year: asNumber("year", date.getUTCFullYear()),
    month: asNumber("month", date.getUTCMonth() + 1),
    day: asNumber("day", date.getUTCDate())
  };
}

function formatDateKeyInTimeZone(date, timeZone = DEFAULT_OPERATION_TIME_ZONE) {
  const parts = extractTimeZoneDateParts(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function resolveReservationReferenceDate(request) {
  const desiredPickupAt = normalizeDateInput(request?.desiredPickupAt);
  if (desiredPickupAt) {
    return desiredPickupAt;
  }
  const desiredDropoffAt = normalizeDateInput(request?.desiredDropoffAt);
  if (desiredDropoffAt) {
    return desiredDropoffAt;
  }
  return normalizeDateInput(request?.pickupNotBeforeAt);
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

function resolveRequestEvaluationNow(request) {
  return normalizeDateInput(request?.evaluationNowAt) ?? new Date();
}

function resolveArriveByPickupEtaMinutes({
  request,
  serviceProfile,
  travelMinutes = defaultTravelMinutes
}) {
  const requestType = typeof request?.requestType === "string"
    ? request.requestType.trim().toUpperCase()
    : "";
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
  const pickupServiceMinutes = normalizeNonNegative(serviceProfile?.dispatchPolicy?.pickupServiceMinutes, 0);
  const dropoffServiceMinutes = normalizeNonNegative(serviceProfile?.dispatchPolicy?.dropoffServiceMinutes, 0);
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

function resolvePickupNotBeforeEtaMinutes(request) {
  const now = resolveRequestEvaluationNow(request);
  const pickupNotBeforeAt = normalizeDateInput(request?.pickupNotBeforeAt);
  if (!pickupNotBeforeAt) {
    return null;
  }
  const etaMinutes = (pickupNotBeforeAt.getTime() - now.getTime()) / (60 * 1000);
  if (!Number.isFinite(etaMinutes)) {
    return null;
  }
  return Math.max(0, etaMinutes);
}

function resolveEffectiveMaxWaitMinutes({
  request,
  serviceProfile,
  travelMinutes = defaultTravelMinutes
}) {
  const configuredMaxWait = normalizeNonNegative(serviceProfile?.dispatchPolicy?.maxWaitMinutes, 0);
  const desiredPickupEtaMinutes = resolveArriveByPickupEtaMinutes({
    request,
    serviceProfile,
    travelMinutes
  });
  const pickupNotBeforeEtaMinutes = resolvePickupNotBeforeEtaMinutes(request);
  const requiredPickupEtaMinutes =
    Number.isFinite(desiredPickupEtaMinutes) || Number.isFinite(pickupNotBeforeEtaMinutes)
      ? Math.max(desiredPickupEtaMinutes ?? 0, pickupNotBeforeEtaMinutes ?? 0)
      : null;
  if (!Number.isFinite(requiredPickupEtaMinutes)) {
    return configuredMaxWait;
  }
  return Math.max(configuredMaxWait, requiredPickupEtaMinutes);
}

function resolveArriveByEarlyPickupToleranceMinutes(serviceProfile) {
  const configured = normalizeNonNegative(
    serviceProfile?.dispatchPolicy?.arriveByEarlyPickupToleranceMinutes,
    DEFAULT_ARRIVE_BY_EARLY_PICKUP_TOLERANCE_MINUTES
  );
  return configured;
}

function resolveArriveByReservationConstraints({
  request,
  serviceProfile,
  travelMinutes = defaultTravelMinutes
}) {
  const desiredPickupEtaMinutes = resolveArriveByPickupEtaMinutes({
    request,
    serviceProfile,
    travelMinutes
  });
  const pickupNotBeforeEtaMinutes = resolvePickupNotBeforeEtaMinutes(request);
  if (
    !Number.isFinite(desiredPickupEtaMinutes) &&
    !Number.isFinite(pickupNotBeforeEtaMinutes)
  ) {
    return {
      enabled: false,
      earliestPickupEtaMinutes: null,
      reservationDateKey: null,
      operationTimeZone: resolveOperationTimeZone(serviceProfile)
    };
  }

  const earlyPickupToleranceMinutes = resolveArriveByEarlyPickupToleranceMinutes(serviceProfile);
  const reservationReferenceDate = resolveReservationReferenceDate(request);
  const operationTimeZone = resolveOperationTimeZone(serviceProfile);
  let earliestPickupEtaMinutes = Number.isFinite(desiredPickupEtaMinutes)
    ? Math.max(0, desiredPickupEtaMinutes - earlyPickupToleranceMinutes)
    : null;
  if (Number.isFinite(pickupNotBeforeEtaMinutes)) {
    earliestPickupEtaMinutes = Number.isFinite(earliestPickupEtaMinutes)
      ? Math.max(earliestPickupEtaMinutes, pickupNotBeforeEtaMinutes)
      : Math.max(0, pickupNotBeforeEtaMinutes);
  }

  return {
    enabled: Number.isFinite(earliestPickupEtaMinutes),
    earliestPickupEtaMinutes: Number.isFinite(earliestPickupEtaMinutes)
      ? earliestPickupEtaMinutes
      : null,
    reservationDateKey: reservationReferenceDate
      ? formatDateKeyInTimeZone(reservationReferenceDate, operationTimeZone)
      : null,
    operationTimeZone
  };
}

function taskNotBeforeEtaMinutes(task, evaluationNow = new Date()) {
  const notBeforeAt = normalizeDateInput(task?.notBeforeAt);
  if (!notBeforeAt) {
    return null;
  }
  return (notBeforeAt.getTime() - evaluationNow.getTime()) / (60 * 1000);
}

function alignElapsedWithTaskWindow(elapsedMinutes, task, evaluationNow = new Date()) {
  const notBeforeEtaMinutes = taskNotBeforeEtaMinutes(task, evaluationNow);
  if (Number.isFinite(notBeforeEtaMinutes) && notBeforeEtaMinutes > elapsedMinutes) {
    return notBeforeEtaMinutes;
  }
  return elapsedMinutes;
}

function travelMinutesUntilTask(
  startPoint,
  route,
  taskIndex,
  travelMinutes,
  serviceProfile,
  evaluationNow = new Date()
) {
  let minutes = 0;
  let current = startPoint;
  for (let i = 0; i <= taskIndex; i += 1) {
    const task = route[i];
    minutes += travelMinutes(current, task.point);
    minutes = alignElapsedWithTaskWindow(minutes, task, evaluationNow);
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

function taskEtasFromStart(startPoint, route, travelMinutes, serviceProfile, evaluationNow = new Date()) {
  const etas = [];
  let minutes = 0;
  let current = startPoint;

  for (const task of route) {
    minutes += travelMinutes(current, task.point);
    minutes = alignElapsedWithTaskWindow(minutes, task, evaluationNow);
    etas.push(minutes);
    minutes += taskServiceMinutes(task, serviceProfile);
    current = task.point;
  }

  return etas;
}

function buildRequestPassengerCountIndex(route = []) {
  const requestPassengerCounts = new Map();
  for (const task of route) {
    if (!task?.requestId) {
      continue;
    }
    if (task?.type !== "PICKUP") {
      continue;
    }
    const load = Number(task?.loadChange);
    const passengerCount =
      Number.isFinite(load) && Math.abs(Math.trunc(load)) > 0
        ? Math.abs(Math.trunc(load))
        : 1;
    const previous = requestPassengerCounts.get(task.requestId) ?? 0;
    requestPassengerCounts.set(task.requestId, Math.max(previous, passengerCount));
  }
  return requestPassengerCounts;
}

function existingTaskDelayMetrics({
  startPoint,
  existingRoute,
  candidateRoute,
  newRequestId,
  travelMinutes,
  serviceProfile,
  evaluationNow = new Date()
}) {
  if (!existingRoute.length) {
    return {
      maxDelayMinutes: 0,
      sumDelayMinutes: 0,
      passengerWeightedSumDelayMinutes: 0
    };
  }

  const baselineEtas = taskEtasFromStart(
    startPoint,
    existingRoute,
    travelMinutes,
    serviceProfile,
    evaluationNow
  );
  const requestPassengerCountIndex = buildRequestPassengerCountIndex(existingRoute);
  let current = startPoint;
  let elapsed = 0;
  let existingTaskIndex = 0;
  let maxDelay = 0;
  let sumDelay = 0;
  let passengerWeightedSumDelay = 0;

  for (const task of candidateRoute) {
    elapsed += travelMinutes(current, task.point);
    elapsed = alignElapsedWithTaskWindow(elapsed, task, evaluationNow);
    current = task.point;

    if (task.requestId !== newRequestId) {
      const baselineEta = baselineEtas[existingTaskIndex];
      if (Number.isFinite(baselineEta)) {
        const delay = Math.max(0, elapsed - baselineEta);
        const passengerCount = Math.max(
          1,
          requestPassengerCountIndex.get(task.requestId) ?? 1
        );
        maxDelay = Math.max(maxDelay, delay);
        sumDelay += delay;
        passengerWeightedSumDelay += delay * passengerCount;
      }
      existingTaskIndex += 1;
    }
    elapsed += taskServiceMinutes(task, serviceProfile);
  }

  return {
    maxDelayMinutes: Math.max(0, maxDelay),
    sumDelayMinutes: Math.max(0, sumDelay),
    passengerWeightedSumDelayMinutes: Math.max(0, passengerWeightedSumDelay)
  };
}

function requestRideMinutes({
  startPoint,
  route,
  requestId,
  travelMinutes,
  serviceProfile,
  evaluationNow = new Date()
}) {
  let current = startPoint;
  let elapsed = 0;
  let pickupElapsed = null;

  for (const task of route) {
    elapsed += travelMinutes(current, task.point);
    elapsed = alignElapsedWithTaskWindow(elapsed, task, evaluationNow);
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
  existingDelaySumMinutes = 0,
  deadheadMinutes,
  newRideDetourMinutes = 0,
  consecutivePickupPairs = 0,
  serviceProfile
}) {
  const weights = serviceProfile.dispatchPolicy.weights ?? {};
  const pickupDelayWeight = normalizeNonNegative(weights.pickupDelay, 0.4);
  const detourWeight = normalizeNonNegative(weights.detour, 0.25);
  const deadheadWeight = normalizeNonNegative(weights.deadhead, 0.2);
  const configuredRideDetourWeight = normalizeNonNegative(weights.rideTimeDetour, 0.1);
  // Keep in-vehicle detour meaningful even when profile weight is set too low.
  const rideDetourWeight = Math.max(configuredRideDetourWeight, 0.3);
  const existingDelaySumWeight = normalizeNonNegative(weights.existingDelaySum, 0);
  const latenessWeight = normalizeNonNegative(weights.lateness, 0.15);
  const dropoffPriorityWeight = normalizeNonNegative(weights.dropoffPriority, 0);
  const normalizedNewRideDetourMinutes = normalizeNonNegative(newRideDetourMinutes, 0);
  const normalizedExistingDelaySumMinutes = normalizeNonNegative(existingDelaySumMinutes, 0);
  const normalizedConsecutivePickupPairs = normalizeNonNegative(consecutivePickupPairs, 0);
  return (
    pickupDelayWeight * etaPickupMinutes +
    detourWeight * detourMinutes +
    existingDelaySumWeight * normalizedExistingDelaySumMinutes +
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

function resolveTaskDateKey(task, operationTimeZone, fallbackDateKey) {
  const notBeforeAt = normalizeDateInput(task?.notBeforeAt);
  if (!notBeforeAt) {
    return fallbackDateKey;
  }
  return formatDateKeyInTimeZone(notBeforeAt, operationTimeZone);
}

function candidateFitsReservationDateWindow({
  candidateRoute,
  requestId,
  reservationDateKey,
  operationTimeZone,
  evaluationNow = new Date()
}) {
  if (!reservationDateKey) {
    return true;
  }
  const fallbackDateKey = formatDateKeyInTimeZone(evaluationNow, operationTimeZone);

  let pickupIndex = -1;
  let dropoffIndex = -1;
  for (let i = 0; i < candidateRoute.length; i += 1) {
    const task = candidateRoute[i];
    if (task?.requestId !== requestId) {
      continue;
    }
    const type = typeof task?.type === "string" ? task.type.trim().toUpperCase() : "";
    if (type === "PICKUP" && pickupIndex < 0) {
      pickupIndex = i;
      continue;
    }
    if (type === "DROPOFF" && dropoffIndex < 0) {
      dropoffIndex = i;
    }
  }
  if (pickupIndex < 0 || dropoffIndex < 0) {
    return true;
  }

  for (let i = 0; i < pickupIndex; i += 1) {
    const task = candidateRoute[i];
    if (task?.requestId === requestId) {
      continue;
    }
    const dateKey = resolveTaskDateKey(task, operationTimeZone, fallbackDateKey);
    if (dateKey > reservationDateKey) {
      return false;
    }
  }
  for (let i = dropoffIndex + 1; i < candidateRoute.length; i += 1) {
    const task = candidateRoute[i];
    if (task?.requestId === requestId) {
      continue;
    }
    const dateKey = resolveTaskDateKey(task, operationTimeZone, fallbackDateKey);
    if (dateKey < reservationDateKey) {
      return false;
    }
  }

  return true;
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
    MAX_ADDITIONAL_STOPS: 0,
    RESERVATION_WINDOW: 0
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
  const maxWait = resolveEffectiveMaxWaitMinutes({
    request,
    serviceProfile,
    travelMinutes
  });
  const arriveByConstraints = resolveArriveByReservationConstraints({
    request,
    serviceProfile,
    travelMinutes
  });
  const requestEvaluationNow = resolveRequestEvaluationNow(request);
  const maxAdditionalStops = serviceProfile.poolingPolicy.maxAdditionalStops;

  let candidateCount = 0;
  let feasibleCount = 0;
  let minEtaPickupMinutes = null;
  let minDetourMinutes = null;

  for (let pickupIndex = 0; pickupIndex <= existingRoute.length; pickupIndex += 1) {
    for (let dropoffIndex = pickupIndex + 1; dropoffIndex <= existingRoute.length + 1; dropoffIndex += 1) {
      candidateCount += 1;
      let pickupTaskForCandidate = pickupTask;
      let candidateRoute = insertTasks(
        existingRoute,
        pickupTaskForCandidate,
        dropoffTask,
        pickupIndex,
        dropoffIndex
      );
      if (
        arriveByConstraints.enabled &&
        !candidateFitsReservationDateWindow({
          candidateRoute,
          requestId: request.id,
          reservationDateKey: arriveByConstraints.reservationDateKey,
          operationTimeZone: arriveByConstraints.operationTimeZone,
          evaluationNow: requestEvaluationNow
        })
      ) {
        rejectionCounts.RESERVATION_WINDOW += 1;
        continue;
      }

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

      let etaPickupMinutes = travelMinutesUntilTask(
        vehicle.currentLocation,
        candidateRoute,
        pickupIndex,
        travelMinutes,
        serviceProfile,
        requestEvaluationNow
      );
      if (
        arriveByConstraints.enabled &&
        Number.isFinite(arriveByConstraints.earliestPickupEtaMinutes) &&
        etaPickupMinutes < arriveByConstraints.earliestPickupEtaMinutes
      ) {
        pickupTaskForCandidate = {
          ...pickupTask,
          notBeforeAt: new Date(
            requestEvaluationNow.getTime() + arriveByConstraints.earliestPickupEtaMinutes * 60 * 1000
          ).toISOString()
        };
        candidateRoute = insertTasks(
          existingRoute,
          pickupTaskForCandidate,
          dropoffTask,
          pickupIndex,
          dropoffIndex
        );
        etaPickupMinutes = arriveByConstraints.earliestPickupEtaMinutes;
      }
      if (minEtaPickupMinutes === null || etaPickupMinutes < minEtaPickupMinutes) {
        minEtaPickupMinutes = etaPickupMinutes;
      }
      if (etaPickupMinutes > maxWait) {
        rejectionCounts.MAX_WAIT += 1;
        continue;
      }

      const detourMetrics = existingTaskDelayMetrics({
        startPoint: vehicle.currentLocation,
        existingRoute,
        candidateRoute,
        newRequestId: request.id,
        travelMinutes,
        serviceProfile,
        evaluationNow: requestEvaluationNow
      });
      const detourMinutes = detourMetrics.maxDelayMinutes;
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
  const maxWait = resolveEffectiveMaxWaitMinutes({
    request,
    serviceProfile,
    travelMinutes
  });
  const arriveByConstraints = resolveArriveByReservationConstraints({
    request,
    serviceProfile,
    travelMinutes
  });
  const requestEvaluationNow = resolveRequestEvaluationNow(request);
  const maxAdditionalStops = serviceProfile.poolingPolicy.maxAdditionalStops;

  for (let pickupIndex = 0; pickupIndex <= existingRoute.length; pickupIndex += 1) {
    for (let dropoffIndex = pickupIndex + 1; dropoffIndex <= existingRoute.length + 1; dropoffIndex += 1) {
      let pickupTaskForCandidate = pickupTask;
      let candidateRoute = insertTasks(existingRoute, pickupTaskForCandidate, dropoffTask, pickupIndex, dropoffIndex);
      if (
        arriveByConstraints.enabled &&
        !candidateFitsReservationDateWindow({
          candidateRoute,
          requestId: request.id,
          reservationDateKey: arriveByConstraints.reservationDateKey,
          operationTimeZone: arriveByConstraints.operationTimeZone,
          evaluationNow: requestEvaluationNow
        })
      ) {
        continue;
      }

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

      let etaPickupMinutes = travelMinutesUntilTask(
        vehicle.currentLocation,
        candidateRoute,
        pickupIndex,
        travelMinutes,
        serviceProfile,
        requestEvaluationNow
      );
      if (
        arriveByConstraints.enabled &&
        Number.isFinite(arriveByConstraints.earliestPickupEtaMinutes) &&
        etaPickupMinutes < arriveByConstraints.earliestPickupEtaMinutes
      ) {
        pickupTaskForCandidate = {
          ...pickupTask,
          notBeforeAt: new Date(
            requestEvaluationNow.getTime() + arriveByConstraints.earliestPickupEtaMinutes * 60 * 1000
          ).toISOString()
        };
        candidateRoute = insertTasks(
          existingRoute,
          pickupTaskForCandidate,
          dropoffTask,
          pickupIndex,
          dropoffIndex
        );
        etaPickupMinutes = arriveByConstraints.earliestPickupEtaMinutes;
      }
      if (etaPickupMinutes > maxWait) {
        continue;
      }

      const detourMetrics = existingTaskDelayMetrics({
        startPoint: vehicle.currentLocation,
        existingRoute,
        candidateRoute,
        newRequestId: request.id,
        travelMinutes,
        serviceProfile,
        evaluationNow: requestEvaluationNow
      });
      const detourMinutes = detourMetrics.maxDelayMinutes;
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
        serviceProfile,
        evaluationNow: requestEvaluationNow
      });
      const directRideMinutes = travelMinutes(request.pickupPoint, request.dropoffPoint);
      const newRideDetourMinutes = Math.max(0, newRideMinutes - directRideMinutes);
      const consecutivePickupPairs = countConsecutivePickupPairs(candidateRoute);
      const score = insertionCost({
        etaPickupMinutes,
        detourMinutes,
        existingDelaySumMinutes: detourMetrics.passengerWeightedSumDelayMinutes,
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
          detourSumMinutes: detourMetrics.passengerWeightedSumDelayMinutes,
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
