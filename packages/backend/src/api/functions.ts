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

function normalizeDesiredDropoffAt(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("desiredDropoffAt must be a valid ISO datetime");
  }
  return date.toISOString();
}

function resolvePhoneRequestType({ requestType, desiredDropoffAt }) {
  if (typeof requestType === "string" && requestType.trim()) {
    return requestType.trim().toUpperCase();
  }
  return desiredDropoffAt ? "ARRIVE_BY" : "ASAP";
}

function normalizePreferredVehicleId(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
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
  context = {}
}) {
  const serviceProfile = repository.getServiceProfile(serviceProfileId);
  if (!serviceProfile) {
    throw new Error("No active service profile configured");
  }

  return previewRideRequestDispatch({
    repository,
    rideRequest: {
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
      }
    },
    serviceProfile,
    context
  });
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
  context = {}
}) {
  const serviceProfile = repository.getServiceProfile(serviceProfileId);
  if (!serviceProfile) {
    throw new Error("No active service profile configured");
  }

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
    }
  });

  return dispatchRideRequest({ repository, rideRequest: request, serviceProfile, context });
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

export async function updateVehicleLocation({
  repository,
  serviceProfileId,
  vehicleId,
  point,
  source = "DRIVER_APP",
  heading = null,
  speedKmh = null,
  capturedAt = null,
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
  const normalizedDesiredDropoffAt = normalizeDesiredDropoffAt(
    desiredDropoffAt ?? desiredPickupAt ?? null
  );
  const resolvedRequestType = resolvePhoneRequestType({
    requestType,
    desiredDropoffAt: normalizedDesiredDropoffAt
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
    desiredDropoffAt: normalizedDesiredDropoffAt
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
  const normalizedDesiredDropoffAt = normalizeDesiredDropoffAt(
    desiredDropoffAt ?? desiredPickupAt ?? null
  );
  const resolvedRequestType = resolvePhoneRequestType({
    requestType,
    desiredDropoffAt: normalizedDesiredDropoffAt
  });
  const linkedUser = callerE164 ? repository.findUserByPhone(callerE164) : null;

  return listRideRequestDispatchOptions({
    repository,
    rideRequest: {
      id: generatePreviewRequestId(),
      tenantId,
      requesterId: linkedUser?.id ?? null,
      channel: CHANNELS.PHONE_OPERATOR,
      pickup,
      dropoff,
      partySize,
      passenger: resolvedPassenger,
      status: "PREVIEW",
      dispatchMeta: {
        primaryAlgorithm: serviceProfile.dispatchPolicy.algorithmPrimary,
        fallbackAlgorithm: serviceProfile.dispatchPolicy.algorithmFallback,
        serviceProfileId: serviceProfile.id
      },
      timeWindow: {
        requestType: resolvedRequestType,
        scheduledAt: null,
        desiredDropoffAt: normalizedDesiredDropoffAt
      }
    },
    serviceProfile,
    context,
    desiredDropoffAt: normalizedDesiredDropoffAt,
    optionLimit
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
