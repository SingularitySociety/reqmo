const { createApp, nextTick } = Vue;

const API_BASE = (() => {
  if (window.REQMO_API_BASE) {
    return window.REQMO_API_BASE;
  }
  if (window.location.protocol === "file:") {
    return "http://localhost:18787";
  }
  return "";
})();
const ROUTE_CACHE_MAX_ENTRIES = 300;
const ROUTE_CACHE_RETRY_MS = 30 * 1000;
const ROUTE_DEVIATION_RECALC_METERS = 45;
const routeGeometryCache = new Map();
const BUS_ICON_COLORS = [
  "#0284c7",
  "#059669",
  "#ea580c",
  "#7c3aed",
  "#dc2626",
  "#0f766e",
  "#b45309",
  "#2563eb"
];

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return numeric;
}

function normalizeTaskType(value) {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.trim().toUpperCase();
  if (normalized === "PICKUP" || normalized === "DROPOFF") {
    return normalized;
  }
  return "";
}

function hasPoint(point) {
  return Boolean(point) && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng));
}

function normalizeRoutePoints(points) {
  return (Array.isArray(points) ? points : [])
    .filter(hasPoint)
    .map((point) => ({
      lat: Number(point.lat),
      lng: Number(point.lng)
    }));
}

function routePointKey(point) {
  return `${Number(point.lat).toFixed(6)},${Number(point.lng).toFixed(6)}`;
}

function buildRouteCacheKey(points) {
  return normalizeRoutePoints(points)
    .map((point) => routePointKey(point))
    .join(";");
}

function setRouteCacheEntry(key, value) {
  if (routeGeometryCache.has(key)) {
    routeGeometryCache.delete(key);
  }
  routeGeometryCache.set(key, value);
  if (routeGeometryCache.size > ROUTE_CACHE_MAX_ENTRIES) {
    const oldestKey = routeGeometryCache.keys().next().value;
    if (oldestKey) {
      routeGeometryCache.delete(oldestKey);
    }
  }
}

function hashText(value) {
  const text = String(value ?? "");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function colorForVehicle(vehicleId) {
  const index = Math.abs(hashText(vehicleId)) % BUS_ICON_COLORS.length;
  return BUS_ICON_COLORS[index];
}

function createBusIcon(vehicleId, emphasized = false) {
  const size = emphasized ? 34 : 30;
  const color = colorForVehicle(vehicleId);
  const borderColor = emphasized ? "#0f172a" : "#ffffff";

  return L.divIcon({
    className: "sim-bus-icon",
    html:
      `<div style="width:${size}px;height:${size}px;border-radius:999px;` +
      `background:${color};border:2px solid ${borderColor};` +
      "box-shadow:0 3px 10px rgba(15,23,42,0.35);" +
      "display:flex;align-items:center;justify-content:center;" +
      "color:#ffffff;font-size:17px;line-height:1;\">" +
      "<span class=\"mdi mdi-bus\"></span></div>",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2]
  });
}

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

function distanceKm(a, b) {
  if (!hasPoint(a) || !hasPoint(b)) {
    return 0;
  }
  const earthRadiusKm = 6371;
  const lat1 = toRadians(Number(a.lat));
  const lat2 = toRadians(Number(b.lat));
  const dLat = lat2 - lat1;
  const dLng = toRadians(Number(b.lng) - Number(a.lng));

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function interpolatePoint(from, to, ratio) {
  const normalized = clamp(ratio, 0, 1);
  return {
    lat: Number(from.lat) + (Number(to.lat) - Number(from.lat)) * normalized,
    lng: Number(from.lng) + (Number(to.lng) - Number(from.lng)) * normalized
  };
}

function buildPolylineProgress(polylineInput) {
  const polyline = normalizeRoutePoints(polylineInput);
  if (!polyline.length) {
    return {
      polyline: [],
      cumulativeKm: [0],
      totalKm: 0
    };
  }

  const cumulativeKm = [0];
  let totalKm = 0;
  for (let i = 1; i < polyline.length; i += 1) {
    totalKm += distanceKm(polyline[i - 1], polyline[i]);
    cumulativeKm.push(totalKm);
  }

  return {
    polyline,
    cumulativeKm,
    totalKm
  };
}

function pointAlongPolyline(progress, targetDistanceKm) {
  const clampedDistanceKm = clamp(toNumber(targetDistanceKm, 0), 0, progress.totalKm);
  const polyline = progress.polyline;
  const cumulativeKm = progress.cumulativeKm;

  if (!polyline.length) {
    return null;
  }
  if (polyline.length === 1 || clampedDistanceKm <= 0) {
    return polyline[0];
  }
  if (clampedDistanceKm >= progress.totalKm) {
    return polyline.at(-1);
  }

  for (let i = 1; i < polyline.length; i += 1) {
    const segmentEndKm = cumulativeKm[i];
    if (clampedDistanceKm <= segmentEndKm) {
      const segmentStartKm = cumulativeKm[i - 1];
      const segmentLengthKm = Math.max(segmentEndKm - segmentStartKm, 0);
      if (segmentLengthKm <= 0) {
        return polyline[i];
      }
      const ratio = (clampedDistanceKm - segmentStartKm) / segmentLengthKm;
      return interpolatePoint(polyline[i - 1], polyline[i], ratio);
    }
  }

  return polyline.at(-1);
}

function pointToSegmentDistanceMeters(point, start, end) {
  if (!hasPoint(point) || !hasPoint(start) || !hasPoint(end)) {
    return Number.POSITIVE_INFINITY;
  }

  const earthRadiusMeters = 6371000;
  const refLatRad = toRadians(
    (Number(point.lat) + Number(start.lat) + Number(end.lat)) / 3
  );
  const toLocalMeters = (entry) => ({
    x: earthRadiusMeters * toRadians(Number(entry.lng)) * Math.cos(refLatRad),
    y: earthRadiusMeters * toRadians(Number(entry.lat))
  });

  const p = toLocalMeters(point);
  const a = toLocalMeters(start);
  const b = toLocalMeters(end);
  const abX = b.x - a.x;
  const abY = b.y - a.y;
  const abLenSq = abX * abX + abY * abY;
  if (abLenSq <= 0) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }

  const apX = p.x - a.x;
  const apY = p.y - a.y;
  const ratio = clamp((apX * abX + apY * abY) / abLenSq, 0, 1);
  const closestX = a.x + abX * ratio;
  const closestY = a.y + abY * ratio;
  return Math.hypot(p.x - closestX, p.y - closestY);
}

function distanceToPolylineMeters(point, polylineInput) {
  const polyline = normalizeRoutePoints(polylineInput);
  if (!hasPoint(point) || !polyline.length) {
    return Number.POSITIVE_INFINITY;
  }
  if (polyline.length === 1) {
    return distanceKm(point, polyline[0]) * 1000;
  }

  let nearest = Number.POSITIVE_INFINITY;
  for (let i = 1; i < polyline.length; i += 1) {
    nearest = Math.min(
      nearest,
      pointToSegmentDistanceMeters(point, polyline[i - 1], polyline[i])
    );
  }
  return nearest;
}

function polylineFromProgress(progress, progressKm, currentPoint = null) {
  const polyline = normalizeRoutePoints(progress?.polyline);
  const cumulativeKm = Array.isArray(progress?.cumulativeKm) ? progress.cumulativeKm : [];
  const totalKm = toNumber(progress?.totalKm, 0);
  if (!polyline.length) {
    return [];
  }
  if (polyline.length === 1) {
    return [polyline[0]];
  }

  const clampedProgressKm = clamp(toNumber(progressKm, 0), 0, totalKm);
  const startPoint = hasPoint(currentPoint)
    ? {
        lat: Number(currentPoint.lat),
        lng: Number(currentPoint.lng)
      }
    : pointAlongPolyline(progress, clampedProgressKm);
  const remaining = [];
  if (hasPoint(startPoint)) {
    remaining.push(startPoint);
  }

  let startIndex = polyline.length - 1;
  for (let i = 1; i < cumulativeKm.length; i += 1) {
    if (clampedProgressKm <= cumulativeKm[i]) {
      startIndex = i;
      break;
    }
  }

  for (let i = startIndex; i < polyline.length; i += 1) {
    const point = polyline[i];
    if (!remaining.length || routePointKey(remaining.at(-1)) !== routePointKey(point)) {
      remaining.push(point);
    }
  }
  return remaining;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatTimestamp(value) {
  if (!value) {
    return "--:--:--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--:--:--";
  }
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatDurationLabel(totalSeconds) {
  const safeSeconds = Math.max(0, Math.round(toNumber(totalSeconds, 0)));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}時間${minutes}分${seconds}秒`;
  }
  if (minutes > 0) {
    return `${minutes}分${seconds}秒`;
  }
  return `${seconds}秒`;
}

function parseTimestampMs(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  const timestampMs = date.getTime();
  if (Number.isNaN(timestampMs)) {
    return null;
  }
  return timestampMs;
}

function formatScheduleDeltaLabel(deltaSeconds) {
  const numeric = toNumber(deltaSeconds, Number.NaN);
  if (!Number.isFinite(numeric)) {
    return "データなし";
  }
  const rounded = Math.round(numeric);
  if (rounded === 0) {
    return "±0秒";
  }
  const sign = rounded > 0 ? "+" : "-";
  return `${sign}${formatDurationLabel(Math.abs(rounded))}`;
}

async function apiGet(path) {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status}`);
  }
  return response.json();
}

async function apiPost(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? `POST ${path} failed`);
  }
  return payload;
}

const app = createApp({
  data() {
    return {
      loading: false,
      tickBusy: false,
      running: false,
      timerId: null,
      errorMessage: "",
      infoMessage: "",
      vehicles: [],
      stopsById: {},
      requestsById: {},
      selectedVehicleId: "",
      averageSpeedKmh: 25,
      speedVariationKmh: 10,
      perPassengerServiceSeconds: 60,
      perPassengerServiceVariationSeconds: 2,
      tickSeconds: 5,
      currentPosition: null,
      currentSpeedKmh: 0,
      totalBoarded: 0,
      totalAlighted: 0,
      totalDistanceKm: 0,
      totalWaitingSeconds: 0,
      pickupDelayLastSeconds: null,
      pickupDelayTotalSeconds: 0,
      pickupDelayCount: 0,
      pickupDelayLastPlannedAt: null,
      pickupDelayLastActualAt: null,
      dropoffDelayLastSeconds: null,
      dropoffDelayTotalSeconds: 0,
      dropoffDelayCount: 0,
      dropoffDelayLastPlannedAt: null,
      dropoffDelayLastActualAt: null,
      pendingStopEvent: null,
      lastEvent: null,
      map: null,
      busMarker: null,
      targetMarker: null,
      traveledLine: null,
      routeLine: null,
      traveledTrack: [],
      activeRouteSegment: null,
      shouldFitBounds: true
    };
  },

  computed: {
    selectedVehicle() {
      return this.vehicles.find((vehicle) => vehicle.id === this.selectedVehicleId) ?? null;
    },

    routeTasks() {
      return Array.isArray(this.selectedVehicle?.route) ? this.selectedVehicle.route : [];
    },

    currentOnboard() {
      return Math.max(0, Math.trunc(toNumber(this.selectedVehicle?.onboardCount, 0)));
    },

    currentPositionLabel() {
      const point = hasPoint(this.currentPosition)
        ? this.currentPosition
        : this.selectedVehicle?.currentLocation;
      if (!hasPoint(point)) {
        return "-";
      }
      return `${Number(point.lat).toFixed(6)}, ${Number(point.lng).toFixed(6)}`;
    },

    currentSpeedLabel() {
      const speed = toNumber(this.currentSpeedKmh, 0);
      return `${speed.toFixed(1)} km/h`;
    },

    totalDistanceLabel() {
      const km = Math.max(0, toNumber(this.totalDistanceKm, 0));
      if (km < 1) {
        const meters = Math.round(km * 1000);
        return `${meters.toLocaleString("ja-JP")} m`;
      }
      return `${km.toFixed(2)} km`;
    },

    totalWaitingTimeLabel() {
      return formatDurationLabel(this.totalWaitingSeconds);
    },

    pickupScheduleDeltaLatestLabel() {
      return formatScheduleDeltaLabel(this.pickupDelayLastSeconds);
    },

    pickupScheduleDeltaAverageLabel() {
      if (this.pickupDelayCount <= 0) {
        return "データなし";
      }
      return formatScheduleDeltaLabel(this.pickupDelayTotalSeconds / this.pickupDelayCount);
    },

    pickupScheduleDeltaMetaLabel() {
      if (this.pickupDelayCount <= 0) {
        return "平均: データなし";
      }
      const plannedLabel = formatTimestamp(this.pickupDelayLastPlannedAt);
      const actualLabel = formatTimestamp(this.pickupDelayLastActualAt);
      return `平均: ${this.pickupScheduleDeltaAverageLabel} / 予定 ${plannedLabel} → 実績 ${actualLabel}`;
    },

    dropoffScheduleDeltaLatestLabel() {
      return formatScheduleDeltaLabel(this.dropoffDelayLastSeconds);
    },

    dropoffScheduleDeltaAverageLabel() {
      if (this.dropoffDelayCount <= 0) {
        return "データなし";
      }
      return formatScheduleDeltaLabel(this.dropoffDelayTotalSeconds / this.dropoffDelayCount);
    },

    dropoffScheduleDeltaMetaLabel() {
      if (this.dropoffDelayCount <= 0) {
        return "平均: データなし";
      }
      const plannedLabel = formatTimestamp(this.dropoffDelayLastPlannedAt);
      const actualLabel = formatTimestamp(this.dropoffDelayLastActualAt);
      return `平均: ${this.dropoffScheduleDeltaAverageLabel} / 予定 ${plannedLabel} → 実績 ${actualLabel}`;
    },

    nextTask() {
      return this.routeTasks[0] ?? null;
    },

    nextPickupSummary() {
      const task = this.routeTasks.find((entry) => normalizeTaskType(entry?.type) === "PICKUP") ?? null;
      return this.describeTask(task);
    },

    nextDropoffSummary() {
      const task = this.routeTasks.find((entry) => normalizeTaskType(entry?.type) === "DROPOFF") ?? null;
      return this.describeTask(task);
    },

    distanceToNextLabel() {
      if (!this.nextTask || !hasPoint(this.nextTask.point)) {
        return "-";
      }
      const signature = this.buildTaskSignature(this.nextTask);
      if (
        this.activeRouteSegment &&
        this.activeRouteSegment.signature === signature
      ) {
        const remainingKm = Math.max(
          0,
          this.activeRouteSegment.progress.totalKm - this.activeRouteSegment.progressKm
        );
        const meters = Math.round(remainingKm * 1000);
        return `${meters.toLocaleString("ja-JP")}m`;
      }
      const origin = hasPoint(this.currentPosition)
        ? this.currentPosition
        : this.selectedVehicle?.currentLocation;
      if (!hasPoint(origin)) {
        return "-";
      }
      const meters = Math.round(distanceKm(origin, this.nextTask.point) * 1000);
      return `${meters.toLocaleString("ja-JP")}m`;
    }
  },

  watch: {
    selectedVehicleId() {
      this.syncSelectedVehicleState({ preservePosition: false });
      this.syncMap();
    }
  },

  methods: {
    formatTimestamp,

    resetSimulationStats() {
      this.totalDistanceKm = 0;
      this.totalWaitingSeconds = 0;
      this.pickupDelayLastSeconds = null;
      this.pickupDelayTotalSeconds = 0;
      this.pickupDelayCount = 0;
      this.pickupDelayLastPlannedAt = null;
      this.pickupDelayLastActualAt = null;
      this.dropoffDelayLastSeconds = null;
      this.dropoffDelayTotalSeconds = 0;
      this.dropoffDelayCount = 0;
      this.dropoffDelayLastPlannedAt = null;
      this.dropoffDelayLastActualAt = null;
    },

    async bootstrap() {
      this.loading = true;
      this.errorMessage = "";
      try {
        await this.refreshState({ preservePosition: false });
        await nextTick();
        this.initMap();
        this.syncMap();
      } catch (error) {
        this.errorMessage = error instanceof Error ? error.message : "初期化に失敗しました";
      } finally {
        this.loading = false;
      }
    },

    async refreshState({ preservePosition = true } = {}) {
      const [vehiclesRes, stopsRes, requestsRes] = await Promise.all([
        apiGet("/api/vehicles"),
        apiGet("/api/stops"),
        apiGet("/api/ride-requests")
      ]);

      this.vehicles = Array.isArray(vehiclesRes.data) ? vehiclesRes.data : [];
      this.stopsById = Object.fromEntries((stopsRes.data ?? []).map((stop) => [stop.id, stop]));
      this.requestsById = Object.fromEntries((requestsRes.data ?? []).map((request) => [request.id, request]));

      if (!this.selectedVehicleId || !this.vehicles.find((vehicle) => vehicle.id === this.selectedVehicleId)) {
        this.selectedVehicleId = this.vehicles[0]?.id ?? "";
      }

      this.syncSelectedVehicleState({ preservePosition });
    },

    syncSelectedVehicleState({ preservePosition = true } = {}) {
      const vehicle = this.selectedVehicle;
      if (!vehicle) {
        this.currentPosition = null;
        this.traveledTrack = [];
        this.activeRouteSegment = null;
        this.pendingStopEvent = null;
        this.totalBoarded = 0;
        this.totalAlighted = 0;
        this.resetSimulationStats();
        return;
      }

      const telemetry = vehicle.telemetry ?? {};
      this.totalBoarded = Math.max(0, Math.trunc(toNumber(telemetry.totalBoarded, 0)));
      this.totalAlighted = Math.max(0, Math.trunc(toNumber(telemetry.totalAlighted, 0)));

      if (!preservePosition || !hasPoint(this.currentPosition)) {
        this.currentPosition = hasPoint(vehicle.currentLocation)
          ? {
              lat: Number(vehicle.currentLocation.lat),
              lng: Number(vehicle.currentLocation.lng)
            }
          : null;
        this.activeRouteSegment = null;
        this.pendingStopEvent = null;
        this.resetSimulationStats();
        this.resetTraveledTrack(this.currentPosition);
      }
    },

    resetTraveledTrack(point) {
      if (hasPoint(point)) {
        this.traveledTrack = [
          {
            lat: Number(point.lat),
            lng: Number(point.lng)
          }
        ];
        return;
      }
      this.traveledTrack = [];
    },

    appendTrackPoint(point) {
      if (!hasPoint(point)) {
        return;
      }
      const normalized = {
        lat: Number(point.lat),
        lng: Number(point.lng)
      };
      const last = this.traveledTrack.at(-1);
      if (last && distanceKm(last, normalized) * 1000 < 3) {
        return;
      }
      this.traveledTrack = [...this.traveledTrack, normalized].slice(-1000);
    },

    describeTask(task) {
      if (!task) {
        return null;
      }
      const count = Math.abs(Math.trunc(toNumber(task.loadChange, 0)));
      return {
        type: normalizeTaskType(task.type),
        location: this.resolveTaskLocation(task),
        count
      };
    },

    resolveNearestStopName(point) {
      if (!hasPoint(point)) {
        return null;
      }

      let nearestStop = null;
      let nearestDistanceKm = Number.POSITIVE_INFINITY;
      for (const stop of Object.values(this.stopsById)) {
        if (!hasPoint(stop)) {
          continue;
        }
        const distanceToStopKm = distanceKm(point, stop);
        if (distanceToStopKm < nearestDistanceKm) {
          nearestDistanceKm = distanceToStopKm;
          nearestStop = stop;
        }
      }

      return nearestStop?.name ?? null;
    },

    resolveTaskLocation(task) {
      if (!task) {
        return "なし";
      }

      const type = normalizeTaskType(task.type);
      const rideRequest = task.requestId ? this.requestsById[task.requestId] : null;
      const location = type === "PICKUP" ? rideRequest?.pickup : rideRequest?.dropoff;

      const stopId = location?.stopId;
      if (stopId && this.stopsById[stopId]?.name) {
        return this.stopsById[stopId].name;
      }

      const point = location?.resolvedPoint ?? location?.point ?? task.point;
      const nearestStopName = this.resolveNearestStopName(point);
      if (nearestStopName) {
        return nearestStopName;
      }

      const title = typeof location?.title === "string" ? location.title.trim() : "";
      if (title) {
        return title;
      }

      return "停留所不明";
    },

    buildTaskSignature(task) {
      if (!task || !hasPoint(task.point)) {
        return "";
      }
      return `${task.requestId ?? ""}:${normalizeTaskType(task.type)}:${routePointKey(task.point)}`;
    },

    pickSpeedKmh() {
      const avg = clamp(toNumber(this.averageSpeedKmh, 25), 1, 120);
      const jitter = Math.max(0, toNumber(this.speedVariationKmh, 10));
      const randomOffset = (Math.random() * 2 - 1) * jitter;
      return clamp(Number((avg + randomOffset).toFixed(1)), 1, 120);
    },

    resolvePassengerServiceSeconds(passengerCount) {
      const count = Math.max(0, Math.trunc(toNumber(passengerCount, 0)));
      if (count <= 0) {
        return 0;
      }

      const perPassengerSeconds = clamp(
        toNumber(this.perPassengerServiceSeconds, 60),
        0,
        120
      );
      const variationSeconds = clamp(
        toNumber(this.perPassengerServiceVariationSeconds, 2),
        0,
        60
      );

      let totalSeconds = 0;
      for (let i = 0; i < count; i += 1) {
        const offset = (Math.random() * 2 - 1) * variationSeconds;
        totalSeconds += Math.max(0, perPassengerSeconds + offset);
      }
      return Math.max(0, Math.round(totalSeconds));
    },

    resolveTaskPlannedAt(task) {
      if (!task) {
        return null;
      }
      const etaAt = typeof task.etaAt === "string" ? task.etaAt : null;
      if (parseTimestampMs(etaAt) !== null) {
        return etaAt;
      }

      const type = normalizeTaskType(task.type);
      const request = task.requestId ? this.requestsById[task.requestId] : null;
      const assignment = request?.assignment ?? null;
      const plannedAt = type === "PICKUP" ? assignment?.plannedPickupAt : assignment?.plannedDropoffAt;
      if (parseTimestampMs(plannedAt) !== null) {
        return plannedAt;
      }
      return null;
    },

    recordScheduleDeviation(task, processedAt) {
      const type = normalizeTaskType(task?.type);
      if (type !== "PICKUP" && type !== "DROPOFF") {
        return;
      }

      const plannedAt = this.resolveTaskPlannedAt(task);
      const plannedMs = parseTimestampMs(plannedAt);
      const actualMs = parseTimestampMs(processedAt);
      if (plannedMs === null || actualMs === null) {
        return;
      }

      const deltaSeconds = (actualMs - plannedMs) / 1000;
      if (type === "PICKUP") {
        this.pickupDelayLastSeconds = deltaSeconds;
        this.pickupDelayTotalSeconds += deltaSeconds;
        this.pickupDelayCount += 1;
        this.pickupDelayLastPlannedAt = plannedAt;
        this.pickupDelayLastActualAt = processedAt;
      } else {
        this.dropoffDelayLastSeconds = deltaSeconds;
        this.dropoffDelayTotalSeconds += deltaSeconds;
        this.dropoffDelayCount += 1;
        this.dropoffDelayLastPlannedAt = plannedAt;
        this.dropoffDelayLastActualAt = processedAt;
      }
    },

    scheduleTimer() {
      this.clearTimer();
      const seconds = clamp(Math.round(toNumber(this.tickSeconds, 5)), 1, 60);
      this.tickSeconds = seconds;
      this.timerId = setInterval(() => {
        this.runTick();
      }, seconds * 1000);
    },

    clearTimer() {
      if (!this.timerId) {
        return;
      }
      clearInterval(this.timerId);
      this.timerId = null;
    },

    startSimulation() {
      if (this.running || !this.selectedVehicleId) {
        return;
      }
      this.errorMessage = "";
      this.infoMessage = "シミュレーション実行中";
      this.running = true;
      this.shouldFitBounds = true;
      this.scheduleTimer();
      this.runTick();
    },

    pauseSimulation() {
      this.running = false;
      this.currentSpeedKmh = 0;
      this.clearTimer();
      this.infoMessage = "シミュレーション停止中";
    },

    async manualReload() {
      this.errorMessage = "";
      try {
        await this.refreshState({ preservePosition: this.running });
        this.syncMap();
      } catch (error) {
        this.errorMessage = error instanceof Error ? error.message : "最新化に失敗しました";
      }
    },

    async runTick() {
      if (!this.running || this.tickBusy) {
        return;
      }

      this.tickBusy = true;
      this.errorMessage = "";

      try {
        await this.refreshState({ preservePosition: true });

        const vehicle = this.selectedVehicle;
        if (!vehicle) {
          throw new Error("選択中の車両が見つかりません");
        }

        const position = hasPoint(this.currentPosition)
          ? this.currentPosition
          : vehicle.currentLocation;
        if (!hasPoint(position)) {
          throw new Error("車両現在地が未設定です");
        }

        this.currentPosition = {
          lat: Number(position.lat),
          lng: Number(position.lng)
        };
        this.appendTrackPoint(this.currentPosition);

        const seconds = clamp(Math.round(toNumber(this.tickSeconds, 5)), 1, 60);
        const nextTask = this.routeTasks[0] ?? null;
        const nextTaskSignature = this.buildTaskSignature(nextTask);
        if (this.pendingStopEvent) {
          const pending = this.pendingStopEvent;
          if (!nextTask || pending.signature !== nextTaskSignature) {
            this.pendingStopEvent = null;
          } else {
            const consumedSeconds = Math.max(
              0,
              Math.min(seconds, toNumber(pending.remainingSeconds, pending.totalSeconds))
            );
            this.totalWaitingSeconds += consumedSeconds;
            const remainingSeconds = Math.max(
              0,
              toNumber(pending.remainingSeconds, pending.totalSeconds) - seconds
            );
            this.currentSpeedKmh = 0;
            await this.sendLocation(this.currentPosition, 0);
            if (remainingSeconds <= 0) {
              await this.sendPassengerEvent(nextTask);
              this.pendingStopEvent = null;
              this.activeRouteSegment = null;
              await this.refreshState({ preservePosition: true });
              this.infoMessage = "停留ポイントで乗降イベントを送信しました";
            } else {
              this.pendingStopEvent = {
                ...pending,
                remainingSeconds
              };
              this.infoMessage = `停留中... 乗降処理 残り${Math.ceil(remainingSeconds)}秒`;
            }
            this.syncMap();
            return;
          }
        }

        const currentSpeed = this.pickSpeedKmh();
        this.currentSpeedKmh = currentSpeed;

        if (!nextTask || !hasPoint(nextTask.point)) {
          this.activeRouteSegment = null;
          this.pendingStopEvent = null;
          await this.sendLocation(this.currentPosition, currentSpeed);
          this.infoMessage = "ルート待機中: 現在地を送信しました";
          this.syncMap();
          return;
        }

        const stepKm = (currentSpeed * seconds) / 3600;
        const previousPosition = {
          lat: Number(this.currentPosition.lat),
          lng: Number(this.currentPosition.lng)
        };
        const segment = await this.ensureActiveRouteSegment({
          origin: this.currentPosition,
          task: nextTask
        });
        if (!segment) {
          throw new Error("移動経路を解決できませんでした");
        }

        const nextProgressKm = Math.min(
          segment.progress.totalKm,
          segment.progressKm + stepKm
        );
        const moved = pointAlongPolyline(segment.progress, nextProgressKm);
        if (!hasPoint(moved)) {
          throw new Error("道路経路上の移動座標を計算できませんでした");
        }

        this.currentPosition = moved;
        segment.progressKm = nextProgressKm;
        this.totalDistanceKm += Math.max(0, distanceKm(previousPosition, moved));
        this.appendTrackPoint(this.currentPosition);

        const arrived =
          segment.progress.totalKm <= 0 ||
          nextProgressKm >= segment.progress.totalKm - 0.00005;

        if (arrived) {
          const snappedPoint = {
            lat: Number(nextTask.point.lat),
            lng: Number(nextTask.point.lng)
          };
          this.totalDistanceKm += Math.max(0, distanceKm(this.currentPosition, snappedPoint));
          this.currentPosition = {
            lat: snappedPoint.lat,
            lng: snappedPoint.lng
          };
          this.appendTrackPoint(this.currentPosition);
          const passengerCount = Math.abs(Math.trunc(toNumber(nextTask.loadChange, 0)));
          const serviceSeconds = this.resolvePassengerServiceSeconds(passengerCount);
          if (serviceSeconds > 0) {
            this.currentSpeedKmh = 0;
            await this.sendLocation(this.currentPosition, 0);
            this.pendingStopEvent = {
              signature: nextTaskSignature,
              taskType: normalizeTaskType(nextTask.type),
              passengerCount,
              totalSeconds: serviceSeconds,
              remainingSeconds: serviceSeconds
            };
            this.infoMessage = `停留中... 乗降処理 ${passengerCount}人 / ${serviceSeconds}秒`;
          } else {
            await this.sendLocation(this.currentPosition, currentSpeed);
            await this.sendPassengerEvent(nextTask);
            this.activeRouteSegment = null;
            await this.refreshState({ preservePosition: true });
            this.infoMessage = "停留ポイントに到達して乗降イベントを送信しました";
          }
        } else {
          await this.sendLocation(moved, currentSpeed);
          this.infoMessage = "GPSを送信しながら移動中";
        }

        this.syncMap();
      } catch (error) {
        this.errorMessage = error instanceof Error ? error.message : "シミュレーション実行中にエラーが発生しました";
        this.pauseSimulation();
      } finally {
        this.tickBusy = false;
      }
    },

    async sendLocation(point, speedKmh) {
      const vehicleId = this.selectedVehicleId;
      if (!vehicleId) {
        return;
      }
      await apiPost(`/api/vehicles/${encodeURIComponent(vehicleId)}/location`, {
        point,
        speedKmh,
        source: "SIMULATION_WEB",
        capturedAt: new Date().toISOString(),
        skipReoptimization: true
      });
    },

    async sendPassengerEvent(task) {
      const vehicleId = this.selectedVehicleId;
      if (!vehicleId) {
        return;
      }

      const payload = await apiPost(`/api/vehicles/${encodeURIComponent(vehicleId)}/passenger-events`, {
        requestId: task.requestId ?? null,
        taskType: normalizeTaskType(task.type) || null,
        source: "SIMULATION_WEB",
        processedAt: new Date().toISOString()
      });

      this.lastEvent = payload.event ?? null;
      if (payload.event?.processedAt) {
        this.recordScheduleDeviation(task, payload.event.processedAt);
      }
      if (payload.vehicle) {
        const telemetry = payload.vehicle.telemetry ?? {};
        this.totalBoarded = Math.max(0, Math.trunc(toNumber(telemetry.totalBoarded, this.totalBoarded)));
        this.totalAlighted = Math.max(0, Math.trunc(toNumber(telemetry.totalAlighted, this.totalAlighted)));
      }
    },

    toLeafletLatLng(point) {
      return [Number(point.lat), Number(point.lng)];
    },

    buildPlannedRoutePoints(origin) {
      const points = [];
      if (hasPoint(origin)) {
        points.push({
          lat: Number(origin.lat),
          lng: Number(origin.lng)
        });
      }

      for (const task of this.routeTasks) {
        if (!hasPoint(task?.point)) {
          continue;
        }
        const point = {
          lat: Number(task.point.lat),
          lng: Number(task.point.lng)
        };
        if (!points.length || routePointKey(points.at(-1)) !== routePointKey(point)) {
          points.push(point);
        }
      }
      return points;
    },

    async requestRouteGeometry(cacheKey, points) {
      const cached = routeGeometryCache.get(cacheKey);
      if (cached?.status === "pending") {
        return;
      }
      if (
        cached?.status === "failed" &&
        Number.isFinite(cached.failedAt) &&
        Date.now() - cached.failedAt < ROUTE_CACHE_RETRY_MS
      ) {
        return;
      }

      setRouteCacheEntry(cacheKey, { status: "pending" });
      try {
        const response = await apiPost("/api/routing/path", { points });
        const polyline = normalizeRoutePoints(response?.polyline);
        if (polyline.length > 1) {
          setRouteCacheEntry(cacheKey, {
            status: "ready",
            polyline
          });
        } else {
          setRouteCacheEntry(cacheKey, {
            status: "failed",
            failedAt: Date.now()
          });
        }
      } catch (_error) {
        setRouteCacheEntry(cacheKey, {
          status: "failed",
          failedAt: Date.now()
        });
      } finally {
        this.syncMap();
      }
    },

    async fetchRoutePolyline(points) {
      const normalized = normalizeRoutePoints(points);
      if (normalized.length < 2) {
        return normalized;
      }

      const cacheKey = buildRouteCacheKey(normalized);
      const cached = routeGeometryCache.get(cacheKey);
      if (cached?.status === "ready" && Array.isArray(cached.polyline) && cached.polyline.length > 1) {
        return cached.polyline;
      }

      if (
        cached?.status === "failed" &&
        Number.isFinite(cached.failedAt) &&
        Date.now() - cached.failedAt < ROUTE_CACHE_RETRY_MS
      ) {
        return normalized;
      }

      try {
        const response = await apiPost("/api/routing/path", { points: normalized });
        const polyline = normalizeRoutePoints(response?.polyline);
        if (polyline.length > 1) {
          setRouteCacheEntry(cacheKey, {
            status: "ready",
            polyline
          });
          return polyline;
        }
      } catch (_error) {
        // fallthrough
      }

      setRouteCacheEntry(cacheKey, {
        status: "failed",
        failedAt: Date.now()
      });
      return normalized;
    },

    async ensureActiveRouteSegment({ origin, task }) {
      const signature = this.buildTaskSignature(task);
      if (!signature || !hasPoint(origin) || !hasPoint(task?.point)) {
        this.activeRouteSegment = null;
        return null;
      }

      if (this.activeRouteSegment && this.activeRouteSegment.signature === signature) {
        const deviationMeters = distanceToPolylineMeters(
          origin,
          this.activeRouteSegment.progress?.polyline ?? []
        );
        if (
          Number.isFinite(deviationMeters) &&
          deviationMeters <= ROUTE_DEVIATION_RECALC_METERS
        ) {
          return this.activeRouteSegment;
        }
      }

      const polyline = await this.fetchRoutePolyline([origin, task.point]);
      const progress = buildPolylineProgress(polyline);
      this.activeRouteSegment = {
        signature,
        progress,
        progressKm: 0
      };
      return this.activeRouteSegment;
    },

    initMap() {
      if (this.map) {
        return;
      }

      this.map = L.map("sim-map", {
        zoomControl: true,
        preferCanvas: true
      });

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors"
      }).addTo(this.map);

      const initialPoint = hasPoint(this.currentPosition)
        ? this.currentPosition
        : this.selectedVehicle?.currentLocation;

      if (hasPoint(initialPoint)) {
        this.map.setView([Number(initialPoint.lat), Number(initialPoint.lng)], 14);
      } else {
        this.map.setView([35.681236, 139.767125], 12);
      }

      this.routeLine = L.polyline([], {
        color: "#0f766e",
        weight: 4,
        opacity: 0.7
      }).addTo(this.map);

      this.traveledLine = L.polyline([], {
        color: "#f97316",
        weight: 3,
        opacity: 0.9
      }).addTo(this.map);

      this.syncMap();
    },

    syncMap() {
      if (!this.map) {
        return;
      }

      const origin = hasPoint(this.currentPosition)
        ? this.currentPosition
        : this.selectedVehicle?.currentLocation;

      if (hasPoint(origin)) {
        const latLng = this.toLeafletLatLng(origin);
        const vehicleIdForColor = this.selectedVehicle?.id ?? this.selectedVehicleId ?? "veh";
        const busIcon = createBusIcon(vehicleIdForColor, true);
        if (!this.busMarker) {
          this.busMarker = L.marker(latLng, {
            icon: busIcon,
            zIndexOffset: 1200
          }).addTo(this.map);
        } else {
          this.busMarker.setLatLng(latLng);
          this.busMarker.setIcon(busIcon);
        }
      }

      const targetTask = this.routeTasks[0] ?? null;
      if (targetTask && hasPoint(targetTask.point)) {
        const latLng = this.toLeafletLatLng(targetTask.point);
        if (!this.targetMarker) {
          this.targetMarker = L.circleMarker(latLng, {
            radius: 8,
            color: "#0f172a",
            weight: 2,
            fillColor: "#38bdf8",
            fillOpacity: 0.9
          }).addTo(this.map);
        } else {
          this.targetMarker.setLatLng(latLng);
        }
      } else if (this.targetMarker) {
        this.map.removeLayer(this.targetMarker);
        this.targetMarker = null;
      }

      if (this.traveledLine) {
        const movedPoints = normalizeRoutePoints(this.traveledTrack);
        this.traveledLine.setLatLngs(movedPoints.map(this.toLeafletLatLng));
      }

      if (this.routeLine) {
        const nextTask = this.routeTasks[0] ?? null;
        const nextTaskSignature = this.buildTaskSignature(nextTask);
        const hasStableSegment =
          Boolean(nextTaskSignature) &&
          this.activeRouteSegment?.signature === nextTaskSignature &&
          Array.isArray(this.activeRouteSegment?.progress?.polyline) &&
          this.activeRouteSegment.progress.polyline.length > 1;

        let drawPoints = [];
        if (hasStableSegment) {
          drawPoints = polylineFromProgress(
            this.activeRouteSegment.progress,
            this.activeRouteSegment.progressKm,
            origin
          );
          for (const task of this.routeTasks.slice(1)) {
            if (!hasPoint(task?.point)) {
              continue;
            }
            const point = {
              lat: Number(task.point.lat),
              lng: Number(task.point.lng)
            };
            if (
              !drawPoints.length ||
              routePointKey(drawPoints.at(-1)) !== routePointKey(point)
            ) {
              drawPoints.push(point);
            }
          }
        } else {
          const points = this.buildPlannedRoutePoints(origin);
          drawPoints = points;
          if (points.length >= 2) {
            const cacheKey = buildRouteCacheKey(points);
            const cached = routeGeometryCache.get(cacheKey);
            if (
              cached?.status === "ready" &&
              Array.isArray(cached.polyline) &&
              cached.polyline.length > 1
            ) {
              drawPoints = cached.polyline;
            } else {
              void this.requestRouteGeometry(cacheKey, points);
            }
          }
        }

        this.routeLine.setLatLngs(drawPoints.map(this.toLeafletLatLng));

        if (drawPoints.length >= 2 && this.shouldFitBounds) {
          this.map.fitBounds(drawPoints.map(this.toLeafletLatLng), {
            padding: [24, 24],
            maxZoom: 16
          });
          this.shouldFitBounds = false;
        }
      }
    }
  },

  mounted() {
    this.bootstrap();
  },

  beforeUnmount() {
    this.clearTimer();
  }
});

app.mount("#app");
