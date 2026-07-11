const DEFAULT_EVALUATION_WEIGHTS = {
  rejectedBooking: 100000,
  hardViolation: 1000000,
  pickupWaitMinute: 2,
  desiredTimeDeviationMinute: 4,
  existingPassengerDelayMinute: 6,
  routeTravelMinute: 0.25,
  preferredVehicleMismatch: 30
};

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function timestamp(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.getTime() : null;
}

function mergeExpectations(defaults, booking) {
  return {
    ...(defaults && typeof defaults === "object" ? defaults : {}),
    ...(booking?.expectations && typeof booking.expectations === "object"
      ? booking.expectations
      : {})
  };
}

function desiredTimeDeviationMinutes(booking, result) {
  const desiredDropoff = timestamp(booking?.desiredDropoffAt);
  const desiredPickup = timestamp(booking?.desiredPickupAt);
  const plannedDropoff = timestamp(result?.simulation?.plannedDropoffAt);
  const plannedPickup = timestamp(result?.simulation?.plannedPickupAt);
  if (desiredDropoff !== null && plannedDropoff !== null) {
    return Math.abs(plannedDropoff - desiredDropoff) / (60 * 1000);
  }
  if (desiredPickup !== null && plannedPickup !== null) {
    return Math.abs(plannedPickup - desiredPickup) / (60 * 1000);
  }
  return 0;
}

function positiveExistingDelayMetrics(result) {
  const impacts = Array.isArray(result?.simulation?.impactedRequests)
    ? result.simulation.impactedRequests
    : [];
  let total = 0;
  let max = 0;
  for (const impact of impacts) {
    const pickup = Math.max(0, finiteNumber(impact?.pickupDeltaMinutes));
    const dropoff = Math.max(0, finiteNumber(impact?.dropoffDeltaMinutes));
    const delay = Math.max(pickup, dropoff);
    total += delay;
    max = Math.max(max, delay);
  }
  return { total, max };
}

function routePreferenceMetrics(result) {
  const route = Array.isArray(result?.simulation?.routeAfter) ? result.simulation.routeAfter : [];
  const newRequestId = result?.rideRequest?.id ?? null;
  const newPickupIndex = route.findIndex(
    (task) =>
      task?.type === "PICKUP" &&
      (task?.requestId === newRequestId || task?.requestLabel === "新規予約")
  );
  const existingDropoffIndexes = route
    .map((task, index) => ({ task, index }))
    .filter(
      ({ task }) =>
        task?.type === "DROPOFF" &&
        task?.requestId !== newRequestId &&
        task?.requestLabel !== "新規予約"
    )
    .map(({ index }) => index);
  let consecutivePickupPairs = 0;
  for (let index = 1; index < route.length; index += 1) {
    if (route[index - 1]?.type === "PICKUP" && route[index]?.type === "PICKUP") {
      consecutivePickupPairs += 1;
    }
  }
  return {
    hasExistingDropoff: existingDropoffIndexes.length > 0,
    existingDropoffBeforeNewPickup:
      newPickupIndex < 0 || existingDropoffIndexes.some((index) => index < newPickupIndex),
    consecutivePickupPairs
  };
}

function violation(code, message, details = {}) {
  return { code, message, ...details };
}

export function evaluateBookingOutcome({
  booking,
  result,
  defaultExpectations = {}
}) {
  const expectations = mergeExpectations(defaultExpectations, booking);
  const assigned = result?.status === "ASSIGNED" || result?.status === "ASSIGNABLE";
  const pickupWaitMinutes = assigned
    ? Math.max(0, finiteNumber(result?.simulation?.etaPickupMinutes))
    : 0;
  const deviationMinutes = assigned ? desiredTimeDeviationMinutes(booking, result) : 0;
  const existingDelay = positiveExistingDelayMetrics(result);
  const routePreferences = routePreferenceMetrics(result);
  const selectedVehicleId =
    result?.rideRequest?.assignment?.vehicleId ?? result?.simulation?.vehicleId ?? null;
  const preferredVehicleId = expectations.preferredVehicleId ?? booking?.preferredVehicleId ?? null;
  const preferredVehicleMismatch = Boolean(
    assigned && preferredVehicleId && selectedVehicleId !== preferredVehicleId
  );
  const violations = [];

  if (!assigned && expectations.mustAssign !== false) {
    violations.push(
      violation("MUST_ASSIGN", "予約を配車できませんでした。", {
        reason: result?.reason ?? result?.diagnostics?.summary ?? "NO_FEASIBLE_VEHICLE"
      })
    );
  }

  const maxPickupWaitMinutes = finiteNumber(
    expectations.maxPickupWaitMinutes ?? expectations.maxPickupDelayMinutes,
    Number.NaN
  );
  if (assigned && Number.isFinite(maxPickupWaitMinutes) && pickupWaitMinutes > maxPickupWaitMinutes) {
    violations.push(
      violation("MAX_PICKUP_WAIT", `乗車待ち時間が${maxPickupWaitMinutes}分を超えました。`, {
        expected: maxPickupWaitMinutes,
        actual: pickupWaitMinutes
      })
    );
  }

  const maxExistingDelayMinutes = finiteNumber(
    expectations.maxExistingPassengerDelayMinutes,
    Number.NaN
  );
  if (
    assigned &&
    Number.isFinite(maxExistingDelayMinutes) &&
    existingDelay.max > maxExistingDelayMinutes
  ) {
    violations.push(
      violation("MAX_EXISTING_DELAY", `既存乗客の遅延が${maxExistingDelayMinutes}分を超えました。`, {
        expected: maxExistingDelayMinutes,
        actual: existingDelay.max
      })
    );
  }

  const maxDesiredTimeDeviationMinutes = finiteNumber(
    expectations.maxDesiredTimeDeviationMinutes,
    Number.NaN
  );
  if (
    assigned &&
    Number.isFinite(maxDesiredTimeDeviationMinutes) &&
    deviationMinutes > maxDesiredTimeDeviationMinutes
  ) {
    violations.push(
      violation("MAX_TIME_DEVIATION", `希望時刻との差が${maxDesiredTimeDeviationMinutes}分を超えました。`, {
        expected: maxDesiredTimeDeviationMinutes,
        actual: deviationMinutes
      })
    );
  }

  if (preferredVehicleMismatch && expectations.preferredVehicleRequired === true) {
    violations.push(
      violation("PREFERRED_VEHICLE_REQUIRED", "必須指定された車両へ配車されませんでした。", {
        expected: preferredVehicleId,
        actual: selectedVehicleId
      })
    );
  }

  if (
    assigned &&
    expectations.dropoffExistingPassengersBeforeNewPickup === true &&
    routePreferences.hasExistingDropoff &&
    !routePreferences.existingDropoffBeforeNewPickup
  ) {
    violations.push(
      violation(
        "EXISTING_DROPOFF_BEFORE_NEW_PICKUP",
        "既存乗客を降ろす前に新しい乗車が挿入されました。"
      )
    );
  }

  const maxConsecutivePickups = finiteNumber(expectations.maxConsecutivePickups, Number.NaN);
  if (
    assigned &&
    Number.isFinite(maxConsecutivePickups) &&
    routePreferences.consecutivePickupPairs > maxConsecutivePickups
  ) {
    violations.push(
      violation("MAX_CONSECUTIVE_PICKUPS", "連続する乗車タスクが上限を超えました。", {
        expected: maxConsecutivePickups,
        actual: routePreferences.consecutivePickupPairs
      })
    );
  }

  return {
    assigned,
    selectedVehicleId,
    pickupWaitMinutes,
    desiredTimeDeviationMinutes: deviationMinutes,
    totalExistingPassengerDelayMinutes: existingDelay.total,
    maxExistingPassengerDelayMinutes: existingDelay.max,
    preferredVehicleMismatch,
    routePreferences,
    violations
  };
}

export function createEmptyMetrics() {
  return {
    totalBookings: 0,
    assignedBookings: 0,
    rejectedBookings: 0,
    hardViolationCount: 0,
    totalPickupWaitMinutes: 0,
    maxPickupWaitMinutes: 0,
    totalDesiredTimeDeviationMinutes: 0,
    totalExistingPassengerDelayMinutes: 0,
    maxExistingPassengerDelayMinutes: 0,
    preferredVehicleMismatchCount: 0,
    totalRouteTravelMinutes: 0,
    objectiveScore: 0
  };
}

export function addOutcomeToMetrics(metrics, outcome) {
  metrics.totalBookings += 1;
  metrics.assignedBookings += outcome.assigned ? 1 : 0;
  metrics.rejectedBookings += outcome.assigned ? 0 : 1;
  metrics.hardViolationCount += outcome.violations.length;
  metrics.totalPickupWaitMinutes += outcome.pickupWaitMinutes;
  metrics.maxPickupWaitMinutes = Math.max(
    metrics.maxPickupWaitMinutes,
    outcome.pickupWaitMinutes
  );
  metrics.totalDesiredTimeDeviationMinutes += outcome.desiredTimeDeviationMinutes;
  metrics.totalExistingPassengerDelayMinutes += outcome.totalExistingPassengerDelayMinutes;
  metrics.maxExistingPassengerDelayMinutes = Math.max(
    metrics.maxExistingPassengerDelayMinutes,
    outcome.maxExistingPassengerDelayMinutes
  );
  metrics.preferredVehicleMismatchCount += outcome.preferredVehicleMismatch ? 1 : 0;
  return metrics;
}

export function scoreMetrics(metrics, evaluationPolicy = {}) {
  const weights = {
    ...DEFAULT_EVALUATION_WEIGHTS,
    ...(evaluationPolicy?.weights ?? {})
  };
  const score =
    weights.rejectedBooking * metrics.rejectedBookings +
    weights.hardViolation * metrics.hardViolationCount +
    weights.pickupWaitMinute * metrics.totalPickupWaitMinutes +
    weights.desiredTimeDeviationMinute * metrics.totalDesiredTimeDeviationMinutes +
    weights.existingPassengerDelayMinute * metrics.totalExistingPassengerDelayMinutes +
    weights.routeTravelMinute * metrics.totalRouteTravelMinutes +
    weights.preferredVehicleMismatch * metrics.preferredVehicleMismatchCount;
  metrics.objectiveScore = Number(score.toFixed(6));
  metrics.assignmentRate = metrics.totalBookings
    ? Number((metrics.assignedBookings / metrics.totalBookings).toFixed(6))
    : 0;
  metrics.averagePickupWaitMinutes = metrics.assignedBookings
    ? Number((metrics.totalPickupWaitMinutes / metrics.assignedBookings).toFixed(6))
    : 0;
  return metrics;
}

export function mergeMetrics(target, source) {
  target.totalBookings += source.totalBookings;
  target.assignedBookings += source.assignedBookings;
  target.rejectedBookings += source.rejectedBookings;
  target.hardViolationCount += source.hardViolationCount;
  target.totalPickupWaitMinutes += source.totalPickupWaitMinutes;
  target.maxPickupWaitMinutes = Math.max(target.maxPickupWaitMinutes, source.maxPickupWaitMinutes);
  target.totalDesiredTimeDeviationMinutes += source.totalDesiredTimeDeviationMinutes;
  target.totalExistingPassengerDelayMinutes += source.totalExistingPassengerDelayMinutes;
  target.maxExistingPassengerDelayMinutes = Math.max(
    target.maxExistingPassengerDelayMinutes,
    source.maxExistingPassengerDelayMinutes
  );
  target.preferredVehicleMismatchCount += source.preferredVehicleMismatchCount;
  target.totalRouteTravelMinutes += source.totalRouteTravelMinutes;
  return target;
}

export function defaultEvaluationPolicy() {
  return {
    weights: { ...DEFAULT_EVALUATION_WEIGHTS },
    holdoutRegressionTolerance: 0.02
  };
}
