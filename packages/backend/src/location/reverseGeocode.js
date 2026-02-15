const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
const DEFAULT_TIMEOUT_MS = 3500;
const DEFAULT_USER_AGENT = "ReqmoDispatcher/1.0 (reverse geocode)";

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function findFirstLabel(candidates) {
  for (const candidate of candidates) {
    const text = trimText(candidate);
    if (text) {
      return text;
    }
  }
  return "";
}

function normalizeStationTitle(stationName) {
  const name = trimText(stationName);
  if (!name) {
    return "";
  }
  return name.endsWith("駅") ? `${name}前` : `${name}駅前`;
}

function normalizeNearbyTitle(baseName, suffix = "近く") {
  const name = trimText(baseName);
  if (!name) {
    return "";
  }
  if (name.endsWith("駅")) {
    return `${name}前`;
  }
  return `${name}${suffix}`;
}

function buildTitleFromAddress(address) {
  if (!address || typeof address !== "object") {
    return "";
  }

  const station = findFirstLabel([
    address.station,
    address.train_station,
    address.railway
  ]);
  if (station) {
    return normalizeStationTitle(station);
  }

  const landmark = findFirstLabel([
    address.amenity,
    address.tourism,
    address.building,
    address.shop,
    address.office,
    address.university,
    address.school,
    address.hospital
  ]);
  if (landmark) {
    return normalizeNearbyTitle(landmark, "近く");
  }

  const area = findFirstLabel([
    address.neighbourhood,
    address.suburb,
    address.quarter,
    address.city_district,
    address.road,
    address.hamlet,
    address.village,
    address.town,
    address.city
  ]);
  if (area) {
    return normalizeNearbyTitle(area, "付近");
  }

  return "";
}

function buildTitleFromDisplayName(displayName) {
  const firstToken = trimText(displayName).split(",")[0]?.trim() ?? "";
  if (!firstToken) {
    return "";
  }
  return normalizeNearbyTitle(firstToken, "付近");
}

function buildFallbackTitle(lat, lng) {
  return `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}付近`;
}

export async function reverseGeocodePoint({
  lat,
  lng,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  userAgent = DEFAULT_USER_AGENT,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) {
    throw new Error("lat/lng must be finite numbers");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available for reverse geocoding");
  }

  const latitude = Number(lat);
  const longitude = Number(lng);
  const query = new URLSearchParams({
    format: "jsonv2",
    lat: String(latitude),
    lon: String(longitude),
    zoom: "18",
    addressdetails: "1",
    "accept-language": "ja"
  });
  const url = `${NOMINATIM_REVERSE_URL}?${query.toString()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": userAgent
      },
      signal: controller.signal
    });

    if (!response.ok) {
      return {
        title: buildFallbackTitle(latitude, longitude),
        source: "FALLBACK",
        reason: `HTTP_${response.status}`
      };
    }

    const payload = await response.json();
    const title =
      buildTitleFromAddress(payload?.address) ||
      buildTitleFromDisplayName(payload?.display_name);

    if (title) {
      return {
        title,
        source: "REVERSE_GEOCODE",
        displayName: trimText(payload?.display_name) || null
      };
    }

    return {
      title: buildFallbackTitle(latitude, longitude),
      source: "FALLBACK",
      displayName: trimText(payload?.display_name) || null
    };
  } catch (_error) {
    return {
      title: buildFallbackTitle(latitude, longitude),
      source: "FALLBACK",
      reason: "NETWORK_ERROR"
    };
  } finally {
    clearTimeout(timeout);
  }
}
