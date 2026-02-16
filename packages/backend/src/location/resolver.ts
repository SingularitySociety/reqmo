import {
  LOCATION_MODES,
  RESOLVED_AS
} from "../../../shared/src/constants.ts";
import { haversineDistanceMeters } from "../../../shared/src/geo.ts";

export function findNearestStop(point, stops) {
  if (!point || !Array.isArray(stops) || stops.length === 0) {
    return null;
  }
  let best = null;
  for (const stop of stops) {
    const distanceMeters = haversineDistanceMeters(point, stop);
    if (!best || distanceMeters < best.distanceMeters) {
      best = { stop, distanceMeters };
    }
  }
  return best;
}

function makeVirtualStop(point) {
  const lat = Number(point.lat.toFixed(6));
  const lng = Number(point.lng.toFixed(6));
  return {
    id: `virtual_${lat}_${lng}`,
    name: "Virtual Stop",
    lat,
    lng,
    virtual: true
  };
}

function resolveFixedStop(input, stops) {
  const stop = stops.find((candidate) => candidate.id === input.stopId);
  if (!stop) {
    throw new Error(`Unknown stopId: ${input.stopId}`);
  }

  return {
    resolvedAs: RESOLVED_AS.FIXED_STOP,
    resolvedPoint: { lat: stop.lat, lng: stop.lng },
    stopId: stop.id,
    reason: "FIXED_STOP_INPUT"
  };
}

function scoreFreePoint(point, context) {
  const congestionPenalty = context?.isPeak ? 3 : 0;
  const safetyPenalty = context?.safetyPenalty ?? 0;
  return congestionPenalty + safetyPenalty;
}

function scoreVirtualStop(nearestStop, context) {
  if (!nearestStop) {
    return Number.POSITIVE_INFINITY;
  }
  const walkPenalty = nearestStop.distanceMeters / 80;
  const preferencePenalty = context?.preferFreePoint ? 2 : 0;
  return walkPenalty + preferencePenalty;
}

function resolveFreePointInput(input, serviceProfile, stops, context = {}) {
  if (!input.point || typeof input.point.lat !== "number" || typeof input.point.lng !== "number") {
    throw new Error("FREE_POINT input requires numeric point");
  }

  const mode = serviceProfile.locationPolicy.mode;
  const nearestStop = findNearestStop(input.point, stops);
  const virtualStopRadiusMeters = serviceProfile.locationPolicy.virtualStopRadiusMeters;

  const freeCandidate = {
    resolvedAs: RESOLVED_AS.FREE_POINT,
    resolvedPoint: input.point,
    stopId: null,
    reason: "FREE_POINT_SELECTED",
    cost: scoreFreePoint(input.point, context)
  };

  const virtualCandidateStop =
    nearestStop && nearestStop.distanceMeters <= virtualStopRadiusMeters
      ? nearestStop.stop
      : makeVirtualStop(input.point);

  const virtualCandidate = {
    resolvedAs: RESOLVED_AS.VIRTUAL_STOP,
    resolvedPoint: { lat: virtualCandidateStop.lat, lng: virtualCandidateStop.lng },
    stopId: virtualCandidateStop.id,
    reason:
      virtualCandidateStop.virtual === true
        ? "VIRTUAL_STOP_SYNTHETIC"
        : "VIRTUAL_STOP_NEAREST_EXISTING",
    cost: scoreVirtualStop(nearestStop, context)
  };

  if (mode === LOCATION_MODES.FREE_ONLY || !serviceProfile.locationPolicy.virtualStopEnabled) {
    return freeCandidate;
  }

  if (mode === LOCATION_MODES.VIRTUAL_ONLY || !serviceProfile.locationPolicy.freePointEnabled) {
    return virtualCandidate;
  }

  if (context.preferVirtualStop) {
    return virtualCandidate;
  }
  if (context.preferFreePoint) {
    return freeCandidate;
  }

  return freeCandidate.cost <= virtualCandidate.cost ? freeCandidate : virtualCandidate;
}

export function resolveLocationInput({ input, serviceProfile, stops, context }) {
  if (!input || !input.mode) {
    throw new Error("Location input requires mode");
  }

  if (input.mode === "FIXED_STOP") {
    return resolveFixedStop(input, stops);
  }

  if (input.mode === "FREE_POINT") {
    return resolveFreePointInput(input, serviceProfile, stops, context);
  }

  throw new Error(`Unsupported input mode: ${input.mode}`);
}

export function resolveRideRequestLocations({ rideRequest, serviceProfile, stops, context = {} }) {
  const pickup = resolveLocationInput({
    input: rideRequest.pickup,
    serviceProfile,
    stops,
    context: context.pickup
  });

  const dropoff = resolveLocationInput({
    input: rideRequest.dropoff,
    serviceProfile,
    stops,
    context: context.dropoff
  });

  return {
    pickup,
    dropoff
  };
}
