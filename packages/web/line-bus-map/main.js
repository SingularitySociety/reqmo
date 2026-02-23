const API_BASE =
  window.location.protocol === "file:" ? "http://localhost:18787" : "";

const REFRESH_INTERVAL_MS = 15000;
const SHIMANTO_FALLBACK_POINT = {
  lat: 32.9912,
  lng: 132.9339
};

const elements = {
  statusMessage: document.getElementById("status-message"),
  refreshButton: document.getElementById("refresh-button"),
  fitButton: document.getElementById("fit-button"),
  vehicleMap: document.getElementById("vehicle-map"),
  vehicleList: document.getElementById("vehicle-list")
};

const state = {
  map: null,
  markers: new Map(),
  hasInitialFit: false,
  timerId: null
};

function buildApiUrl(path) {
  if (API_BASE) {
    return `${API_BASE}${path}`;
  }
  return path;
}

function escapeHtml(raw) {
  const value = typeof raw === "string" ? raw : String(raw ?? "");
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setStatus(message, tone = "info") {
  if (!elements.statusMessage) {
    return;
  }
  elements.statusMessage.textContent = message || "";
  elements.statusMessage.dataset.tone = tone;
}

async function apiGet(path) {
  const response = await fetch(buildApiUrl(path), {
    headers: {
      Accept: "application/json"
    }
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function resolveVehiclePoint(vehicle) {
  const fromCurrent = vehicle?.currentLocation;
  const currentLat = toFiniteNumber(fromCurrent?.lat);
  const currentLng = toFiniteNumber(fromCurrent?.lng);
  if (currentLat !== null && currentLng !== null) {
    return {
      lat: currentLat,
      lng: currentLng
    };
  }

  const firstRoutePoint = Array.isArray(vehicle?.route)
    ? vehicle.route.find((task) => task?.point)
    : null;
  const routeLat = toFiniteNumber(firstRoutePoint?.point?.lat);
  const routeLng = toFiniteNumber(firstRoutePoint?.point?.lng);
  if (routeLat !== null && routeLng !== null) {
    return {
      lat: routeLat,
      lng: routeLng
    };
  }

  return null;
}

function formatDateTime(value) {
  if (!value) {
    return "未取得";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "未取得";
  }
  return parsed.toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function formatCoordinate(value) {
  const number = toFiniteNumber(value);
  if (number === null) {
    return "-";
  }
  return number.toFixed(5);
}

function normalizeVehicleStatus(value) {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  return normalized || "UNKNOWN";
}

function resolveVehicleStatusTone(status) {
  if (status === "ACTIVE") {
    return "active";
  }
  if (status === "INACTIVE") {
    return "inactive";
  }
  return "unknown";
}

function buildVehiclePopup(vehicle, point) {
  const status = normalizeVehicleStatus(vehicle?.status);
  const id = escapeHtml(vehicle?.id || "-");
  const onboardCount = Number.isFinite(Number(vehicle?.onboardCount))
    ? Number(vehicle.onboardCount)
    : 0;
  const capacity = Number.isFinite(Number(vehicle?.capacity))
    ? Number(vehicle.capacity)
    : null;
  const occupancy = capacity !== null ? `${onboardCount}/${capacity}` : `${onboardCount}`;
  const lat = formatCoordinate(point?.lat);
  const lng = formatCoordinate(point?.lng);
  return [
    `<div class="lb-popup">`,
    `<strong>${id}</strong>`,
    `<div>状態: ${escapeHtml(status)}</div>`,
    `<div>乗車人数: ${escapeHtml(String(occupancy))}</div>`,
    `<div>座標: ${escapeHtml(lat)}, ${escapeHtml(lng)}</div>`,
    `</div>`
  ].join("");
}

function createMarker(point, status) {
  const tone = resolveVehicleStatusTone(status);
  const color = tone === "active" ? "#0ea5e9" : tone === "inactive" ? "#94a3b8" : "#f59e0b";
  return window.L.circleMarker([point.lat, point.lng], {
    radius: 9,
    color,
    fillColor: color,
    fillOpacity: 0.9,
    weight: 2
  });
}

function upsertVehicleMarker(vehicle, point) {
  if (!state.map || !point || !vehicle?.id) {
    return;
  }
  const key = vehicle.id;
  const status = normalizeVehicleStatus(vehicle.status);
  const popupHtml = buildVehiclePopup(vehicle, point);
  const existing = state.markers.get(key);
  if (existing) {
    existing.setLatLng([point.lat, point.lng]);
    existing.setPopupContent(popupHtml);
    return;
  }
  const marker = createMarker(point, status);
  marker.bindPopup(popupHtml);
  marker.addTo(state.map);
  state.markers.set(key, marker);
}

function removeStaleMarkers(activeVehicleIds) {
  for (const [vehicleId, marker] of state.markers.entries()) {
    if (activeVehicleIds.has(vehicleId)) {
      continue;
    }
    marker.remove();
    state.markers.delete(vehicleId);
  }
}

function renderVehicleList(vehicles) {
  if (!elements.vehicleList) {
    return;
  }
  const list = Array.isArray(vehicles) ? vehicles.slice() : [];
  list.sort((a, b) => String(a?.id || "").localeCompare(String(b?.id || ""), "ja-JP"));
  if (!list.length) {
    elements.vehicleList.innerHTML = '<li class="lb-empty">現在表示できる車両はありません。</li>';
    return;
  }
  elements.vehicleList.innerHTML = list
    .map((vehicle) => {
      const id = escapeHtml(vehicle?.id || "-");
      const status = normalizeVehicleStatus(vehicle?.status);
      const tone = resolveVehicleStatusTone(status);
      const point = resolveVehiclePoint(vehicle);
      const lat = formatCoordinate(point?.lat);
      const lng = formatCoordinate(point?.lng);
      const onboardCount = Number.isFinite(Number(vehicle?.onboardCount))
        ? Number(vehicle.onboardCount)
        : 0;
      const capacity = Number.isFinite(Number(vehicle?.capacity))
        ? Number(vehicle.capacity)
        : null;
      const occupancy = capacity !== null ? `${onboardCount}/${capacity}` : `${onboardCount}`;
      const updatedAt = formatDateTime(vehicle?.updatedAt);
      return [
        '<li class="lb-vehicle-item">',
        '<div class="lb-vehicle-head">',
        `<span class="lb-vehicle-id">${id}</span>`,
        `<span class="lb-status-pill lb-status-pill-${tone}">${escapeHtml(status)}</span>`,
        "</div>",
        `<div class="lb-vehicle-meta">乗車人数: ${escapeHtml(String(occupancy))}</div>`,
        `<div class="lb-vehicle-meta">座標: ${escapeHtml(lat)}, ${escapeHtml(lng)}</div>`,
        `<div class="lb-vehicle-meta">更新: ${escapeHtml(updatedAt)}</div>`,
        "</li>"
      ].join("");
    })
    .join("");
}

function fitMapToVehicles(points, forceFit = false) {
  if (!state.map || !Array.isArray(points) || points.length === 0) {
    return;
  }
  if (!forceFit && state.hasInitialFit) {
    return;
  }
  const bounds = window.L.latLngBounds(points.map((point) => [point.lat, point.lng]));
  state.map.fitBounds(bounds.pad(0.25), { maxZoom: 15 });
  state.hasInitialFit = true;
}

async function refreshVehicles({ forceFit = false } = {}) {
  setStatus("車両情報を更新中です...", "info");
  const payload = await apiGet("/api/vehicles");
  const vehicles = Array.isArray(payload?.data) ? payload.data : [];
  const activeVehicleIds = new Set();
  const availablePoints = [];
  vehicles.forEach((vehicle) => {
    const vehicleId = typeof vehicle?.id === "string" ? vehicle.id : "";
    if (vehicleId) {
      activeVehicleIds.add(vehicleId);
    }
    const point = resolveVehiclePoint(vehicle);
    if (!point) {
      return;
    }
    availablePoints.push(point);
    upsertVehicleMarker(vehicle, point);
  });
  removeStaleMarkers(activeVehicleIds);
  renderVehicleList(vehicles);
  fitMapToVehicles(availablePoints, forceFit);

  const updatedText = new Date().toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  if (vehicles.length === 0) {
    setStatus(`車両データがありません (${updatedText})`, "warn");
    return;
  }
  if (availablePoints.length === 0) {
    setStatus(`車両${vehicles.length}台を取得しましたが、位置情報がありません (${updatedText})`, "warn");
    return;
  }
  setStatus(`車両${vehicles.length}台 / 位置情報あり${availablePoints.length}台 (${updatedText})`, "success");
}

function setupMap() {
  if (!elements.vehicleMap || !window.L) {
    throw new Error("地図ライブラリの初期化に失敗しました");
  }
  state.map = window.L.map(elements.vehicleMap, {
    zoomControl: true
  });
  window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
  }).addTo(state.map);
  state.map.setView([SHIMANTO_FALLBACK_POINT.lat, SHIMANTO_FALLBACK_POINT.lng], 12);
}

function attachEvents() {
  if (elements.refreshButton) {
    elements.refreshButton.addEventListener("click", () => {
      void refreshVehicles({ forceFit: false }).catch((error) => {
        setStatus(`更新に失敗しました: ${error instanceof Error ? error.message : "不明なエラー"}`, "error");
      });
    });
  }
  if (elements.fitButton) {
    elements.fitButton.addEventListener("click", () => {
      const points = [];
      for (const marker of state.markers.values()) {
        const latLng = marker.getLatLng();
        points.push({
          lat: latLng.lat,
          lng: latLng.lng
        });
      }
      fitMapToVehicles(points, true);
    });
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      void refreshVehicles({ forceFit: false }).catch(() => {});
    }
  });
  window.addEventListener("beforeunload", () => {
    if (state.timerId !== null) {
      window.clearInterval(state.timerId);
      state.timerId = null;
    }
  });
}

async function init() {
  try {
    setupMap();
    attachEvents();
    await refreshVehicles({ forceFit: true });
    state.timerId = window.setInterval(() => {
      void refreshVehicles({ forceFit: false }).catch((error) => {
        setStatus(`自動更新に失敗しました: ${error instanceof Error ? error.message : "不明なエラー"}`, "error");
      });
    }, REFRESH_INTERVAL_MS);
  } catch (error) {
    setStatus(`初期化に失敗しました: ${error instanceof Error ? error.message : "不明なエラー"}`, "error");
  }
}

void init();
