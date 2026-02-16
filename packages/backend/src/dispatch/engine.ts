import { findGreedyVehicle } from "./greedy.ts";
import {
  analyzeInsertionCandidateFailures,
  findBestInsertionAcrossVehicles,
  findBestInsertionPlan
} from "./insertion.ts";
import { resolveRideRequestLocations } from "../location/resolver.ts";
import { estimateTravelMinutes } from "../../../shared/src/geo.ts";
import { createTravelEstimator } from "../routing/service.ts";

const DEFAULT_CRUISE_SPEED_KMH = 25;

function selectAlgorithm(serviceProfile) {
  return serviceProfile.dispatchPolicy.algorithmPrimary ?? "INSERTION";
}

function selectFallbackAlgorithm(serviceProfile) {
  return serviceProfile.dispatchPolicy.algorithmFallback ?? "GREEDY";
}

function buildDispatchRequest(rideRequest, resolvedLocations) {
  return {
    id: rideRequest.id,
    partySize: rideRequest.partySize ?? 1,
    pickupPoint: resolvedLocations.pickup.resolvedPoint,
    dropoffPoint: resolvedLocations.dropoff.resolvedPoint
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
    onboard += task.loadChange ?? 0;
    current = task.point;

    const entry = {
      sequence: index + 1,
      type: task.type,
      requestId: task.requestId ?? null,
      point: task.point,
      loadChange: task.loadChange ?? 0,
      segmentMinutes: roundMinutes(segmentMinutes),
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

function chooseBestPlan({ requestForDispatch, vehicles, serviceProfile, travelMinutes }) {
  const primary = selectAlgorithm(serviceProfile);
  const fallback = selectFallbackAlgorithm(serviceProfile);

  let bestPlan = null;
  if (primary === "INSERTION") {
    bestPlan = findBestInsertionAcrossVehicles({
      request: requestForDispatch,
      vehicles,
      serviceProfile,
      travelMinutes
    });
  } else {
    bestPlan = findGreedyVehicle({
      request: requestForDispatch,
      vehicles,
      serviceProfile,
      travelMinutes
    });
  }

  if (bestPlan) {
    return bestPlan;
  }

  if (fallback === "GREEDY") {
    return findGreedyVehicle({
      request: requestForDispatch,
      vehicles,
      serviceProfile,
      travelMinutes
    });
  }
  return findBestInsertionAcrossVehicles({
    request: requestForDispatch,
    vehicles,
    serviceProfile,
    travelMinutes
  });
}

const INSERTION_REJECTION_KEYS = [
  "CONSECUTIVE_PICKUP",
  "CAPACITY",
  "MAX_WAIT",
  "MAX_DETOUR",
  "MAX_ADDITIONAL_STOPS"
];

function createInsertionRejectionCounts() {
  return {
    CONSECUTIVE_PICKUP: 0,
    CAPACITY: 0,
    MAX_WAIT: 0,
    MAX_DETOUR: 0,
    MAX_ADDITIONAL_STOPS: 0
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
      maxOnboardPerVehicle: normalizeNonNegativeInteger(serviceProfile?.poolingPolicy?.maxOnboardPerVehicle, 0)
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

function compareDispatchOptions(left, right, desiredDropoffDate) {
  const leftPickupEta = Number(left.etaPickupMinutes);
  const rightPickupEta = Number(right.etaPickupMinutes);
  const leftScore = Number(left.score);
  const rightScore = Number(right.score);

  if (desiredDropoffDate) {
    const desiredTs = desiredDropoffDate.getTime();
    const leftDropoffTs = normalizeDateInput(left.plannedDropoffAt)?.getTime();
    const rightDropoffTs = normalizeDateInput(right.plannedDropoffAt)?.getTime();

    const leftDelta = Number.isFinite(leftDropoffTs)
      ? Math.abs((leftDropoffTs - desiredTs) / (60 * 1000))
      : Number.POSITIVE_INFINITY;
    const rightDelta = Number.isFinite(rightDropoffTs)
      ? Math.abs((rightDropoffTs - desiredTs) / (60 * 1000))
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

  const requestForDispatch = buildDispatchRequest(rideRequest, resolvedLocations);
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
  const bestPlan = chooseBestPlan({
    requestForDispatch,
    vehicles,
    serviceProfile,
    travelMinutes: travelEstimator.travelMinutes
  });

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

  const vehicle = vehicles.find((entry) => entry.id === bestPlan.vehicleId);
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
      score: roundMinutes(bestPlan.score),
      detourMinutes: roundMinutes(bestPlan.detourMinutes),
      etaPickupMinutes: requestSummary.pickupEtaMinutes ?? roundMinutes(bestPlan.etaPickupMinutes),
      etaDropoffMinutes: requestSummary.dropoffEtaMinutes ?? null,
      plannedPickupAt: requestSummary.pickupEtaAt ?? null,
      plannedDropoffAt: requestSummary.dropoffEtaAt ?? null,
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
    context
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
  optionLimit = 5,
  allowedVehicleIds = null
}) {
  const now = new Date();
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

  const requestForDispatch = buildDispatchRequest(rideRequest, resolvedLocations);
  if (!vehicles.length) {
    return {
      status: "REJECTED",
      reason: "NO_FEASIBLE_VEHICLE",
      resolvedLocations,
      desiredDropoffAt: normalizeDateInput(desiredDropoffAt)?.toISOString() ?? null,
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
  const desiredDropoffDate = normalizeDateInput(desiredDropoffAt);
  const options = [];

  for (const vehicle of vehicles) {
    const plan = chooseBestPlan({
      requestForDispatch,
      vehicles: [vehicle],
      serviceProfile,
      travelMinutes: travelEstimator.travelMinutes
    });
    if (!plan) {
      continue;
    }

    const timelineAfter = buildRouteTimeline({
      vehicle,
      route: plan.route ?? [],
      now,
      travelMinutes: travelEstimator.travelMinutes,
      serviceProfile
    });
    const afterSummary = summarizeTimelineByRequest(timelineAfter);
    const requestSummary = afterSummary.get(rideRequest.id) ?? {};
    const pickupAt = requestSummary.pickupEtaAt ?? null;
    const dropoffAt = requestSummary.dropoffEtaAt ?? null;
    const dropoffDeltaMinutes =
      desiredDropoffDate && dropoffAt
        ? roundMinutes((new Date(dropoffAt).getTime() - desiredDropoffDate.getTime()) / (60 * 1000))
        : null;

    options.push({
      optionId: `vehicle:${vehicle.id}`,
      vehicleId: vehicle.id,
      score: roundMinutes(plan.score),
      detourMinutes: roundMinutes(plan.detourMinutes),
      etaPickupMinutes: requestSummary.pickupEtaMinutes ?? roundMinutes(plan.etaPickupMinutes),
      etaDropoffMinutes: requestSummary.dropoffEtaMinutes ?? null,
      plannedPickupAt: pickupAt,
      plannedDropoffAt: dropoffAt,
      desiredDropoffDeltaMinutes: dropoffDeltaMinutes,
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
    .sort((left, right) => compareDispatchOptions(left, right, desiredDropoffDate))
    .slice(0, normalizedLimit);

  if (!sortedOptions.length) {
    return {
      status: "REJECTED",
      reason: "NO_FEASIBLE_VEHICLE",
      resolvedLocations,
      desiredDropoffAt: desiredDropoffDate?.toISOString() ?? null,
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
    context
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
      score: evaluated.simulation.score
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
