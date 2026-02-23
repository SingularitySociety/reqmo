import { CHANNELS } from "../../../shared/src/constants.ts";
import {
  cancelRideRequestDispatch,
  dispatchRideRequest,
  listRideRequestDispatchOptions,
  previewRideRequestDispatch,
  reoptimizeVehicleDispatchFromLocation
} from "../dispatch/engine.ts";
import {
  createRideRequestByPhone,
  ingestCallEvent,
  resolveCallerIdentity
} from "../telephony/service.ts";
import { normalizePhoneNumber } from "../telephony/phoneNumber.ts";
import { resolveRoutePath } from "../routing/service.ts";

function generatePreviewRequestId() {
  const stamp = Date.now().toString(36);
  const nonce = Math.random().toString(36).slice(2, 8);
  return `preview_${stamp}_${nonce}`;
}

function normalizeDesiredDateTime(value, fieldName) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid ISO datetime`);
  }
  return date.toISOString();
}

function normalizeDesiredDropoffAt(value) {
  return normalizeDesiredDateTime(value, "desiredDropoffAt");
}

function normalizeDesiredPickupAt(value) {
  return normalizeDesiredDateTime(value, "desiredPickupAt");
}

function resolvePhoneRequestType({ requestType, desiredDropoffAt = null, desiredPickupAt = null }) {
  if (typeof requestType === "string" && requestType.trim()) {
    return requestType.trim().toUpperCase();
  }
  if (desiredDropoffAt) {
    return "ARRIVE_BY";
  }
  if (desiredPickupAt) {
    return "DEPART_AT";
  }
  return "ASAP";
}

function resolveRequestTimeWindow({
  requestType = null,
  desiredDropoffAt = null,
  desiredPickupAt = null
}) {
  const normalizedDesiredDropoffAt = normalizeDesiredDropoffAt(desiredDropoffAt);
  const normalizedDesiredPickupAt = normalizeDesiredPickupAt(desiredPickupAt);
  const hasRequestedType = typeof requestType === "string" && requestType.trim().length > 0;
  if (!normalizedDesiredDropoffAt && !normalizedDesiredPickupAt && !hasRequestedType) {
    return null;
  }
  return {
    requestType: resolvePhoneRequestType({
      requestType,
      desiredDropoffAt: normalizedDesiredDropoffAt,
      desiredPickupAt: normalizedDesiredPickupAt
    }),
    scheduledAt: null,
    desiredDropoffAt: normalizedDesiredDropoffAt,
    desiredPickupAt: normalizedDesiredPickupAt
  };
}

function normalizePreferredVehicleId(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function normalizeOptionLimit(value, fallback = 5) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(numeric), 1), 10);
}

function toTimestamp(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  const timestamp = date.getTime();
  if (Number.isNaN(timestamp)) {
    return null;
  }
  return timestamp;
}

function isSameLocalDate(left, right) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function shouldIncludeFastestStrategy(requestedDesiredTimeAt, now = new Date()) {
  const requestedTs = toTimestamp(requestedDesiredTimeAt);
  if (!Number.isFinite(requestedTs)) {
    return true;
  }
  return isSameLocalDate(new Date(requestedTs), now);
}

function absoluteTimeDeltaMinutes(option, desiredTs, target = "DROPOFF") {
  if (!Number.isFinite(desiredTs)) {
    return Number.POSITIVE_INFINITY;
  }
  const plannedTs = toTimestamp(
    target === "PICKUP" ? option?.plannedPickupAt : option?.plannedDropoffAt
  );
  if (!Number.isFinite(plannedTs)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs((plannedTs - desiredTs) / (60 * 1000));
}

function buildPreviewRideRequest({
  tenantId,
  requesterId,
  channel,
  pickup,
  dropoff,
  partySize,
  passenger,
  serviceProfile,
  timeWindow = null
}) {
  return {
    id: generatePreviewRequestId(),
    tenantId,
    requesterId,
    channel,
    pickup,
    dropoff,
    partySize,
    passenger,
    status: "PREVIEW",
    dispatchMeta: {
      primaryAlgorithm: serviceProfile.dispatchPolicy.algorithmPrimary,
      fallbackAlgorithm: serviceProfile.dispatchPolicy.algorithmFallback,
      serviceProfileId: serviceProfile.id
    },
    ...(timeWindow ? { timeWindow } : {})
  };
}

function normalizeVehicleTaskType(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  if (normalized === "PICKUP" || normalized === "DROPOFF") {
    return normalized;
  }
  return null;
}

function normalizeTimestamp(value, fieldName) {
  if (!value) {
    return new Date().toISOString();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid ISO datetime`);
  }
  return date.toISOString();
}

function normalizeInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.trunc(numeric);
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  const normalized = normalizeInteger(value, fallback);
  return normalized >= 0 ? normalized : fallback;
}

function normalizePositiveInteger(value, fallback = 1) {
  const normalized = normalizeInteger(value, fallback);
  return normalized > 0 ? normalized : fallback;
}

function normalizeColorHex(value) {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  if (!text) {
    return null;
  }
  if (!/^#([0-9a-fA-F]{6})$/.test(text)) {
    throw new Error("iconColor must be #RRGGBB format");
  }
  return text.toLowerCase();
}

function normalizePoint(value, fieldName = "point") {
  if (!value || typeof value !== "object") {
    return null;
  }
  const lat = Number(value.lat);
  const lng = Number(value.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`${fieldName} must include finite lat/lng`);
  }
  return {
    lat,
    lng
  };
}

function normalizeVehicleStatus(value, fallback = "ACTIVE") {
  if (typeof value !== "string") {
    return fallback;
  }
  const status = value.trim().toUpperCase();
  if (!status) {
    return fallback;
  }
  return status;
}

export async function previewRideRequest({
  repository,
  tenantId,
  requesterId,
  pickup,
  dropoff,
  partySize = 1,
  passenger = null,
  channel = CHANNELS.PASSENGER_APP,
  serviceProfileId,
  requestType = null,
  desiredDropoffAt = null,
  desiredPickupAt = null,
  context = {}
}) {
  const serviceProfile = repository.getServiceProfile(serviceProfileId);
  if (!serviceProfile) {
    throw new Error("No active service profile configured");
  }
  const timeWindow = resolveRequestTimeWindow({
    requestType,
    desiredDropoffAt,
    desiredPickupAt
  });

  return previewRideRequestDispatch({
    repository,
    rideRequest: buildPreviewRideRequest({
      tenantId,
      requesterId,
      channel,
      pickup,
      dropoff,
      partySize,
      passenger,
      serviceProfile,
      timeWindow
    }),
    serviceProfile,
    context
  });
}

export async function listRideRequestOptions({
  repository,
  tenantId,
  requesterId,
  pickup,
  dropoff,
  partySize = 1,
  passenger = null,
  channel = CHANNELS.PASSENGER_APP,
  serviceProfileId,
  requestType = null,
  desiredDropoffAt = null,
  desiredPickupAt = null,
  optionLimit = 5,
  context = {}
}) {
  const serviceProfile = repository.getServiceProfile(serviceProfileId);
  if (!serviceProfile) {
    throw new Error("No active service profile configured");
  }
  const requestedTimeWindow = resolveRequestTimeWindow({
    requestType,
    desiredDropoffAt,
    desiredPickupAt
  });
  const normalizedLimit = normalizeOptionLimit(optionLimit, 5);
  const requestedDesiredDropoffAt = requestedTimeWindow?.desiredDropoffAt ?? null;
  const requestedDesiredPickupAt = requestedTimeWindow?.desiredPickupAt ?? null;
  const requestedType =
    typeof requestedTimeWindow?.requestType === "string"
      ? requestedTimeWindow.requestType.trim().toUpperCase()
      : "";
  const requestedTimeTarget =
    requestedType === "ARRIVE_BY" && requestedDesiredDropoffAt
      ? "DROPOFF"
      : requestedType === "DEPART_AT" && requestedDesiredPickupAt
        ? "PICKUP"
        : requestedDesiredDropoffAt
          ? "DROPOFF"
          : requestedDesiredPickupAt
            ? "PICKUP"
            : null;
  const requestedTimeAt =
    requestedTimeTarget === "PICKUP" ? requestedDesiredPickupAt : requestedDesiredDropoffAt;
  const requestedTimeTs = toTimestamp(requestedTimeAt);
  const includeFastestStrategy = shouldIncludeFastestStrategy(requestedTimeAt);

  const strategies = [];
  if (includeFastestStrategy) {
    strategies.push({
      key: "FASTEST",
      label: "今すぐ向かう",
      description: "最短で乗車できる案",
      timeWindow: {
        requestType: "ASAP",
        scheduledAt: null,
        desiredDropoffAt: null,
        desiredPickupAt: null
      }
    });
  }

  if (requestedTimeTarget === "DROPOFF" && requestedDesiredDropoffAt) {
    strategies.push({
      key: "REQUESTED_TIME",
      label: "希望時刻に近づける",
      description: "希望降車時刻を優先する案",
      timeWindow: {
        requestType: "ARRIVE_BY",
        scheduledAt: null,
        desiredDropoffAt: requestedDesiredDropoffAt,
        desiredPickupAt: null
      }
    });
  } else if (requestedTimeTarget === "PICKUP" && requestedDesiredPickupAt) {
    strategies.push({
      key: "REQUESTED_TIME",
      label: "希望時刻に近づける",
      description: "希望乗車時刻を優先する案",
      timeWindow: {
        requestType: "DEPART_AT",
        scheduledAt: null,
        desiredDropoffAt: null,
        desiredPickupAt: requestedDesiredPickupAt
      }
    });
  }

  if (!strategies.length) {
    strategies.push({
      key: "FASTEST",
      label: "今すぐ向かう",
      description: "最短で乗車できる案",
      timeWindow: {
        requestType: "ASAP",
        scheduledAt: null,
        desiredDropoffAt: null,
        desiredPickupAt: null
      }
    });
  }

  const strategyResults = [];
  for (const strategy of strategies) {
    const previewRequest = buildPreviewRideRequest({
      tenantId,
      requesterId,
      channel,
      pickup,
      dropoff,
      partySize,
      passenger,
      serviceProfile,
      timeWindow: strategy.timeWindow
    });
    const result = await listRideRequestDispatchOptions({
      repository,
      rideRequest: previewRequest,
      serviceProfile,
      context,
      desiredDropoffAt: strategy.timeWindow.desiredDropoffAt,
      desiredPickupAt: strategy.timeWindow.desiredPickupAt,
      optionLimit: normalizedLimit
    });
    strategyResults.push({
      strategy,
      result,
      options:
        result.status === "ASSIGNABLE"
          ? result.options.map((option) => ({
              ...option,
              optionId: `${strategy.key}:${option.optionId}`,
              strategyKey: strategy.key,
              strategyLabel: strategy.label,
              strategyDescription: strategy.description,
              requestType: strategy.timeWindow.requestType,
              desiredDropoffAt: strategy.timeWindow.desiredDropoffAt,
              desiredPickupAt: strategy.timeWindow.desiredPickupAt
            }))
          : []
    });
  }

  if (Number.isFinite(requestedTimeTs) && requestedTimeTarget) {
    const fastestEntry =
      strategyResults.find((entry) => entry.strategy.key === "FASTEST") ?? null;
    const requestedEntry =
      strategyResults.find((entry) => entry.strategy.key === "REQUESTED_TIME") ?? null;
    if (fastestEntry && requestedEntry && Array.isArray(requestedEntry.options)) {
      const fastestBestDelta = fastestEntry.options.reduce((best, option) => {
        const delta = absoluteTimeDeltaMinutes(option, requestedTimeTs, requestedTimeTarget);
        return Math.min(best, delta);
      }, Number.POSITIVE_INFINITY);

      if (Number.isFinite(fastestBestDelta)) {
        requestedEntry.options = requestedEntry.options.filter(
          (option) =>
            absoluteTimeDeltaMinutes(option, requestedTimeTs, requestedTimeTarget) <
            fastestBestDelta
        );
      }
    }
  }

  const buckets = strategyResults.map((entry) => [...entry.options]);
  const options = [];
  const seen = new Set();
  while (options.length < normalizedLimit) {
    let added = false;
    for (const bucket of buckets) {
      if (!bucket.length) {
        continue;
      }
      const option = bucket.shift();
      const signature = [
        option.vehicleId ?? "",
        option.plannedPickupAt ?? "",
        option.plannedDropoffAt ?? ""
      ].join("|");
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      options.push(option);
      added = true;
      if (options.length >= normalizedLimit) {
        break;
      }
    }
    if (!added) {
      break;
    }
  }

  if (options.length) {
    return {
      status: "ASSIGNABLE",
      desiredDropoffAt: requestedDesiredDropoffAt,
      desiredPickupAt: requestedDesiredPickupAt,
      options
    };
  }

  const rejected =
    strategyResults.find((entry) => entry.result.status === "REJECTED" && entry.result.diagnostics) ??
    strategyResults.find((entry) => entry.result.status === "REJECTED") ??
    null;

  return {
    status: "REJECTED",
    reason: rejected?.result?.reason ?? "NO_FEASIBLE_VEHICLE",
    diagnostics: rejected?.result?.diagnostics ?? null,
    resolvedLocations: rejected?.result?.resolvedLocations ?? null,
    desiredDropoffAt: requestedDesiredDropoffAt,
    desiredPickupAt: requestedDesiredPickupAt,
    options: []
  };
}

export async function createRideRequest({
  repository,
  tenantId,
  requesterId,
  pickup,
  dropoff,
  partySize = 1,
  passenger = null,
  channel = CHANNELS.PASSENGER_APP,
  serviceProfileId,
  requestType = null,
  desiredDropoffAt = null,
  desiredPickupAt = null,
  preferredVehicleId = null,
  context = {}
}) {
  const serviceProfile = repository.getServiceProfile(serviceProfileId);
  if (!serviceProfile) {
    throw new Error("No active service profile configured");
  }
  const timeWindow = resolveRequestTimeWindow({
    requestType,
    desiredDropoffAt,
    desiredPickupAt
  });
  const allowedVehicleId = normalizePreferredVehicleId(preferredVehicleId);

  const request = repository.createRideRequest({
    tenantId,
    requesterId,
    channel,
    pickup,
    dropoff,
    partySize,
    passenger,
    status: "MATCHING",
    dispatchMeta: {
      attemptCount: 1,
      primaryAlgorithm: serviceProfile.dispatchPolicy.algorithmPrimary,
      fallbackAlgorithm: serviceProfile.dispatchPolicy.algorithmFallback,
      serviceProfileId: serviceProfile.id
    },
    ...(timeWindow ? { timeWindow } : {})
  });

  return dispatchRideRequest({
    repository,
    rideRequest: request,
    serviceProfile,
    context,
    allowedVehicleIds: allowedVehicleId ? [allowedVehicleId] : null
  });
}

export async function cancelRideRequest({
  repository,
  requestId,
  reason = "OPERATOR_CANCELLED",
  context = {}
}) {
  const request = repository.getRideRequest(requestId);
  if (!request) {
    throw new Error("Ride request not found");
  }

  if (request.status === "CANCELLED") {
    return {
      status: "CANCELLED",
      rideRequest: request,
      alreadyCancelled: true
    };
  }

  if (request.status === "COMPLETED" || request.status === "PICKED_UP") {
    throw new Error("Ride request cannot be cancelled after pickup");
  }

  return cancelRideRequestDispatch({
    repository,
    rideRequest: request,
    context,
    reason
  });
}

export async function resetRideRequests({
  repository
}) {
  if (typeof repository?.resetRideRequests !== "function") {
    throw new Error("Repository does not support ride request reset");
  }

  const summary = await repository.resetRideRequests();
  return {
    status: "RESET",
    ...summary
  };
}

export async function updateVehicleLocation({
  repository,
  serviceProfileId,
  vehicleId,
  point,
  source = "DRIVER_APP",
  heading = null,
  speedKmh = null,
  capturedAt = null,
  skipReoptimization = false,
  context = {}
}) {
  const serviceProfile = repository.getServiceProfile(serviceProfileId);
  if (!serviceProfile) {
    throw new Error("No active service profile configured");
  }

  if (
    !point ||
    !Number.isFinite(Number(point.lat)) ||
    !Number.isFinite(Number(point.lng))
  ) {
    throw new Error("Invalid vehicle location point");
  }

  const normalizedPoint = {
    lat: Number(point.lat),
    lng: Number(point.lng)
  };

  const updated = repository.updateVehicle(vehicleId, {
    currentLocation: normalizedPoint,
    lastLocationAt: capturedAt ?? new Date().toISOString(),
    telemetry: {
      ...(repository.listVehicles().find((entry) => entry.id === vehicleId)?.telemetry ?? {}),
      source,
      heading: Number.isFinite(Number(heading)) ? Number(heading) : null,
      speedKmh: Number.isFinite(Number(speedKmh)) ? Number(speedKmh) : null
    }
  });

  if (!updated) {
    throw new Error("Vehicle not found");
  }

  if (skipReoptimization) {
    return {
      status: "UPDATED",
      vehicle: updated,
      reoptimization: null
    };
  }

  const reoptimization = await reoptimizeVehicleDispatchFromLocation({
    repository,
    vehicleId,
    serviceProfile,
    context
  });

  return {
    status: "UPDATED",
    vehicle: reoptimization.vehicle ?? updated,
    reoptimization
  };
}

export async function recordVehiclePassengerEvent({
  repository,
  serviceProfileId,
  vehicleId,
  requestId = null,
  taskType = null,
  source = "SIMULATION",
  processedAt = null
}) {
  const serviceProfile = repository.getServiceProfile(serviceProfileId);
  if (!serviceProfile) {
    throw new Error("No active service profile configured");
  }

  const vehicle = repository.listVehicles().find((entry) => entry.id === vehicleId);
  if (!vehicle) {
    throw new Error("Vehicle not found");
  }

  const route = Array.isArray(vehicle.route) ? vehicle.route : [];
  if (!route.length) {
    throw new Error("Vehicle route is empty");
  }

  const currentTask = route[0];
  const currentTaskType = normalizeVehicleTaskType(currentTask.type);
  if (!currentTaskType) {
    throw new Error("Current route task is invalid");
  }

  const requestedTaskType = normalizeVehicleTaskType(taskType);
  if (requestedTaskType && requestedTaskType !== currentTaskType) {
    throw new Error("Task type does not match current route head");
  }
  if (
    typeof requestId === "string" &&
    requestId.trim() &&
    currentTask.requestId &&
    requestId !== currentTask.requestId
  ) {
    throw new Error("Request id does not match current route head");
  }

  const eventAt = normalizeTimestamp(processedAt, "processedAt");
  const loadChange = normalizeInteger(currentTask.loadChange, 0);
  const boardedCount = Math.max(0, loadChange);
  const alightedCount = Math.max(0, -loadChange);
  const onboardBefore = Math.max(0, normalizeInteger(vehicle.onboardCount, 0));
  const onboardAfter = Math.max(0, onboardBefore + loadChange);
  const telemetry = vehicle.telemetry ?? {};
  const totalBoarded = Math.max(0, normalizeInteger(telemetry.totalBoarded, 0)) + boardedCount;
  const totalAlighted = Math.max(0, normalizeInteger(telemetry.totalAlighted, 0)) + alightedCount;

  const updatedVehicle = repository.updateVehicle(vehicleId, {
    onboardCount: onboardAfter,
    route: route.slice(1),
    lastLocationAt: eventAt,
    telemetry: {
      ...telemetry,
      source,
      totalBoarded,
      totalAlighted,
      lastPassengerEvent: {
        taskType: currentTaskType,
        requestId: currentTask.requestId ?? null,
        boardedCount,
        alightedCount,
        onboardBefore,
        onboardAfter,
        processedAt: eventAt,
        point: currentTask.point ?? null
      }
    }
  });

  if (!updatedVehicle) {
    throw new Error("Vehicle not found");
  }

  let rideRequest = null;
  if (currentTask.requestId) {
    const existingRequest = repository.getRideRequest(currentTask.requestId);
    if (existingRequest) {
      const assignment = {
        ...(existingRequest.assignment ?? {}),
        ...(currentTaskType === "PICKUP"
          ? { actualPickupAt: eventAt }
          : { actualDropoffAt: eventAt })
      };
      const updates =
        currentTaskType === "DROPOFF"
          ? {
              status: "COMPLETED",
              assignment
            }
          : { assignment };
      rideRequest = repository.updateRideRequest(existingRequest.id, updates);
    }
  }

  return {
    status: "RECORDED",
    vehicle: updatedVehicle,
    rideRequest,
    event: {
      taskType: currentTaskType,
      requestId: currentTask.requestId ?? null,
      boardedCount,
      alightedCount,
      onboardBefore,
      onboardAfter,
      processedAt: eventAt,
      point: currentTask.point ?? null
    }
  };
}

export function ingestCall({ repository, serviceProfileId, provider, adapterType, payload }) {
  const serviceProfile = repository.getServiceProfile(serviceProfileId);
  if (!serviceProfile) {
    throw new Error("No service profile for telephony flow");
  }

  return ingestCallEvent({
    repository,
    telephonyPolicy: serviceProfile.telephonyPolicy,
    provider,
    adapterType,
    payload
  });
}

export async function createPhoneRideRequest({
  repository,
  serviceProfileId,
  tenantId = "tenant_default",
  callerRaw,
  pickup,
  dropoff,
  partySize = 1,
  passenger = null,
  requestType = null,
  desiredDropoffAt = null,
  desiredPickupAt = null,
  preferredVehicleId = null,
  context = {}
}) {
  const serviceProfile = repository.getServiceProfile(serviceProfileId);
  if (!serviceProfile) {
    throw new Error("No service profile for phone ride request");
  }

  const callerE164 = normalizePhoneNumber(
    callerRaw,
    serviceProfile.telephonyPolicy.defaultCountryCode
  );

  const passengerFromCaller = callerE164 ? { phoneNumber: callerE164 } : null;
  const resolvedPassenger =
    passenger && typeof passenger === "object"
      ? { ...passengerFromCaller, ...passenger }
      : passengerFromCaller;
  const resolvedTimeWindow = resolveRequestTimeWindow({
    requestType,
    desiredDropoffAt,
    desiredPickupAt
  });
  const resolvedRequestType = resolvePhoneRequestType({
    requestType: resolvedTimeWindow?.requestType ?? requestType,
    desiredDropoffAt: resolvedTimeWindow?.desiredDropoffAt ?? null,
    desiredPickupAt: resolvedTimeWindow?.desiredPickupAt ?? null
  });
  const allowedVehicleId = normalizePreferredVehicleId(preferredVehicleId);

  const phoneRequest = createRideRequestByPhone({
    repository,
    serviceProfile,
    tenantId,
    callerE164,
    pickup,
    dropoff,
    partySize,
    passenger: resolvedPassenger,
    requestType: resolvedRequestType,
    desiredDropoffAt: resolvedTimeWindow?.desiredDropoffAt ?? null,
    desiredPickupAt: resolvedTimeWindow?.desiredPickupAt ?? null
  });

  return dispatchRideRequest({
    repository,
    rideRequest: phoneRequest,
    serviceProfile,
    context,
    allowedVehicleIds: allowedVehicleId ? [allowedVehicleId] : null
  });
}

export async function listPhoneRideOptions({
  repository,
  serviceProfileId,
  tenantId = "tenant_default",
  callerRaw,
  pickup,
  dropoff,
  partySize = 1,
  passenger = null,
  requestType = null,
  desiredDropoffAt = null,
  desiredPickupAt = null,
  optionLimit = 5,
  context = {}
}) {
  const serviceProfile = repository.getServiceProfile(serviceProfileId);
  if (!serviceProfile) {
    throw new Error("No service profile for phone ride request");
  }

  const callerE164 = normalizePhoneNumber(
    callerRaw,
    serviceProfile.telephonyPolicy.defaultCountryCode
  );
  const passengerFromCaller = callerE164 ? { phoneNumber: callerE164 } : null;
  const resolvedPassenger =
    passenger && typeof passenger === "object"
      ? { ...passengerFromCaller, ...passenger }
      : passengerFromCaller;
  const resolvedTimeWindow = resolveRequestTimeWindow({
    requestType,
    desiredDropoffAt,
    desiredPickupAt
  });
  const resolvedRequestType = resolvePhoneRequestType({
    requestType: resolvedTimeWindow?.requestType ?? requestType,
    desiredDropoffAt: resolvedTimeWindow?.desiredDropoffAt ?? null,
    desiredPickupAt: resolvedTimeWindow?.desiredPickupAt ?? null
  });
  const linkedUser = callerE164 ? repository.findUserByPhone(callerE164) : null;
  const normalizedOptionLimit = normalizeOptionLimit(optionLimit, 5);

  return listRideRequestDispatchOptions({
    repository,
    rideRequest: buildPreviewRideRequest({
      tenantId,
      requesterId: linkedUser?.id ?? null,
      channel: CHANNELS.PHONE_OPERATOR,
      pickup,
      dropoff,
      partySize,
      passenger: resolvedPassenger,
      serviceProfile,
      timeWindow: {
        requestType: resolvedRequestType,
        scheduledAt: null,
        desiredDropoffAt: resolvedTimeWindow?.desiredDropoffAt ?? null,
        desiredPickupAt: resolvedTimeWindow?.desiredPickupAt ?? null
      }
    }),
    serviceProfile,
    context,
    desiredDropoffAt: resolvedTimeWindow?.desiredDropoffAt ?? null,
    desiredPickupAt: resolvedTimeWindow?.desiredPickupAt ?? null,
    optionLimit: normalizedOptionLimit
  });
}

export async function getRoutePath({
  points,
  context = {}
}) {
  return resolveRoutePath({
    points: Array.isArray(points) ? points : [],
    context
  });
}

export function linkPhoneIdentity({ repository, serviceProfileId, userId, phoneNumber, verified = true }) {
  const serviceProfile = repository.getServiceProfile(serviceProfileId);
  if (!serviceProfile) {
    throw new Error("No service profile for phone identity");
  }

  const normalizedPhoneE164 = normalizePhoneNumber(
    phoneNumber,
    serviceProfile.telephonyPolicy.defaultCountryCode
  );

  if (!normalizedPhoneE164) {
    throw new Error("Invalid phone number");
  }

  return repository.linkPhoneIdentity({
    userId,
    normalizedPhoneE164,
    source: "APP_VERIFIED",
    verified
  });
}

export function resolveCaller({ repository, serviceProfileId, callerRaw }) {
  const serviceProfile = repository.getServiceProfile(serviceProfileId);
  if (!serviceProfile) {
    throw new Error("No service profile for caller resolution");
  }

  return resolveCallerIdentity({
    repository,
    telephonyPolicy: serviceProfile.telephonyPolicy,
    callerRaw
  });
}

export function createVehicle({
  repository,
  vehicle = {},
  fallbackLocation = null
}) {
  const requestedId = typeof vehicle.id === "string" ? vehicle.id.trim() : "";
  const id = requestedId || repository.nextId("veh");
  const existing = repository.listVehicles().find((entry) => entry.id === id);
  if (existing) {
    throw new Error(`Vehicle already exists: ${id}`);
  }

  const resolvedCurrentLocation =
    normalizePoint(vehicle.currentLocation ?? fallbackLocation, "currentLocation") ??
    null;
  if (!resolvedCurrentLocation) {
    throw new Error("currentLocation is required when creating vehicle");
  }
  const resolvedOfficePoint =
    normalizePoint(vehicle.officePoint ?? vehicle.homeBase, "officePoint") ??
    null;

  const nameRaw = typeof vehicle.name === "string" ? vehicle.name.trim() : "";
  const iconColor = normalizeColorHex(vehicle.iconColor);
  const routeInput = Array.isArray(vehicle.route) ? vehicle.route : [];
  const route = routeInput
    .map((task, index) => {
      if (!task || typeof task !== "object") {
        throw new Error(`route[${index}] must be an object`);
      }
      const point = normalizePoint(task.point, `route[${index}].point`);
      if (!point) {
        throw new Error(`route[${index}].point is required`);
      }
      return {
        type: typeof task.type === "string" ? task.type : "PICKUP",
        requestId:
          typeof task.requestId === "string" && task.requestId.trim()
            ? task.requestId.trim()
            : null,
        point,
        loadChange: normalizeInteger(task.loadChange, 0)
      };
    });

  return repository.addVehicle({
    id,
    name: nameRaw || id,
    status: normalizeVehicleStatus(vehicle.status, "ACTIVE"),
    capacity: normalizePositiveInteger(vehicle.capacity, 4),
    onboardCount: normalizeNonNegativeInteger(vehicle.onboardCount, 0),
    currentLocation: resolvedCurrentLocation,
    iconColor,
    route,
    ...(resolvedOfficePoint
      ? {
          officePoint: resolvedOfficePoint,
          homeBase: resolvedOfficePoint
        }
      : {})
  });
}

export function updateVehicleConfig({
  repository,
  vehicleId,
  updates = {}
}) {
  const normalizedVehicleId = typeof vehicleId === "string" ? vehicleId.trim() : "";
  if (!normalizedVehicleId) {
    throw new Error("vehicleId is required");
  }

  const current = repository.listVehicles().find((entry) => entry.id === normalizedVehicleId);
  if (!current) {
    throw new Error("Vehicle not found");
  }

  const next = {};
  if (updates.name !== undefined) {
    const nextName = typeof updates.name === "string" ? updates.name.trim() : "";
    if (!nextName) {
      throw new Error("name must be a non-empty string");
    }
    next.name = nextName;
  }
  if (updates.iconColor !== undefined) {
    next.iconColor = normalizeColorHex(updates.iconColor);
  }
  if (updates.status !== undefined) {
    next.status = normalizeVehicleStatus(updates.status, current.status ?? "ACTIVE");
  }
  if (updates.capacity !== undefined) {
    next.capacity = normalizePositiveInteger(updates.capacity, current.capacity ?? 4);
  }
  if (updates.onboardCount !== undefined) {
    next.onboardCount = normalizeNonNegativeInteger(updates.onboardCount, current.onboardCount ?? 0);
  }

  if (updates.currentLocation !== undefined) {
    const resolvedLocation = normalizePoint(
      updates.currentLocation,
      "currentLocation"
    );
    if (resolvedLocation) {
      next.currentLocation = resolvedLocation;
    }
  }

  if (updates.officePoint !== undefined || updates.homeBase !== undefined) {
    const officeInput =
      updates.officePoint !== undefined ? updates.officePoint : updates.homeBase;
    if (officeInput === null) {
      next.officePoint = null;
      next.homeBase = null;
    } else {
      const officePoint = normalizePoint(
        officeInput,
        updates.officePoint !== undefined ? "officePoint" : "homeBase"
      );
      if (!officePoint) {
        throw new Error("officePoint/homeBase must include finite lat/lng");
      }
      next.officePoint = officePoint;
      next.homeBase = officePoint;
    }
  }

  const updated = repository.updateVehicle(normalizedVehicleId, next);
  if (!updated) {
    throw new Error("Vehicle not found");
  }
  return updated;
}

export function upsertServiceProfile({ repository, profile }) {
  return repository.setServiceProfile(profile);
}

export function upsertFarePolicy({ repository, farePolicy }) {
  return repository.setFarePolicy(farePolicy);
}

export function upsertTelephonyConfig({ repository, config }) {
  return repository.setTelephonyConfig(config);
}

export function previewFare({ serviceProfile, distanceKm, durationMinutes, pooled = false }) {
  const { model, params } = serviceProfile.farePolicy;
  let fare = params.baseFare ?? 0;

  if (model === "FIXED") {
    fare = params.fixedFare ?? fare;
  } else {
    fare += distanceKm * (params.perKm ?? 0);
    fare += durationMinutes * (params.perMinute ?? 0);
  }

  if (pooled) {
    fare *= 1 - (params.sharedDiscountRate ?? 0);
  }

  return {
    amount: Math.max(params.minFare ?? 0, Math.round(fare)),
    currency: serviceProfile.farePolicy.currency ?? "JPY"
  };
}
