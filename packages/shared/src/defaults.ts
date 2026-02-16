import { LOCATION_MODES } from "./constants.ts";

export function createDefaultServiceProfile(overrides = {}) {
  return {
    id: "weekday_default_v1",
    locationPolicy: {
      mode: LOCATION_MODES.HYBRID,
      freePointEnabled: true,
      virtualStopEnabled: true,
      virtualStopRadiusMeters: 350,
      peakHoursUseVirtualStop: true
    },
    reservationPolicy: {
      maxAdvanceDays: 14,
      minLeadMinutes: 10,
      sameDayCutoffLocalTime: "20:00"
    },
    fleetPolicy: {
      maxActiveVehicles: 20,
      minStandbyVehicles: 2,
      activationStrategy: "DEMAND_BASED"
    },
    poolingPolicy: {
      enabled: true,
      maxOnboardPerVehicle: 4,
      maxDetourMinutes: 10,
      maxAdditionalStops: 4
    },
    dispatchPolicy: {
      maxWaitMinutes: 15,
      candidateVehicleLimit: 30,
      algorithmPrimary: "INSERTION",
      algorithmFallback: "GREEDY",
      reoptimizationIntervalSec: 60,
      cruiseSpeedKmh: 25,
      pickupServiceMinutes: 0,
      dropoffServiceMinutes: 0,
      weights: {
        pickupDelay: 0.4,
        detour: 0.25,
        deadhead: 0.2,
        lateness: 0.15,
        dropoffPriority: 1
      }
    },
    farePolicy: {
      model: "HYBRID",
      currency: "JPY",
      params: {
        baseFare: 300,
        perKm: 80,
        perMinute: 10,
        sharedDiscountRate: 0.2,
        minFare: 300
      }
    },
    telephonyPolicy: {
      defaultCountryCode: "+81",
      allowAnonymousCaller: false,
      requireAdditionalIdentityCheck: true,
      denyList: []
    },
    ...overrides
  };
}
