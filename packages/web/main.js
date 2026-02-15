const { createApp, ref, computed, onMounted, onBeforeUnmount, watch, nextTick, reactive } = Vue;
const { createVuetify } = Vuetify;

const vuetify = createVuetify({
  theme: {
    defaultTheme: "reqmo",
    themes: {
      reqmo: {
        colors: {
          primary: "#0f766e",
          secondary: "#ea580c",
          background: "#f0f4f8"
        }
      }
    }
  }
});

const API_BASE = (() => {
  if (window.REQMO_API_BASE) {
    return window.REQMO_API_BASE;
  }
  if (window.location.protocol === "file:") {
    return "http://localhost:18787";
  }
  return "";
})();
const ROUTE_CACHE_MAX_ENTRIES = 400;
const ROUTE_CACHE_RETRY_MS = 30 * 1000;
const ROUTE_SEGMENT_METRICS_RETRY_MS = 30 * 1000;

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status}`);
  }
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = await res.json();
  if (!res.ok) {
    throw new Error(payload.error ?? `POST ${path} failed`);
  }
  return payload;
}

function parsePointText(text) {
  const [latRaw, lngRaw] = `${text}`.split(",").map((part) => part.trim());
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("自由点は 'lat,lng' 形式で入力してください");
  }
  return { lat, lng };
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatClock(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function formatDateLabel(date) {
  return `${date.getFullYear()}.${pad2(date.getMonth() + 1)}.${pad2(date.getDate())}`;
}

function formatTimeLabel(value) {
  if (!value) {
    return "--:--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }
  return formatClock(date);
}

function buildDesiredDropoffAtFromClock(clockText, baseNow = new Date()) {
  const [hourRaw, minuteRaw] = `${clockText}`.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error("希望降車時刻は HH:mm 形式で入力してください");
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error("希望降車時刻は 00:00 から 23:59 の範囲で入力してください");
  }

  const candidate = new Date(baseNow);
  candidate.setSeconds(0, 0);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() < baseNow.getTime() - 5 * 60 * 1000) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.toISOString();
}

function addMinutes(baseDate, minutes) {
  return new Date(baseDate.getTime() + minutes * 60 * 1000);
}

function hasPoint(point) {
  return Boolean(point) && Number.isFinite(point.lat) && Number.isFinite(point.lng);
}

function roundedEta(value) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

function roundedDistanceKm(value) {
  return Number.isFinite(value) && value >= 0 ? Number(value.toFixed(2)) : null;
}

function pointKey(point) {
  return `${Number(point.lat).toFixed(6)},${Number(point.lng).toFixed(6)}`;
}

function buildRouteSegmentKey(from, to) {
  return `${pointKey(from)}->${pointKey(to)}`;
}

function formatDistanceLabel(distanceKm) {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) {
    return null;
  }
  if (distanceKm < 1) {
    return `${Math.round(distanceKm * 1000)}m`;
  }
  return `${distanceKm.toFixed(distanceKm >= 10 ? 1 : 2)}km`;
}

function formatMinutesLabel(value) {
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  return `${Math.max(0, Math.round(value))}分`;
}

function formatSignedMinutes(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  const rounded = Math.round(value);
  if (rounded === 0) {
    return "0分";
  }
  return rounded > 0 ? `+${rounded}分` : `${rounded}分`;
}

function previewReasonLabel(reason) {
  if (reason === "NO_FEASIBLE_VEHICLE") {
    return "現在の車両状態では予約を受け付けできません。";
  }
  return "予約案を算出できませんでした。";
}

function formatCoordinate(value) {
  return Number.isFinite(value) ? Number(value).toFixed(6) : "-";
}

function statusColor(status) {
  const map = {
    ASSIGNED: "primary",
    PENDING: "warning",
    PICKED_UP: "info",
    COMPLETED: "success",
    CANCELLED: "error"
  };
  return map[status] ?? "default";
}

const LOCATION_INPUT_OPTIONS = [
  {
    title: "バス停を指定",
    value: "FIXED_STOP",
    description: "登録済みのバス停から選択します。"
  },
  {
    title: "自由地点を指定",
    value: "FREE_POINT",
    description: "緯度経度（lat,lng）を直接入力します。"
  }
];

const LOCATION_POLICY_OPTIONS = [
  {
    title: "自由地点のみ",
    value: "FREE_ONLY",
    description: "入力された座標をそのまま配車地点として扱います。"
  },
  {
    title: "仮想停留所のみ",
    value: "VIRTUAL_ONLY",
    description: "最寄りの仮想停留所に補正して配車地点を決定します。"
  },
  {
    title: "自由地点と仮想停留所を併用",
    value: "HYBRID",
    description: "自由地点と仮想停留所の双方を比較し、最適な地点を採用します。"
  }
];

const FARE_MODEL_OPTIONS = [
  {
    title: "固定運賃",
    value: "FIXED",
    description: "距離や時間に関係なく一定料金を適用します。"
  },
  {
    title: "距離連動",
    value: "DISTANCE",
    description: "走行距離に応じて運賃を計算します。"
  },
  {
    title: "時間連動",
    value: "TIME",
    description: "乗車時間に応じて運賃を計算します。"
  },
  {
    title: "ゾーン別",
    value: "ZONAL",
    description: "出発地・到着地のゾーン組み合わせで運賃を決定します。"
  },
  {
    title: "ハイブリッド",
    value: "HYBRID",
    description: "固定・距離・時間の要素を組み合わせて運賃を算出します。"
  }
];

function findOption(options, value) {
  return options.find((option) => option.value === value) ?? null;
}

createApp({
  setup() {
    const drawerOpen = ref(false);
    const settingsOpen = ref(false);
    const loading = ref(false);
    const errorMessage = ref("");
    const activePanel = ref("dispatch"); // dispatch | calls

    const summary = ref({
      vehicles: 0,
      stops: 0,
      rideRequests: 0,
      callEvents: 0,
      serviceProfileId: ""
    });

    const serviceProfile = ref(null);
    const farePolicies = ref([]);
    const stops = ref([]);
    const vehicles = ref([]);
    const requests = ref([]);
    const dispatchPreview = ref(null);
    const previewDialogOpen = ref(false);
    const previewPayload = ref(null);
    const previewDirty = ref(false);
    const callQueue = ref([]);
    const selectedRequestId = ref("");
    const leafletMapEl = ref(null);
    const now = ref(new Date());

    let nowTicker = null;
    let realtimeTicker = null;
    let leafletMap = null;
    let syncingLocationForm = false;
    let hasInitialMapViewport = false;
    let routeRefreshTimer = null;
    const routeGeometryCache = new Map();
    const routeSegmentMetricsCache = reactive(new Map());
    const mapLayers = {
      stops: null,
      vehicleRoutes: null,
      activeRoutes: null,
      selectedRoute: null,
      previewRoute: null,
      focus: null,
      vehicles: null
    };

    const form = ref({
      pickupMode: "FIXED_STOP",
      dropoffMode: "FIXED_STOP",
      pickupStopId: "",
      dropoffStopId: "",
      pickupPoint: "32.9898,132.9298",
      dropoffPoint: "32.9989,132.9341",
      pickupTitle: "",
      dropoffTitle: "",
      passengerName: "",
      passengerPhone: "",
      partySize: 1,
      desiredTime: formatClock(new Date())
    });

    const callForm = ref({
      callerRaw: "08012345678",
      pickupStopId: "",
      dropoffStopId: "",
      partySize: 1,
      desiredTime: formatClock(new Date())
    });
    const callRideOptions = ref([]);
    const selectedCallOptionId = ref("");
    const callDesiredDropoffAt = ref(null);

    const locationForm = ref({
      vehicleId: "",
      point: "32.9898,132.9298"
    });
    const locationFormDirty = ref(false);
    const locationTitleState = ref({
      pickup: { manual: false, pending: false, requestId: 0, pointKey: "" },
      dropoff: { manual: false, pending: false, requestId: 0, pointKey: "" }
    });

    const profileEditor = ref({
      id: "",
      maxAdvanceDays: 14,
      maxActiveVehicles: 10,
      maxOnboardPerVehicle: 4,
      cruiseSpeedKmh: 25,
      pickupServiceMinutes: 0,
      dropoffServiceMinutes: 0,
      locationMode: "HYBRID",
      fareModel: "HYBRID"
    });

    const availableStops = computed(() => stops.value.map((stop) => ({
      title: `${stop.name} (${stop.id})`,
      value: stop.id
    })));

    const availableVehicles = computed(() => vehicles.value.map((vehicle) => ({
      title: vehicle.id,
      value: vehicle.id
    })));

    const locationInputOptions = LOCATION_INPUT_OPTIONS;
    const locationPolicyOptions = LOCATION_POLICY_OPTIONS;
    const fareModelOptions = FARE_MODEL_OPTIONS;

    const topbarLocationModeTitle = computed(() => {
      const mode = serviceProfile.value?.locationPolicy?.mode ?? "HYBRID";
      return findOption(locationPolicyOptions, mode)?.title ?? mode;
    });

    const pickupModeDescription = computed(
      () => findOption(locationInputOptions, form.value.pickupMode)?.description ?? ""
    );

    const dropoffModeDescription = computed(
      () => findOption(locationInputOptions, form.value.dropoffMode)?.description ?? ""
    );

    const locationModeDescription = computed(
      () => findOption(locationPolicyOptions, profileEditor.value.locationMode)?.description ?? ""
    );

    const fareModelDescription = computed(
      () => findOption(fareModelOptions, profileEditor.value.fareModel)?.description ?? ""
    );

    const stopIndex = computed(() => {
      const index = new Map();
      stops.value.forEach((stop) => {
        index.set(stop.id, stop);
      });
      return index;
    });

    const kpi = computed(() => {
      const assigned = requests.value.filter((request) => request.status === "ASSIGNED").length;
      const pending = requests.value.filter((request) => request.status === "PENDING").length;
      const successRate = requests.value.length
        ? `${Math.round((assigned / requests.value.length) * 100)}%`
        : "-";

      const avgWait = requests.value.length
        ? `${(
            requests.value
              .map((request) => Number(request.assignment?.etaPickupMinutes ?? 0))
              .reduce((acc, value) => acc + value, 0) / requests.value.length
          ).toFixed(1)}分`
        : "-";

      return {
        successRate,
        avgWait,
        pooledRate: `${serviceProfile.value?.poolingPolicy?.enabled ? "ON" : "OFF"}`,
        activeVehicles: summary.value.vehicles,
        pending,
        totalRequests: requests.value.length,
        callCount: summary.value.callEvents
      };
    });

    const currentDateLabel = computed(() => formatDateLabel(now.value));
    const currentClockLabel = computed(() => formatClock(now.value));
    const mapSelectionField = ref("");
    const isMapPicking = computed(() => Boolean(mapSelectionField.value));
    const mapSelectionHint = computed(() => {
      if (!mapSelectionField.value) {
        return "";
      }
      if (mapSelectionField.value === "vehicle") {
        return "車両現在位置を地図で選択中: クリックで座標を設定";
      }
      const isPickup = mapSelectionField.value === "pickup";
      const mode = isPickup ? form.value.pickupMode : form.value.dropoffMode;
      const targetLabel = isPickup ? "乗車" : "降車";
      const actionLabel = mode === "FIXED_STOP" ? "最寄りのバス停" : "地点座標";
      return `${targetLabel}地点を地図で選択中: クリックで${actionLabel}を設定`;
    });

    function resolveLocationPoint(location) {
      if (!location) {
        return null;
      }
      if (hasPoint(location.resolvedPoint)) {
        return location.resolvedPoint;
      }
      if (location.mode === "FIXED_STOP" && location.stopId) {
        const stop = stopIndex.value.get(location.stopId);
        if (stop) {
          return { lat: stop.lat, lng: stop.lng };
        }
      }
      if (hasPoint(location.point)) {
        return location.point;
      }
      return null;
    }

    function resolveLocationLabel(location) {
      if (!location) {
        return "未設定";
      }
      const customTitle = typeof location.title === "string" ? location.title.trim() : "";
      if (customTitle) {
        return customTitle;
      }
      if (location.stopId && stopIndex.value.has(location.stopId)) {
        return stopIndex.value.get(location.stopId).name;
      }
      if (location.resolvedAs === "VIRTUAL_STOP") {
        return "仮想停留所";
      }
      if (location.mode === "FREE_POINT" || location.resolvedAs === "FREE_POINT") {
        return "自由地点";
      }
      return "地点";
    }

    function getRouteSegmentMetricsFromCache(from, to) {
      if (!hasPoint(from) || !hasPoint(to)) {
        return null;
      }
      const cacheKey = buildRouteSegmentKey(from, to);
      const cached = routeSegmentMetricsCache.get(cacheKey);
      if (cached?.status !== "ready") {
        return null;
      }
      if (!Number.isFinite(cached.distanceKm) || !Number.isFinite(cached.durationMinutes)) {
        return null;
      }
      return {
        distanceKm: Math.max(0, Number(cached.distanceKm)),
        durationMinutes: Math.max(0, Number(cached.durationMinutes))
      };
    }

    async function requestRouteSegmentMetrics(from, to) {
      if (!hasPoint(from) || !hasPoint(to)) {
        return;
      }
      const cacheKey = buildRouteSegmentKey(from, to);
      const cached = routeSegmentMetricsCache.get(cacheKey);
      if (cached?.status === "pending") {
        return;
      }
      if (
        cached?.status === "failed" &&
        Number.isFinite(cached.failedAt) &&
        Date.now() - cached.failedAt < ROUTE_SEGMENT_METRICS_RETRY_MS
      ) {
        return;
      }

      routeSegmentMetricsCache.set(cacheKey, {
        status: "pending"
      });

      try {
        const response = await apiPost("/api/routing/path", {
          points: [from, to]
        });
        const source = typeof response?.source === "string" ? response.source.toUpperCase() : "";
        const durationMinutes = Number(response?.durationMinutes);
        const distanceMeters = Number(response?.distanceMeters);
        if (
          source !== "OSRM" ||
          !Number.isFinite(durationMinutes) ||
          durationMinutes < 0 ||
          !Number.isFinite(distanceMeters) ||
          distanceMeters < 0
        ) {
          routeSegmentMetricsCache.set(cacheKey, {
            status: "failed",
            failedAt: Date.now()
          });
          return;
        }
        routeSegmentMetricsCache.set(cacheKey, {
          status: "ready",
          distanceKm: distanceMeters / 1000,
          durationMinutes
        });
      } catch (_error) {
        routeSegmentMetricsCache.set(cacheKey, {
          status: "failed",
          failedAt: Date.now()
        });
      }
    }

    function primeVehicleRouteSegmentMetrics(vehicle) {
      if (!vehicle || !hasPoint(vehicle.currentLocation)) {
        return;
      }
      const route = Array.isArray(vehicle.route) ? vehicle.route : [];
      if (!route.length) {
        return;
      }

      let current = vehicle.currentLocation;
      for (const task of route) {
        if (!hasPoint(task?.point)) {
          continue;
        }
        void requestRouteSegmentMetrics(current, task.point);
        current = task.point;
      }
    }

    function routeMetricsByRequest(vehicle) {
      if (!vehicle || !hasPoint(vehicle.currentLocation)) {
        return new Map();
      }

      const route = Array.isArray(vehicle.route) ? vehicle.route : [];
      if (!route.length) {
        return new Map();
      }

      const timeline = [];
      let current = vehicle.currentLocation;
      let elapsedMinutes = 0;
      let elapsedDistanceKm = 0;

      for (const task of route) {
        if (!hasPoint(task?.point)) {
          continue;
        }
        const segmentMetrics = getRouteSegmentMetricsFromCache(current, task.point);
        if (!segmentMetrics) {
          void requestRouteSegmentMetrics(current, task.point);
          elapsedDistanceKm = null;
          elapsedMinutes = null;
        } else if (Number.isFinite(elapsedDistanceKm) && Number.isFinite(elapsedMinutes)) {
          elapsedDistanceKm += segmentMetrics.distanceKm;
          elapsedMinutes += segmentMetrics.durationMinutes;
        }
        timeline.push({
          task,
          elapsedDistanceKm,
          elapsedMinutes
        });
        current = task.point;
      }

      const result = new Map();
      for (let index = 0; index < timeline.length; index += 1) {
        const entry = timeline[index];
        const requestId = entry.task?.requestId;
        if (!requestId || entry.task?.type !== "DROPOFF") {
          continue;
        }
        if (result.has(requestId)) {
          continue;
        }

        const nextPickupIndex = timeline.findIndex(
          (candidate, candidateIndex) => candidateIndex > index && candidate.task?.type === "PICKUP"
        );
        const nextPickupEntry = nextPickupIndex >= 0 ? timeline[nextPickupIndex] : null;
        const hasNextPickup = nextPickupEntry !== null;
        const dropoffDistanceKm = Number.isFinite(entry.elapsedDistanceKm) ? entry.elapsedDistanceKm : null;
        const dropoffMinutes = Number.isFinite(entry.elapsedMinutes) ? entry.elapsedMinutes : null;
        const nextPickupDistanceKm =
          hasNextPickup &&
          Number.isFinite(nextPickupEntry.elapsedDistanceKm) &&
          Number.isFinite(entry.elapsedDistanceKm)
            ? Math.max(0, nextPickupEntry.elapsedDistanceKm - entry.elapsedDistanceKm)
            : null;
        const nextPickupMinutes =
          hasNextPickup &&
          Number.isFinite(nextPickupEntry.elapsedMinutes) &&
          Number.isFinite(entry.elapsedMinutes)
            ? Math.max(0, nextPickupEntry.elapsedMinutes - entry.elapsedMinutes)
            : null;

        result.set(requestId, {
          dropoffDistanceKm,
          dropoffMinutes,
          nextPickupDistanceKm,
          nextPickupMinutes,
          hasNextPickup
        });
      }

      return result;
    }

    const requestRouteMetrics = computed(() => {
      const metrics = new Map();
      vehicles.value.forEach((vehicle) => {
        const perVehicle = routeMetricsByRequest(vehicle);
        perVehicle.forEach((value, requestId) => {
          metrics.set(requestId, value);
        });
      });
      return metrics;
    });

    watch(
      vehicles,
      (nextVehicles) => {
        nextVehicles.forEach((vehicle) => {
          primeVehicleRouteSegmentMetrics(vehicle);
        });
      },
      { deep: true, immediate: true }
    );

    const requestRows = computed(() =>
      [...requests.value]
        .sort((left, right) => new Date(left.createdAt ?? 0).getTime() - new Date(right.createdAt ?? 0).getTime())
        .map((request) => {
          const pickupPoint = resolveLocationPoint(request.pickup);
          const dropoffPoint = resolveLocationPoint(request.dropoff);
          const etaRaw = Number(request.assignment?.etaPickupMinutes);
          const etaDropoffRaw = Number(request.assignment?.etaDropoffMinutes);
          const etaMinutes = roundedEta(etaRaw);
          const etaDropoffMinutes = roundedEta(etaDropoffRaw);
          const routeMetrics = requestRouteMetrics.value.get(request.id);
          const dropoffTravelDistanceKm = roundedDistanceKm(routeMetrics?.dropoffDistanceKm);
          const dropoffTravelMinutes = roundedEta(routeMetrics?.dropoffMinutes);
          const nextPickupTravelDistanceKm = roundedDistanceKm(routeMetrics?.nextPickupDistanceKm);
          const nextPickupTravelMinutes = roundedEta(routeMetrics?.nextPickupMinutes);
          const hasNextPickup = Boolean(routeMetrics?.hasNextPickup);
          const plannedPickup = etaMinutes !== null ? addMinutes(now.value, etaMinutes) : new Date(request.createdAt ?? now.value);
          const plannedDropoff = etaDropoffMinutes !== null
            ? addMinutes(now.value, etaDropoffMinutes)
            : new Date(request.createdAt ?? now.value);
          const passengerName =
            typeof request.passenger?.name === "string" ? request.passenger.name.trim() : "";
          const passengerPhone =
            typeof request.passenger?.phoneNumber === "string"
              ? request.passenger.phoneNumber.trim()
              : typeof request.passenger?.phone === "string"
                ? request.passenger.phone.trim()
                : "";

          return {
            id: request.id,
            status: request.status,
            statusColor: statusColor(request.status),
            channel: request.channel,
            partySize: request.partySize ?? 1,
            vehicleId: request.assignment?.vehicleId ?? "-",
            etaMinutes,
            etaDropoffMinutes,
            dropoffTravelDistanceKm,
            dropoffTravelMinutes,
            dropoffTravelDistanceLabel: formatDistanceLabel(dropoffTravelDistanceKm),
            dropoffTravelMinutesLabel: formatMinutesLabel(dropoffTravelMinutes),
            nextPickupTravelDistanceKm,
            nextPickupTravelMinutes,
            nextPickupTravelDistanceLabel: formatDistanceLabel(nextPickupTravelDistanceKm),
            nextPickupTravelMinutesLabel: formatMinutesLabel(nextPickupTravelMinutes),
            hasNextPickup,
            displayTime: formatClock(plannedPickup),
            dropoffDisplayTime: formatClock(plannedDropoff),
            createdTime: formatTimeLabel(request.createdAt),
            pickupLabel: resolveLocationLabel(request.pickup),
            dropoffLabel: resolveLocationLabel(request.dropoff),
            pickupPoint,
            dropoffPoint,
            pickupStopId: request.pickup?.stopId ?? null,
            dropoffStopId: request.dropoff?.stopId ?? null,
            passengerName,
            passengerPhone
          };
        })
    );

    const selectedRequest = computed(() =>
      requestRows.value.find((request) => request.id === selectedRequestId.value) ?? requestRows.value[0] ?? null
    );

    watch(
      requests,
      () => {
        const rows = requestRows.value;
        if (!rows.length) {
          selectedRequestId.value = "";
          return;
        }
        if (!rows.some((row) => row.id === selectedRequestId.value)) {
          selectedRequestId.value = rows[0].id;
        }
      },
      { immediate: true }
    );

    function selectRequest(requestId) {
      selectedRequestId.value = requestId;
      refreshLeafletMap({ focusSelected: true });
    }

    function canCancelRequest(row) {
      return row.status !== "CANCELLED" && row.status !== "COMPLETED" && row.status !== "PICKED_UP";
    }

    const mapRows = computed(() =>
      requestRows.value.map((row) => ({
        id: row.id,
        status: row.status,
        pickupLabel: row.pickupLabel,
        dropoffLabel: row.dropoffLabel,
        pickupPoint: row.pickupPoint,
        dropoffPoint: row.dropoffPoint,
        pickupStopId: row.pickupStopId,
        dropoffStopId: row.dropoffStopId
      }))
    );

    const previewSimulation = computed(() => dispatchPreview.value?.simulation ?? null);
    const hasAssignablePreview = computed(() => dispatchPreview.value?.status === "ASSIGNABLE");
    const previewPickupClock = computed(
      () => formatTimeLabel(previewSimulation.value?.plannedPickupAt)
    );
    const previewDropoffClock = computed(
      () => formatTimeLabel(previewSimulation.value?.plannedDropoffAt)
    );
    const previewRoutePoints = computed(() =>
      (previewSimulation.value?.routeAfter ?? [])
        .map((task) => task.point)
        .filter(hasPoint)
    );
    const selectedVehicle = computed(
      () => vehicles.value.find((vehicle) => vehicle.id === locationForm.value.vehicleId) ?? null
    );
    const selectedVehiclePointLabel = computed(() => {
      const point = selectedVehicle.value?.currentLocation;
      if (!hasPoint(point)) {
        return "--";
      }
      return `${formatCoordinate(point.lat)},${formatCoordinate(point.lng)}`;
    });

    const mapSourcePoints = computed(() => {
      const points = [];
      stops.value.forEach((stop) => {
        if (hasPoint(stop)) {
          points.push({ lat: stop.lat, lng: stop.lng });
        }
      });
      vehicles.value.forEach((vehicle) => {
        if (hasPoint(vehicle.currentLocation)) {
          points.push(vehicle.currentLocation);
        }
      });
      mapRows.value.forEach((row) => {
        if (hasPoint(row.pickupPoint)) {
          points.push(row.pickupPoint);
        }
        if (hasPoint(row.dropoffPoint)) {
          points.push(row.dropoffPoint);
        }
      });
      previewRoutePoints.value.forEach((point) => {
        points.push(point);
      });
      return points;
    });

    const hasStopData = computed(() => stops.value.some((stop) => hasPoint(stop)));

    function toPointText(lat, lng) {
      return `${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
    }

    function normalizeLocationTitle(value) {
      return typeof value === "string" ? value.trim() : "";
    }

    function findNearestStop(point) {
      let nearestStop = null;
      let nearestDistance = Infinity;
      stops.value.forEach((stop) => {
        if (!hasPoint(stop)) {
          return;
        }
        const latDiff = stop.lat - point.lat;
        const lngDiff = stop.lng - point.lng;
        const distance = latDiff * latDiff + lngDiff * lngDiff;
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestStop = stop;
        }
      });
      return nearestStop;
    }

    function locationTitlePointKey(point) {
      return `${Number(point.lat).toFixed(6)},${Number(point.lng).toFixed(6)}`;
    }

    function buildFreePointFallbackTitle(point) {
      const nearestStop = findNearestStop(point);
      if (nearestStop?.name) {
        return `${nearestStop.name}近く`;
      }
      return `${formatCoordinate(point.lat)},${formatCoordinate(point.lng)}付近`;
    }

    function onLocationTitleInput(field, value) {
      const normalized = typeof value === "string" ? value : "";
      if (field === "pickup") {
        form.value.pickupTitle = normalized;
      } else if (field === "dropoff") {
        form.value.dropoffTitle = normalized;
      } else {
        return;
      }
      locationTitleState.value[field].manual = true;
    }

    async function suggestLocationTitle(field, { force = false } = {}) {
      if (field !== "pickup" && field !== "dropoff") {
        return;
      }

      const isPickup = field === "pickup";
      const mode = isPickup ? form.value.pickupMode : form.value.dropoffMode;
      if (mode !== "FREE_POINT") {
        return;
      }

      const pointText = isPickup ? form.value.pickupPoint : form.value.dropoffPoint;
      const currentTitle = normalizeLocationTitle(
        isPickup ? form.value.pickupTitle : form.value.dropoffTitle
      );
      const state = locationTitleState.value[field];

      let point;
      try {
        point = parsePointText(pointText);
      } catch (_error) {
        return;
      }

      const pointKey = locationTitlePointKey(point);
      if (!force && state.manual && currentTitle) {
        return;
      }
      if (!force && state.pointKey === pointKey && currentTitle) {
        return;
      }

      state.requestId += 1;
      const requestId = state.requestId;
      state.pending = true;

      try {
        const query = new URLSearchParams({
          lat: String(point.lat),
          lng: String(point.lng)
        });
        const response = await apiGet(`/api/geocode/reverse?${query.toString()}`);
        if (locationTitleState.value[field].requestId !== requestId) {
          return;
        }
        const suggestedTitle =
          normalizeLocationTitle(response?.title) || buildFreePointFallbackTitle(point);
        if (isPickup) {
          form.value.pickupTitle = suggestedTitle;
        } else {
          form.value.dropoffTitle = suggestedTitle;
        }
        state.manual = false;
        state.pointKey = pointKey;
      } catch (_error) {
        if (locationTitleState.value[field].requestId !== requestId) {
          return;
        }
        if (!state.manual || force || !currentTitle) {
          const fallbackTitle = buildFreePointFallbackTitle(point);
          if (isPickup) {
            form.value.pickupTitle = fallbackTitle;
          } else {
            form.value.dropoffTitle = fallbackTitle;
          }
          state.manual = false;
        }
        state.pointKey = pointKey;
      } finally {
        if (locationTitleState.value[field].requestId === requestId) {
          state.pending = false;
        }
      }
    }

    function cancelMapSelection() {
      mapSelectionField.value = "";
    }

    function applyMapSelection(field, point) {
      if (field !== "pickup" && field !== "dropoff" && field !== "vehicle") {
        return;
      }

      if (field === "vehicle") {
        const selectedPoint = { lat: Number(point.lat), lng: Number(point.lng) };
        locationForm.value.point = toPointText(selectedPoint.lat, selectedPoint.lng);
        locationFormDirty.value = true;
        cancelMapSelection();
        void updateVehicleLocationFromForm({
          point: selectedPoint,
          source: "MAP_PICKER"
        });
        return;
      }

      const isPickup = field === "pickup";
      const mode = isPickup ? form.value.pickupMode : form.value.dropoffMode;

      if (mode === "FIXED_STOP") {
        const nearestStop = findNearestStop(point);
        if (!nearestStop) {
          throw new Error("停留所データがないため、地図からバス停を選択できません。");
        }
        if (isPickup) {
          form.value.pickupStopId = nearestStop.id;
        } else {
          form.value.dropoffStopId = nearestStop.id;
        }
      } else {
        const pointText = toPointText(point.lat, point.lng);
        if (isPickup) {
          form.value.pickupPoint = pointText;
        } else {
          form.value.dropoffPoint = pointText;
        }
        void suggestLocationTitle(field);
      }

      cancelMapSelection();
    }

    function onLeafletMapClick(event) {
      if (!mapSelectionField.value) {
        return;
      }
      try {
        applyMapSelection(mapSelectionField.value, event.latlng);
      } catch (error) {
        errorMessage.value = error.message;
      }
    }

    function toggleMapSelection(field) {
      if (field !== "pickup" && field !== "dropoff" && field !== "vehicle") {
        return;
      }
      if (!ensureLeafletMap()) {
        return;
      }
      if (mapSelectionField.value === field) {
        cancelMapSelection();
        return;
      }
      errorMessage.value = "";
      mapSelectionField.value = field;
    }

    function ensureLeafletMap() {
      if (leafletMap || !leafletMapEl.value) {
        return Boolean(leafletMap);
      }

      const leaflet = window.L;
      if (!leaflet) {
        errorMessage.value = "Leaflet の読み込みに失敗しました。";
        return false;
      }

      leafletMap = leaflet.map(leafletMapEl.value, {
        zoomControl: true,
        attributionControl: true
      });

      leaflet
        .tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: "&copy; OpenStreetMap contributors"
        })
        .addTo(leafletMap);

      mapLayers.stops = leaflet.layerGroup().addTo(leafletMap);
      mapLayers.vehicleRoutes = leaflet.layerGroup().addTo(leafletMap);
      mapLayers.activeRoutes = leaflet.layerGroup().addTo(leafletMap);
      mapLayers.selectedRoute = leaflet.layerGroup().addTo(leafletMap);
      mapLayers.previewRoute = leaflet.layerGroup().addTo(leafletMap);
      mapLayers.focus = leaflet.layerGroup().addTo(leafletMap);
      mapLayers.vehicles = leaflet.layerGroup().addTo(leafletMap);

      leafletMap.setView([32.9898, 132.9298], 13);
      leafletMap.on("click", onLeafletMapClick);
      return true;
    }

    function clearLeafletLayers() {
      Object.values(mapLayers).forEach((layer) => layer?.clearLayers());
    }

    function toLeafletLatLng(point) {
      return [point.lat, point.lng];
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

    function scheduleRouteMapRefresh() {
      if (!leafletMap || routeRefreshTimer) {
        return;
      }
      routeRefreshTimer = setTimeout(() => {
        routeRefreshTimer = null;
        if (leafletMap) {
          refreshLeafletMap();
        }
      }, 0);
    }

    async function requestRouteGeometry(cacheKey, points) {
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

      setRouteCacheEntry(cacheKey, {
        status: "pending"
      });

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
        scheduleRouteMapRefresh();
      }
    }

    function drawRoutePolyline({ leaflet, layer, points, style }) {
      const normalized = normalizeRoutePoints(points);
      if (normalized.length < 2) {
        return;
      }

      const cacheKey = buildRouteCacheKey(normalized);
      const cached = routeGeometryCache.get(cacheKey);
      let drawPoints = normalized;
      if (cached?.status === "ready" && Array.isArray(cached.polyline) && cached.polyline.length > 1) {
        drawPoints = cached.polyline;
      } else {
        void requestRouteGeometry(cacheKey, normalized);
      }

      leaflet
        .polyline(drawPoints.map(toLeafletLatLng), style)
        .addTo(layer);
    }

    function refreshLeafletMap({ fitToData = false, focusSelected = false } = {}) {
      if (!ensureLeafletMap()) {
        return;
      }

      const leaflet = window.L;
      clearLeafletLayers();

      const selectedStopIds = new Set();
      if (selectedRequest.value?.pickupStopId) {
        selectedStopIds.add(selectedRequest.value.pickupStopId);
      }
      if (selectedRequest.value?.dropoffStopId) {
        selectedStopIds.add(selectedRequest.value.dropoffStopId);
      }

      stops.value.forEach((stop) => {
        if (!hasPoint(stop)) {
          return;
        }
        const isSelected = selectedStopIds.has(stop.id);
        const onStopClick = () => {
          if (mapSelectionField.value) {
            applyMapSelection(mapSelectionField.value, { lat: stop.lat, lng: stop.lng });
          }
        };

        leaflet
          .circleMarker(toLeafletLatLng(stop), {
            radius: isSelected ? 16 : 14,
            color: "transparent",
            weight: 0,
            fillColor: "transparent",
            fillOpacity: 0
          })
          .on("click", onStopClick)
          .addTo(mapLayers.stops);

        leaflet
          .circleMarker(toLeafletLatLng(stop), {
            radius: isSelected ? 9 : 7.5,
            color: isSelected ? "#1d4ed8" : "#1e3a8a",
            weight: isSelected ? 3 : 2,
            fillColor: isSelected ? "#f97316" : "#facc15",
            fillOpacity: isSelected ? 0.98 : 0.9
          })
          .bindTooltip(stop.name, { direction: "top", offset: [0, -6] })
          .on("click", onStopClick)
          .addTo(mapLayers.stops);
      });

      vehicles.value.forEach((vehicle) => {
        if (!hasPoint(vehicle.currentLocation)) {
          return;
        }

        const isSelectedVehicle = vehicle.id === locationForm.value.vehicleId;
        const tooltipText = `${vehicle.id} 現在地 ${formatTimeLabel(vehicle.lastLocationAt)}`;

        leaflet
          .circleMarker(toLeafletLatLng(vehicle.currentLocation), {
            radius: isSelectedVehicle ? 12 : 9,
            color: isSelectedVehicle ? "#082f49" : "#e0f2fe",
            weight: isSelectedVehicle ? 2.5 : 1.5,
            fillColor: isSelectedVehicle ? "#38bdf8" : "#7dd3fc",
            fillOpacity: isSelectedVehicle ? 0.4 : 0.28
          })
          .addTo(mapLayers.vehicles);

        const vehicleMarker = leaflet
          .circleMarker(toLeafletLatLng(vehicle.currentLocation), {
            radius: isSelectedVehicle ? 7 : 6,
            color: "#e0f2fe",
            weight: 2,
            fillColor: isSelectedVehicle ? "#0369a1" : "#0284c7",
            fillOpacity: 0.95
          })
          .bindTooltip(tooltipText, {
            direction: "right",
            offset: [8, 0],
            permanent: isSelectedVehicle
          })
          .bindPopup(
            `<strong>${vehicle.id}</strong><br>現在地: ${formatCoordinate(vehicle.currentLocation.lat)}, ${formatCoordinate(vehicle.currentLocation.lng)}<br>最終更新: ${vehicle.lastLocationAt ?? "-"}`
          );
        vehicleMarker.addTo(mapLayers.vehicles);

        const routeLatLngs = [vehicle.currentLocation, ...(vehicle.route ?? []).map((task) => task.point)].filter(hasPoint);
        if (routeLatLngs.length > 1) {
          drawRoutePolyline({
            leaflet,
            layer: mapLayers.vehicleRoutes,
            points: routeLatLngs,
            style: {
              color: "#0f766e",
              weight: 3,
              opacity: 0.42,
              dashArray: "8 8"
            }
          });
        }
      });

      if (hasAssignablePreview.value && previewSimulation.value) {
        const previewVehicle = vehicles.value.find(
          (vehicle) => vehicle.id === previewSimulation.value.vehicleId
        );
        const previewPath = [
          previewVehicle?.currentLocation,
          ...(previewSimulation.value.routeAfter ?? []).map((task) => task.point)
        ].filter(hasPoint);

        if (previewPath.length > 1) {
          drawRoutePolyline({
            leaflet,
            layer: mapLayers.previewRoute,
            points: previewPath,
            style: {
              color: "#f59e0b",
              weight: 5,
              opacity: 0.8
            }
          });
        }

        (previewSimulation.value.routeAfter ?? []).forEach((task) => {
          if (!hasPoint(task.point)) {
            return;
          }
          const taskTypeLabel = task.type === "PICKUP" ? "乗車" : "降車";
          leaflet
            .circleMarker(toLeafletLatLng(task.point), {
              radius: 6,
              color: "#fef3c7",
              weight: 2,
              fillColor: task.type === "PICKUP" ? "#047857" : "#b45309",
              fillOpacity: 0.95
            })
            .bindTooltip(
              `${task.sequence}. ${taskTypeLabel} ${task.locationLabel} (${formatTimeLabel(task.etaAt)})`,
              {
                direction: "top"
              }
            )
            .addTo(mapLayers.previewRoute);
        });
      }

      mapRows.value
        .filter((row) => row.id !== selectedRequest.value?.id)
        .filter((row) => row.status === "ASSIGNED" || row.status === "PICKED_UP")
        .forEach((row) => {
          const routePoints = [row.pickupPoint, row.dropoffPoint].filter(hasPoint);
          if (routePoints.length < 2) {
            return;
          }
          drawRoutePolyline({
            leaflet,
            layer: mapLayers.activeRoutes,
            points: routePoints,
            style: {
              color: "#0e7490",
              weight: 4,
              opacity: 0.45
            }
          });
        });

      const selectedRoutePoints = selectedRequest.value
        ? [selectedRequest.value.pickupPoint, selectedRequest.value.dropoffPoint].filter(hasPoint)
        : [];
      if (selectedRoutePoints.length > 1) {
        drawRoutePolyline({
          leaflet,
          layer: mapLayers.selectedRoute,
          points: selectedRoutePoints,
          style: {
            color: "#ea580c",
            weight: 6,
            opacity: 0.9
          }
        });
      }

      if (selectedRequest.value?.pickupPoint && hasPoint(selectedRequest.value.pickupPoint)) {
        leaflet
          .circleMarker(toLeafletLatLng(selectedRequest.value.pickupPoint), {
            radius: 8,
            color: "#ecfdf5",
            weight: 2,
            fillColor: "#0f766e",
            fillOpacity: 0.95
          })
          .bindTooltip(`乗車: ${selectedRequest.value.pickupLabel}`, {
            permanent: true,
            direction: "top",
            offset: [0, -8]
          })
          .addTo(mapLayers.focus);
      }
      if (selectedRequest.value?.dropoffPoint && hasPoint(selectedRequest.value.dropoffPoint)) {
        leaflet
          .circleMarker(toLeafletLatLng(selectedRequest.value.dropoffPoint), {
            radius: 8,
            color: "#fff7ed",
            weight: 2,
            fillColor: "#ea580c",
            fillOpacity: 0.95
          })
          .bindTooltip(`降車: ${selectedRequest.value.dropoffLabel}`, {
            permanent: true,
            direction: "top",
            offset: [0, -8]
          })
          .addTo(mapLayers.focus);
      }

      const allPoints = mapSourcePoints.value.map((point) => toLeafletLatLng(point));
      if ((fitToData || !hasInitialMapViewport) && allPoints.length) {
        leafletMap.fitBounds(leaflet.latLngBounds(allPoints).pad(0.15), {
          maxZoom: 15
        });
        hasInitialMapViewport = true;
        return;
      }

      if (focusSelected && selectedRoutePoints.length) {
        leafletMap.flyToBounds(leaflet.latLngBounds(selectedRoutePoints.map(toLeafletLatLng)).pad(0.42), {
          maxZoom: 16,
          duration: 0.45
        });
      }
    }

    function syncLocationFormWithVehicles() {
      syncingLocationForm = true;
      if (!vehicles.value.length) {
        locationForm.value.vehicleId = "";
        locationFormDirty.value = false;
        syncingLocationForm = false;
        return;
      }

      const selectedVehicleEntry = vehicles.value.find(
        (vehicle) => vehicle.id === locationForm.value.vehicleId
      );
      const targetVehicle = selectedVehicleEntry ?? vehicles.value[0];
      locationForm.value.vehicleId = targetVehicle.id;
      if (!locationFormDirty.value && hasPoint(targetVehicle.currentLocation)) {
        locationForm.value.point = toPointText(
          targetVehicle.currentLocation.lat,
          targetVehicle.currentLocation.lng
        );
      }
      syncingLocationForm = false;
    }

    async function refreshAll() {
      loading.value = true;
      errorMessage.value = "";

      try {
        const [state, stopRes, requestRes, callRes, profileRes, fareRes, vehicleRes] = await Promise.all([
          apiGet("/api/state"),
          apiGet("/api/stops"),
          apiGet("/api/ride-requests"),
          apiGet("/api/call-events"),
          apiGet("/api/service-profiles"),
          apiGet("/api/fare-policies"),
          apiGet("/api/vehicles")
        ]);

        summary.value = state;
        stops.value = stopRes.data ?? [];
        requests.value = requestRes.data ?? [];
        callQueue.value = callRes.data ?? [];
        farePolicies.value = fareRes.data ?? [];
        vehicles.value = vehicleRes.data ?? [];
        syncLocationFormWithVehicles();

        const activeId = profileRes.activeServiceProfileId;
        const activeProfile = (profileRes.data ?? []).find((profile) => profile.id === activeId) ?? profileRes.data?.[0] ?? null;
        serviceProfile.value = activeProfile;

        if (activeProfile) {
          const farePolicy = farePolicies.value.find((policy) => policy.id === activeProfile.farePolicyRef);
          profileEditor.value = {
            id: activeProfile.id,
            maxAdvanceDays: activeProfile.reservationPolicy?.maxAdvanceDays ?? 14,
            maxActiveVehicles: activeProfile.fleetPolicy?.maxActiveVehicles ?? 10,
            maxOnboardPerVehicle: activeProfile.poolingPolicy?.maxOnboardPerVehicle ?? 4,
            cruiseSpeedKmh: activeProfile.dispatchPolicy?.cruiseSpeedKmh ?? 25,
            pickupServiceMinutes: activeProfile.dispatchPolicy?.pickupServiceMinutes ?? 0,
            dropoffServiceMinutes: activeProfile.dispatchPolicy?.dropoffServiceMinutes ?? 0,
            locationMode: activeProfile.locationPolicy?.mode ?? "HYBRID",
            fareModel: farePolicy?.model ?? "HYBRID"
          };
        }

        if (stops.value.length && !form.value.pickupStopId) {
          form.value.pickupStopId = stops.value[0].id;
          callForm.value.pickupStopId = stops.value[0].id;
        }
        if (stops.value.length > 1 && !form.value.dropoffStopId) {
          form.value.dropoffStopId = stops.value[1].id;
          callForm.value.dropoffStopId = stops.value[1].id;
        }
        if (dispatchPreview.value) {
          previewDirty.value = true;
        }

        await nextTick();
        refreshLeafletMap({ fitToData: !hasInitialMapViewport });
      } catch (error) {
        errorMessage.value = error.message;
      } finally {
        loading.value = false;
      }
    }

    async function refreshRealtimeVehicleState() {
      if (loading.value) {
        return;
      }
      try {
        const [vehicleRes, requestRes] = await Promise.all([
          apiGet("/api/vehicles"),
          apiGet("/api/ride-requests")
        ]);
        vehicles.value = vehicleRes.data ?? [];
        requests.value = requestRes.data ?? [];
        syncLocationFormWithVehicles();
        refreshLeafletMap();
      } catch (_error) {
        // Ignore transient polling errors and keep previous values.
      }
    }

    function buildLocation(mode, stopId, pointText, titleText) {
      const title = normalizeLocationTitle(titleText);
      if (mode === "FIXED_STOP") {
        return { mode, stopId };
      }
      return {
        mode,
        point: parsePointText(pointText),
        ...(title ? { title } : {})
      };
    }

    function buildDispatchPayload() {
      const passengerName = form.value.passengerName.trim();
      const passengerPhone = form.value.passengerPhone.trim();
      return {
        pickup: buildLocation(
          form.value.pickupMode,
          form.value.pickupStopId,
          form.value.pickupPoint,
          form.value.pickupTitle
        ),
        dropoff: buildLocation(
          form.value.dropoffMode,
          form.value.dropoffStopId,
          form.value.dropoffPoint,
          form.value.dropoffTitle
        ),
        partySize: Number(form.value.partySize),
        passenger:
          passengerName || passengerPhone
            ? {
                ...(passengerName ? { name: passengerName } : {}),
                ...(passengerPhone ? { phoneNumber: passengerPhone } : {})
              }
            : null
      };
    }

    function clearDispatchPreview() {
      dispatchPreview.value = null;
      previewDialogOpen.value = false;
      previewPayload.value = null;
      previewDirty.value = false;
      refreshLeafletMap();
    }

    async function previewDispatchRequest() {
      errorMessage.value = "";
      loading.value = true;

      try {
        const payload = buildDispatchPayload();
        const preview = await apiPost("/api/ride-requests/preview", payload);
        dispatchPreview.value = preview;
        previewDialogOpen.value = true;
        previewPayload.value = payload;
        previewDirty.value = false;
        refreshLeafletMap({ focusSelected: true });
      } catch (error) {
        errorMessage.value = error.message;
      } finally {
        loading.value = false;
      }
    }

    async function confirmDispatchRequest() {
      errorMessage.value = "";
      if (!hasAssignablePreview.value || !previewPayload.value) {
        errorMessage.value = "先に最適経路を試算してください。";
        return;
      }
      if (previewDirty.value) {
        errorMessage.value = "入力内容が変更されています。再試算してから追加してください。";
        return;
      }

      loading.value = true;
      try {
        await apiPost("/api/ride-requests", previewPayload.value);
        clearDispatchPreview();
        await refreshAll();
      } catch (error) {
        errorMessage.value = error.message;
      } finally {
        loading.value = false;
      }
    }

    async function cancelRideRequestById(requestId) {
      if (!requestId) {
        return;
      }

      const ok = window.confirm(`予約 ${requestId} を取り消しますか？`);
      if (!ok) {
        return;
      }

      errorMessage.value = "";
      loading.value = true;
      try {
        await apiPost(`/api/ride-requests/${encodeURIComponent(requestId)}/cancel`, {
          reason: "OPERATOR_CANCELLED"
        });
        clearDispatchPreview();
        await refreshAll();
      } catch (error) {
        errorMessage.value = error.message;
      } finally {
        loading.value = false;
      }
    }

    async function updateVehicleLocationFromForm({ point: directPoint = null, source = "DISPATCHER_WEB" } = {}) {
      if (!locationForm.value.vehicleId) {
        errorMessage.value = "車両を選択してください。";
        return;
      }

      errorMessage.value = "";
      loading.value = true;
      try {
        const point = directPoint ?? parsePointText(locationForm.value.point);
        locationForm.value.point = toPointText(point.lat, point.lng);
        await apiPost(
          `/api/vehicles/${encodeURIComponent(locationForm.value.vehicleId)}/location`,
          {
            point,
            source
          }
        );
        locationFormDirty.value = false;
        clearDispatchPreview();
        await refreshAll();
      } catch (error) {
        errorMessage.value = error.message;
      } finally {
        loading.value = false;
      }
    }

    async function simulateInboundCall() {
      errorMessage.value = "";
      try {
        await apiPost("/api/telephony/ingest", {
          provider: "sample-pbx",
          adapterType: "WEBHOOK",
          payload: {
            from: callForm.value.callerRaw,
            to: "0880-11-2222"
          }
        });
        await refreshAll();
      } catch (error) {
        errorMessage.value = error.message;
      }
    }

    function clearPhoneRideOptions() {
      callRideOptions.value = [];
      selectedCallOptionId.value = "";
      callDesiredDropoffAt.value = null;
    }

    function buildPhoneRidePayload() {
      if (!callForm.value.pickupStopId || !callForm.value.dropoffStopId) {
        throw new Error("乗車/降車バス停を選択してください。");
      }
      if (callForm.value.pickupStopId === callForm.value.dropoffStopId) {
        throw new Error("乗車バス停と降車バス停は別にしてください。");
      }

      const partySize = Math.max(1, Math.trunc(Number(callForm.value.partySize) || 1));
      const desiredDropoffAt = buildDesiredDropoffAtFromClock(callForm.value.desiredTime, now.value);

      return {
        callerRaw: callForm.value.callerRaw,
        pickup: { mode: "FIXED_STOP", stopId: callForm.value.pickupStopId },
        dropoff: { mode: "FIXED_STOP", stopId: callForm.value.dropoffStopId },
        partySize,
        desiredDropoffAt
      };
    }

    async function fetchPhoneRideOptions() {
      errorMessage.value = "";
      loading.value = true;
      try {
        const payload = buildPhoneRidePayload();
        const result = await apiPost("/api/phone-rides/options", payload);
        if (result.status !== "ASSIGNABLE" || !Array.isArray(result.options) || !result.options.length) {
          clearPhoneRideOptions();
          errorMessage.value = previewReasonLabel(result.reason);
          return;
        }
        callRideOptions.value = result.options;
        selectedCallOptionId.value = result.options[0].optionId;
        callDesiredDropoffAt.value = result.desiredDropoffAt ?? payload.desiredDropoffAt;
      } catch (error) {
        clearPhoneRideOptions();
        errorMessage.value = error.message;
      } finally {
        loading.value = false;
      }
    }

    async function createPhoneRide() {
      errorMessage.value = "";
      if (!selectedCallOptionId.value) {
        errorMessage.value = "先に乗車候補を取得してください。";
        return;
      }

      const selectedOption = callRideOptions.value.find(
        (option) => option.optionId === selectedCallOptionId.value
      );
      if (!selectedOption) {
        errorMessage.value = "選択された候補が見つかりません。候補を再取得してください。";
        return;
      }

      loading.value = true;
      try {
        const payload = buildPhoneRidePayload();
        await apiPost("/api/phone-rides", {
          ...payload,
          desiredDropoffAt: callDesiredDropoffAt.value ?? payload.desiredDropoffAt,
          preferredVehicleId: selectedOption.vehicleId
        });
        clearPhoneRideOptions();
        await refreshAll();
      } catch (error) {
        errorMessage.value = error.message;
      } finally {
        loading.value = false;
      }
    }

    async function saveProfile() {
      if (!serviceProfile.value) {
        return;
      }
      errorMessage.value = "";

      try {
        const cruiseSpeedKmh = Number(profileEditor.value.cruiseSpeedKmh);
        const pickupServiceMinutes = Number(profileEditor.value.pickupServiceMinutes);
        const dropoffServiceMinutes = Number(profileEditor.value.dropoffServiceMinutes);
        const nextProfile = {
          ...serviceProfile.value,
          reservationPolicy: {
            ...serviceProfile.value.reservationPolicy,
            maxAdvanceDays: Number(profileEditor.value.maxAdvanceDays)
          },
          fleetPolicy: {
            ...serviceProfile.value.fleetPolicy,
            maxActiveVehicles: Number(profileEditor.value.maxActiveVehicles)
          },
          poolingPolicy: {
            ...serviceProfile.value.poolingPolicy,
            maxOnboardPerVehicle: Number(profileEditor.value.maxOnboardPerVehicle)
          },
          dispatchPolicy: {
            ...serviceProfile.value.dispatchPolicy,
            cruiseSpeedKmh:
              Number.isFinite(cruiseSpeedKmh) && cruiseSpeedKmh > 0
                ? cruiseSpeedKmh
                : 25,
            pickupServiceMinutes:
              Number.isFinite(pickupServiceMinutes) && pickupServiceMinutes >= 0
                ? pickupServiceMinutes
                : 0,
            dropoffServiceMinutes:
              Number.isFinite(dropoffServiceMinutes) && dropoffServiceMinutes >= 0
                ? dropoffServiceMinutes
                : 0
          },
          locationPolicy: {
            ...serviceProfile.value.locationPolicy,
            mode: profileEditor.value.locationMode
          },
          farePolicy: {
            ...(serviceProfile.value.farePolicy ?? {}),
            model: profileEditor.value.fareModel
          }
        };

        await apiPost("/api/service-profiles", nextProfile);

        const currentFare = farePolicies.value.find((policy) => policy.id === nextProfile.farePolicyRef);
        if (currentFare) {
          await apiPost("/api/fare-policies", {
            ...currentFare,
            model: profileEditor.value.fareModel
          });
        }
        await refreshAll();
        settingsOpen.value = false;
      } catch (error) {
        errorMessage.value = error.message;
      }
    }

    watch(
      form,
      () => {
        if (dispatchPreview.value) {
          previewDirty.value = true;
        }
      },
      { deep: true }
    );

    watch(
      callForm,
      () => {
        clearPhoneRideOptions();
      },
      { deep: true }
    );

    watch(
      dispatchPreview,
      () => {
        refreshLeafletMap();
      },
      { deep: true }
    );

    watch(
      () => locationForm.value.point,
      () => {
        if (!syncingLocationForm) {
          locationFormDirty.value = true;
        }
      }
    );

    watch(
      () => locationForm.value.vehicleId,
      (vehicleId) => {
        if (!vehicleId) {
          return;
        }
        const vehicle = vehicles.value.find((entry) => entry.id === vehicleId);
        if (vehicle && hasPoint(vehicle.currentLocation)) {
          syncingLocationForm = true;
          locationForm.value.point = toPointText(
            vehicle.currentLocation.lat,
            vehicle.currentLocation.lng
          );
          syncingLocationForm = false;
          locationFormDirty.value = false;
        }
      }
    );

    watch(
      () => form.value.pickupMode,
      (mode) => {
        const state = locationTitleState.value.pickup;
        state.requestId += 1;
        state.pending = false;
        if (mode !== "FREE_POINT") {
          return;
        }
        if (!normalizeLocationTitle(form.value.pickupTitle)) {
          void suggestLocationTitle("pickup");
        }
      }
    );

    watch(
      () => form.value.dropoffMode,
      (mode) => {
        const state = locationTitleState.value.dropoff;
        state.requestId += 1;
        state.pending = false;
        if (mode !== "FREE_POINT") {
          return;
        }
        if (!normalizeLocationTitle(form.value.dropoffTitle)) {
          void suggestLocationTitle("dropoff");
        }
      }
    );

    watch(activePanel, () => {
      if (!leafletMap) return;
      nextTick(() => {
        leafletMap.invalidateSize();
      });
    });

    onMounted(async () => {
      await nextTick();
      ensureLeafletMap();
      await refreshAll();
      nowTicker = setInterval(() => {
        now.value = new Date();
      }, 30 * 1000);
      realtimeTicker = setInterval(() => {
        refreshRealtimeVehicleState();
      }, 10 * 1000);
    });

    onBeforeUnmount(() => {
      if (nowTicker) {
        clearInterval(nowTicker);
      }
      if (realtimeTicker) {
        clearInterval(realtimeTicker);
      }
      if (routeRefreshTimer) {
        clearTimeout(routeRefreshTimer);
        routeRefreshTimer = null;
      }
      if (leafletMap) {
        leafletMap.off("click", onLeafletMapClick);
        leafletMap.remove();
        leafletMap = null;
      }
    });

    return {
      drawerOpen,
      settingsOpen,
      activePanel,
      loading,
      errorMessage,
      summary,
      serviceProfile,
      form,
      callForm,
      callRideOptions,
      selectedCallOptionId,
      callDesiredDropoffAt,
      locationForm,
      locationFormDirty,
      locationTitleState,
      vehicles,
      requests,
      dispatchPreview,
      previewDialogOpen,
      previewDirty,
      previewSimulation,
      hasAssignablePreview,
      previewPickupClock,
      previewDropoffClock,
      selectedVehicle,
      selectedVehiclePointLabel,
      callQueue,
      availableStops,
      availableVehicles,
      locationInputOptions,
      locationPolicyOptions,
      fareModelOptions,
      topbarLocationModeTitle,
      pickupModeDescription,
      dropoffModeDescription,
      locationModeDescription,
      fareModelDescription,
      mapSelectionField,
      isMapPicking,
      mapSelectionHint,
      profileEditor,
      kpi,
      currentDateLabel,
      currentClockLabel,
      requestRows,
      selectedRequestId,
      selectedRequest,
      selectRequest,
      canCancelRequest,
      leafletMapEl,
      hasStopData,
      refreshAll,
      toggleMapSelection,
      cancelMapSelection,
      onLocationTitleInput,
      suggestLocationTitle,
      previewDispatchRequest,
      confirmDispatchRequest,
      clearDispatchPreview,
      cancelRideRequestById,
      updateVehicleLocationFromForm,
      formatSignedMinutes,
      previewReasonLabel,
      simulateInboundCall,
      fetchPhoneRideOptions,
      createPhoneRide,
      saveProfile
    };
  },

  template: `
<v-app class="rq-app">

  <!-- ===== 設定ドロワー ===== -->
  <v-navigation-drawer v-model="settingsOpen" location="right" width="360" temporary>
    <div class="rq-drawer-header">
      <span class="rq-drawer-title">サービス設定</span>
      <v-btn icon="mdi-close" variant="text" density="compact" @click="settingsOpen=false" />
    </div>
    <div class="pa-4">
      <div class="rq-setting-section mb-4">
        <div class="rq-setting-label mb-2">予約ポリシー</div>
        <v-text-field label="予約可能日数" type="number" v-model="profileEditor.maxAdvanceDays" suffix="日" density="compact" variant="outlined" hide-details class="mb-2" />
        <v-text-field label="最大稼働車両" type="number" v-model="profileEditor.maxActiveVehicles" suffix="台" density="compact" variant="outlined" hide-details class="mb-2" />
        <v-text-field label="最大同乗人数" type="number" v-model="profileEditor.maxOnboardPerVehicle" suffix="人" density="compact" variant="outlined" hide-details />
      </div>
      <div class="rq-setting-section mb-4">
        <div class="rq-setting-label mb-2">走行・乗降時間</div>
        <v-text-field label="想定時速" type="number" v-model="profileEditor.cruiseSpeedKmh" suffix="km/h" density="compact" variant="outlined" hide-details class="mb-2" />
        <v-text-field label="乗車に必要な予想時間" type="number" v-model="profileEditor.pickupServiceMinutes" suffix="分" density="compact" variant="outlined" hide-details class="mb-2" />
        <v-text-field label="降車に必要な予想時間" type="number" v-model="profileEditor.dropoffServiceMinutes" suffix="分" density="compact" variant="outlined" hide-details />
      </div>
      <div class="rq-setting-section mb-4">
        <div class="rq-setting-label mb-2">地点・運賃</div>
        <v-select
          label="地点解決モード"
          :items="locationPolicyOptions"
          item-title="title"
          item-value="value"
          v-model="profileEditor.locationMode"
          density="compact"
          variant="outlined"
          hide-details
          class="mb-1"
        />
        <div class="rq-setting-help mb-2">{{ locationModeDescription }}</div>
        <v-select
          label="運賃解決モード"
          :items="fareModelOptions"
          item-title="title"
          item-value="value"
          v-model="profileEditor.fareModel"
          density="compact"
          variant="outlined"
          hide-details
          class="mb-1"
        />
        <div class="rq-setting-help">{{ fareModelDescription }}</div>
      </div>
      <v-btn color="primary" block prepend-icon="mdi-content-save" @click="saveProfile">保存</v-btn>
    </div>
  </v-navigation-drawer>

  <!-- ===== トップバー ===== -->
  <div class="rq-topbar">
    <div class="rq-topbar-left">
      <div class="rq-logo">
        <span class="rq-logo-mark">R</span>
        <span class="rq-logo-text">Reqmo</span>
      </div>
      <div class="rq-topbar-meta">
        <span class="rq-meta-tag">{{ topbarLocationModeTitle }}</span>
        <span class="rq-meta-tag rq-meta-tag--orange">Telephony</span>
      </div>
    </div>

    <div class="rq-kpi-bar">
      <div class="rq-kpi-item">
        <span class="rq-kpi-label">配車成功率</span>
        <span class="rq-kpi-value">{{ kpi.successRate }}</span>
      </div>
      <div class="rq-kpi-divider"></div>
      <div class="rq-kpi-item">
        <span class="rq-kpi-label">平均待機</span>
        <span class="rq-kpi-value">{{ kpi.avgWait }}</span>
      </div>
      <div class="rq-kpi-divider"></div>
      <div class="rq-kpi-item">
        <span class="rq-kpi-label">稼働車両</span>
        <span class="rq-kpi-value">{{ kpi.activeVehicles }}</span>
      </div>
      <div class="rq-kpi-divider"></div>
      <div class="rq-kpi-item">
        <span class="rq-kpi-label">乗合</span>
        <span class="rq-kpi-value">{{ kpi.pooledRate }}</span>
      </div>
      <div class="rq-kpi-divider"></div>
      <div class="rq-kpi-item">
        <span class="rq-kpi-label">電話待ち</span>
        <span class="rq-kpi-value">{{ kpi.callCount }}</span>
      </div>
    </div>

    <div class="rq-topbar-right">
      <div class="rq-clock">
        <div class="rq-clock-time">{{ currentClockLabel }}</div>
        <div class="rq-clock-date">{{ currentDateLabel }}</div>
      </div>
      <v-btn
        icon="mdi-refresh"
        variant="text"
        :loading="loading"
        density="compact"
        class="rq-icon-btn"
        @click="refreshAll"
      />
      <v-btn
        icon="mdi-cog-outline"
        variant="text"
        density="compact"
        class="rq-icon-btn"
        @click="settingsOpen=true"
      />
    </div>
  </div>

  <!-- ===== エラーバー ===== -->
  <div v-if="errorMessage" class="rq-error-bar">
    <v-icon size="16" class="mr-1">mdi-alert-circle-outline</v-icon>
    {{ errorMessage }}
    <v-btn icon="mdi-close" variant="text" density="compact" size="x-small" class="ml-auto" @click="errorMessage=''" />
  </div>

  <v-dialog v-model="previewDialogOpen" max-width="1080" persistent scrollable>
    <v-card v-if="dispatchPreview" class="rq-preview-dialog">
      <div class="rq-preview-dialog-header">
        <div class="rq-preview-dialog-title-row">
          <div class="rq-preview-dialog-title">予約追加シミュレーション確認</div>
          <v-chip
            :color="dispatchPreview.status === 'ASSIGNABLE' ? 'success' : 'error'"
            size="small"
            variant="tonal"
          >
            {{ dispatchPreview.status }}
          </v-chip>
        </div>
        <div class="rq-preview-dialog-subtitle">オペレータ確認: この案で予約追加してよいか判断してください</div>
      </div>

      <v-card-text class="rq-preview-dialog-body">
        <template v-if="dispatchPreview.status === 'ASSIGNABLE' && previewSimulation">
          <div v-if="previewDirty" class="rq-preview-alert">
            入力内容が変更されています。再試算してから追加してください。
          </div>

          <div class="rq-preview-kpis">
            <div class="rq-preview-kpi">
              <span class="rq-preview-kpi-label">担当車両</span>
              <span class="rq-preview-kpi-value">{{ previewSimulation.vehicleId }}</span>
            </div>
            <div class="rq-preview-kpi">
              <span class="rq-preview-kpi-label">乗車予定</span>
              <span class="rq-preview-kpi-value">{{ previewPickupClock }}</span>
            </div>
            <div class="rq-preview-kpi">
              <span class="rq-preview-kpi-label">降車予定</span>
              <span class="rq-preview-kpi-value">{{ previewDropoffClock }}</span>
            </div>
          </div>

          <div class="rq-preview-dialog-grid">
            <div class="rq-preview-section">
              <div class="rq-preview-subtitle">既存予約への影響</div>
              <div v-if="previewSimulation.impactedRequests?.length" class="rq-impact-list">
                <div v-for="impact in previewSimulation.impactedRequests" :key="impact.requestId" class="rq-impact-item">
                  <div class="rq-impact-top">
                    <span class="rq-impact-id">{{ impact.passengerName || impact.requestId }}</span>
                    <v-chip
                      size="small"
                      variant="tonal"
                      :color="(impact.pickupDeltaMinutes > 0 || impact.dropoffDeltaMinutes > 0) ? 'warning' : 'success'"
                    >
                      乗車 {{ formatSignedMinutes(impact.pickupDeltaMinutes) }} / 降車 {{ formatSignedMinutes(impact.dropoffDeltaMinutes) }}
                    </v-chip>
                  </div>
                  <div class="rq-impact-times">
                    <span>乗車 {{ impact.pickupBeforeAt ? impact.pickupBeforeAt.slice(11,16) : '--:--' }} → {{ impact.pickupAfterAt ? impact.pickupAfterAt.slice(11,16) : '--:--' }}</span>
                    <span>降車 {{ impact.dropoffBeforeAt ? impact.dropoffBeforeAt.slice(11,16) : '--:--' }} → {{ impact.dropoffAfterAt ? impact.dropoffAfterAt.slice(11,16) : '--:--' }}</span>
                  </div>
                </div>
              </div>
              <div v-else class="rq-inline-help">既存予約の時刻変化はありません。</div>
            </div>

            <div class="rq-preview-section">
              <div class="rq-preview-subtitle">ドライバー運行手順（最適）</div>
              <div class="rq-driver-steps">
                <div v-for="step in previewSimulation.routeAfter" :key="step.sequence + '-' + step.requestId + '-' + step.type" class="rq-driver-step">
                  <span class="rq-step-index">{{ step.sequence }}</span>
                  <span class="rq-step-time">{{ step.etaAt ? step.etaAt.slice(11,16) : '--:--' }}</span>
                  <span class="rq-step-label">{{ step.type === 'PICKUP' ? '乗車' : '降車' }}: {{ step.locationLabel }}</span>
                </div>
              </div>
            </div>
          </div>
        </template>

        <template v-else>
          <div class="rq-preview-alert rq-preview-alert--error">{{ previewReasonLabel(dispatchPreview.reason) }}</div>
        </template>
      </v-card-text>

      <v-card-actions class="rq-preview-dialog-actions">
        <v-spacer />
        <v-btn
          variant="outlined"
          color="error"
          size="large"
          prepend-icon="mdi-close-thick"
          @click="clearDispatchPreview"
        >
          NG: 破棄
        </v-btn>
        <v-btn
          color="primary"
          size="large"
          prepend-icon="mdi-check-bold"
          :disabled="previewDirty || dispatchPreview.status !== 'ASSIGNABLE'"
          :loading="loading"
          @click="confirmDispatchRequest"
        >
          OK: この案で予約を追加
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <!-- ===== メインレイアウト ===== -->
  <div class="rq-workspace">

    <!-- 左パネル: 入力フォーム -->
    <div class="rq-panel rq-panel--left">
      <div class="rq-panel-tabs">
        <button
          class="rq-ptab"
          :class="{ 'is-active': activePanel === 'dispatch' }"
          @click="activePanel = 'dispatch'"
        >
          <v-icon size="14" class="mr-1">mdi-taxi</v-icon>配車
        </button>
        <button
          class="rq-ptab"
          :class="{ 'is-active': activePanel === 'calls' }"
          @click="activePanel = 'calls'"
        >
          <v-icon size="14" class="mr-1">mdi-phone-incoming</v-icon>電話
          <span v-if="kpi.callCount > 0" class="rq-badge">{{ kpi.callCount }}</span>
        </button>
      </div>

      <!-- 配車フォーム -->
      <div v-show="activePanel === 'dispatch'" class="rq-form-body">
        <div class="rq-form-section">
          <div class="rq-form-label">
            <v-icon size="14" color="#0f766e">mdi-map-marker-up</v-icon>乗車
          </div>
          <v-select
            :items="locationInputOptions"
            item-title="title"
            item-value="value"
            v-model="form.pickupMode"
            density="compact"
            variant="outlined"
            hide-details
            class="mb-1"
          />
          <div class="rq-inline-help mb-1">{{ pickupModeDescription }}</div>
          <div class="rq-map-pick-row mb-1">
            <v-btn
              variant="tonal"
              color="primary"
              size="x-small"
              density="comfortable"
              prepend-icon="mdi-crosshairs-gps"
              class="rq-map-pick-btn"
              :class="{ 'is-active': mapSelectionField === 'pickup' }"
              @click="toggleMapSelection('pickup')"
            >
              {{ mapSelectionField === 'pickup' ? '地図選択を解除' : '地図で選択' }}
            </v-btn>
          </div>
          <div v-if="mapSelectionField === 'pickup'" class="rq-inline-help mb-1">
            地図をクリックすると、{{ form.pickupMode === 'FIXED_STOP' ? '最寄りのバス停' : '地点座標' }}を設定します。
          </div>
          <v-select
            v-if="form.pickupMode==='FIXED_STOP'"
            :items="availableStops"
            v-model="form.pickupStopId"
            density="compact"
            variant="outlined"
            hide-details
            placeholder="バス停を選択"
          />
          <div v-else>
            <v-text-field
              v-model="form.pickupPoint"
              density="compact"
              variant="outlined"
              hide-details
              placeholder="lat,lng"
              @blur="suggestLocationTitle('pickup')"
            />
            <v-text-field
              :model-value="form.pickupTitle"
              density="compact"
              variant="outlined"
              hide-details
              class="mt-1"
              placeholder="地点タイトル（編集可） 例: 中村駅前"
              @update:model-value="onLocationTitleInput('pickup', $event)"
            />
            <div class="rq-map-pick-row mt-1">
              <v-btn
                variant="text"
                color="primary"
                size="x-small"
                density="comfortable"
                prepend-icon="mdi-map-search"
                :loading="locationTitleState.pickup.pending"
                @click="suggestLocationTitle('pickup', { force: true })"
              >
                候補取得
              </v-btn>
            </div>
          </div>
        </div>

        <div class="rq-form-section">
          <div class="rq-form-label">
            <v-icon size="14" color="#ea580c">mdi-map-marker-down</v-icon>降車
          </div>
          <v-select
            :items="locationInputOptions"
            item-title="title"
            item-value="value"
            v-model="form.dropoffMode"
            density="compact"
            variant="outlined"
            hide-details
            class="mb-1"
          />
          <div class="rq-inline-help mb-1">{{ dropoffModeDescription }}</div>
          <div class="rq-map-pick-row mb-1">
            <v-btn
              variant="tonal"
              color="secondary"
              size="x-small"
              density="comfortable"
              prepend-icon="mdi-crosshairs-gps"
              class="rq-map-pick-btn"
              :class="{ 'is-active': mapSelectionField === 'dropoff' }"
              @click="toggleMapSelection('dropoff')"
            >
              {{ mapSelectionField === 'dropoff' ? '地図選択を解除' : '地図で選択' }}
            </v-btn>
          </div>
          <div v-if="mapSelectionField === 'dropoff'" class="rq-inline-help mb-1">
            地図をクリックすると、{{ form.dropoffMode === 'FIXED_STOP' ? '最寄りのバス停' : '地点座標' }}を設定します。
          </div>
          <v-select
            v-if="form.dropoffMode==='FIXED_STOP'"
            :items="availableStops"
            v-model="form.dropoffStopId"
            density="compact"
            variant="outlined"
            hide-details
            placeholder="バス停を選択"
          />
          <div v-else>
            <v-text-field
              v-model="form.dropoffPoint"
              density="compact"
              variant="outlined"
              hide-details
              placeholder="lat,lng"
              @blur="suggestLocationTitle('dropoff')"
            />
            <v-text-field
              :model-value="form.dropoffTitle"
              density="compact"
              variant="outlined"
              hide-details
              class="mt-1"
              placeholder="地点タイトル（編集可） 例: 市役所近く"
              @update:model-value="onLocationTitleInput('dropoff', $event)"
            />
            <div class="rq-map-pick-row mt-1">
              <v-btn
                variant="text"
                color="secondary"
                size="x-small"
                density="comfortable"
                prepend-icon="mdi-map-search"
                :loading="locationTitleState.dropoff.pending"
                @click="suggestLocationTitle('dropoff', { force: true })"
              >
                候補取得
              </v-btn>
            </div>
          </div>
        </div>

        <div class="rq-form-row">
          <div class="rq-form-section" style="flex:1">
            <div class="rq-form-label">人数</div>
            <v-text-field type="number" min="1" v-model="form.partySize" density="compact" variant="outlined" hide-details />
          </div>
          <div class="rq-form-section" style="flex:1">
            <div class="rq-form-label">希望降車時刻</div>
            <v-text-field type="time" v-model="form.desiredTime" density="compact" variant="outlined" hide-details />
          </div>
        </div>

        <div class="rq-form-row">
          <div class="rq-form-section" style="flex:1">
            <div class="rq-form-label">氏名（任意）</div>
            <v-text-field
              v-model="form.passengerName"
              density="compact"
              variant="outlined"
              hide-details
              placeholder="例: 山田 太郎"
            />
          </div>
          <div class="rq-form-section" style="flex:1">
            <div class="rq-form-label">電話番号（任意）</div>
            <v-text-field
              v-model="form.passengerPhone"
              density="compact"
              variant="outlined"
              hide-details
              placeholder="例: 08012345678"
            />
          </div>
        </div>

        <div class="rq-form-section rq-vehicle-location-panel">
          <div class="rq-form-label">
            <v-icon size="14" color="#0284c7">mdi-bus-marker</v-icon>車載端末: バス現在位置
          </div>
          <v-select
            :items="availableVehicles"
            v-model="locationForm.vehicleId"
            density="compact"
            variant="outlined"
            hide-details
            placeholder="車両を選択"
            class="mb-1"
          />
          <div class="rq-map-pick-row mb-1">
            <v-btn
              variant="tonal"
              color="info"
              size="x-small"
              density="comfortable"
              prepend-icon="mdi-crosshairs-gps"
              class="rq-map-pick-btn"
              :class="{ 'is-active': mapSelectionField === 'vehicle' }"
              @click="toggleMapSelection('vehicle')"
            >
              {{ mapSelectionField === 'vehicle' ? '地図選択を解除' : '地図で現在地を指定' }}
            </v-btn>
          </div>
          <v-text-field
            v-model="locationForm.point"
            density="compact"
            variant="outlined"
            hide-details
            placeholder="lat,lng"
            class="mb-2"
          />
          <div v-if="locationFormDirty" class="rq-inline-help mb-1">
            地図または入力値は未送信です。送信すると地図上の現在地が更新されます。
          </div>
          <v-btn
            color="info"
            block
            prepend-icon="mdi-radar"
            :loading="loading"
            size="small"
            density="comfortable"
            class="rq-action-btn"
            @click="updateVehicleLocationFromForm"
          >
            位置情報を送信して再最適化
          </v-btn>
        </div>

        <v-btn color="primary" block prepend-icon="mdi-calculator-variant-outline" :loading="loading" size="small" density="comfortable" @click="previewDispatchRequest" class="rq-submit-btn rq-action-btn">
          最適経路を試算
        </v-btn>

      </div>

      <!-- 電話フォーム -->
      <div v-show="activePanel === 'calls'" class="rq-form-body">
        <div class="rq-form-section">
          <div class="rq-form-label">
            <v-icon size="14">mdi-phone</v-icon>発信者番号
          </div>
          <v-text-field v-model="callForm.callerRaw" density="compact" variant="outlined" hide-details placeholder="08012345678" />
        </div>
        <v-btn color="secondary" block variant="tonal" prepend-icon="mdi-phone-incoming" size="small" density="comfortable" @click="simulateInboundCall" class="mb-3 rq-action-btn">
          着信イベント送信
        </v-btn>
        <div class="rq-form-row">
          <div class="rq-form-section" style="flex:1">
            <div class="rq-form-label">人数</div>
            <v-text-field type="number" min="1" v-model="callForm.partySize" density="compact" variant="outlined" hide-details />
          </div>
          <div class="rq-form-section" style="flex:1">
            <div class="rq-form-label">希望降車時刻</div>
            <v-text-field type="time" v-model="callForm.desiredTime" density="compact" variant="outlined" hide-details />
          </div>
        </div>
        <div class="rq-form-section">
          <div class="rq-form-label">
            <v-icon size="14" color="#0f766e">mdi-map-marker-up</v-icon>乗車バス停
          </div>
          <v-select :items="availableStops" v-model="callForm.pickupStopId" density="compact" variant="outlined" hide-details />
        </div>
        <div class="rq-form-section">
          <div class="rq-form-label">
            <v-icon size="14" color="#ea580c">mdi-map-marker-down</v-icon>降車バス停
          </div>
          <v-select :items="availableStops" v-model="callForm.dropoffStopId" density="compact" variant="outlined" hide-details />
        </div>
        <v-btn color="secondary" block variant="tonal" prepend-icon="mdi-format-list-bulleted-square" :loading="loading" size="small" density="comfortable" @click="fetchPhoneRideOptions" class="rq-action-btn">
          降車時刻ベースで候補取得
        </v-btn>
        <div class="rq-form-section rq-call-options-panel">
          <div class="rq-form-label">
            <v-icon size="14" color="#0f766e">mdi-bus-clock</v-icon>オペレータ案内候補（乗車時刻）
          </div>
          <div v-if="callRideOptions.length" class="rq-call-options-list">
            <label
              v-for="option in callRideOptions"
              :key="option.optionId"
              class="rq-call-option-item"
              :class="{ 'is-selected': selectedCallOptionId === option.optionId }"
            >
              <input
                type="radio"
                name="phone-ride-option"
                :value="option.optionId"
                v-model="selectedCallOptionId"
              />
              <div class="rq-call-option-body">
                <div class="rq-call-option-top">
                  <span class="rq-call-option-vehicle">{{ option.vehicleId }}</span>
                  <span class="rq-call-option-pickup">ご案内乗車 {{ formatTimeLabel(option.plannedPickupAt) }}</span>
                </div>
                <div class="rq-call-option-meta">
                  <span>降車 {{ formatTimeLabel(option.plannedDropoffAt) }}</span>
                  <span v-if="option.desiredDropoffDeltaMinutes !== null">
                    希望降車との差 {{ formatSignedMinutes(option.desiredDropoffDeltaMinutes) }}
                  </span>
                </div>
              </div>
            </label>
          </div>
          <div v-else class="rq-inline-help">人数と希望降車時刻を入力して候補を取得してください。</div>
        </div>
        <v-btn color="primary" block prepend-icon="mdi-phone-plus" :loading="loading" size="small" density="comfortable" @click="createPhoneRide" class="rq-submit-btn rq-action-btn">
          選択した候補で予約確定
        </v-btn>
      </div>
    </div>

    <!-- 中央: 地図 -->
    <div class="rq-map-area">
      <div ref="leafletMapEl" :class="['rq-leaflet', { 'is-picking': isMapPicking }]" aria-label="配車地図"></div>
      <div v-if="!hasStopData" class="rq-map-placeholder">
        <v-icon size="40" color="rgba(31,41,55,0.3)">mdi-map-off</v-icon>
        <div class="mt-2">停留所データなし</div>
      </div>
      <!-- 地図レジェンド -->
      <div class="rq-map-legend">
        <span class="rq-legend-item">
          <span class="rq-legend-dot rq-legend-dot--green"></span>乗車
        </span>
        <span class="rq-legend-item">
          <span class="rq-legend-dot rq-legend-dot--orange"></span>降車
        </span>
        <span class="rq-legend-item">
          <span class="rq-legend-dot rq-legend-dot--blue"></span>バス現在地
        </span>
        <span class="rq-legend-item">
          <span class="rq-legend-dot rq-legend-dot--amber"></span>試算経路
        </span>
        <span class="rq-legend-item">
          <span class="rq-legend-dot rq-legend-dot--gray"></span>停留所
        </span>
      </div>
      <div v-if="mapSelectionField" class="rq-map-pick-hint">
        <v-icon size="13" color="#0f766e">mdi-crosshairs-gps</v-icon>
        <span>{{ mapSelectionHint }}</span>
        <v-btn icon="mdi-close" variant="text" density="compact" size="x-small" @click="cancelMapSelection" />
      </div>
      <!-- 選択中ルート表示 -->
      <div v-if="selectedRequest" class="rq-map-selected-chip">
        <v-icon size="12" color="#0f766e">mdi-map-marker</v-icon>
        {{ selectedRequest.pickupLabel }}
        <v-icon size="12" class="mx-1">mdi-arrow-right-thin</v-icon>
        <v-icon size="12" color="#ea580c">mdi-map-marker</v-icon>
        {{ selectedRequest.dropoffLabel }}
      </div>
      <div v-if="hasAssignablePreview && previewSimulation" class="rq-map-preview-chip">
        <v-icon size="12" color="#b45309">mdi-bus-clock</v-icon>
        試算: {{ previewSimulation.vehicleId }} / 乗車 {{ previewPickupClock }} / 降車 {{ previewDropoffClock }}
      </div>
      <div v-if="selectedVehicle && selectedVehicle.currentLocation" class="rq-map-vehicle-chip">
        <v-icon size="12" color="#0369a1">mdi-bus-marker</v-icon>
        {{ selectedVehicle.id }} 現在地 {{ selectedVehiclePointLabel }}
      </div>
    </div>

    <!-- 右パネル: 予約リスト -->
    <div class="rq-panel rq-panel--right">
      <div class="rq-panel-header">
        <div class="rq-panel-title">予約案 <span class="rq-count-badge">{{ requestRows.length }}</span></div>
      </div>

      <div class="rq-request-list" v-if="requestRows.length">
        <button
          v-for="row in requestRows"
          :key="row.id"
          type="button"
          class="rq-request-item"
          :class="{ 'is-active': row.id === selectedRequestId }"
          @click="selectRequest(row.id)"
        >
          <div class="rq-req-top">
            <span class="rq-req-time">{{ row.displayTime }}</span>
            <span class="rq-req-subtime">降車 {{ row.dropoffDisplayTime }}</span>
            <div class="rq-req-actions">
              <v-chip :color="row.statusColor" size="x-small" variant="tonal" class="rq-req-status">
                {{ row.status }}
              </v-chip>
              <v-btn
                v-if="canCancelRequest(row)"
                icon="mdi-close-circle-outline"
                variant="text"
                color="error"
                density="compact"
                size="x-small"
                class="rq-cancel-btn"
                :loading="loading"
                @click.stop="cancelRideRequestById(row.id)"
              />
            </div>
          </div>
          <div class="rq-req-route">
            <span class="rq-req-stop rq-req-stop--pickup">{{ row.pickupLabel }}</span>
            <v-icon size="12" class="rq-req-arrow">mdi-arrow-right-thin</v-icon>
            <span class="rq-req-stop rq-req-stop--dropoff">{{ row.dropoffLabel }}</span>
          </div>
          <div v-if="row.passengerName || row.passengerPhone" class="rq-req-contact">
            <span v-if="row.passengerName"><v-icon size="11">mdi-account</v-icon> {{ row.passengerName }}</span>
            <span v-if="row.passengerPhone"><v-icon size="11">mdi-phone</v-icon> {{ row.passengerPhone }}</span>
          </div>
          <div class="rq-req-meta">
            <span class="rq-party-size"><v-icon size="14">mdi-account-multiple</v-icon><strong>{{ row.partySize }}</strong>人乗車</span>
            <span><v-icon size="11">mdi-bus</v-icon> {{ row.vehicleId }}</span>
            <span v-if="row.etaMinutes !== null"><v-icon size="11">mdi-clock-outline</v-icon> 乗車 {{ row.etaMinutes }}分後</span>
            <span v-if="row.etaDropoffMinutes !== null"><v-icon size="11">mdi-flag-checkered</v-icon> 降車 {{ row.etaDropoffMinutes }}分後</span>
          </div>
          <div v-if="row.vehicleId !== '-'" class="rq-req-metrics">
            <span class="rq-req-metric">
              <v-icon size="12" color="#b45309">mdi-map-marker-distance</v-icon>
              降車まで 距離 {{ row.dropoffTravelDistanceLabel ?? "算出中" }} / 時間 {{ row.dropoffTravelMinutesLabel ?? "算出中" }}
            </span>
            <span class="rq-req-metric">
              <v-icon size="12" color="#0f766e">mdi-map-clock-outline</v-icon>
              <template v-if="row.hasNextPickup">
                次の乗車まで 距離 {{ row.nextPickupTravelDistanceLabel ?? "算出中" }} / 時間 {{ row.nextPickupTravelMinutesLabel ?? "算出中" }}
              </template>
              <template v-else>次の乗車予定なし</template>
            </span>
          </div>
        </button>
      </div>

      <div v-else class="rq-empty">
        <v-icon size="32" color="rgba(31,41,55,0.25)">mdi-calendar-blank</v-icon>
        <div class="mt-2 text-caption">予約案なし</div>
      </div>

      <!-- 電話着信キュー (常時表示) -->
      <div class="rq-panel-header rq-panel-header--sub">
        <div class="rq-panel-title">
          着信キュー
          <span class="rq-count-badge">{{ callQueue.length }}</span>
        </div>
      </div>

      <div class="rq-call-list" v-if="callQueue.length">
        <div v-for="c in callQueue" :key="c.id" class="rq-call-item">
          <v-icon size="14" color="#ea580c">mdi-phone-incoming</v-icon>
          <div class="rq-call-body">
            <div class="rq-call-number">{{ c.callerE164 ?? c.callerRaw }}</div>
            <div class="rq-call-meta">{{ c.id }} / {{ c.status }}</div>
          </div>
        </div>
      </div>
      <div v-else class="rq-empty rq-empty--sm">
        <span class="text-caption" style="color:rgba(31,41,55,0.4)">待機中の着信なし</span>
      </div>
    </div>

  </div>
</v-app>
  `
}).use(vuetify).mount("#app");
