import { CHANNELS } from "../../../shared/src/constants.ts";
import { normalizeAdapterEvent } from "./adapters.ts";
import { normalizePhoneNumber } from "./phoneNumber.ts";

export function resolveCallerIdentity({ repository, telephonyPolicy, callerRaw }) {
  const callerE164 = normalizePhoneNumber(callerRaw, telephonyPolicy.defaultCountryCode);

  if (!callerE164) {
    if (telephonyPolicy.allowAnonymousCaller) {
      return { callerE164: null, user: null, status: "ANONYMOUS" };
    }
    return { callerE164: null, user: null, status: "REJECTED", reason: "CALLER_UNKNOWN" };
  }

  if (telephonyPolicy.denyList.includes(callerE164)) {
    return { callerE164, user: null, status: "BLOCKED", reason: "DENY_LIST" };
  }

  const user = repository.findUserByPhone(callerE164);
  if (!user) {
    return { callerE164, user: null, status: "UNREGISTERED" };
  }

  return { callerE164, user, status: "LINKED" };
}

export function ingestCallEvent({ repository, telephonyPolicy, provider, adapterType, payload }) {
  const normalized = normalizeAdapterEvent({ adapterType, payload, provider });
  const identity = resolveCallerIdentity({
    repository,
    telephonyPolicy,
    callerRaw: normalized.callerRaw
  });

  const event = repository.saveCallEvent({
    provider: normalized.provider,
    adapterType: normalized.adapterType,
    direction: normalized.direction,
    callerRaw: normalized.callerRaw,
    callerE164: identity.callerE164,
    receiverNumber: normalized.receiverNumber,
    ringAt: normalized.ringAt,
    receivedAt: normalized.receivedAt,
    status: identity.status === "REJECTED" ? "FAILED" : identity.status === "BLOCKED" ? "IGNORED" : "RECEIVED",
    linkedUserId: identity.user?.id ?? null,
    rawPayload: normalized.rawPayload
  });

  return {
    event,
    identity
  };
}

export function createRideRequestByPhone({
  repository,
  serviceProfile,
  tenantId = "tenant_default",
  callerE164,
  pickup,
  dropoff,
  partySize = 1,
  passenger = null,
  requestType = "ASAP",
  scheduledAt = null,
  desiredDropoffAt = null,
  desiredPickupAt = null
}) {
  const user = callerE164 ? repository.findUserByPhone(callerE164) : null;
  const requesterId = user?.id ?? null;

  return repository.createRideRequest({
    tenantId,
    requesterId,
    channel: CHANNELS.PHONE_OPERATOR,
    pickup,
    dropoff,
    partySize,
    passenger,
    status: "MATCHING",
    dispatchMeta: {
      attemptCount: 0,
      primaryAlgorithm: serviceProfile.dispatchPolicy.algorithmPrimary,
      fallbackAlgorithm: serviceProfile.dispatchPolicy.algorithmFallback,
      serviceProfileId: serviceProfile.id
    },
    timeWindow: {
      requestType,
      scheduledAt,
      desiredDropoffAt,
      desiredPickupAt
    }
  });
}
