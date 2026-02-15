import { estimateTravelMinutes, haversineDistanceMeters } from "../../../shared/src/geo.js";

const DEFAULT_PROVIDER = "STRAIGHT_LINE";
const DEFAULT_TIMEOUT_MS = 3500;
const DEFAULT_STRAIGHT_LINE_SPEED_KMH = 25;
const MAX_OSRM_TABLE_COORDINATES = 100;
const MAX_OSRM_ROUTE_COORDINATES = 100;
const ROUTE_PATH_CACHE_MAX_ENTRIES = 1000;
const ROUTE_PATH_CACHE_TTL_MS = 5 * 60 * 1000;
const ROUTE_PATH_FALLBACK_CACHE_TTL_MS = 30 * 1000;

const routePathCache = new Map();

function normalizeProvider(value) {
  if (typeof value !== "string") {
    return DEFAULT_PROVIDER;
  }
  const upper = value.trim().toUpperCase();
  if (upper === "OSRM") {
    return "OSRM";
  }
  return DEFAULT_PROVIDER;
}

function normalizeBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "https://router.project-osrm.org";
  }
  return value.trim().replace(/\/+$/, "");
}

function normalizeTimeoutMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.round(numeric), 500), 20000);
}

function normalizeSpeedKmh(value, fallback = DEFAULT_STRAIGHT_LINE_SPEED_KMH) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.min(Math.max(Number(numeric), 1), 130);
}

function hasFinitePoint(point) {
  return (
    Boolean(point) &&
    Number.isFinite(Number(point.lat)) &&
    Number.isFinite(Number(point.lng))
  );
}

function normalizePoint(point) {
  if (!hasFinitePoint(point)) {
    return null;
  }
  return {
    lat: Number(point.lat),
    lng: Number(point.lng)
  };
}

function pointKey(point) {
  return `${Number(point.lat).toFixed(6)},${Number(point.lng).toFixed(6)}`;
}

function encodeCoordinates(points) {
  return points.map((point) => `${point.lng},${point.lat}`).join(";");
}

function buildRoutePathCacheKey({ points, options, speedKmh }) {
  const providerScope =
    options.provider === "OSRM"
      ? `OSRM|${normalizeBaseUrl(options.osrmBaseUrl)}`
      : `${options.provider}|${normalizeSpeedKmh(speedKmh)}`;
  return `${providerScope}|${points.map((point) => pointKey(point)).join(";")}`;
}

function setRoutePathCacheEntry(key, entry) {
  if (routePathCache.has(key)) {
    routePathCache.delete(key);
  }
  routePathCache.set(key, entry);
  while (routePathCache.size > ROUTE_PATH_CACHE_MAX_ENTRIES) {
    const oldestKey = routePathCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    routePathCache.delete(oldestKey);
  }
}

function getRoutePathCacheEntry(key) {
  const entry = routePathCache.get(key);
  if (!entry) {
    return null;
  }
  if (Number.isFinite(entry.expiresAt) && entry.expiresAt <= Date.now()) {
    routePathCache.delete(key);
    return null;
  }
  routePathCache.delete(key);
  routePathCache.set(key, entry);
  return entry;
}

function cloneRoutePath(path) {
  return {
    source: typeof path?.source === "string" ? path.source : "STRAIGHT_LINE",
    polyline: Array.isArray(path?.polyline)
      ? path.polyline
          .map((point) => normalizePoint(point))
          .filter(Boolean)
      : [],
    durationMinutes: Number(path?.durationMinutes) || 0,
    distanceMeters: Number(path?.distanceMeters) || 0
  };
}

function buildStraightLineRoutePath(points, speedKmh = DEFAULT_STRAIGHT_LINE_SPEED_KMH) {
  let durationMinutes = 0;
  let distanceMeters = 0;
  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1];
    const to = points[i];
    durationMinutes += estimateTravelMinutes(from, to, speedKmh);
    distanceMeters += haversineDistanceMeters(from, to);
  }

  return {
    source: "STRAIGHT_LINE",
    polyline: points,
    durationMinutes,
    distanceMeters
  };
}

function resolveRoutingOptions(context = {}) {
  const config = context?.routing ?? {};
  return {
    provider: normalizeProvider(config.provider),
    osrmBaseUrl: normalizeBaseUrl(config.osrmBaseUrl),
    timeoutMs: normalizeTimeoutMs(config.timeoutMs)
  };
}

function buildStraightLineEstimator(speedKmh = DEFAULT_STRAIGHT_LINE_SPEED_KMH) {
  return {
    source: "STRAIGHT_LINE",
    travelMinutes(from, to) {
      const a = normalizePoint(from);
      const b = normalizePoint(to);
      if (!a || !b) {
        return 0;
      }
      const minutes = estimateTravelMinutes(a, b, speedKmh);
      return Number.isFinite(minutes) && minutes >= 0 ? minutes : 0;
    }
  };
}

function dedupePoints(points = []) {
  const unique = [];
  const index = new Map();

  for (const raw of points) {
    const point = normalizePoint(raw);
    if (!point) {
      continue;
    }
    const key = pointKey(point);
    if (index.has(key)) {
      continue;
    }
    index.set(key, unique.length);
    unique.push(point);
  }

  return { unique, index };
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Routing API error: ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOsrmTable({ points, osrmBaseUrl, timeoutMs }) {
  const coordinates = encodeCoordinates(points);
  const url = `${osrmBaseUrl}/table/v1/driving/${coordinates}?annotations=duration,distance`;
  const payload = await fetchJsonWithTimeout(url, timeoutMs);
  if (payload.code !== "Ok") {
    throw new Error(payload.message ?? "OSRM table request failed");
  }
  return {
    durations: Array.isArray(payload.durations) ? payload.durations : [],
    distances: Array.isArray(payload.distances) ? payload.distances : []
  };
}

async function fetchOsrmRoute({ points, osrmBaseUrl, timeoutMs }) {
  const coordinates = encodeCoordinates(points);
  const url =
    `${osrmBaseUrl}/route/v1/driving/${coordinates}` +
    "?overview=full&geometries=geojson&steps=false&annotations=false";
  const payload = await fetchJsonWithTimeout(url, timeoutMs);
  if (payload.code !== "Ok") {
    throw new Error(payload.message ?? "OSRM route request failed");
  }
  const route = Array.isArray(payload.routes) ? payload.routes[0] : null;
  if (!route) {
    throw new Error("OSRM route not found");
  }

  const geometryCoordinates = route.geometry?.coordinates;
  const polyline = Array.isArray(geometryCoordinates)
    ? geometryCoordinates
        .map((pair) => ({
          lat: Number(pair?.[1]),
          lng: Number(pair?.[0])
        }))
        .filter(hasFinitePoint)
    : [];

  if (polyline.length < 2) {
    throw new Error("OSRM route geometry is empty");
  }

  return {
    source: "OSRM",
    polyline,
    durationMinutes: Number(route.duration) / 60,
    distanceMeters: Number(route.distance)
  };
}

function safeMatrixMinutes(durations, fromIndex, toIndex) {
  const seconds = durations?.[fromIndex]?.[toIndex];
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return seconds / 60;
}

function buildMatrixEstimator({
  points,
  pointIndex,
  durations,
  speedKmh = DEFAULT_STRAIGHT_LINE_SPEED_KMH
}) {
  const straightLine = buildStraightLineEstimator(speedKmh);
  return {
    source: "OSRM",
    travelMinutes(from, to) {
      const a = normalizePoint(from);
      const b = normalizePoint(to);
      if (!a || !b) {
        return 0;
      }
      const fromIndex = pointIndex.get(pointKey(a));
      const toIndex = pointIndex.get(pointKey(b));
      if (fromIndex === undefined || toIndex === undefined) {
        return straightLine.travelMinutes(a, b);
      }
      const matrixMinutes = safeMatrixMinutes(durations, fromIndex, toIndex);
      if (matrixMinutes === null) {
        return straightLine.travelMinutes(a, b);
      }
      return matrixMinutes;
    },
    points
  };
}

export function createRoutingContextFromEnv(env = process.env) {
  return {
    provider: normalizeProvider(env.ROUTING_PROVIDER),
    osrmBaseUrl: normalizeBaseUrl(env.ROUTING_OSRM_BASE_URL),
    timeoutMs: normalizeTimeoutMs(env.ROUTING_REQUEST_TIMEOUT_MS)
  };
}

export async function createTravelEstimator({ points = [], context = {}, speedKmh = null }) {
  const normalizedSpeedKmh = normalizeSpeedKmh(speedKmh);
  const { unique, index } = dedupePoints(points);
  if (!unique.length) {
    return buildStraightLineEstimator(normalizedSpeedKmh);
  }

  const options = resolveRoutingOptions(context);
  if (options.provider !== "OSRM" || unique.length > MAX_OSRM_TABLE_COORDINATES) {
    return buildStraightLineEstimator(normalizedSpeedKmh);
  }

  try {
    const { durations } = await fetchOsrmTable({
      points: unique,
      osrmBaseUrl: options.osrmBaseUrl,
      timeoutMs: options.timeoutMs
    });
    return buildMatrixEstimator({
      points: unique,
      pointIndex: index,
      durations,
      speedKmh: normalizedSpeedKmh
    });
  } catch (_error) {
    return buildStraightLineEstimator(normalizedSpeedKmh);
  }
}

export async function resolveRoutePath({ points = [], context = {}, speedKmh = null }) {
  const normalized = points.map(normalizePoint).filter(Boolean);
  const options = resolveRoutingOptions(context);
  const normalizedSpeedKmh = normalizeSpeedKmh(speedKmh);
  const cacheKey = buildRoutePathCacheKey({
    points: normalized,
    options,
    speedKmh: normalizedSpeedKmh
  });
  const cached = getRoutePathCacheEntry(cacheKey);
  if (cached?.value) {
    return cloneRoutePath(cached.value);
  }
  if (cached?.promise) {
    const shared = await cached.promise;
    return cloneRoutePath(shared);
  }

  const canUseOsrm =
    options.provider === "OSRM" &&
    normalized.length >= 2 &&
    normalized.length <= MAX_OSRM_ROUTE_COORDINATES;

  const pendingPromise = (async () => {
    if (canUseOsrm) {
      try {
        return await fetchOsrmRoute({
          points: normalized,
          osrmBaseUrl: options.osrmBaseUrl,
          timeoutMs: options.timeoutMs
        });
      } catch (_error) {
        // Fallback to straight-line when routing API is unavailable.
      }
    }
    return buildStraightLineRoutePath(normalized, normalizedSpeedKmh);
  })();

  setRoutePathCacheEntry(cacheKey, {
    promise: pendingPromise,
    expiresAt: Date.now() + Math.max(options.timeoutMs * 2, 5000)
  });

  try {
    const resolved = await pendingPromise;
    const ttlMs =
      resolved.source === "OSRM" || !canUseOsrm
        ? ROUTE_PATH_CACHE_TTL_MS
        : ROUTE_PATH_FALLBACK_CACHE_TTL_MS;
    setRoutePathCacheEntry(cacheKey, {
      value: resolved,
      expiresAt: Date.now() + ttlMs
    });
    return cloneRoutePath(resolved);
  } catch (error) {
    routePathCache.delete(cacheKey);
    throw error;
  }
}
