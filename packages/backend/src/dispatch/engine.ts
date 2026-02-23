import { findGreedyVehicle } from "./greedy.ts";
import {
  analyzeInsertionCandidateFailures,
  findBestInsertionAcrossVehicles,
  findBestInsertionPlan
} from "./insertion.ts";
import { selectCandidateByHighs } from "./highs.ts";
import { resolveRideRequestLocations } from "../location/resolver.ts";
import { estimateTravelMinutes } from "../../../shared/src/geo.ts";
import { createTravelEstimator } from "../routing/service.ts";

const DEFAULT_CRUISE_SPEED_KMH = 25;
const DEFAULT_ARRIVE_BY_EARLY_PICKUP_TOLERANCE_MINUTES = 10;
const DEFAULT_OPERATION_TIME_ZONE = "Asia/Tokyo";
const DISPATCH_ALGORITHMS = new Set(["INSERTION", "GREEDY", "HIGHS"]);

function normalizeDispatchAlgorithm(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toUpperCase();
  if (!DISPATCH_ALGORITHMS.has(normalized)) {
    return fallback;
  }
  return normalized;
}

function selectAlgorithm(serviceProfile) {
  return normalizeDispatchAlgorithm(serviceProfile?.dispatchPolicy?.algorithmPrimary, "INSERTION");
}

function selectFallbackAlgorithm(serviceProfile) {
  return normalizeDispatchAlgorithm(serviceProfile?.dispatchPolicy?.algorithmFallback, "GREEDY");
}

function buildDispatchRequest(rideRequest, resolvedLocations, now = new Date()) {
  const desiredPickupAt = normalizeDateInput(
    rideRequest?.timeWindow?.desiredPickupAt ?? rideRequest?.timeWindow?.scheduledAt
  );
  const desiredDropoffAt = normalizeDateInput(rideRequest?.timeWindow?.desiredDropoffAt);
  const requestType =
    typeof rideRequest?.timeWindow?.requestType === "string"
      ? rideRequest.timeWindow.requestType.trim().toUpperCase()
      : desiredDropoffAt
        ? "ARRIVE_BY"
        : "ASAP";
  return {
    id: rideRequest.id,
    partySize: rideRequest.partySize ?? 1,
    pickupPoint: resolvedLocations.pickup.resolvedPoint,
    dropoffPoint: resolvedLocations.dropoff.resolvedPoint,
    requestType,
    desiredPickupAt: desiredPickupAt?.toISOString() ?? null,
    desiredDropoffAt: desiredDropoffAt?.toISOString() ?? null,
    pickupNotBeforeAt: null,
    evaluationNowAt: now.toISOString()
  };
}

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

function resolveCruiseSpeedKmh(serviceProfile) {
  const speed = Number(serviceProfile?.dispatchPolicy?.cruiseSpeedKmh);
  if (!Number.isFinite(speed) || speed <= 0) {
    return DEFAULT_CRUISE_SPEED_KMH;
  }
  return Math.min(Math.max(speed, 1), 130);
}

function resolveArriveByEarlyPickupToleranceMinutes(serviceProfile) {
  return normalizeNonNegative(
    serviceProfile?.dispatchPolicy?.arriveByEarlyPickupToleranceMinutes,
    DEFAULT_ARRIVE_BY_EARLY_PICKUP_TOLERANCE_MINUTES
  );
}

function resolveTaskServiceMinutes(task, serviceProfile) {
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

function safeTravelMinutes(from, to, travelMinutes = defaultTravelMinutes) {
  if (!from || !to) {
    return 0;
  }
  const minutes = travelMinutes(from, to);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : 0;
}

function roundMinutes(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function resolveOperationTimeZone(operationPolicy) {
  const configured =
    typeof operationPolicy?.timeZone === "string" ? operationPolicy.timeZone.trim() : "";
  const candidate = configured || DEFAULT_OPERATION_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch (_error) {
    return DEFAULT_OPERATION_TIME_ZONE;
  }
}

function parseTimeZoneOffsetMinutes(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace("UTC", "GMT").trim();
  if (normalized === "GMT" || normalized === "GMT+0" || normalized === "GMT+00:00" || normalized === "GMT-0" || normalized === "GMT-00:00") {
    return 0;
  }
  const match = normalized.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) {
    return null;
  }
  const sign = match[1] === "-" ? -1 : 1;
  const hour = Number(match[2]);
  const minute = Number(match[3] ?? "0");
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return null;
  }
  return sign * (hour * 60 + minute);
}

function resolveTimeZoneOffsetMinutes(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(date);
    const zoneName = parts.find((part) => part.type === "timeZoneName")?.value ?? "";
    const parsed = parseTimeZoneOffsetMinutes(zoneName);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  } catch (_error) {
    // Fallback below.
  }

  const localized = new Date(date.toLocaleString("en-US", { timeZone }));
  if (Number.isNaN(localized.getTime())) {
    return 0;
  }
  return Math.round((localized.getTime() - date.getTime()) / (60 * 1000));
}

function extractTimeZoneDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const asNumber = (type, fallback = 0) => {
    const raw = parts.find((part) => part.type === type)?.value;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    year: asNumber("year", date.getUTCFullYear()),
    month: asNumber("month", date.getUTCMonth() + 1),
    day: asNumber("day", date.getUTCDate()),
    hour: asNumber("hour", date.getUTCHours()) % 24,
    minute: asNumber("minute", date.getUTCMinutes())
  };
}

function buildDateInTimeZone({ year, month, day, hour, minute }, timeZone) {
  const localAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let utcMs = localAsUtcMs;
  for (let i = 0; i < 3; i += 1) {
    const offsetMinutes = resolveTimeZoneOffsetMinutes(new Date(utcMs), timeZone);
    const adjustedUtcMs = localAsUtcMs - offsetMinutes * 60 * 1000;
    if (adjustedUtcMs === utcMs) {
      break;
    }
    utcMs = adjustedUtcMs;
  }
  return new Date(utcMs);
}

function formatLocalClock(date, timeZone = DEFAULT_OPERATION_TIME_ZONE) {
  const parts = extractTimeZoneDateParts(date, timeZone);
  return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

function parseLocalClockMinutes(value, fallbackMinutes) {
  if (typeof value !== "string") {
    return fallbackMinutes;
  }
  const [hourRaw, minuteRaw] = value.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return fallbackMinutes;
  }
  return hour * 60 + minute;
}

function buildLocalTimeDate(baseDate, minutesOfDay, timeZone = DEFAULT_OPERATION_TIME_ZONE) {
  const localParts = extractTimeZoneDateParts(baseDate, timeZone);
  const hour = Math.floor(minutesOfDay / 60);
  const minute = minutesOfDay % 60;
  return buildDateInTimeZone(
    {
      year: localParts.year,
      month: localParts.month,
      day: localParts.day,
      hour,
      minute
    },
    timeZone
  );
}

function resolveOfficePointFromPolicy(serviceProfile, vehicle = null) {
  const vehicleOfficePoint = isFinitePoint(vehicle?.officePoint)
    ? vehicle.officePoint
    : vehicle?.homeBase;
  if (isFinitePoint(vehicleOfficePoint)) {
    return {
      lat: Number(vehicleOfficePoint.lat),
      lng: Number(vehicleOfficePoint.lng)
    };
  }
  const officePoint = serviceProfile?.operationPolicy?.office?.point;
  if (isFinitePoint(officePoint)) {
    return {
      lat: Number(officePoint.lat),
      lng: Number(officePoint.lng)
    };
  }
  return null;
}

function resolveLunchBreakWindow(operationPolicy, baseDate) {
  const timeZone = resolveOperationTimeZone(operationPolicy);
  const lunchBreakConfigured =
    operationPolicy &&
    typeof operationPolicy === "object" &&
    operationPolicy.lunchBreak &&
    typeof operationPolicy.lunchBreak === "object"
      ? operationPolicy.lunchBreak
      : null;
  const lunchBreak = lunchBreakConfigured ?? {};
  const startMinutes = parseLocalClockMinutes(lunchBreak.startLocalTime, 11 * 60);
  const endMinutes = parseLocalClockMinutes(lunchBreak.endLocalTime, 12 * 60);
  const startAt = buildLocalTimeDate(baseDate, startMinutes, timeZone);
  const endAt = buildLocalTimeDate(baseDate, endMinutes, timeZone);
  if (endAt.getTime() <= startAt.getTime()) {
    endAt.setDate(endAt.getDate() + 1);
  }
  return {
    enabled: Boolean(lunchBreakConfigured) && lunchBreak.enabled !== false,
    timeZone,
    startMinutes,
    endMinutes,
    startAt,
    endAt,
    requireReturnToOffice: lunchBreak.requireReturnToOffice !== false,
    departFromOfficeAtEnd: lunchBreak.departFromOfficeAtEnd !== false
  };
}

function resolveBusinessHoursWindow(operationPolicy, baseDate) {
  const timeZone = resolveOperationTimeZone(operationPolicy);
  const businessHours = operationPolicy?.businessHours ?? {};
  const startMinutes = parseLocalClockMinutes(businessHours.startLocalTime, 8 * 60);
  const endMinutes = parseLocalClockMinutes(businessHours.endLocalTime, 18 * 60);
  const startAt = buildLocalTimeDate(baseDate, startMinutes, timeZone);
  const endAt = buildLocalTimeDate(baseDate, endMinutes, timeZone);
  if (endAt.getTime() <= startAt.getTime()) {
    endAt.setDate(endAt.getDate() + 1);
  }
  return {
    enabled: businessHours.enabled === true,
    timeZone,
    startMinutes,
    endMinutes,
    startAt,
    endAt,
    requireDepartFromOffice: businessHours.requireDepartFromOffice !== false,
    requireReturnToOffice: businessHours.requireReturnToOffice !== false
  };
}

function hasOperationPolicyConstraints(serviceProfile) {
  const operationPolicy = serviceProfile?.operationPolicy ?? {};
  const lunchBreakEnabled = resolveLunchBreakWindow(operationPolicy, new Date()).enabled;
  return (
    lunchBreakEnabled ||
    operationPolicy?.businessHours?.enabled === true
  );
}

function isWithinHalfOpenRange(timestampMs, startMs, endMs) {
  if (
    !Number.isFinite(timestampMs) ||
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs)
  ) {
    return false;
  }
  return timestampMs >= startMs && timestampMs < endMs;
}

function applyLunchBreakPickupNotBefore({
  requestForDispatch,
  serviceProfile,
  now,
  travelMinutes
}) {
  const operationPolicy = serviceProfile?.operationPolicy ?? {};
  const baseDate =
    normalizeDateInput(requestForDispatch?.desiredPickupAt) ??
    normalizeDateInput(requestForDispatch?.desiredDropoffAt) ??
    now;
  let lunchBreakWindow = resolveLunchBreakWindow(operationPolicy, baseDate);
  if (!lunchBreakWindow.enabled || !lunchBreakWindow.departFromOfficeAtEnd) {
    return requestForDispatch;
  }

  const expectedPickupAt = resolveOperationPolicyPickupAt({
    requestSummary: null,
    requestForDispatch,
    travelMinutes,
    serviceProfile
  });
  if (expectedPickupAt) {
    lunchBreakWindow = resolveLunchBreakWindow(operationPolicy, expectedPickupAt);
  }

  const startMs = lunchBreakWindow.startAt.getTime();
  const endMs = lunchBreakWindow.endAt.getTime();
  const pickupMs = expectedPickupAt?.getTime();
  const earlyPickupToleranceMinutes = resolveArriveByEarlyPickupToleranceMinutes(serviceProfile);
  const earlyPickupToleranceMs = earlyPickupToleranceMinutes * 60 * 1000;
  const shouldDelayPickup =
    isWithinHalfOpenRange(pickupMs, startMs, endMs) ||
    (!expectedPickupAt && isWithinHalfOpenRange(now.getTime(), startMs, endMs));
  const shouldClampEarlyPickupToBreakEnd =
    Number.isFinite(pickupMs) &&
    pickupMs >= endMs &&
    pickupMs - earlyPickupToleranceMs < endMs;

  if (!shouldDelayPickup && !shouldClampEarlyPickupToBreakEnd) {
    return requestForDispatch;
  }

  const desiredPickupAt = normalizeDateInput(requestForDispatch?.desiredPickupAt);
  const pickupNotBeforeAt = normalizeDateInput(requestForDispatch?.pickupNotBeforeAt);
  const enforcedPickupAt = shouldDelayPickup
    ? desiredPickupAt && desiredPickupAt.getTime() > endMs
      ? desiredPickupAt
      : lunchBreakWindow.endAt
    : desiredPickupAt;
  const enforcedPickupNotBeforeAt =
    pickupNotBeforeAt && pickupNotBeforeAt.getTime() > endMs
      ? pickupNotBeforeAt
      : lunchBreakWindow.endAt;

  return {
    ...requestForDispatch,
    desiredPickupAt: enforcedPickupAt?.toISOString() ?? requestForDispatch?.desiredPickupAt ?? null,
    pickupNotBeforeAt: enforcedPickupNotBeforeAt.toISOString()
  };
}

function resolveOperationPolicyPickupAt({
  requestSummary,
  requestForDispatch,
  travelMinutes,
  serviceProfile
}) {
  const plannedPickupAt = normalizeDateInput(requestSummary?.pickupEtaAt);
  let policyPickupAt = plannedPickupAt;

  const desiredPickupAt = normalizeDateInput(requestForDispatch?.desiredPickupAt);
  if (desiredPickupAt) {
    if (!policyPickupAt || desiredPickupAt.getTime() > policyPickupAt.getTime()) {
      policyPickupAt = desiredPickupAt;
    }
  }

  const desiredDropoffAt = normalizeDateInput(requestForDispatch?.desiredDropoffAt);
  if (desiredDropoffAt) {
    const rideMinutes = safeTravelMinutes(
      requestForDispatch?.pickupPoint,
      requestForDispatch?.dropoffPoint,
      travelMinutes
    );
    const pickupServiceMinutes = normalizeNonNegative(
      serviceProfile?.dispatchPolicy?.pickupServiceMinutes,
      0
    );
    const dropoffServiceMinutes = normalizeNonNegative(
      serviceProfile?.dispatchPolicy?.dropoffServiceMinutes,
      0
    );
    const offsetMinutes = Math.max(
      0,
      rideMinutes + pickupServiceMinutes + dropoffServiceMinutes
    );
    const estimatedPickupAt = new Date(desiredDropoffAt.getTime() - offsetMinutes * 60 * 1000);
    if (!policyPickupAt || estimatedPickupAt.getTime() > policyPickupAt.getTime()) {
      policyPickupAt = estimatedPickupAt;
    }
  }

  const pickupNotBeforeAt = normalizeDateInput(requestForDispatch?.pickupNotBeforeAt);
  if (pickupNotBeforeAt) {
    if (!policyPickupAt || pickupNotBeforeAt.getTime() > policyPickupAt.getTime()) {
      policyPickupAt = pickupNotBeforeAt;
    }
  }

  return policyPickupAt;
}

function buildOperationPolicyDiagnostics({
  violation,
  serviceProfile,
  officePoint,
  vehicle,
  route,
  now,
  requestSummary,
  requestForDispatch,
  travelMinutes
}) {
  const operationPolicy = serviceProfile?.operationPolicy ?? {};

  let completionAt = now;
  let completionPoint = vehicle.currentLocation;
  if (route.length) {
    const timeline = buildRouteTimeline({
      vehicle,
      route,
      now,
      travelMinutes,
      serviceProfile
    });
    const lastEntry = timeline.at(-1);
    if (lastEntry) {
      const lastArrival = normalizeDateInput(lastEntry.etaAt) ?? now;
      const serviceMinutes = resolveTaskServiceMinutes(lastEntry, serviceProfile);
      completionAt = new Date(lastArrival.getTime() + serviceMinutes * 60 * 1000);
      completionPoint = lastEntry.point ?? completionPoint;
    }
  }

  const officeArrivalAt = new Date(
    completionAt.getTime() + safeTravelMinutes(completionPoint, officePoint, travelMinutes) * 60 * 1000
  );
  const plannedPickupAt = normalizeDateInput(requestSummary?.pickupEtaAt);
  const policyPickupAt = resolveOperationPolicyPickupAt({
    requestSummary,
    requestForDispatch,
    travelMinutes,
    serviceProfile
  });
  const pickupAt = plannedPickupAt ?? policyPickupAt;
  const policyBaseDate = pickupAt ?? completionAt ?? now;
  const lunchBreakWindow = resolveLunchBreakWindow(operationPolicy, policyBaseDate);
  const businessHoursWindow = resolveBusinessHoursWindow(operationPolicy, policyBaseDate);
  const officeToPickupMinutes = safeTravelMinutes(
    officePoint,
    requestForDispatch.pickupPoint,
    travelMinutes
  );
  const officeDepartureAt =
    pickupAt
      ? new Date(pickupAt.getTime() - officeToPickupMinutes * 60 * 1000)
      : null;
  const earliestPickupFromOfficeAt = new Date(
    lunchBreakWindow.endAt.getTime() + officeToPickupMinutes * 60 * 1000
  );

  const details = {
    code: "OFFICE_BREAK_POLICY",
    type: violation.type,
    message: violation.message,
    officeArrivalAt: officeArrivalAt.toISOString(),
    breakStartAt: lunchBreakWindow.startAt.toISOString(),
    breakEndAt: lunchBreakWindow.endAt.toISOString(),
    businessStartAt: businessHoursWindow.startAt.toISOString(),
    businessEndAt: businessHoursWindow.endAt.toISOString(),
    pickupAt: pickupAt?.toISOString() ?? null,
    officeDepartureAt: officeDepartureAt?.toISOString() ?? null,
    earliestPickupFromOfficeAt: earliestPickupFromOfficeAt.toISOString(),
    officePoint
  };

  let countermeasure = "運行ポリシーに沿うよう、希望時刻か乗降地点を調整してください。";
  if (violation.type === "RETURN_BEFORE_BREAK") {
    countermeasure = `昼休憩開始(${formatLocalClock(lunchBreakWindow.startAt, lunchBreakWindow.timeZone)})までに事務所へ戻れるよう、希望時刻か乗降地点を調整してください。`;
  } else if (violation.type === "DEPART_AFTER_BREAK") {
    countermeasure = `昼休憩終了(${formatLocalClock(lunchBreakWindow.endAt, lunchBreakWindow.timeZone)})に事務所を出発しても乗車時刻に間に合いません。希望時刻か乗車地点を調整してください。`;
  } else if (violation.type === "PICKUP_DURING_BREAK") {
    countermeasure = `昼休憩時間帯(${formatLocalClock(lunchBreakWindow.startAt, lunchBreakWindow.timeZone)}-${formatLocalClock(lunchBreakWindow.endAt, lunchBreakWindow.timeZone)})の予約は、休憩終了後の時刻で再試算してください。`;
  } else if (violation.type === "DEPART_BEFORE_BUSINESS_HOURS") {
    countermeasure = `営業時間開始(${formatLocalClock(businessHoursWindow.startAt, businessHoursWindow.timeZone)})以降の事務所出発で間に合うよう、希望時刻か乗車地点を調整してください。`;
  } else if (violation.type === "RETURN_AFTER_BUSINESS_HOURS") {
    countermeasure = `営業時間終了(${formatLocalClock(businessHoursWindow.endAt, businessHoursWindow.timeZone)})までに事務所へ戻れるよう、希望時刻か降車地点を調整してください。`;
  }

  return {
    summary: violation.message,
    candidateCount: 1,
    feasibleCount: 0,
    rejectionCounts: {
      OFFICE_BREAK_POLICY: 1
    },
    constraints: {
      lunchBreakEnabled: lunchBreakWindow.enabled,
      lunchBreakStartLocalTime: `${pad2(Math.floor(lunchBreakWindow.startMinutes / 60))}:${pad2(lunchBreakWindow.startMinutes % 60)}`,
      lunchBreakEndLocalTime: `${pad2(Math.floor(lunchBreakWindow.endMinutes / 60))}:${pad2(lunchBreakWindow.endMinutes % 60)}`,
      requireReturnToOffice: lunchBreakWindow.requireReturnToOffice,
      departFromOfficeAtEnd: lunchBreakWindow.departFromOfficeAtEnd,
      businessHoursEnabled: businessHoursWindow.enabled,
      businessHoursStartLocalTime: `${pad2(Math.floor(businessHoursWindow.startMinutes / 60))}:${pad2(businessHoursWindow.startMinutes % 60)}`,
      businessHoursEndLocalTime: `${pad2(Math.floor(businessHoursWindow.endMinutes / 60))}:${pad2(businessHoursWindow.endMinutes % 60)}`,
      requireDepartFromOfficeInBusinessHours: businessHoursWindow.requireDepartFromOffice,
      requireReturnToOfficeInBusinessHours: businessHoursWindow.requireReturnToOffice
    },
    observed: {
      officeArrivalAt: officeArrivalAt.toISOString(),
      breakStartAt: lunchBreakWindow.startAt.toISOString(),
      breakEndAt: lunchBreakWindow.endAt.toISOString(),
      businessStartAt: businessHoursWindow.startAt.toISOString(),
      businessEndAt: businessHoursWindow.endAt.toISOString(),
      pickupAt: pickupAt?.toISOString() ?? null,
      officeDepartureAt: officeDepartureAt?.toISOString() ?? null,
      earliestPickupFromOfficeAt: earliestPickupFromOfficeAt.toISOString()
    },
    countermeasureCandidates: [countermeasure],
    breakdown: [
      {
        code: "OFFICE_BREAK_POLICY",
        count: 1,
        ratioPercent: 100
      }
    ],
    details
  };
}

function evaluateOperationPolicyForPlan({
  serviceProfile,
  vehicle,
  route,
  requestForDispatch,
  requestSummary,
  now,
  travelMinutes
}) {
  const operationPolicy = serviceProfile?.operationPolicy ?? {};
  const lunchBreakEnabled = resolveLunchBreakWindow(operationPolicy, now).enabled;
  const businessHoursEnabled = operationPolicy?.businessHours?.enabled === true;
  if (!lunchBreakEnabled && !businessHoursEnabled) {
    return null;
  }

  const officePoint = resolveOfficePointFromPolicy(serviceProfile, vehicle);
  if (!officePoint) {
    return null;
  }

  let completionAt = now;
  let completionPoint = vehicle.currentLocation;
  if (route.length) {
    const timeline = buildRouteTimeline({
      vehicle,
      route,
      now,
      travelMinutes,
      serviceProfile
    });
    const lastEntry = timeline.at(-1);
    if (lastEntry) {
      const lastArrival = normalizeDateInput(lastEntry.etaAt) ?? now;
      const serviceMinutes = resolveTaskServiceMinutes(lastEntry, serviceProfile);
      completionAt = new Date(lastArrival.getTime() + serviceMinutes * 60 * 1000);
      completionPoint = lastEntry.point ?? completionPoint;
    }
  }

  const officeArrivalAt = new Date(
    completionAt.getTime() + safeTravelMinutes(completionPoint, officePoint, travelMinutes) * 60 * 1000
  );
  const plannedPickupAt = normalizeDateInput(requestSummary?.pickupEtaAt);
  const policyPickupAt = resolveOperationPolicyPickupAt({
    requestSummary,
    requestForDispatch,
    travelMinutes,
    serviceProfile
  });
  const pickupAt = plannedPickupAt ?? policyPickupAt;
  const policyBaseDate = pickupAt ?? completionAt ?? now;
  const lunchBreakWindow = resolveLunchBreakWindow(operationPolicy, policyBaseDate);
  const businessHoursWindow = resolveBusinessHoursWindow(operationPolicy, policyBaseDate);
  const pickupAtMs = pickupAt?.getTime();
  const breakStartMs = lunchBreakWindow.startAt.getTime();
  const breakEndMs = lunchBreakWindow.endAt.getTime();

  if (
    lunchBreakWindow.enabled &&
    isWithinHalfOpenRange(pickupAtMs, breakStartMs, breakEndMs)
  ) {
    return {
      type: "PICKUP_DURING_BREAK",
      message: `昼休憩時間帯(${formatLocalClock(lunchBreakWindow.startAt, lunchBreakWindow.timeZone)}-${formatLocalClock(lunchBreakWindow.endAt, lunchBreakWindow.timeZone)})の乗車予定となるため、予約を受け付けできません。`,
      officePoint
    };
  }

  if (businessHoursWindow.enabled) {
    const officeToPickupMinutes = safeTravelMinutes(
      officePoint,
      requestForDispatch.pickupPoint,
      travelMinutes
    );
    const officeDepartureAt =
      pickupAt
        ? new Date(pickupAt.getTime() - officeToPickupMinutes * 60 * 1000)
        : null;

    if (
      businessHoursWindow.requireDepartFromOffice &&
      officeDepartureAt &&
      officeDepartureAt.getTime() < businessHoursWindow.startAt.getTime()
    ) {
      return {
        type: "DEPART_BEFORE_BUSINESS_HOURS",
        message: `営業時間開始(${formatLocalClock(businessHoursWindow.startAt, businessHoursWindow.timeZone)})より前に事務所を出発する必要があるため、予約を受け付けできません。`,
        officePoint
      };
    }

    if (
      businessHoursWindow.requireReturnToOffice &&
      officeArrivalAt.getTime() > businessHoursWindow.endAt.getTime()
    ) {
      return {
        type: "RETURN_AFTER_BUSINESS_HOURS",
        message: `営業時間終了(${formatLocalClock(businessHoursWindow.endAt, businessHoursWindow.timeZone)})までに事務所へ戻れないため、予約を受け付けできません。`,
        officePoint
      };
    }
  }

  const isAfternoonPickup =
    pickupAt && pickupAt.getTime() >= lunchBreakWindow.endAt.getTime();

  if (
    lunchBreakWindow.enabled &&
    lunchBreakWindow.requireReturnToOffice &&
    !isAfternoonPickup &&
    officeArrivalAt.getTime() > lunchBreakWindow.startAt.getTime()
  ) {
    return {
      type: "RETURN_BEFORE_BREAK",
      message: `昼休憩開始(${formatLocalClock(lunchBreakWindow.startAt, lunchBreakWindow.timeZone)})までに事務所へ戻れないため、予約を受け付けできません。`,
      officePoint
    };
  }

  if (
    lunchBreakWindow.enabled &&
    lunchBreakWindow.departFromOfficeAtEnd &&
    pickupAt &&
    pickupAt.getTime() >= lunchBreakWindow.endAt.getTime()
  ) {
    const officeToPickupMinutes = safeTravelMinutes(
      officePoint,
      requestForDispatch.pickupPoint,
      travelMinutes
    );
    const earliestPickupFromOffice = new Date(
      lunchBreakWindow.endAt.getTime() + officeToPickupMinutes * 60 * 1000
    );
    if (earliestPickupFromOffice.getTime() > pickupAt.getTime()) {
      return {
        type: "DEPART_AFTER_BREAK",
        message: `昼休憩終了(${formatLocalClock(lunchBreakWindow.endAt, lunchBreakWindow.timeZone)})に事務所を出発しても乗車時刻に間に合わないため、予約を受け付けできません。`,
        officePoint
      };
    }
  }

  return null;
}

function buildRouteTimeline({
  vehicle,
  route,
  now,
  travelMinutes = defaultTravelMinutes,
  serviceProfile = null
}) {
  let current = vehicle.currentLocation;
  let elapsed = 0;
  let onboard = vehicle.onboardCount ?? 0;

  return route.map((task, index) => {
    const segmentMinutes = safeTravelMinutes(current, task.point, travelMinutes);
    elapsed += segmentMinutes;
    const notBeforeAt = normalizeDateInput(task?.notBeforeAt);
    let waitBeforeTaskMinutes = 0;
    if (notBeforeAt) {
      const notBeforeEtaMinutes = (notBeforeAt.getTime() - now.getTime()) / (60 * 1000);
      if (Number.isFinite(notBeforeEtaMinutes) && notBeforeEtaMinutes > elapsed) {
        waitBeforeTaskMinutes = notBeforeEtaMinutes - elapsed;
        elapsed = notBeforeEtaMinutes;
      }
    }
    onboard += task.loadChange ?? 0;
    current = task.point;

    const entry = {
      sequence: index + 1,
      type: task.type,
      requestId: task.requestId ?? null,
      point: task.point,
      loadChange: task.loadChange ?? 0,
      segmentMinutes: roundMinutes(segmentMinutes),
      waitBeforeTaskMinutes: roundMinutes(waitBeforeTaskMinutes),
      etaMinutes: roundMinutes(elapsed),
      etaAt: new Date(now.getTime() + elapsed * 60 * 1000).toISOString(),
      onboardAfterTask: onboard
    };

    elapsed += resolveTaskServiceMinutes(task, serviceProfile);
    return entry;
  });
}

function summarizeTimelineByRequest(timeline) {
  const index = new Map();

  for (const task of timeline) {
    if (!task.requestId) {
      continue;
    }
    if (!index.has(task.requestId)) {
      index.set(task.requestId, {
        pickupEtaMinutes: null,
        pickupEtaAt: null,
        dropoffEtaMinutes: null,
        dropoffEtaAt: null
      });
    }

    const summary = index.get(task.requestId);
    if (task.type === "PICKUP" && summary.pickupEtaMinutes === null) {
      summary.pickupEtaMinutes = task.etaMinutes;
      summary.pickupEtaAt = task.etaAt;
    } else if (task.type === "DROPOFF" && summary.dropoffEtaMinutes === null) {
      summary.dropoffEtaMinutes = task.etaMinutes;
      summary.dropoffEtaAt = task.etaAt;
    }
  }

  return index;
}

function buildDesiredDropoffSuggestion({
  requestForDispatch,
  requestSummary
}) {
  const desiredDropoffAt = normalizeDateInput(requestForDispatch?.desiredDropoffAt);
  const plannedDropoffAt = normalizeDateInput(requestSummary?.dropoffEtaAt);
  if (!desiredDropoffAt || !plannedDropoffAt) {
    return null;
  }

  const exceededByMinutes = roundMinutes(
    (plannedDropoffAt.getTime() - desiredDropoffAt.getTime()) / (60 * 1000)
  );
  if (!Number.isFinite(exceededByMinutes) || exceededByMinutes <= 0) {
    return null;
  }

  return {
    requestedDropoffAt: desiredDropoffAt.toISOString(),
    suggestedDropoffAt: plannedDropoffAt.toISOString(),
    exceededByMinutes,
    message: `希望降車時刻を約${Math.round(exceededByMinutes)}分超過します。${formatLocalClock(plannedDropoffAt)}頃の降車であれば受付可能です。`
  };
}

function resolveLocationLabel(location, stopIndex) {
  if (!location) {
    return "地点";
  }
  const customTitle = typeof location.title === "string" ? location.title.trim() : "";
  if (customTitle) {
    return customTitle;
  }
  if (location.stopId && stopIndex.has(location.stopId)) {
    return stopIndex.get(location.stopId).name;
  }
  if (location.resolvedAs === "VIRTUAL_STOP") {
    return "仮想停留所";
  }
  if (location.mode === "FREE_POINT" || location.resolvedAs === "FREE_POINT") {
    return "自由地点";
  }
  return "地点";
}

function buildRequestLabel(rideRequest) {
  const passengerName =
    typeof rideRequest?.passenger?.name === "string" ? rideRequest.passenger.name.trim() : "";
  return passengerName || rideRequest?.id || "予約";
}

function getTaskLocation({
  task,
  rideRequest,
  resolvedLocations,
  requestLookup
}) {
  if (task.requestId === rideRequest.id && resolvedLocations) {
    return task.type === "PICKUP"
      ? {
          ...rideRequest.pickup,
          stopId: resolvedLocations.pickup.stopId ?? rideRequest.pickup?.stopId,
          resolvedAs: resolvedLocations.pickup.resolvedAs,
          resolvedPoint: resolvedLocations.pickup.resolvedPoint
        }
      : {
          ...rideRequest.dropoff,
          stopId: resolvedLocations.dropoff.stopId ?? rideRequest.dropoff?.stopId,
          resolvedAs: resolvedLocations.dropoff.resolvedAs,
          resolvedPoint: resolvedLocations.dropoff.resolvedPoint
        };
  }

  const existingRequest = requestLookup.get(task.requestId);
  if (!existingRequest) {
    return null;
  }
  return task.type === "PICKUP" ? existingRequest.pickup : existingRequest.dropoff;
}

function decorateTimeline({
  timeline,
  rideRequest,
  resolvedLocations,
  requestLookup,
  stopIndex
}) {
  return timeline.map((task) => {
    const location = getTaskLocation({ task, rideRequest, resolvedLocations, requestLookup });
    const requestMeta = task.requestId ? requestLookup.get(task.requestId) : null;
    return {
      ...task,
      locationLabel: resolveLocationLabel(location, stopIndex),
      requestLabel:
        task.requestId === rideRequest.id
          ? "新規予約"
          : buildRequestLabel(requestMeta ?? { id: task.requestId })
    };
  });
}

function deltaMinutes(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) {
    return null;
  }
  return roundMinutes(after - before);
}

function buildImpactSummary({ beforeSummary, afterSummary, rideRequest, requestLookup }) {
  const requestIds = new Set([...beforeSummary.keys(), ...afterSummary.keys()]);
  requestIds.delete(rideRequest.id);

  const impacts = [];
  for (const requestId of requestIds) {
    const before = beforeSummary.get(requestId) ?? {};
    const after = afterSummary.get(requestId) ?? {};
    const request = requestLookup.get(requestId);

    const pickupDelta = deltaMinutes(before.pickupEtaMinutes, after.pickupEtaMinutes);
    const dropoffDelta = deltaMinutes(before.dropoffEtaMinutes, after.dropoffEtaMinutes);

    impacts.push({
      requestId,
      status: request?.status ?? "UNKNOWN",
      passengerName:
        typeof request?.passenger?.name === "string" ? request.passenger.name.trim() : "",
      pickupBeforeMinutes: before.pickupEtaMinutes ?? null,
      pickupAfterMinutes: after.pickupEtaMinutes ?? null,
      pickupBeforeAt: before.pickupEtaAt ?? null,
      pickupAfterAt: after.pickupEtaAt ?? null,
      pickupDeltaMinutes: pickupDelta,
      dropoffBeforeMinutes: before.dropoffEtaMinutes ?? null,
      dropoffAfterMinutes: after.dropoffEtaMinutes ?? null,
      dropoffBeforeAt: before.dropoffEtaAt ?? null,
      dropoffAfterAt: after.dropoffEtaAt ?? null,
      dropoffDeltaMinutes: dropoffDelta,
      changed: pickupDelta !== null || dropoffDelta !== null
    });
  }

  impacts.sort((left, right) => {
    const leftDelta = Math.max(
      Math.abs(left.pickupDeltaMinutes ?? 0),
      Math.abs(left.dropoffDeltaMinutes ?? 0)
    );
    const rightDelta = Math.max(
      Math.abs(right.pickupDeltaMinutes ?? 0),
      Math.abs(right.dropoffDeltaMinutes ?? 0)
    );
    return rightDelta - leftDelta;
  });

  return impacts;
}

function collectRouteTravelPoints(vehicle) {
  const points = [];
  if (isFinitePoint(vehicle?.currentLocation)) {
    points.push(vehicle.currentLocation);
  }
  for (const task of vehicle?.route ?? []) {
    if (isFinitePoint(task?.point)) {
      points.push(task.point);
    }
  }
  return points;
}

function collectDispatchTravelPoints({ vehicles, requestForDispatch }) {
  const points = [];
  for (const vehicle of vehicles) {
    points.push(...collectRouteTravelPoints(vehicle));
  }
  if (isFinitePoint(requestForDispatch?.pickupPoint)) {
    points.push(requestForDispatch.pickupPoint);
  }
  if (isFinitePoint(requestForDispatch?.dropoffPoint)) {
    points.push(requestForDispatch.dropoffPoint);
  }
  return points;
}

function resolveHighsTimeLimitSeconds(serviceProfile) {
  const configured = Number(serviceProfile?.dispatchPolicy?.highs?.timeLimitSec);
  if (!Number.isFinite(configured) || configured <= 0) {
    return 0.5;
  }
  return Math.min(Math.max(configured, 0.05), 10);
}

function isActiveVehicle(vehicle) {
  const status = typeof vehicle?.status === "string" ? vehicle.status.trim().toUpperCase() : "";
  return status === "ACTIVE";
}

function resolveHighsComplexityPolicy(serviceProfile) {
  const highsPolicy = serviceProfile?.dispatchPolicy?.highs ?? {};
  return {
    enabledForComplex: highsPolicy.enabledForComplex !== false,
    minExistingRouteTasks: normalizeNonNegativeInteger(highsPolicy.minExistingRouteTasks, 4),
    minCandidateCount: normalizeNonNegativeInteger(highsPolicy.minCandidateCount, 10),
    minActiveVehicles: normalizeNonNegativeInteger(highsPolicy.minActiveVehicles, 2)
  };
}

function estimateInsertionCandidateCount(routeTaskCount) {
  const n = normalizeNonNegativeInteger(routeTaskCount, 0);
  return ((n + 1) * (n + 2)) / 2;
}

function shouldPreferHighsByComplexity({ vehicles, serviceProfile }) {
  const policy = resolveHighsComplexityPolicy(serviceProfile);
  if (!policy.enabledForComplex) {
    return false;
  }

  const limit = normalizeNonNegativeInteger(
    serviceProfile?.dispatchPolicy?.candidateVehicleLimit,
    vehicles.length
  );
  const inspectedVehicles = limit > 0 ? vehicles.slice(0, limit) : [];
  const activeVehicles = inspectedVehicles.filter((vehicle) => isActiveVehicle(vehicle));
  if (activeVehicles.length < policy.minActiveVehicles) {
    return false;
  }

  const totalExistingRouteTasks = activeVehicles.reduce((sum, vehicle) => {
    const route = Array.isArray(vehicle?.route) ? vehicle.route : [];
    return sum + route.length;
  }, 0);
  const estimatedCandidateCount = activeVehicles.reduce((sum, vehicle) => {
    const route = Array.isArray(vehicle?.route) ? vehicle.route : [];
    return sum + estimateInsertionCandidateCount(route.length);
  }, 0);

  return (
    totalExistingRouteTasks >= policy.minExistingRouteTasks ||
    estimatedCandidateCount >= policy.minCandidateCount
  );
}

function collectInsertionCandidatesAcrossVehicles({
  requestForDispatch,
  vehicles,
  serviceProfile,
  travelMinutes
}) {
  const limit = normalizeNonNegativeInteger(
    serviceProfile?.dispatchPolicy?.candidateVehicleLimit,
    30
  );
  let inspected = 0;
  const candidates = [];

  for (const vehicle of vehicles) {
    if (inspected >= limit) {
      break;
    }
    const plan = findBestInsertionPlan({
      vehicle,
      request: requestForDispatch,
      serviceProfile,
      travelMinutes
    });
    inspected += 1;
    if (plan) {
      candidates.push(plan);
    }
  }

  return candidates;
}

function selectBestInsertionCandidate(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return null;
  }
  let best = null;
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (!best || Number(candidate.score) < Number(best.score)) {
      best = candidate;
    }
  }
  return best;
}

async function findBestPlanByAlgorithm({
  algorithm,
  requestForDispatch,
  vehicles,
  serviceProfile,
  travelMinutes
}) {
  if (algorithm === "INSERTION") {
    return findBestInsertionAcrossVehicles({
      request: requestForDispatch,
      vehicles,
      serviceProfile,
      travelMinutes
    });
  }
  if (algorithm === "GREEDY") {
    return findGreedyVehicle({
      request: requestForDispatch,
      vehicles,
      serviceProfile,
      travelMinutes
    });
  }
  if (algorithm !== "HIGHS") {
    return null;
  }

  const insertionCandidates = collectInsertionCandidatesAcrossVehicles({
    requestForDispatch,
    vehicles,
    serviceProfile,
    travelMinutes
  });
  if (!insertionCandidates.length) {
    return null;
  }

  try {
    const selectedByHighs = await selectCandidateByHighs({
      candidates: insertionCandidates,
      timeLimitSeconds: resolveHighsTimeLimitSeconds(serviceProfile)
    });
    if (selectedByHighs) {
      return {
        ...selectedByHighs,
        selectedAlgorithm: "HIGHS"
      };
    }
  } catch (_error) {
    // Fallback below.
  }

  const insertionFallback = selectBestInsertionCandidate(insertionCandidates);
  if (!insertionFallback) {
    return null;
  }
  return {
    ...insertionFallback,
    selectedAlgorithm: "INSERTION",
    algorithmPhase: "FALLBACK"
  };
}

function annotatePlanWithDispatchAlgorithm({
  plan,
  selectedAlgorithm,
  algorithmPhase,
  primaryAlgorithm,
  fallbackAlgorithm
}) {
  if (!plan) {
    return null;
  }
  return {
    ...plan,
    selectedAlgorithm: plan.selectedAlgorithm ?? selectedAlgorithm,
    algorithmPhase: plan.algorithmPhase ?? algorithmPhase,
    primaryAlgorithm,
    fallbackAlgorithm
  };
}

async function chooseBestPlan({ requestForDispatch, vehicles, serviceProfile, travelMinutes }) {
  const primary = selectAlgorithm(serviceProfile);
  const fallback = selectFallbackAlgorithm(serviceProfile);
  const forceHighsForComplex =
    primary !== "HIGHS" &&
    shouldPreferHighsByComplexity({
      vehicles,
      serviceProfile
    });

  const attempts = [];
  if (forceHighsForComplex) {
    attempts.push({
      algorithm: "HIGHS",
      phase: "COMPLEX_OR"
    });
  }
  attempts.push({
    algorithm: primary,
    phase: "PRIMARY"
  });
  if (fallback !== primary) {
    attempts.push({
      algorithm: fallback,
      phase: "FALLBACK"
    });
  }

  const attemptedAlgorithms = new Set();
  for (const attempt of attempts) {
    if (attemptedAlgorithms.has(attempt.algorithm)) {
      continue;
    }
    attemptedAlgorithms.add(attempt.algorithm);

    const planRaw = await findBestPlanByAlgorithm({
      algorithm: attempt.algorithm,
      requestForDispatch,
      vehicles,
      serviceProfile,
      travelMinutes
    });
    const plan = annotatePlanWithDispatchAlgorithm({
      plan: planRaw,
      selectedAlgorithm: attempt.algorithm,
      algorithmPhase: attempt.phase,
      primaryAlgorithm: primary,
      fallbackAlgorithm: fallback
    });
    if (plan) {
      return plan;
    }
  }

  return null;
}

const INSERTION_REJECTION_KEYS = [
  "CONSECUTIVE_PICKUP",
  "CAPACITY",
  "MAX_WAIT",
  "MAX_DETOUR",
  "MAX_ADDITIONAL_STOPS",
  "RESERVATION_WINDOW"
];

function createInsertionRejectionCounts() {
  return {
    CONSECUTIVE_PICKUP: 0,
    CAPACITY: 0,
    MAX_WAIT: 0,
    MAX_DETOUR: 0,
    MAX_ADDITIONAL_STOPS: 0,
    RESERVATION_WINDOW: 0
  };
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.trunc(numeric));
}

function minFinite(current, next) {
  if (!Number.isFinite(next)) {
    return current;
  }
  if (!Number.isFinite(current)) {
    return next;
  }
  return Math.min(current, next);
}

function summarizeVehicleStatuses(vehicles) {
  const statusCounts = {};
  for (const vehicle of vehicles) {
    const status =
      typeof vehicle?.status === "string" && vehicle.status.trim()
        ? vehicle.status.trim().toUpperCase()
        : "UNKNOWN";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }
  return statusCounts;
}

function resolveCandidateVehicleLimit(serviceProfile, vehicleCount) {
  const configured = normalizeNonNegativeInteger(
    serviceProfile?.dispatchPolicy?.candidateVehicleLimit,
    vehicleCount
  );
  return configured;
}

function pushCandidateSuggestion(suggestions, message) {
  if (typeof message !== "string" || !message.trim()) {
    return;
  }
  if (!suggestions.includes(message)) {
    suggestions.push(message);
  }
}

function summarizeNoFeasibleOutcome({
  totalVehicleCount,
  inspectedVehicleCount,
  activeVehicleCount,
  candidateCount,
  feasibleCount
}) {
  if (totalVehicleCount === 0) {
    return "候補車両が存在しないため、予約を受け付けできません。";
  }
  if (inspectedVehicleCount === 0) {
    return "候補車両の探索対象が0台のため、予約を受け付けできません。";
  }
  if (activeVehicleCount === 0) {
    return "探索対象の車両がすべて稼働停止中のため、予約を受け付けできません。";
  }
  if (candidateCount === 0) {
    return "候補ルートを生成できないため、予約を受け付けできません。";
  }
  if (feasibleCount === 0) {
    return `${candidateCount}件の候補ルートを評価しましたが、すべて制約で除外されました。`;
  }
  return "候補ルートの評価で条件を満たす案が見つかりませんでした。";
}

function buildCountermeasureCandidates({
  diagnostics,
  rejectionCounts
}) {
  const candidates = [];
  const {
    totalVehicleCount,
    inspectedVehicleCount,
    activeVehicleCount,
    skippedVehicleCount,
    constraints,
    observed
  } = diagnostics;

  if (totalVehicleCount === 0) {
    pushCandidateSuggestion(
      candidates,
      "稼働可能な車両を追加するか、車両フィルタ条件を見直してください。"
    );
  }
  if (inspectedVehicleCount === 0 && totalVehicleCount > 0) {
    pushCandidateSuggestion(
      candidates,
      "候補車両上限が0台です。candidateVehicleLimit を1以上に設定して再試算してください。"
    );
  }
  if (activeVehicleCount === 0 && inspectedVehicleCount > 0) {
    pushCandidateSuggestion(
      candidates,
      "探索対象車両を ACTIVE に変更するか、ACTIVE車両を追加してください。"
    );
  }
  if (skippedVehicleCount > 0) {
    pushCandidateSuggestion(
      candidates,
      `候補車両上限(${constraints.candidateVehicleLimit}台)により${skippedVehicleCount}台が探索対象外です。上限の拡大を検討してください。`
    );
  }
  if (rejectionCounts.MAX_WAIT > 0) {
    const minEta = observed.minEtaPickupMinutes;
    const maxWait = constraints.maxWaitMinutes;
    if (Number.isFinite(minEta) && Number.isFinite(maxWait)) {
      pushCandidateSuggestion(
        candidates,
        `最短乗車到達は約${Math.round(minEta)}分です。希望時刻調整または maxWaitMinutes(${Math.round(maxWait)}分) の見直しを検討してください。`
      );
    } else {
      pushCandidateSuggestion(
        candidates,
        "乗車待ち時間制約により除外されています。希望時刻調整または maxWaitMinutes の見直しを検討してください。"
      );
    }
  }
  if (rejectionCounts.MAX_DETOUR > 0) {
    const minDetour = observed.minDetourMinutes;
    const maxDetour = constraints.maxDetourMinutes;
    if (Number.isFinite(minDetour) && Number.isFinite(maxDetour)) {
      pushCandidateSuggestion(
        candidates,
        `既存予約への最小遅延は約${Math.round(minDetour)}分です。乗降地点の見直し、または maxDetourMinutes(${Math.round(maxDetour)}分) の調整を検討してください。`
      );
    } else {
      pushCandidateSuggestion(
        candidates,
        "既存予約への遅延制約で除外されています。乗降地点または maxDetourMinutes の見直しを検討してください。"
      );
    }
  }
  if (rejectionCounts.CAPACITY > 0) {
    pushCandidateSuggestion(
      candidates,
      `同時乗車人数制約で除外されています。partySize の調整、または maxOnboardPerVehicle(${constraints.maxOnboardPerVehicle}人) の見直しを検討してください。`
    );
  }
  if (rejectionCounts.MAX_ADDITIONAL_STOPS > 0) {
    pushCandidateSuggestion(
      candidates,
      `追加停留所制約で除外されています。maxAdditionalStops(${constraints.maxAdditionalStops}) の見直しを検討してください。`
    );
  }
  if (rejectionCounts.CONSECUTIVE_PICKUP > 0) {
    pushCandidateSuggestion(
      candidates,
      "既存ルート構成では降車前に連続乗車が発生します。先行予約完了後に再試算するか、乗車地点・時刻の変更を検討してください。"
    );
  }
  if (rejectionCounts.RESERVATION_WINDOW > 0) {
    pushCandidateSuggestion(
      candidates,
      "予約対象日が異なるタスクを同じ便に混在させないよう除外されています。予約日を確認して再試算してください。"
    );
  }
  if (!candidates.length) {
    pushCandidateSuggestion(
      candidates,
      "車両現在地を更新して再試算し、必要に応じて配車制約値を見直してください。"
    );
  }

  return candidates.slice(0, 6);
}

function buildNoFeasibleDiagnostics({
  vehicles,
  requestForDispatch,
  serviceProfile,
  travelMinutes = defaultTravelMinutes
}) {
  const candidateVehicleLimit = resolveCandidateVehicleLimit(serviceProfile, vehicles.length);
  const inspectedVehicles =
    candidateVehicleLimit > 0 ? vehicles.slice(0, candidateVehicleLimit) : [];

  const rejectionCounts = createInsertionRejectionCounts();
  let candidateCount = 0;
  let feasibleCount = 0;
  let minEtaPickupMinutes = null;
  let minDetourMinutes = null;

  const perVehicle = inspectedVehicles.map((vehicle) => {
    const analysis = analyzeInsertionCandidateFailures({
      vehicle,
      request: requestForDispatch,
      serviceProfile,
      travelMinutes
    });
    candidateCount += analysis.candidateCount;
    feasibleCount += analysis.feasibleCount;
    minEtaPickupMinutes = minFinite(minEtaPickupMinutes, analysis.minEtaPickupMinutes);
    minDetourMinutes = minFinite(minDetourMinutes, analysis.minDetourMinutes);

    for (const key of INSERTION_REJECTION_KEYS) {
      rejectionCounts[key] += analysis.rejectionCounts[key] ?? 0;
    }
    return analysis;
  });

  const activeVehicleCount = inspectedVehicles.filter((vehicle) => {
    const status = typeof vehicle?.status === "string" ? vehicle.status.trim().toUpperCase() : "";
    return status === "ACTIVE";
  }).length;
  const skippedVehicleCount = Math.max(0, vehicles.length - inspectedVehicles.length);
  const diagnostics = {
    algorithmPrimary: selectAlgorithm(serviceProfile),
    algorithmFallback: selectFallbackAlgorithm(serviceProfile),
    totalVehicleCount: vehicles.length,
    inspectedVehicleCount: inspectedVehicles.length,
    skippedVehicleCount,
    activeVehicleCount,
    vehicleStatusCounts: summarizeVehicleStatuses(vehicles),
    candidateCount,
    feasibleCount,
    rejectionCounts,
    constraints: {
      candidateVehicleLimit,
      maxWaitMinutes: normalizeNonNegative(serviceProfile?.dispatchPolicy?.maxWaitMinutes, 0),
      maxDetourMinutes: normalizeNonNegative(serviceProfile?.poolingPolicy?.maxDetourMinutes, 0),
      maxAdditionalStops: normalizeNonNegativeInteger(serviceProfile?.poolingPolicy?.maxAdditionalStops, 0),
      maxOnboardPerVehicle: normalizeNonNegativeInteger(serviceProfile?.poolingPolicy?.maxOnboardPerVehicle, 0),
      futureReservationSeparationMinutes: normalizeNonNegative(
        serviceProfile?.dispatchPolicy?.futureReservationSeparationMinutes,
        60
      ),
      arriveByEarlyPickupToleranceMinutes: normalizeNonNegative(
        serviceProfile?.dispatchPolicy?.arriveByEarlyPickupToleranceMinutes,
        10
      )
    },
    observed: {
      minEtaPickupMinutes: roundMinutes(minEtaPickupMinutes),
      minDetourMinutes: roundMinutes(minDetourMinutes)
    },
    perVehicle
  };

  diagnostics.summary = summarizeNoFeasibleOutcome(diagnostics);
  diagnostics.countermeasureCandidates = buildCountermeasureCandidates({
    diagnostics,
    rejectionCounts
  });
  diagnostics.breakdown = INSERTION_REJECTION_KEYS
    .map((code) => {
      const count = rejectionCounts[code] ?? 0;
      if (count <= 0) {
        return null;
      }
      return {
        code,
        count,
        ratioPercent: candidateCount > 0 ? Math.round((count / candidateCount) * 100) : null
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.count - left.count);

  return diagnostics;
}

function filterVehiclesByAllowedIds(vehicles, allowedVehicleIds = null) {
  if (!Array.isArray(allowedVehicleIds) || !allowedVehicleIds.length) {
    return vehicles;
  }
  const allowed = new Set(
    allowedVehicleIds
      .map((vehicleId) => (typeof vehicleId === "string" ? vehicleId.trim() : ""))
      .filter(Boolean)
  );
  if (!allowed.size) {
    return vehicles;
  }
  return vehicles.filter((vehicle) => allowed.has(vehicle.id));
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

function resolveNowFromContext(context = {}) {
  const resolved = normalizeDateInput(context?.now);
  return resolved ?? new Date();
}

function compareDispatchOptions(
  left,
  right,
  {
    desiredDropoffDate = null,
    desiredPickupDate = null
  } = {}
) {
  const leftPickupEta = Number(left.etaPickupMinutes);
  const rightPickupEta = Number(right.etaPickupMinutes);
  const leftScore = Number(left.score);
  const rightScore = Number(right.score);

  const desiredTs = desiredDropoffDate?.getTime() ?? desiredPickupDate?.getTime() ?? null;
  const compareByPickup = !desiredDropoffDate && Boolean(desiredPickupDate);
  if (Number.isFinite(desiredTs)) {
    const leftTargetTs = normalizeDateInput(
      compareByPickup ? left.plannedPickupAt : left.plannedDropoffAt
    )?.getTime();
    const rightTargetTs = normalizeDateInput(
      compareByPickup ? right.plannedPickupAt : right.plannedDropoffAt
    )?.getTime();

    const leftDelta = Number.isFinite(leftTargetTs)
      ? Math.abs((leftTargetTs - desiredTs) / (60 * 1000))
      : Number.POSITIVE_INFINITY;
    const rightDelta = Number.isFinite(rightTargetTs)
      ? Math.abs((rightTargetTs - desiredTs) / (60 * 1000))
      : Number.POSITIVE_INFINITY;

    if (leftDelta !== rightDelta) {
      return leftDelta - rightDelta;
    }
  }

  if (leftPickupEta !== rightPickupEta) {
    return leftPickupEta - rightPickupEta;
  }
  if (leftScore !== rightScore) {
    return leftScore - rightScore;
  }
  return left.vehicleId.localeCompare(right.vehicleId);
}

function comparePlanCandidates(left, right) {
  const leftScore = Number(left?.score);
  const rightScore = Number(right?.score);
  if (Number.isFinite(leftScore) && Number.isFinite(rightScore) && leftScore !== rightScore) {
    return leftScore - rightScore;
  }

  const leftPickup = Number(left?.etaPickupMinutes);
  const rightPickup = Number(right?.etaPickupMinutes);
  if (Number.isFinite(leftPickup) && Number.isFinite(rightPickup) && leftPickup !== rightPickup) {
    return leftPickup - rightPickup;
  }

  const leftVehicleId = String(left?.vehicleId ?? "");
  const rightVehicleId = String(right?.vehicleId ?? "");
  return leftVehicleId.localeCompare(rightVehicleId);
}

async function evaluateDispatchPlan({
  repository,
  rideRequest,
  serviceProfile,
  allowedVehicleIds = null,
  context = {},
  now = new Date()
}) {
  const stops = repository.listStops();
  const vehicles = filterVehiclesByAllowedIds(repository.listVehicles(), allowedVehicleIds);
  const requestLookup = new Map(
    repository.listRideRequests().map((request) => [request.id, request])
  );
  requestLookup.set(rideRequest.id, rideRequest);
  const stopIndex = new Map(stops.map((stop) => [stop.id, stop]));

  const resolvedLocations = resolveRideRequestLocations({
    rideRequest,
    serviceProfile,
    stops,
    context
  });

  let requestForDispatch = buildDispatchRequest(rideRequest, resolvedLocations, now);
  if (!vehicles.length) {
    return {
      status: "REJECTED",
      reason: "NO_FEASIBLE_VEHICLE",
      resolvedLocations,
      diagnostics: buildNoFeasibleDiagnostics({
        vehicles,
        requestForDispatch,
        serviceProfile
      })
    };
  }
  const travelEstimator = await createTravelEstimator({
    points: collectDispatchTravelPoints({ vehicles, requestForDispatch }),
    context,
    speedKmh: resolveCruiseSpeedKmh(serviceProfile)
  });
  if (hasOperationPolicyConstraints(serviceProfile)) {
    requestForDispatch = applyLunchBreakPickupNotBefore({
      requestForDispatch,
      serviceProfile,
      now,
      travelMinutes: travelEstimator.travelMinutes
    });
  }
  let bestPlan = await chooseBestPlan({
    requestForDispatch,
    vehicles,
    serviceProfile,
    travelMinutes: travelEstimator.travelMinutes
  });
  let vehicle = bestPlan ? vehicles.find((entry) => entry.id === bestPlan.vehicleId) : null;

  if (!bestPlan) {
    return {
      status: "REJECTED",
      reason: "NO_FEASIBLE_VEHICLE",
      resolvedLocations,
      diagnostics: buildNoFeasibleDiagnostics({
        vehicles,
        requestForDispatch,
        serviceProfile,
        travelMinutes: travelEstimator.travelMinutes
      })
    };
  }

  if (!vehicle) {
    return {
      status: "REJECTED",
      reason: "NO_FEASIBLE_VEHICLE",
      resolvedLocations,
      diagnostics: buildNoFeasibleDiagnostics({
        vehicles,
        requestForDispatch,
        serviceProfile,
        travelMinutes: travelEstimator.travelMinutes
      })
    };
  }

  if (hasOperationPolicyConstraints(serviceProfile)) {
    const timelineForInitialPlan = buildRouteTimeline({
      vehicle,
      route: bestPlan.route ?? [],
      now,
      travelMinutes: travelEstimator.travelMinutes,
      serviceProfile
    });
    const initialSummary =
      summarizeTimelineByRequest(timelineForInitialPlan).get(rideRequest.id) ?? {};
    const initialViolation = evaluateOperationPolicyForPlan({
      serviceProfile,
      vehicle,
      route: bestPlan.route ?? [],
      requestForDispatch,
      requestSummary: initialSummary,
      now,
      travelMinutes: travelEstimator.travelMinutes
    });

    if (initialViolation) {
      let fallbackPlan = null;
      let fallbackVehicle = null;

      for (const candidateVehicle of vehicles) {
        const candidatePlan = await chooseBestPlan({
          requestForDispatch,
          vehicles: [candidateVehicle],
          serviceProfile,
          travelMinutes: travelEstimator.travelMinutes
        });
        if (!candidatePlan) {
          continue;
        }

        const candidateTimeline = buildRouteTimeline({
          vehicle: candidateVehicle,
          route: candidatePlan.route ?? [],
          now,
          travelMinutes: travelEstimator.travelMinutes,
          serviceProfile
        });
        const candidateSummary =
          summarizeTimelineByRequest(candidateTimeline).get(rideRequest.id) ?? {};
        const violation = evaluateOperationPolicyForPlan({
          serviceProfile,
          vehicle: candidateVehicle,
          route: candidatePlan.route ?? [],
          requestForDispatch,
          requestSummary: candidateSummary,
          now,
          travelMinutes: travelEstimator.travelMinutes
        });
        if (violation) {
          continue;
        }

        if (!fallbackPlan || comparePlanCandidates(candidatePlan, fallbackPlan) < 0) {
          fallbackPlan = candidatePlan;
          fallbackVehicle = candidateVehicle;
        }
      }

      if (!fallbackPlan || !fallbackVehicle) {
        return {
          status: "REJECTED",
          reason: "NO_FEASIBLE_VEHICLE",
          resolvedLocations,
          diagnostics: buildOperationPolicyDiagnostics({
            violation: initialViolation,
            serviceProfile,
            officePoint: initialViolation.officePoint,
            vehicle,
            route: bestPlan.route ?? [],
            now,
            requestSummary: initialSummary,
            requestForDispatch,
            travelMinutes: travelEstimator.travelMinutes
          })
        };
      }

      bestPlan = fallbackPlan;
      vehicle = fallbackVehicle;
    }
  }

  const routeBefore = vehicle.route ?? [];
  const timelineBefore = buildRouteTimeline({
    vehicle,
    route: routeBefore,
    now,
    travelMinutes: travelEstimator.travelMinutes,
    serviceProfile
  });
  const timelineAfter = buildRouteTimeline({
    vehicle,
    route: bestPlan.route ?? [],
    now,
    travelMinutes: travelEstimator.travelMinutes,
    serviceProfile
  });
  const beforeSummary = summarizeTimelineByRequest(timelineBefore);
  const afterSummary = summarizeTimelineByRequest(timelineAfter);
  const requestSummary = afterSummary.get(rideRequest.id) ?? {};
  const desiredDropoffSuggestion = buildDesiredDropoffSuggestion({
    requestForDispatch,
    requestSummary
  });

  const decoratedBefore = decorateTimeline({
    timeline: timelineBefore,
    rideRequest,
    resolvedLocations,
    requestLookup,
    stopIndex
  });

  const decoratedAfter = decorateTimeline({
    timeline: timelineAfter,
    rideRequest,
    resolvedLocations,
    requestLookup,
    stopIndex
  });

  return {
    status: "ASSIGNABLE",
    vehicle,
    bestPlan,
    resolvedLocations,
    beforeSummary,
    afterSummary,
    impacts: buildImpactSummary({
      beforeSummary,
      afterSummary,
      rideRequest,
      requestLookup
    }),
    simulation: {
      vehicleId: bestPlan.vehicleId,
      selectedAlgorithm: bestPlan.selectedAlgorithm ?? selectAlgorithm(serviceProfile),
      algorithmPhase: bestPlan.algorithmPhase ?? "PRIMARY",
      primaryAlgorithm: bestPlan.primaryAlgorithm ?? selectAlgorithm(serviceProfile),
      fallbackAlgorithm: bestPlan.fallbackAlgorithm ?? selectFallbackAlgorithm(serviceProfile),
      score: roundMinutes(bestPlan.score),
      detourMinutes: roundMinutes(bestPlan.detourMinutes),
      etaPickupMinutes: requestSummary.pickupEtaMinutes ?? roundMinutes(bestPlan.etaPickupMinutes),
      etaDropoffMinutes: requestSummary.dropoffEtaMinutes ?? null,
      plannedPickupAt: requestSummary.pickupEtaAt ?? null,
      plannedDropoffAt: requestSummary.dropoffEtaAt ?? null,
      desiredDropoffSuggestion,
      routeBeforeTravelMinutes: timelineBefore.at(-1)?.etaMinutes ?? 0,
      routeAfterTravelMinutes: timelineAfter.at(-1)?.etaMinutes ?? 0,
      routeBefore: decoratedBefore,
      routeAfter: decoratedAfter
    }
  };
}

export async function previewRideRequestDispatch({
  repository,
  rideRequest,
  serviceProfile,
  context = {}
}) {
  const evaluated = await evaluateDispatchPlan({
    repository,
    rideRequest,
    serviceProfile,
    context,
    now: resolveNowFromContext(context)
  });

  if (evaluated.status === "REJECTED") {
    return {
      status: "REJECTED",
      reason: evaluated.reason,
      resolvedLocations: evaluated.resolvedLocations,
      diagnostics: evaluated.diagnostics ?? null
    };
  }

  return {
    status: "ASSIGNABLE",
    resolvedLocations: evaluated.resolvedLocations,
    simulation: {
      ...evaluated.simulation,
      impactedRequests: evaluated.impacts
    }
  };
}

export async function listRideRequestDispatchOptions({
  repository,
  rideRequest,
  serviceProfile,
  context = {},
  desiredDropoffAt = null,
  desiredPickupAt = null,
  optionLimit = 5,
  allowedVehicleIds = null
}) {
  const now = resolveNowFromContext(context);
  const stops = repository.listStops();
  const vehicles = filterVehiclesByAllowedIds(repository.listVehicles(), allowedVehicleIds);
  const requestLookup = new Map(
    repository.listRideRequests().map((request) => [request.id, request])
  );
  requestLookup.set(rideRequest.id, rideRequest);
  const stopIndex = new Map(stops.map((stop) => [stop.id, stop]));
  const resolvedLocations = resolveRideRequestLocations({
    rideRequest,
    serviceProfile,
    stops,
    context
  });

  let requestForDispatch = buildDispatchRequest(rideRequest, resolvedLocations, now);
  if (!vehicles.length) {
    return {
      status: "REJECTED",
      reason: "NO_FEASIBLE_VEHICLE",
      resolvedLocations,
      desiredDropoffAt: normalizeDateInput(desiredDropoffAt)?.toISOString() ?? null,
      desiredPickupAt: normalizeDateInput(desiredPickupAt)?.toISOString() ?? null,
      options: [],
      diagnostics: buildNoFeasibleDiagnostics({
        vehicles,
        requestForDispatch,
        serviceProfile
      })
    };
  }

  const travelEstimator = await createTravelEstimator({
    points: collectDispatchTravelPoints({ vehicles, requestForDispatch }),
    context,
    speedKmh: resolveCruiseSpeedKmh(serviceProfile)
  });
  if (hasOperationPolicyConstraints(serviceProfile)) {
    requestForDispatch = applyLunchBreakPickupNotBefore({
      requestForDispatch,
      serviceProfile,
      now,
      travelMinutes: travelEstimator.travelMinutes
    });
  }
  const desiredDropoffDate = normalizeDateInput(desiredDropoffAt);
  const desiredPickupDate = normalizeDateInput(desiredPickupAt);
  const options = [];
  let firstPolicyRejected = null;

  for (const vehicle of vehicles) {
    const plan = await chooseBestPlan({
      requestForDispatch,
      vehicles: [vehicle],
      serviceProfile,
      travelMinutes: travelEstimator.travelMinutes
    });
    if (!plan) {
      continue;
    }

    const timelineBefore = buildRouteTimeline({
      vehicle,
      route: Array.isArray(vehicle.route) ? vehicle.route : [],
      now,
      travelMinutes: travelEstimator.travelMinutes,
      serviceProfile
    });
    const timelineAfter = buildRouteTimeline({
      vehicle,
      route: plan.route ?? [],
      now,
      travelMinutes: travelEstimator.travelMinutes,
      serviceProfile
    });
    const beforeSummary = summarizeTimelineByRequest(timelineBefore);
    const afterSummary = summarizeTimelineByRequest(timelineAfter);
    const requestSummary = afterSummary.get(rideRequest.id) ?? {};
    const pickupAt = requestSummary.pickupEtaAt ?? null;
    const dropoffAt = requestSummary.dropoffEtaAt ?? null;
    if (hasOperationPolicyConstraints(serviceProfile)) {
      const policyViolation = evaluateOperationPolicyForPlan({
        serviceProfile,
        vehicle,
        route: plan.route ?? [],
        requestForDispatch,
        requestSummary,
        now,
        travelMinutes: travelEstimator.travelMinutes
      });
      if (policyViolation) {
        if (!firstPolicyRejected) {
          firstPolicyRejected = {
            violation: policyViolation,
            vehicle,
            route: plan.route ?? [],
            requestSummary
          };
        }
        continue;
      }
    }

    const dropoffDeltaMinutes =
      desiredDropoffDate && dropoffAt
        ? roundMinutes((new Date(dropoffAt).getTime() - desiredDropoffDate.getTime()) / (60 * 1000))
        : null;
    const pickupDeltaMinutes =
      desiredPickupDate && pickupAt
        ? roundMinutes((new Date(pickupAt).getTime() - desiredPickupDate.getTime()) / (60 * 1000))
        : null;
    const impacts = buildImpactSummary({
      beforeSummary,
      afterSummary,
      rideRequest,
      requestLookup
    });

    options.push({
      optionId: `vehicle:${vehicle.id}`,
      vehicleId: vehicle.id,
      selectedAlgorithm: plan.selectedAlgorithm ?? selectAlgorithm(serviceProfile),
      algorithmPhase: plan.algorithmPhase ?? "PRIMARY",
      primaryAlgorithm: plan.primaryAlgorithm ?? selectAlgorithm(serviceProfile),
      fallbackAlgorithm: plan.fallbackAlgorithm ?? selectFallbackAlgorithm(serviceProfile),
      score: roundMinutes(plan.score),
      detourMinutes: roundMinutes(plan.detourMinutes),
      etaPickupMinutes: requestSummary.pickupEtaMinutes ?? roundMinutes(plan.etaPickupMinutes),
      etaDropoffMinutes: requestSummary.dropoffEtaMinutes ?? null,
      plannedPickupAt: pickupAt,
      plannedDropoffAt: dropoffAt,
      desiredDropoffDeltaMinutes: dropoffDeltaMinutes,
      desiredPickupDeltaMinutes: pickupDeltaMinutes,
      impactedRequests: impacts,
      routeAfter: decorateTimeline({
        timeline: timelineAfter,
        rideRequest,
        resolvedLocations,
        requestLookup,
        stopIndex
      })
    });
  }

  const normalizedLimit = Math.min(Math.max(Math.trunc(Number(optionLimit) || 5), 1), 10);
  const sortedOptions = options
    .sort((left, right) =>
      compareDispatchOptions(left, right, {
        desiredDropoffDate,
        desiredPickupDate
      })
    )
    .slice(0, normalizedLimit);

  if (!sortedOptions.length) {
    if (firstPolicyRejected) {
      return {
        status: "REJECTED",
        reason: "NO_FEASIBLE_VEHICLE",
        resolvedLocations,
        desiredDropoffAt: desiredDropoffDate?.toISOString() ?? null,
        desiredPickupAt: desiredPickupDate?.toISOString() ?? null,
        options: [],
        diagnostics: buildOperationPolicyDiagnostics({
          violation: firstPolicyRejected.violation,
          serviceProfile,
          officePoint: firstPolicyRejected.violation.officePoint,
          vehicle: firstPolicyRejected.vehicle,
          route: firstPolicyRejected.route,
          now,
          requestSummary: firstPolicyRejected.requestSummary,
          requestForDispatch,
          travelMinutes: travelEstimator.travelMinutes
        })
      };
    }
    return {
      status: "REJECTED",
      reason: "NO_FEASIBLE_VEHICLE",
      resolvedLocations,
      desiredDropoffAt: desiredDropoffDate?.toISOString() ?? null,
      desiredPickupAt: desiredPickupDate?.toISOString() ?? null,
      options: [],
      diagnostics: buildNoFeasibleDiagnostics({
        vehicles,
        requestForDispatch,
        serviceProfile,
        travelMinutes: travelEstimator.travelMinutes
      })
    };
  }

  return {
    status: "ASSIGNABLE",
    resolvedLocations,
    desiredDropoffAt: desiredDropoffDate?.toISOString() ?? null,
    desiredPickupAt: desiredPickupDate?.toISOString() ?? null,
    options: sortedOptions
  };
}

export async function dispatchRideRequest({
  repository,
  rideRequest,
  serviceProfile,
  context = {},
  allowedVehicleIds = null
}) {
  const evaluated = await evaluateDispatchPlan({
    repository,
    rideRequest,
    serviceProfile,
    allowedVehicleIds,
    context,
    now: resolveNowFromContext(context)
  });

  if (evaluated.status === "REJECTED") {
    const rejected = repository.updateRideRequest(rideRequest.id, {
      status: "REJECTED",
      pickup: {
        ...rideRequest.pickup,
        resolvedAs: evaluated.resolvedLocations.pickup.resolvedAs,
        resolvedPoint: evaluated.resolvedLocations.pickup.resolvedPoint,
        validation: {
          reason: evaluated.reason
        }
      },
      dropoff: {
        ...rideRequest.dropoff,
        resolvedAs: evaluated.resolvedLocations.dropoff.resolvedAs,
        resolvedPoint: evaluated.resolvedLocations.dropoff.resolvedPoint
      }
    });

    return {
      status: "REJECTED",
      rideRequest: rejected,
      resolvedLocations: evaluated.resolvedLocations,
      diagnostics: evaluated.diagnostics ?? null
    };
  }

  const trip = repository.createTrip({
    vehicleId: evaluated.bestPlan.vehicleId,
    stopPlan: evaluated.bestPlan.route,
    status: "PLANNED"
  });

  repository.updateVehicle(evaluated.bestPlan.vehicleId, {
    route: evaluated.bestPlan.route
  });

  for (const impact of evaluated.impacts) {
    const existingRequest = repository.getRideRequest(impact.requestId);
    if (!existingRequest) {
      continue;
    }

    repository.updateRideRequest(existingRequest.id, {
      assignment: {
        ...(existingRequest.assignment ?? {}),
        vehicleId: evaluated.bestPlan.vehicleId,
        etaPickupMinutes: impact.pickupAfterMinutes,
        etaDropoffMinutes: impact.dropoffAfterMinutes,
        plannedPickupAt: impact.pickupAfterAt,
        plannedDropoffAt: impact.dropoffAfterAt
      }
    });
  }

  const assigned = repository.updateRideRequest(rideRequest.id, {
    status: "ASSIGNED",
    pickup: {
      ...rideRequest.pickup,
      resolvedAs: evaluated.resolvedLocations.pickup.resolvedAs,
      resolvedPoint: evaluated.resolvedLocations.pickup.resolvedPoint,
      validation: {
        reason: evaluated.resolvedLocations.pickup.reason
      }
    },
    dropoff: {
      ...rideRequest.dropoff,
      resolvedAs: evaluated.resolvedLocations.dropoff.resolvedAs,
      resolvedPoint: evaluated.resolvedLocations.dropoff.resolvedPoint,
      validation: {
        reason: evaluated.resolvedLocations.dropoff.reason
      }
    },
    assignment: {
      vehicleId: evaluated.bestPlan.vehicleId,
      tripId: trip.id,
      etaPickupMinutes: evaluated.simulation.etaPickupMinutes,
      etaDropoffMinutes: evaluated.simulation.etaDropoffMinutes,
      plannedPickupAt: evaluated.simulation.plannedPickupAt,
      plannedDropoffAt: evaluated.simulation.plannedDropoffAt,
      score: evaluated.simulation.score,
      selectedAlgorithm: evaluated.simulation.selectedAlgorithm,
      algorithmPhase: evaluated.simulation.algorithmPhase
    },
    dispatchMeta: {
      ...(rideRequest.dispatchMeta ?? {}),
      selectedAlgorithm: evaluated.simulation.selectedAlgorithm,
      algorithmPhase: evaluated.simulation.algorithmPhase
    }
  });

  return {
    status: "ASSIGNED",
    rideRequest: assigned,
    trip,
    resolvedLocations: evaluated.resolvedLocations,
    simulation: {
      ...evaluated.simulation,
      impactedRequests: evaluated.impacts
    }
  };
}

async function evaluateCancellationPlan({
  repository,
  rideRequest,
  serviceProfile,
  context = {},
  now = new Date()
}) {
  const assignedVehicleId = rideRequest.assignment?.vehicleId;
  if (!assignedVehicleId) {
    return {
      status: "CANCEL_ONLY",
      simulation: null,
      impacts: []
    };
  }

  const vehicles = repository.listVehicles();
  const vehicle = vehicles.find((entry) => entry.id === assignedVehicleId);
  if (!vehicle) {
    return {
      status: "CANCEL_ONLY",
      simulation: null,
      impacts: []
    };
  }

  const routeBefore = vehicle.route ?? [];
  const routeAfter = routeBefore.filter((task) => task.requestId !== rideRequest.id);
  const requestLookup = new Map(
    repository.listRideRequests().map((request) => [request.id, request])
  );
  requestLookup.set(rideRequest.id, rideRequest);
  const stopIndex = new Map(repository.listStops().map((stop) => [stop.id, stop]));
  const travelEstimator = await createTravelEstimator({
    points: [
      ...collectRouteTravelPoints(vehicle),
      ...routeAfter.map((task) => task?.point)
    ],
    context,
    speedKmh: resolveCruiseSpeedKmh(serviceProfile)
  });

  const travelMinutes = travelEstimator.travelMinutes;
  const timelineBefore = buildRouteTimeline({
    vehicle,
    route: routeBefore,
    now,
    travelMinutes,
    serviceProfile
  });
  const timelineAfter = buildRouteTimeline({
    vehicle,
    route: routeAfter,
    now,
    travelMinutes,
    serviceProfile
  });
  const beforeSummary = summarizeTimelineByRequest(timelineBefore);
  const afterSummary = summarizeTimelineByRequest(timelineAfter);

  return {
    status: "CANCEL_REOPTIMIZED",
    vehicleId: assignedVehicleId,
    routeAfter,
    impacts: buildImpactSummary({
      beforeSummary,
      afterSummary,
      rideRequest,
      requestLookup
    }),
    simulation: {
      vehicleId: assignedVehicleId,
      routeBeforeTravelMinutes: timelineBefore.at(-1)?.etaMinutes ?? 0,
      routeAfterTravelMinutes: timelineAfter.at(-1)?.etaMinutes ?? 0,
      routeBefore: decorateTimeline({
        timeline: timelineBefore,
        rideRequest,
        resolvedLocations: null,
        requestLookup,
        stopIndex
      }),
      routeAfter: decorateTimeline({
        timeline: timelineAfter,
        rideRequest,
        resolvedLocations: null,
        requestLookup,
        stopIndex
      })
    }
  };
}

export async function cancelRideRequestDispatch({
  repository,
  rideRequest,
  context = {},
  reason = "OPERATOR_CANCELLED"
}) {
  const now = new Date();
  const serviceProfile = repository.getServiceProfile(rideRequest.dispatchMeta?.serviceProfileId);
  const evaluated = await evaluateCancellationPlan({
    repository,
    rideRequest,
    serviceProfile,
    context,
    now
  });

  if (evaluated.status === "CANCEL_REOPTIMIZED") {
    repository.updateVehicle(evaluated.vehicleId, {
      route: evaluated.routeAfter
    });

    for (const impact of evaluated.impacts) {
      const existingRequest = repository.getRideRequest(impact.requestId);
      if (!existingRequest) {
        continue;
      }
      repository.updateRideRequest(existingRequest.id, {
        assignment: {
          ...(existingRequest.assignment ?? {}),
          vehicleId: evaluated.vehicleId,
          etaPickupMinutes: impact.pickupAfterMinutes,
          etaDropoffMinutes: impact.dropoffAfterMinutes,
          plannedPickupAt: impact.pickupAfterAt,
          plannedDropoffAt: impact.dropoffAfterAt
        }
      });
    }
  }

  const cancelled = repository.updateRideRequest(rideRequest.id, {
    status: "CANCELLED",
    cancellation: {
      reason,
      cancelledAt: now.toISOString()
    }
  });

  return {
    status: "CANCELLED",
    rideRequest: cancelled,
    simulation: evaluated.simulation
      ? {
          ...evaluated.simulation,
          impactedRequests: evaluated.impacts
        }
      : null
  };
}

function isFinitePoint(point) {
  return (
    Boolean(point) &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng)
  );
}

function resolvePointFromLocation(location, stopIndex) {
  if (!location) {
    return null;
  }
  if (isFinitePoint(location.resolvedPoint)) {
    return location.resolvedPoint;
  }
  if (location.mode === "FIXED_STOP" && location.stopId && stopIndex.has(location.stopId)) {
    const stop = stopIndex.get(location.stopId);
    return { lat: stop.lat, lng: stop.lng };
  }
  if (isFinitePoint(location.point)) {
    return location.point;
  }
  return null;
}

function buildReoptimizationServiceProfile(serviceProfile, requestCount) {
  const minAdditionalStops = Math.max(2, requestCount * 2);
  return {
    ...serviceProfile,
    dispatchPolicy: {
      ...serviceProfile.dispatchPolicy,
      maxWaitMinutes: 24 * 60
    },
    poolingPolicy: {
      ...serviceProfile.poolingPolicy,
      maxDetourMinutes: 24 * 60,
      maxAdditionalStops: Math.max(
        serviceProfile.poolingPolicy.maxAdditionalStops ?? 0,
        minAdditionalStops
      )
    }
  };
}

function buildRequestForRouteOptimization(rideRequest, stopIndex) {
  const pickupPoint = resolvePointFromLocation(rideRequest.pickup, stopIndex);
  const dropoffPoint = resolvePointFromLocation(rideRequest.dropoff, stopIndex);
  if (!pickupPoint || !dropoffPoint) {
    return null;
  }
  return {
    id: rideRequest.id,
    partySize: rideRequest.partySize ?? 1,
    pickupPoint,
    dropoffPoint
  };
}

function optimizeVehicleRouteByInsertion({
  vehicle,
  requestsForOptimization,
  serviceProfile,
  travelMinutes
}) {
  if (!requestsForOptimization.length) {
    return { route: [], complete: true };
  }

  const relaxedProfile = buildReoptimizationServiceProfile(
    serviceProfile,
    requestsForOptimization.length
  );

  let route = [];
  const remaining = [...requestsForOptimization];

  while (remaining.length) {
    let bestCandidate = null;

    for (let i = 0; i < remaining.length; i += 1) {
      const request = remaining[i];
      const plan = findBestInsertionPlan({
        vehicle: {
          ...vehicle,
          route
        },
        request,
        serviceProfile: relaxedProfile,
        travelMinutes
      });

      if (!plan) {
        continue;
      }
      if (!bestCandidate || plan.score < bestCandidate.plan.score) {
        bestCandidate = {
          index: i,
          plan
        };
      }
    }

    if (!bestCandidate) {
      return {
        route: vehicle.route ?? [],
        complete: false
      };
    }

    route = bestCandidate.plan.route;
    remaining.splice(bestCandidate.index, 1);
  }

  return {
    route,
    complete: true
  };
}

export async function reoptimizeVehicleDispatchFromLocation({
  repository,
  vehicleId,
  serviceProfile,
  context = {}
}) {
  const vehicle = repository.listVehicles().find((entry) => entry.id === vehicleId);
  if (!vehicle) {
    throw new Error("Vehicle not found");
  }

  const now = new Date();
  const routeBefore = vehicle.route ?? [];
  const allRequests = repository.listRideRequests();
  const requestLookup = new Map(allRequests.map((request) => [request.id, request]));
  const stopIndex = new Map(repository.listStops().map((stop) => [stop.id, stop]));

  const assignedRequests = allRequests.filter((request) =>
    request.assignment?.vehicleId === vehicleId &&
    (request.status === "ASSIGNED" || request.status === "PENDING")
  );

  const requestsForOptimization = assignedRequests
    .map((request) => buildRequestForRouteOptimization(request, stopIndex))
    .filter(Boolean);
  const travelEstimator = await createTravelEstimator({
    points: [
      ...collectRouteTravelPoints(vehicle),
      ...requestsForOptimization.flatMap((request) => [request.pickupPoint, request.dropoffPoint])
    ],
    context,
    speedKmh: resolveCruiseSpeedKmh(serviceProfile)
  });
  const travelMinutes = travelEstimator.travelMinutes;

  const routeOptimization = optimizeVehicleRouteByInsertion({
    vehicle,
    requestsForOptimization,
    serviceProfile,
    travelMinutes
  });

  const nextRoute = routeOptimization.route;
  const updatedVehicle = repository.updateVehicle(vehicleId, {
    route: nextRoute
  });

  const timelineBefore = buildRouteTimeline({
    vehicle,
    route: routeBefore,
    now,
    travelMinutes,
    serviceProfile
  });
  const timelineAfter = buildRouteTimeline({
    vehicle: updatedVehicle ?? { ...vehicle, route: nextRoute },
    route: nextRoute,
    now,
    travelMinutes,
    serviceProfile
  });

  const beforeSummary = summarizeTimelineByRequest(timelineBefore);
  const afterSummary = summarizeTimelineByRequest(timelineAfter);
  const impacts = buildImpactSummary({
    beforeSummary,
    afterSummary,
    rideRequest: { id: "__route_reoptimization__" },
    requestLookup
  });

  for (const request of assignedRequests) {
    const after = afterSummary.get(request.id) ?? {};
    repository.updateRideRequest(request.id, {
      assignment: {
        ...(request.assignment ?? {}),
        vehicleId,
        etaPickupMinutes: after.pickupEtaMinutes ?? request.assignment?.etaPickupMinutes ?? null,
        etaDropoffMinutes: after.dropoffEtaMinutes ?? request.assignment?.etaDropoffMinutes ?? null,
        plannedPickupAt: after.pickupEtaAt ?? request.assignment?.plannedPickupAt ?? null,
        plannedDropoffAt: after.dropoffEtaAt ?? request.assignment?.plannedDropoffAt ?? null
      }
    });
  }

  return {
    status: routeOptimization.complete ? "REOPTIMIZED" : "ROUTE_RETAINED",
    vehicle: updatedVehicle,
    reoptimizedRequestCount: assignedRequests.length,
    simulation: {
      vehicleId,
      routeBeforeTravelMinutes: timelineBefore.at(-1)?.etaMinutes ?? 0,
      routeAfterTravelMinutes: timelineAfter.at(-1)?.etaMinutes ?? 0,
      routeBefore: decorateTimeline({
        timeline: timelineBefore,
        rideRequest: { id: "__none__" },
        resolvedLocations: null,
        requestLookup,
        stopIndex
      }),
      routeAfter: decorateTimeline({
        timeline: timelineAfter,
        rideRequest: { id: "__none__" },
        resolvedLocations: null,
        requestLookup,
        stopIndex
      }),
      impactedRequests: impacts
    }
  };
}
