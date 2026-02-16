import { estimateTravelMinutes } from "../../../shared/src/geo.ts";

function defaultTravelMinutes(a, b) {
  return estimateTravelMinutes(a, b);
}

export function findGreedyVehicle({ request, vehicles, serviceProfile, travelMinutes = defaultTravelMinutes }) {
  const limit = serviceProfile.dispatchPolicy.candidateVehicleLimit;
  const maxOnboard = serviceProfile.poolingPolicy.maxOnboardPerVehicle;

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

    const etaPickupMinutes = travelMinutes(vehicle.currentLocation, request.pickupPoint);
    if (etaPickupMinutes > serviceProfile.dispatchPolicy.maxWaitMinutes) {
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
            loadChange: request.partySize
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
