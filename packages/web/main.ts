const {
  createApp,
  ref,
  computed,
  onMounted,
  onBeforeUnmount,
  watch,
  nextTick,
  reactive,
} = Vue;
const { createVuetify } = Vuetify;

const vuetify = createVuetify({
  theme: {
    defaultTheme: "reqmo",
    themes: {
      reqmo: {
        colors: {
          primary: "#0f766e",
          secondary: "#ea580c",
          background: "#f0f4f8",
        },
      },
    },
  },
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
const VEHICLE_ROUTE_ON_PATH_TOLERANCE_METERS = 45;
const ROUTE_POINT_SNAP_TOLERANCE_METERS = 2;
const OFFICE_RETURN_ARRIVAL_METERS = 20;
const DESIRED_TIME_STEP_MINUTES = 5;
const DESIRED_TIME_MODES = [
  { title: "乗車時刻", value: "PICKUP" },
  { title: "降車時刻", value: "DROPOFF" },
];

const simulatorQuery = new URLSearchParams(window.location.search);
if (simulatorQuery.has("simulator")) {
  const simulatorUrl = new URL("./simulation/index.html", window.location.href);
  simulatorUrl.search = "";
  simulatorUrl.hash = "";
  window.location.replace(simulatorUrl.toString());
}

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
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
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

function normalizeColorHex(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const text = value.trim();
  if (!text) {
    return fallback;
  }
  if (!/^#([0-9a-fA-F]{6})$/.test(text)) {
    throw new Error("カラーコードは #RRGGBB 形式で入力してください");
  }
  return text.toLowerCase();
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatClock(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function formatClockByMinuteStep(
  date,
  stepMinutes = DESIRED_TIME_STEP_MINUTES,
) {
  const normalizedStep =
    Number.isInteger(stepMinutes) && stepMinutes > 0
      ? stepMinutes
      : DESIRED_TIME_STEP_MINUTES;
  const normalized = new Date(date);
  normalized.setSeconds(0, 0);
  const minute = normalized.getMinutes();
  const steppedMinute = Math.floor(minute / normalizedStep) * normalizedStep;
  normalized.setMinutes(steppedMinute, 0, 0);
  return formatClock(normalized);
}

function buildHourOptions() {
  const options = [];
  for (let hour = 0; hour < 24; hour += 1) {
    options.push(pad2(hour));
  }
  return options;
}

function buildMinuteOptions(stepMinutes = DESIRED_TIME_STEP_MINUTES) {
  const normalizedStep =
    Number.isInteger(stepMinutes) && stepMinutes > 0
      ? stepMinutes
      : DESIRED_TIME_STEP_MINUTES;
  const options = [];
  for (let minute = 0; minute < 60; minute += normalizedStep) {
    options.push(pad2(minute));
  }
  return options;
}

function formatClockParts(hourValue, minuteValue) {
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  const normalizedHour =
    Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 0;
  const normalizedMinute =
    Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : 0;
  return `${pad2(normalizedHour)}:${pad2(normalizedMinute)}`;
}

function formatDateInput(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatDateKey(date) {
  return formatDateInput(date);
}

function formatDateLabel(date) {
  return `${date.getFullYear()}.${pad2(date.getMonth() + 1)}.${pad2(date.getDate())}`;
}

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

function parseDateKeyToDate(value) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(`${value}`.trim());
  if (!dateMatch) {
    return null;
  }
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return null;
  }
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function formatWeekdayLabel(value) {
  const date = value instanceof Date ? value : parseDateKeyToDate(value);
  if (!date) {
    return "";
  }
  const weekday = WEEKDAY_LABELS[date.getDay()] ?? "";
  return weekday ? `${weekday}曜日` : "";
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

function formatDateTimeLabel(value) {
  if (!value) {
    return "--:--";
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }
  return `${formatDateLabel(date)} ${formatClock(date)}`;
}

function parseTimeValueMs(value) {
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

function normalizeDesiredTimeMode(mode) {
  return mode === "PICKUP" ? "PICKUP" : "DROPOFF";
}

function desiredTimeLabel(mode) {
  return normalizeDesiredTimeMode(mode) === "PICKUP"
    ? "希望乗車時刻"
    : "希望降車時刻";
}

function desiredTimeRequestType(mode) {
  return normalizeDesiredTimeMode(mode) === "PICKUP"
    ? "DEPART_AT"
    : "ARRIVE_BY";
}

function buildDesiredTimeAtFromDateAndClock(
  dateText,
  clockText,
  mode = "DROPOFF",
) {
  const label = desiredTimeLabel(mode);
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(`${dateText}`.trim());
  if (!dateMatch) {
    throw new Error("予約日は YYYY-MM-DD 形式で入力してください");
  }
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    throw new Error("予約日は YYYY-MM-DD 形式で入力してください");
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error("予約日を正しく入力してください");
  }

  const [hourRaw, minuteRaw] = `${clockText}`.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error(`${label}は HH:mm 形式で入力してください`);
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`${label}は 00:00 から 23:59 の範囲で入力してください`);
  }
  if (minute % DESIRED_TIME_STEP_MINUTES !== 0) {
    throw new Error(
      `${label}は ${DESIRED_TIME_STEP_MINUTES}分単位で入力してください`,
    );
  }

  const candidate = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    candidate.getFullYear() !== year ||
    candidate.getMonth() !== month - 1 ||
    candidate.getDate() !== day
  ) {
    throw new Error("予約日を正しく入力してください");
  }
  return candidate.toISOString();
}

function addMinutes(baseDate, minutes) {
  return new Date(baseDate.getTime() + minutes * 60 * 1000);
}

function resolvePlannedDateTime({
  plannedAt = null,
  etaMinutes = null,
  fallbackAt = null,
  now = new Date(),
} = {}) {
  const plannedTimestamp = parseTimeValueMs(plannedAt);
  if (plannedTimestamp !== null) {
    return new Date(plannedTimestamp);
  }
  const eta = Number(etaMinutes);
  if (Number.isFinite(eta)) {
    return addMinutes(now, Math.max(0, eta));
  }
  const fallbackTimestamp = parseTimeValueMs(fallbackAt);
  if (fallbackTimestamp !== null) {
    return new Date(fallbackTimestamp);
  }
  return new Date(now);
}

function hasPoint(point) {
  return (
    Boolean(point) && Number.isFinite(point.lat) && Number.isFinite(point.lng)
  );
}

function resolveOfficeName(profile) {
  const officeName = profile?.operationPolicy?.office?.name;
  if (typeof officeName === "string" && officeName.trim()) {
    return officeName.trim();
  }
  return "事務所";
}

function resolveVehicleOfficePoint(vehicle, profile = null) {
  if (hasPoint(vehicle?.officePoint)) {
    return {
      lat: Number(vehicle.officePoint.lat),
      lng: Number(vehicle.officePoint.lng),
    };
  }
  if (hasPoint(vehicle?.homeBase)) {
    return {
      lat: Number(vehicle.homeBase.lat),
      lng: Number(vehicle.homeBase.lng),
    };
  }
  if (hasPoint(profile?.operationPolicy?.office?.point)) {
    return {
      lat: Number(profile.operationPolicy.office.point.lat),
      lng: Number(profile.operationPolicy.office.point.lng),
    };
  }
  return null;
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

function toRadians(value) {
  return (Number(value) * Math.PI) / 180;
}

function distanceMeters(from, to) {
  if (!hasPoint(from) || !hasPoint(to)) {
    return Number.POSITIVE_INFINITY;
  }

  const lat1 = toRadians(from.lat);
  const lng1 = toRadians(from.lng);
  const lat2 = toRadians(to.lat);
  const lng2 = toRadians(to.lng);
  const dLat = lat2 - lat1;
  const dLng = lng2 - lng1;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const a = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(1 - a, 0)));
  return 6371000 * c;
}

function projectPointOnSegmentMeters(point, start, end) {
  if (!hasPoint(point) || !hasPoint(start) || !hasPoint(end)) {
    return null;
  }

  const refLat = toRadians(
    (Number(start.lat) + Number(end.lat) + Number(point.lat)) / 3,
  );
  const metersPerDegLat = 111320;
  const metersPerDegLng = metersPerDegLat * Math.cos(refLat);
  if (!Number.isFinite(metersPerDegLng) || Math.abs(metersPerDegLng) < 1e-6) {
    return null;
  }

  const px = Number(point.lng) * metersPerDegLng;
  const py = Number(point.lat) * metersPerDegLat;
  const sx = Number(start.lng) * metersPerDegLng;
  const sy = Number(start.lat) * metersPerDegLat;
  const ex = Number(end.lng) * metersPerDegLng;
  const ey = Number(end.lat) * metersPerDegLat;
  const dx = ex - sx;
  const dy = ey - sy;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq < 1e-6) {
    return {
      distanceMeters: Math.hypot(px - sx, py - sy),
      projectedPoint: {
        lat: Number(start.lat),
        lng: Number(start.lng),
      },
    };
  }

  const clampedT = Math.max(
    0,
    Math.min(1, ((px - sx) * dx + (py - sy) * dy) / lengthSq),
  );
  const projectedX = sx + dx * clampedT;
  const projectedY = sy + dy * clampedT;
  return {
    distanceMeters: Math.hypot(px - projectedX, py - projectedY),
    projectedPoint: {
      lat: projectedY / metersPerDegLat,
      lng: projectedX / metersPerDegLng,
    },
  };
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

const PREVIEW_REJECTION_LABELS = {
  CONSECUTIVE_PICKUP: "乗車タスクが連続して成立しない",
  CAPACITY: "同時乗車人数の上限を超える",
  MAX_WAIT: "乗車までの待ち時間上限を超える",
  MAX_DETOUR: "既存予約への迂回遅延上限を超える",
  MAX_ADDITIONAL_STOPS: "追加停留所数の上限を超える",
  RESERVATION_WINDOW: "予約日が異なる便を混在させない",
  OFFICE_BREAK_POLICY: "事務所・休憩ポリシーに合致しない",
};

const PREVIEW_REJECTION_ORDER = [
  "CONSECUTIVE_PICKUP",
  "CAPACITY",
  "MAX_WAIT",
  "MAX_DETOUR",
  "MAX_ADDITIONAL_STOPS",
  "RESERVATION_WINDOW",
];

function previewRejectionCodeLabel(code) {
  return PREVIEW_REJECTION_LABELS[code] ?? code;
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
    CANCELLED: "error",
  };
  return map[status] ?? "default";
}

function normalizeRouteTaskType(value) {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (normalized === "PICKUP" || normalized === "PICK_UP") {
    return "PICKUP";
  }
  if (normalized === "DROPOFF" || normalized === "DROP_OFF") {
    return "DROPOFF";
  }
  return "";
}

function normalizeRequestStatus(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toUpperCase();
}

const STATUS_LABELS = {
  ASSIGNABLE: "配車可能",
  ASSIGNED: "配車済み",
  PENDING: "受付済み",
  PICKED_UP: "乗車済み",
  COMPLETED: "完了",
  CANCELLED: "キャンセル済み",
  CANCELED: "キャンセル済み",
  REJECTED: "却下",
  MATCHING: "マッチング中",
  RECEIVED: "受信",
  IGNORED: "対象外",
  FAILED: "失敗",
  LINKED: "連携済み",
  UNREGISTERED: "未登録",
  ANONYMOUS: "匿名",
  BLOCKED: "拒否",
};

function statusLabel(status) {
  const normalized = normalizeRequestStatus(status);
  if (!normalized) {
    return "-";
  }
  return STATUS_LABELS[normalized] ?? normalized;
}

const DISPATCH_ALGORITHM_LABELS = {
  INSERTION: "INSERTION（局所挿入）",
  GREEDY: "GREEDY（貪欲）",
  HIGHS: "HIGHS（MIP選択）",
};

function dispatchAlgorithmLabel(value) {
  const normalized =
    typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!normalized) {
    return "-";
  }
  return DISPATCH_ALGORITHM_LABELS[normalized] ?? normalized;
}

function dispatchAlgorithmPhaseLabel(value) {
  const normalized =
    typeof value === "string" ? value.trim().toUpperCase() : "";
  if (normalized === "COMPLEX_OR") {
    return "複雑案件OR";
  }
  if (normalized === "FALLBACK") {
    return "フォールバック";
  }
  return "";
}

const LOCATION_INPUT_OPTIONS = [
  {
    title: "バス停を指定",
    value: "FIXED_STOP",
    description: "登録済みのバス停から選択します。",
  },
  {
    title: "自由地点を指定",
    value: "FREE_POINT",
    description: "緯度経度（lat,lng）を直接入力します。",
  },
];

const LOCATION_POLICY_OPTIONS = [
  {
    title: "自由地点のみ",
    value: "FREE_ONLY",
    description: "入力された座標をそのまま配車地点として扱います。",
  },
  {
    title: "仮想停留所のみ",
    value: "VIRTUAL_ONLY",
    description: "最寄りの仮想停留所に補正して配車地点を決定します。",
  },
  {
    title: "自由地点と仮想停留所を併用",
    value: "HYBRID",
    description: "自由地点と仮想停留所の双方を比較し、最適な地点を採用します。",
  },
];

const FARE_MODEL_OPTIONS = [
  {
    title: "固定運賃",
    value: "FIXED",
    description: "距離や時間に関係なく一定料金を適用します。",
  },
  {
    title: "距離連動",
    value: "DISTANCE",
    description: "走行距離に応じて運賃を計算します。",
  },
  {
    title: "時間連動",
    value: "TIME",
    description: "乗車時間に応じて運賃を計算します。",
  },
  {
    title: "ゾーン別",
    value: "ZONAL",
    description: "出発地・到着地のゾーン組み合わせで運賃を決定します。",
  },
  {
    title: "ハイブリッド",
    value: "HYBRID",
    description: "固定・距離・時間の要素を組み合わせて運賃を算出します。",
  },
];

function findOption(options, value) {
  return options.find((option) => option.value === value) ?? null;
}

function normalizeStopSearchText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).normalize("NFKC").toLowerCase().trim();
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
      serviceProfileId: "",
    });

    const serviceProfile = ref(null);
    const farePolicies = ref([]);
    const stops = ref([]);
    const vehicles = ref([]);
    const requests = ref([]);
    const dispatchPreview = ref(null);
    const dispatchOptions = ref([]);
    const selectedDispatchOptionId = ref("");
    const previewDialogOpen = ref(false);
    const resetRequestsDialogOpen = ref(false);
    const previewPayload = ref(null);
    const previewDirty = ref(false);
    const callQueue = ref([]);
    const selectedRequestId = ref("");
    const mapDisplayMode = ref("operation"); // operation | request
    const selectedVehicleRouteStepKey = ref("");
    const leafletMapEl = ref(null);
    const now = ref(new Date());
    const dispatchDateInputEl = ref(null);
    const callDateInputEl = ref(null);
    const dispatchTimeMenuOpen = ref(false);
    const callTimeMenuOpen = ref(false);
    const desiredTimeModeOptions = DESIRED_TIME_MODES;
    const desiredHourOptions = buildHourOptions();
    const desiredMinuteOptions = buildMinuteOptions();
    const [defaultDesiredHour, defaultDesiredMinute] = formatClockByMinuteStep(
      new Date(),
    ).split(":");

    let nowTicker = null;
    let realtimeTicker = null;
    let leafletMap = null;
    let hasInitialMapViewport = false;
    let routeRefreshTimer = null;
    const routeGeometryCache = new Map();
    const routeSegmentMetricsCache = reactive(new Map());
    const mapLayers = {
      stops: null,
      office: null,
      vehicleRoutes: null,
      activeRoutes: null,
      selectedRoute: null,
      previewRoute: null,
      focus: null,
      vehicles: null,
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
      desiredTimeMode: "DROPOFF",
      desiredDate: formatDateInput(new Date()),
      desiredHour: defaultDesiredHour ?? "00",
      desiredMinute: defaultDesiredMinute ?? "00",
    });

    const callForm = ref({
      callerRaw: "08012345678",
      pickupStopId: "",
      dropoffStopId: "",
      partySize: 1,
      desiredTimeMode: "DROPOFF",
      desiredDate: formatDateInput(new Date()),
      desiredHour: defaultDesiredHour ?? "00",
      desiredMinute: defaultDesiredMinute ?? "00",
    });
    const callRideOptions = ref([]);
    const selectedCallOptionId = ref("");
    const callDesiredDropoffAt = ref(null);
    const callDesiredPickupAt = ref(null);
    const formDesiredTimeModeLabel = computed(() =>
      desiredTimeLabel(form.value.desiredTimeMode),
    );
    const callDesiredTimeModeLabel = computed(() =>
      desiredTimeLabel(callForm.value.desiredTimeMode),
    );
    const formDesiredTimeLabel = computed(() =>
      formatClockParts(form.value.desiredHour, form.value.desiredMinute),
    );
    const callDesiredTimeLabel = computed(() =>
      formatClockParts(
        callForm.value.desiredHour,
        callForm.value.desiredMinute,
      ),
    );

    const locationTitleState = ref({
      pickup: { manual: false, pending: false, requestId: 0, pointKey: "" },
      dropoff: { manual: false, pending: false, requestId: 0, pointKey: "" },
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
      fareModel: "HYBRID",
      officeName: "事務所",
      businessHoursEnabled: false,
      businessHoursStart: "08:00",
      businessHoursEnd: "18:00",
      idleReturnThresholdMinutes: 40,
      lunchBreakEnabled: false,
      lunchBreakStart: "11:00",
      lunchBreakEnd: "12:00",
    });
    const vehicleEditor = ref([]);

    const availableStops = computed(() =>
      stops.value.map((stop) => ({
        title: `${stop.name} (${stop.id})`,
        value: stop.id,
        searchText: `${stop.name} ${stop.id}`,
      })),
    );

    function filterStopItem(value, query, item) {
      const normalizedQuery = normalizeStopSearchText(query);
      if (!normalizedQuery) {
        return true;
      }
      const normalizedValue = normalizeStopSearchText(value);
      const normalizedExtra = normalizeStopSearchText(item?.raw?.searchText);
      return (
        normalizedValue.includes(normalizedQuery) ||
        normalizedExtra.includes(normalizedQuery)
      );
    }

    const locationInputOptions = LOCATION_INPUT_OPTIONS;
    const locationPolicyOptions = LOCATION_POLICY_OPTIONS;
    const fareModelOptions = FARE_MODEL_OPTIONS;

    const topbarLocationModeTitle = computed(() => {
      const mode = serviceProfile.value?.locationPolicy?.mode ?? "HYBRID";
      return findOption(locationPolicyOptions, mode)?.title ?? mode;
    });

    const pickupModeDescription = computed(
      () =>
        findOption(locationInputOptions, form.value.pickupMode)?.description ??
        "",
    );

    const dropoffModeDescription = computed(
      () =>
        findOption(locationInputOptions, form.value.dropoffMode)?.description ??
        "",
    );

    const locationModeDescription = computed(
      () =>
        findOption(locationPolicyOptions, profileEditor.value.locationMode)
          ?.description ?? "",
    );

    const fareModelDescription = computed(
      () =>
        findOption(fareModelOptions, profileEditor.value.fareModel)
          ?.description ?? "",
    );

    const stopIndex = computed(() => {
      const index = new Map();
      stops.value.forEach((stop) => {
        index.set(stop.id, stop);
      });
      return index;
    });

    const vehicleIndex = computed(() => {
      const index = new Map();
      vehicles.value.forEach((vehicle) => {
        index.set(vehicle.id, vehicle);
      });
      return index;
    });

    const requestIndex = computed(() => {
      const index = new Map();
      requests.value.forEach((request) => {
        index.set(request.id, request);
      });
      return index;
    });

    const kpi = computed(() => {
      const assigned = requests.value.filter(
        (request) => request.status === "ASSIGNED",
      ).length;
      const pending = requests.value.filter(
        (request) => request.status === "PENDING",
      ).length;
      const successRate = requests.value.length
        ? `${Math.round((assigned / requests.value.length) * 100)}%`
        : "-";

      const avgWait = requests.value.length
        ? `${(
            requests.value
              .map((request) =>
                Number(request.assignment?.etaPickupMinutes ?? 0),
              )
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
        callCount: summary.value.callEvents,
      };
    });

    const currentDateLabel = computed(() => formatDateLabel(now.value));
    const currentClockLabel = computed(() => formatClock(now.value));
    const formDesiredDateLabel = computed(() => {
      const date = parseDateKeyToDate(form.value.desiredDate);
      return date ? formatDateLabel(date) : "日付を選択";
    });
    const formDesiredDateWeekdayLabel = computed(
      () => formatWeekdayLabel(form.value.desiredDate) || "カレンダーから選択",
    );
    const callDesiredDateLabel = computed(() => {
      const date = parseDateKeyToDate(callForm.value.desiredDate);
      return date ? formatDateLabel(date) : "日付を選択";
    });
    const callDesiredDateWeekdayLabel = computed(
      () =>
        formatWeekdayLabel(callForm.value.desiredDate) || "カレンダーから選択",
    );

    function openNativeDatePicker(target) {
      const inputEl =
        target === "dispatch"
          ? dispatchDateInputEl.value
          : callDateInputEl.value;
      if (!(inputEl instanceof HTMLInputElement)) {
        return;
      }
      if (typeof inputEl.showPicker === "function") {
        inputEl.showPicker();
        return;
      }
      inputEl.focus();
      inputEl.click();
    }
    const mapSelectionField = ref("");
    const mapSelectionVehicleIndex = ref(null);
    const isMapPicking = computed(() => Boolean(mapSelectionField.value));
    const mapSelectionHint = computed(() => {
      if (!mapSelectionField.value) {
        return "";
      }
      if (mapSelectionField.value === "vehicleOffice") {
        const index = Number(mapSelectionVehicleIndex.value);
        const vehicle = Number.isInteger(index)
          ? vehicleEditor.value[index]
          : null;
        const vehicleName =
          typeof vehicle?.name === "string" && vehicle.name.trim()
            ? vehicle.name.trim()
            : Number.isInteger(index) && index >= 0
              ? `車両${index + 1}`
              : "車両";
        return `${vehicleName} の事務所位置を地図で選択中: クリックで座標を設定`;
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
      const customTitle =
        typeof location.title === "string" ? location.title.trim() : "";
      if (customTitle) {
        return customTitle;
      }
      if (location.stopId && stopIndex.value.has(location.stopId)) {
        return stopIndex.value.get(location.stopId).name;
      }
      if (location.resolvedAs === "VIRTUAL_STOP") {
        return "仮想停留所";
      }
      if (
        location.mode === "FREE_POINT" ||
        location.resolvedAs === "FREE_POINT"
      ) {
        return "自由地点";
      }
      return "地点";
    }

    function resolveVehicleDisplayName(vehicleId, { includeId = false } = {}) {
      const normalizedId =
        typeof vehicleId === "string" ? vehicleId.trim() : "";
      if (!normalizedId || normalizedId === "-") {
        return "-";
      }
      const vehicleMeta = vehicleIndex.value.get(normalizedId);
      const vehicleName =
        typeof vehicleMeta?.name === "string" ? vehicleMeta.name.trim() : "";
      if (!vehicleName) {
        return normalizedId;
      }
      if (includeId && vehicleName !== normalizedId) {
        return `${vehicleName} (${normalizedId})`;
      }
      return vehicleName;
    }

    function resolveVehicleTaskRequest(task) {
      if (!task?.requestId) {
        return null;
      }
      return requestIndex.value.get(task.requestId) ?? null;
    }

    function resolveVehicleTaskPlannedAt(task, request = null) {
      const taskType = normalizeRouteTaskType(task?.type);
      if (!taskType) {
        return null;
      }
      const targetRequest = request ?? resolveVehicleTaskRequest(task);
      if (!targetRequest) {
        return null;
      }
      const assignment = targetRequest.assignment ?? {};
      const plannedAt =
        taskType === "PICKUP"
          ? assignment?.plannedPickupAt
          : assignment?.plannedDropoffAt;
      if (typeof plannedAt !== "string") {
        return null;
      }
      return parseTimeValueMs(plannedAt) === null ? null : plannedAt;
    }

    function resolveVehicleTaskEtaMinutes(task, request = null) {
      const taskType = normalizeRouteTaskType(task?.type);
      if (!taskType) {
        return null;
      }
      const targetRequest = request ?? resolveVehicleTaskRequest(task);
      if (!targetRequest) {
        return null;
      }
      const assignment = targetRequest.assignment ?? {};
      const etaRaw = Number(
        taskType === "PICKUP"
          ? assignment?.etaPickupMinutes
          : assignment?.etaDropoffMinutes,
      );
      if (!Number.isFinite(etaRaw)) {
        return null;
      }
      return Math.max(0, etaRaw);
    }

    function resolveVehicleTaskLocationLabel(task, request = null) {
      const taskType = normalizeRouteTaskType(task?.type);
      const targetRequest = request ?? resolveVehicleTaskRequest(task);
      if (targetRequest && taskType) {
        return resolveLocationLabel(
          taskType === "PICKUP" ? targetRequest.pickup : targetRequest.dropoff,
        );
      }
      if (hasPoint(task?.point)) {
        return `${formatCoordinate(task.point.lat)},${formatCoordinate(task.point.lng)}`;
      }
      return "地点";
    }

    function resolveVehicleTaskRequestLabel(task, request = null) {
      const targetRequest = request ?? resolveVehicleTaskRequest(task);
      const passengerName =
        typeof targetRequest?.passenger?.name === "string"
          ? targetRequest.passenger.name.trim()
          : "";
      const passengerPhone =
        typeof targetRequest?.passenger?.phoneNumber === "string"
          ? targetRequest.passenger.phoneNumber.trim()
          : typeof targetRequest?.passenger?.phone === "string"
            ? targetRequest.passenger.phone.trim()
            : "";
      if (passengerName && passengerPhone) {
        return `${passengerName} / ${passengerPhone}`;
      }
      return passengerPhone || passengerName || task?.requestId || "-";
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
      if (
        !Number.isFinite(cached.distanceKm) ||
        !Number.isFinite(cached.durationMinutes)
      ) {
        return null;
      }
      return {
        distanceKm: Math.max(0, Number(cached.distanceKm)),
        durationMinutes: Math.max(0, Number(cached.durationMinutes)),
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
        status: "pending",
      });

      try {
        const response = await apiPost("/api/routing/path", {
          points: [from, to],
        });
        const source =
          typeof response?.source === "string"
            ? response.source.toUpperCase()
            : "";
        const durationMinutes = Number(response?.durationMinutes);
        const distanceMeters = Number(response?.distanceMeters);
        const supportsMetricDisplay =
          source === "OSRM" || source === "STRAIGHT_LINE";
        if (
          !supportsMetricDisplay ||
          !Number.isFinite(durationMinutes) ||
          durationMinutes < 0 ||
          !Number.isFinite(distanceMeters) ||
          distanceMeters < 0
        ) {
          routeSegmentMetricsCache.set(cacheKey, {
            status: "failed",
            failedAt: Date.now(),
          });
          return;
        }
        routeSegmentMetricsCache.set(cacheKey, {
          status: "ready",
          distanceKm: distanceMeters / 1000,
          durationMinutes,
        });
      } catch (_error) {
        routeSegmentMetricsCache.set(cacheKey, {
          status: "failed",
          failedAt: Date.now(),
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

    function resolveRouteTaskServiceMinutes(taskType) {
      const dispatchPolicy = serviceProfile.value?.dispatchPolicy ?? {};
      const pickupServiceRaw = Number(dispatchPolicy.pickupServiceMinutes);
      const dropoffServiceRaw = Number(dispatchPolicy.dropoffServiceMinutes);
      const pickupServiceMinutes =
        Number.isFinite(pickupServiceRaw) && pickupServiceRaw >= 0
          ? pickupServiceRaw
          : 0;
      const dropoffServiceMinutes =
        Number.isFinite(dropoffServiceRaw) && dropoffServiceRaw >= 0
          ? dropoffServiceRaw
          : 0;

      if (taskType === "PICKUP") {
        return pickupServiceMinutes;
      }
      if (taskType === "DROPOFF") {
        return dropoffServiceMinutes;
      }
      return 0;
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
        const taskType = normalizeRouteTaskType(task?.type);
        const segmentMetrics = getRouteSegmentMetricsFromCache(
          current,
          task.point,
        );
        if (!segmentMetrics) {
          void requestRouteSegmentMetrics(current, task.point);
          elapsedDistanceKm = null;
          elapsedMinutes = null;
        } else if (
          Number.isFinite(elapsedDistanceKm) &&
          Number.isFinite(elapsedMinutes)
        ) {
          elapsedDistanceKm += segmentMetrics.distanceKm;
          elapsedMinutes += segmentMetrics.durationMinutes;
        }
        timeline.push({
          task,
          taskType,
          elapsedDistanceKm,
          elapsedMinutes,
        });
        current = task.point;
        if (Number.isFinite(elapsedMinutes)) {
          elapsedMinutes += resolveRouteTaskServiceMinutes(taskType);
        }
      }

      const result = new Map();
      for (let index = 0; index < timeline.length; index += 1) {
        const entry = timeline[index];
        const requestId = entry.task?.requestId;
        if (!requestId || entry.taskType !== "DROPOFF") {
          continue;
        }
        if (result.has(requestId)) {
          continue;
        }

        const nextTaskIndex = timeline.findIndex(
          (candidate, candidateIndex) =>
            candidateIndex > index && Boolean(candidate.taskType),
        );
        const nextTaskEntry =
          nextTaskIndex >= 0 ? timeline[nextTaskIndex] : null;
        const nextPickupIndex = timeline.findIndex(
          (candidate, candidateIndex) =>
            candidateIndex > index && candidate.taskType === "PICKUP",
        );
        const nextPickupEntry =
          nextPickupIndex >= 0 ? timeline[nextPickupIndex] : null;
        const hasNextTask = nextTaskEntry !== null;
        const nextTaskType = hasNextTask ? nextTaskEntry.taskType : "";
        const hasNextPickup = nextPickupEntry !== null;
        const dropoffDistanceKm = Number.isFinite(entry.elapsedDistanceKm)
          ? entry.elapsedDistanceKm
          : null;
        const dropoffMinutes = Number.isFinite(entry.elapsedMinutes)
          ? entry.elapsedMinutes
          : null;
        const nextTaskDistanceKm =
          hasNextTask &&
          Number.isFinite(nextTaskEntry.elapsedDistanceKm) &&
          Number.isFinite(entry.elapsedDistanceKm)
            ? Math.max(
                0,
                nextTaskEntry.elapsedDistanceKm - entry.elapsedDistanceKm,
              )
            : null;
        const nextTaskMinutes =
          hasNextTask &&
          Number.isFinite(nextTaskEntry.elapsedMinutes) &&
          Number.isFinite(entry.elapsedMinutes)
            ? Math.max(0, nextTaskEntry.elapsedMinutes - entry.elapsedMinutes)
            : null;
        const nextPickupDistanceKm =
          hasNextPickup &&
          Number.isFinite(nextPickupEntry.elapsedDistanceKm) &&
          Number.isFinite(entry.elapsedDistanceKm)
            ? Math.max(
                0,
                nextPickupEntry.elapsedDistanceKm - entry.elapsedDistanceKm,
              )
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
          nextTaskDistanceKm,
          nextTaskMinutes,
          nextTaskType,
          hasNextTask,
          nextPickupDistanceKm,
          nextPickupMinutes,
          hasNextPickup,
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

    const nextPickupByRequest = computed(() => {
      const result = new Map();
      const requestsByVehicle = new Map();

      function isFuturePickupCandidate(status) {
        return (
          status !== "PICKED_UP" &&
          status !== "COMPLETED" &&
          status !== "CANCELLED" &&
          status !== "CANCELED" &&
          status !== "REJECTED"
        );
      }

      for (const request of requests.value) {
        const status = normalizeRequestStatus(request.status);
        const vehicleId =
          typeof request.assignment?.vehicleId === "string"
            ? request.assignment.vehicleId.trim()
            : "";
        if (!vehicleId) {
          continue;
        }
        const pickupEtaRaw = Number(request.assignment?.etaPickupMinutes);
        const dropoffEtaRaw = Number(request.assignment?.etaDropoffMinutes);
        const pickupEtaMinutes = Number.isFinite(pickupEtaRaw)
          ? Math.max(0, pickupEtaRaw)
          : null;
        const dropoffEtaMinutes = Number.isFinite(dropoffEtaRaw)
          ? Math.max(0, dropoffEtaRaw)
          : null;
        if (pickupEtaMinutes === null && dropoffEtaMinutes === null) {
          continue;
        }
        const dropoffPoint = resolveLocationPoint(request.dropoff);
        if (!requestsByVehicle.has(vehicleId)) {
          requestsByVehicle.set(vehicleId, []);
        }
        requestsByVehicle.get(vehicleId).push({
          requestId: request.id,
          status,
          pickupEtaMinutes,
          dropoffEtaMinutes,
          pickupPoint: resolveLocationPoint(request.pickup),
          dropoffPoint,
        });
      }

      requestsByVehicle.forEach((entries) => {
        if (!Array.isArray(entries) || entries.length === 0) {
          return;
        }
        const pickupCandidates = entries
          .filter(
            (entry) =>
              isFuturePickupCandidate(entry.status) &&
              Number.isFinite(entry.pickupEtaMinutes),
          )
          .sort(
            (left, right) => left.pickupEtaMinutes - right.pickupEtaMinutes,
          );
        if (!pickupCandidates.length) {
          return;
        }

        entries.forEach((entry) => {
          if (!Number.isFinite(entry.dropoffEtaMinutes)) {
            return;
          }

          const nextEntry =
            pickupCandidates.find(
              (candidate) =>
                candidate.requestId !== entry.requestId &&
                Number.isFinite(candidate.pickupEtaMinutes) &&
                candidate.pickupEtaMinutes > entry.dropoffEtaMinutes,
            ) ?? null;
          if (!nextEntry) {
            return;
          }

          const etaDeltaMinutes = roundedEta(
            nextEntry.pickupEtaMinutes - entry.dropoffEtaMinutes,
          );
          let distanceKm = null;
          if (hasPoint(entry.dropoffPoint) && hasPoint(nextEntry.pickupPoint)) {
            const segmentMetrics = getRouteSegmentMetricsFromCache(
              entry.dropoffPoint,
              nextEntry.pickupPoint,
            );
            if (segmentMetrics) {
              distanceKm = roundedDistanceKm(segmentMetrics.distanceKm);
            } else {
              void requestRouteSegmentMetrics(
                entry.dropoffPoint,
                nextEntry.pickupPoint,
              );
            }
          }

          result.set(entry.requestId, {
            etaMinutes: etaDeltaMinutes,
            distanceKm,
          });
        });
      });

      return result;
    });

    watch(
      vehicles,
      (nextVehicles) => {
        nextVehicles.forEach((vehicle) => {
          primeVehicleRouteSegmentMetrics(vehicle);
        });
      },
      { deep: true, immediate: true },
    );

    const requestRows = computed(() => {
      const nowValue = now.value;
      return [...requests.value]
        .sort((left, right) => {
          const leftPickupSort = resolvePlannedDateTime({
            plannedAt: left.assignment?.plannedPickupAt,
            etaMinutes: left.assignment?.etaPickupMinutes,
            fallbackAt: left.createdAt,
            now: nowValue,
          }).getTime();
          const rightPickupSort = resolvePlannedDateTime({
            plannedAt: right.assignment?.plannedPickupAt,
            etaMinutes: right.assignment?.etaPickupMinutes,
            fallbackAt: right.createdAt,
            now: nowValue,
          }).getTime();
          if (leftPickupSort !== rightPickupSort) {
            return leftPickupSort - rightPickupSort;
          }

          const leftDropoffSort = resolvePlannedDateTime({
            plannedAt: left.assignment?.plannedDropoffAt,
            etaMinutes: left.assignment?.etaDropoffMinutes,
            fallbackAt: left.createdAt,
            now: nowValue,
          }).getTime();
          const rightDropoffSort = resolvePlannedDateTime({
            plannedAt: right.assignment?.plannedDropoffAt,
            etaMinutes: right.assignment?.etaDropoffMinutes,
            fallbackAt: right.createdAt,
            now: nowValue,
          }).getTime();
          if (leftDropoffSort !== rightDropoffSort) {
            return leftDropoffSort - rightDropoffSort;
          }

          const leftCreatedAt = new Date(left.createdAt ?? 0).getTime();
          const rightCreatedAt = new Date(right.createdAt ?? 0).getTime();
          if (leftCreatedAt !== rightCreatedAt) {
            return leftCreatedAt - rightCreatedAt;
          }
          return String(left.id ?? "").localeCompare(String(right.id ?? ""));
        })
        .map((request) => {
          const pickupPoint = resolveLocationPoint(request.pickup);
          const dropoffPoint = resolveLocationPoint(request.dropoff);
          const etaRaw = Number(request.assignment?.etaPickupMinutes);
          const etaDropoffRaw = Number(request.assignment?.etaDropoffMinutes);
          const etaMinutes = roundedEta(etaRaw);
          const etaDropoffMinutes = roundedEta(etaDropoffRaw);
          const vehicleId = request.assignment?.vehicleId ?? "-";
          const vehicleLabel = resolveVehicleDisplayName(vehicleId, {
            includeId: true,
          });
          const routeMetrics = requestRouteMetrics.value.get(request.id);
          const dropoffTravelDistanceKm = roundedDistanceKm(
            routeMetrics?.dropoffDistanceKm,
          );
          const dropoffTravelMinutes = roundedEta(routeMetrics?.dropoffMinutes);
          let nextTaskTravelDistanceKm = roundedDistanceKm(
            routeMetrics?.nextTaskDistanceKm,
          );
          let nextTaskTravelMinutes = roundedEta(routeMetrics?.nextTaskMinutes);
          let hasNextTask = Boolean(routeMetrics?.hasNextTask);
          let nextTaskType =
            typeof routeMetrics?.nextTaskType === "string"
              ? routeMetrics.nextTaskType
              : "";
          if (!hasNextTask) {
            const fallback = nextPickupByRequest.value.get(request.id);
            if (fallback) {
              hasNextTask = true;
              nextTaskType = "PICKUP";
              if (nextTaskTravelDistanceKm === null) {
                nextTaskTravelDistanceKm = fallback.distanceKm;
              }
              if (nextTaskTravelMinutes === null) {
                nextTaskTravelMinutes = fallback.etaMinutes;
              }
            }
          }
          const nextTaskLabel =
            nextTaskType === "DROPOFF"
              ? "降車"
              : nextTaskType === "PICKUP"
                ? "乗車"
                : "停車";
          const idleReturnThresholdRaw = Number(
            serviceProfile.value?.operationPolicy?.idleReturnThresholdMinutes,
          );
          const idleReturnThresholdMinutes =
            Number.isFinite(idleReturnThresholdRaw) &&
            idleReturnThresholdRaw >= 0
              ? Math.round(idleReturnThresholdRaw)
              : 40;
          const shouldReturnOffice =
            nextTaskType === "PICKUP" &&
            Number.isFinite(nextTaskTravelMinutes) &&
            nextTaskTravelMinutes >= idleReturnThresholdMinutes;
          const plannedPickup = resolvePlannedDateTime({
            plannedAt: request.assignment?.plannedPickupAt,
            etaMinutes,
            fallbackAt: request.createdAt,
            now: nowValue,
          });
          const plannedDropoff = resolvePlannedDateTime({
            plannedAt: request.assignment?.plannedDropoffAt,
            etaMinutes: etaDropoffMinutes,
            fallbackAt: request.createdAt,
            now: nowValue,
          });
          const pickupDateKey = formatDateKey(plannedPickup);
          const dropoffDateKey = formatDateKey(plannedDropoff);
          const pickupDateLabel = formatDateLabel(plannedPickup);
          const dropoffDateLabel = formatDateLabel(plannedDropoff);
          const passengerName =
            typeof request.passenger?.name === "string"
              ? request.passenger.name.trim()
              : "";
          const passengerPhone =
            typeof request.passenger?.phoneNumber === "string"
              ? request.passenger.phoneNumber.trim()
              : typeof request.passenger?.phone === "string"
                ? request.passenger.phone.trim()
                : "";

          return {
            id: request.id,
            status: request.status,
            statusLabel: statusLabel(request.status),
            statusColor: statusColor(request.status),
            channel: request.channel,
            partySize: request.partySize ?? 1,
            vehicleId,
            vehicleLabel,
            etaMinutes,
            etaDropoffMinutes,
            dropoffTravelDistanceKm,
            dropoffTravelMinutes,
            dropoffTravelDistanceLabel: formatDistanceLabel(
              dropoffTravelDistanceKm,
            ),
            dropoffTravelMinutesLabel: formatMinutesLabel(dropoffTravelMinutes),
            nextTaskTravelDistanceKm,
            nextTaskTravelMinutes,
            nextTaskTravelDistanceLabel: formatDistanceLabel(
              nextTaskTravelDistanceKm,
            ),
            nextTaskTravelMinutesLabel: formatMinutesLabel(
              nextTaskTravelMinutes,
            ),
            hasNextTask,
            nextTaskType,
            nextTaskLabel,
            shouldReturnOffice,
            idleReturnThresholdMinutes,
            pickupDateKey,
            pickupDateLabel,
            dropoffDateKey,
            dropoffDateLabel,
            displayTime: formatClock(plannedPickup),
            displayDateTime: formatDateTimeLabel(plannedPickup),
            dropoffDisplayTime:
              pickupDateKey === dropoffDateKey
                ? formatClock(plannedDropoff)
                : `${dropoffDateLabel} ${formatClock(plannedDropoff)}`,
            dropoffDateTime: formatDateTimeLabel(plannedDropoff),
            createdTime: formatDateTimeLabel(request.createdAt),
            pickupLabel: resolveLocationLabel(request.pickup),
            dropoffLabel: resolveLocationLabel(request.dropoff),
            pickupPoint,
            dropoffPoint,
            pickupStopId: request.pickup?.stopId ?? null,
            dropoffStopId: request.dropoff?.stopId ?? null,
            passengerName,
            passengerPhone,
          };
        });
    });

    const requestDateSections = computed(() => {
      const sectionIndex = new Map();
      const sections = [];
      requestRows.value.forEach((row) => {
        const key = row.pickupDateKey || "unknown";
        if (!sectionIndex.has(key)) {
          const nextSection = {
            dateKey: key,
            dateLabel: row.pickupDateLabel || "日付未設定",
            rows: [],
          };
          sectionIndex.set(key, nextSection);
          sections.push(nextSection);
        }
        sectionIndex.get(key).rows.push(row);
      });
      return sections;
    });

    const selectedRequest = computed(
      () =>
        requestRows.value.find(
          (request) => request.id === selectedRequestId.value,
        ) ??
        requestRows.value[0] ??
        null,
    );

    const selectedVehicleRoutePlan = computed(() => {
      const selectedVehicleId =
        typeof selectedRequest.value?.vehicleId === "string"
          ? selectedRequest.value.vehicleId.trim()
          : "";
      const fallbackVehicle =
        vehicles.value.find(
          (vehicle) =>
            Array.isArray(vehicle?.route) && vehicle.route.length > 0,
        ) ??
        vehicles.value.find(
          (vehicle) =>
            String(vehicle?.status ?? "")
              .trim()
              .toUpperCase() === "ACTIVE",
        ) ??
        vehicles.value[0] ??
        null;
      const vehicle =
        selectedVehicleId && selectedVehicleId !== "-"
          ? (vehicleIndex.value.get(selectedVehicleId) ?? fallbackVehicle)
          : fallbackVehicle;

      if (!vehicle) {
        return {
          vehicleId: "",
          vehicleLabel: "-",
          steps: [],
          routePoints: [],
          emptyLabel: "対象車両なし",
        };
      }

      const vehicleName =
        typeof vehicle?.name === "string" && vehicle.name.trim()
          ? vehicle.name.trim()
          : "";
      const vehicleLabel =
        vehicleName && vehicleName !== vehicle.id
          ? `${vehicleName} (${vehicle.id})`
          : vehicle.id;
      const officeName = resolveOfficeName(serviceProfile.value);
      const officePoint = resolveVehicleOfficePoint(
        vehicle,
        serviceProfile.value,
      );
      const currentPoint = hasPoint(vehicle.currentLocation)
        ? {
            lat: Number(vehicle.currentLocation.lat),
            lng: Number(vehicle.currentLocation.lng),
          }
        : null;
      let emptyLabel = "乗降予定なし";
      if (currentPoint && officePoint) {
        const officeDistanceMeters = distanceMeters(currentPoint, officePoint);
        if (Number.isFinite(officeDistanceMeters)) {
          emptyLabel =
            officeDistanceMeters > OFFICE_RETURN_ARRIVAL_METERS
              ? `乗降予定なし（${officeName}帰還中）`
              : `乗降予定なし（${officeName}待機中）`;
        }
      }

      const route = Array.isArray(vehicle.route) ? vehicle.route : [];
      if (!route.length || !hasPoint(vehicle.currentLocation)) {
        return {
          vehicleId: vehicle.id,
          vehicleLabel,
          steps: [],
          routePoints: currentPoint ? [currentPoint] : [],
          emptyLabel,
        };
      }

      const steps = [];
      let previousPoint = vehicle.currentLocation;
      let onboard = Number.isFinite(Number(vehicle.onboardCount))
        ? Math.round(Number(vehicle.onboardCount))
        : 0;

      for (let index = 0; index < route.length; index += 1) {
        const task = route[index];
        const taskType = normalizeRouteTaskType(task?.type);
        if (!taskType || !hasPoint(task?.point)) {
          continue;
        }

        const request = resolveVehicleTaskRequest(task);
        const locationLabel = resolveVehicleTaskLocationLabel(task, request);
        const requestLabel = resolveVehicleTaskRequestLabel(task, request);
        const loadDelta = Number.isFinite(Number(task?.loadChange))
          ? Number(task.loadChange)
          : 0;
        const passengerCount = Math.max(0, Math.abs(Math.trunc(loadDelta)));
        onboard += loadDelta;

        let moveDistanceLabel = "-";
        let moveMinutesLabel = "-";
        if (hasPoint(previousPoint)) {
          const segmentMetrics = getRouteSegmentMetricsFromCache(
            previousPoint,
            task.point,
          );
          if (segmentMetrics) {
            moveDistanceLabel =
              formatDistanceLabel(segmentMetrics.distanceKm) ?? "-";
            moveMinutesLabel =
              formatMinutesLabel(segmentMetrics.durationMinutes) ?? "-";
          } else {
            void requestRouteSegmentMetrics(previousPoint, task.point);
            moveDistanceLabel = "算出中";
            moveMinutesLabel = "算出中";
          }
        }

        const plannedAt = resolveVehicleTaskPlannedAt(task, request);
        const etaMinutes = plannedAt
          ? null
          : resolveVehicleTaskEtaMinutes(task, request);
        const arrivalMs =
          parseTimeValueMs(plannedAt) ??
          (Number.isFinite(etaMinutes)
            ? now.value.getTime() + etaMinutes * 60 * 1000
            : null);

        const nextTask =
          route
            .slice(index + 1)
            .find(
              (candidate) =>
                normalizeRouteTaskType(candidate?.type) &&
                hasPoint(candidate?.point),
            ) ?? null;
        const nextRequest = nextTask
          ? resolveVehicleTaskRequest(nextTask)
          : null;
        const nextPlannedAt = nextTask
          ? resolveVehicleTaskPlannedAt(nextTask, nextRequest)
          : null;
        const nextEtaMinutes =
          nextTask && !nextPlannedAt
            ? resolveVehicleTaskEtaMinutes(nextTask, nextRequest)
            : null;
        const nextArrivalMs =
          parseTimeValueMs(nextPlannedAt) ??
          (Number.isFinite(nextEtaMinutes)
            ? now.value.getTime() + nextEtaMinutes * 60 * 1000
            : null);

        let waitLabel = "-";
        if (Number.isFinite(arrivalMs) && Number.isFinite(nextArrivalMs)) {
          const serviceMinutes = resolveRouteTaskServiceMinutes(taskType);
          const rawWaitMinutes =
            (nextArrivalMs - arrivalMs) / (60 * 1000) - serviceMinutes;
          waitLabel = `${Math.max(0, Math.round(rawWaitMinutes))}分`;
        }
        const arrivalDate = Number.isFinite(arrivalMs)
          ? new Date(arrivalMs)
          : null;

        steps.push({
          key: `${task.requestId ?? "task"}-${taskType}-${index}`,
          sequence: index + 1,
          routeIndex: index,
          typeLabel: taskType === "PICKUP" ? "乗" : "降",
          type: taskType,
          typeBadgeClass: taskType === "PICKUP" ? "is-pickup" : "is-dropoff",
          passengerCount,
          locationLabel,
          requestLabel,
          requestId: typeof task?.requestId === "string" ? task.requestId : "",
          point: {
            lat: Number(task.point.lat),
            lng: Number(task.point.lng),
          },
          moveDistanceLabel,
          moveMinutesLabel,
          arrivalDateKey: arrivalDate ? formatDateKey(arrivalDate) : "",
          arrivalDateLabel: arrivalDate
            ? formatDateLabel(arrivalDate)
            : "日付未設定",
          arrivalDateTime: arrivalDate
            ? formatDateTimeLabel(arrivalDate)
            : "--:--",
          arrivalLabel:
            arrivalMs === null ? "--:--" : formatClock(new Date(arrivalMs)),
          waitLabel,
          onboardAfter: Math.max(0, onboard),
        });

        previousPoint = task.point;
      }

      return {
        vehicleId: vehicle.id,
        vehicleLabel,
        steps,
        routePoints: [currentPoint, ...steps.map((step) => step.point)].filter(
          hasPoint,
        ),
        emptyLabel: "乗降予定なし",
      };
    });

    const selectedVehicleRouteVehicleLabel = computed(
      () => selectedVehicleRoutePlan.value.vehicleLabel,
    );
    const selectedVehicleRouteSteps = computed(
      () => selectedVehicleRoutePlan.value.steps,
    );
    const selectedVehicleRouteDateSections = computed(() => {
      const sectionIndex = new Map();
      const sections = [];
      selectedVehicleRouteSteps.value.forEach((step) => {
        const key = step.arrivalDateKey || "unknown";
        if (!sectionIndex.has(key)) {
          const nextSection = {
            dateKey: key,
            dateLabel: step.arrivalDateLabel || "日付未設定",
            steps: [],
          };
          sectionIndex.set(key, nextSection);
          sections.push(nextSection);
        }
        sectionIndex.get(key).steps.push(step);
      });
      return sections;
    });
    const selectedPanelDateKey = ref("");
    const panelAvailableDateKeys = computed(() => {
      const keys = new Set();
      requestDateSections.value.forEach((section) => {
        if (section?.dateKey) {
          keys.add(section.dateKey);
        }
      });
      selectedVehicleRouteDateSections.value.forEach((section) => {
        if (section?.dateKey) {
          keys.add(section.dateKey);
        }
      });
      return [...keys].sort((left, right) => left.localeCompare(right));
    });
    const activePanelDateKey = computed(() => {
      const keys = panelAvailableDateKeys.value;
      if (!keys.length) {
        return "";
      }
      if (keys.includes(selectedPanelDateKey.value)) {
        return selectedPanelDateKey.value;
      }
      return keys[0];
    });
    const activePanelDate = computed(() =>
      parseDateKeyToDate(activePanelDateKey.value),
    );
    const activePanelDateLabel = computed(() =>
      activePanelDate.value
        ? formatDateLabel(activePanelDate.value)
        : "日付なし",
    );
    const activePanelDateWeekdayLabel = computed(() =>
      activePanelDate.value ? formatWeekdayLabel(activePanelDate.value) : "",
    );
    const activePanelDateIndex = computed(() =>
      panelAvailableDateKeys.value.findIndex(
        (dateKey) => dateKey === activePanelDateKey.value,
      ),
    );
    const hasPreviousPanelDate = computed(() => activePanelDateIndex.value > 0);
    const hasNextPanelDate = computed(
      () =>
        activePanelDateIndex.value >= 0 &&
        activePanelDateIndex.value < panelAvailableDateKeys.value.length - 1,
    );
    const visibleRequestDateSections = computed(() => {
      const key = activePanelDateKey.value;
      if (!key) {
        return [];
      }
      return requestDateSections.value.filter(
        (section) => section.dateKey === key,
      );
    });
    const visibleVehicleRouteDateSections = computed(() => {
      const key = activePanelDateKey.value;
      if (!key) {
        return [];
      }
      return selectedVehicleRouteDateSections.value.filter(
        (section) => section.dateKey === key,
      );
    });
    const visibleVehicleRouteSteps = computed(() =>
      visibleVehicleRouteDateSections.value.flatMap((section) =>
        Array.isArray(section?.steps) ? section.steps : [],
      ),
    );

    function movePanelDate(delta) {
      if (!Number.isInteger(delta) || delta === 0) {
        return;
      }
      const keys = panelAvailableDateKeys.value;
      if (!keys.length) {
        return;
      }
      const index =
        activePanelDateIndex.value >= 0 ? activePanelDateIndex.value : 0;
      const nextIndex = Math.max(0, Math.min(keys.length - 1, index + delta));
      selectedPanelDateKey.value = keys[nextIndex];
    }

    watch(
      panelAvailableDateKeys,
      (keys) => {
        if (!keys.length) {
          selectedPanelDateKey.value = "";
          return;
        }
        if (keys.includes(selectedPanelDateKey.value)) {
          return;
        }
        const todayKey = formatDateKey(now.value);
        selectedPanelDateKey.value = keys.includes(todayKey)
          ? todayKey
          : keys[0];
      },
      { immediate: true },
    );
    const selectedVehicleRouteEmptyLabel = computed(
      () => selectedVehicleRoutePlan.value.emptyLabel ?? "乗降予定なし",
    );
    const selectedVehicleRoutePoints = computed(() => {
      const currentPoint = selectedVehicleRoutePlan.value.routePoints?.[0];
      const points = hasPoint(currentPoint) ? [currentPoint] : [];
      visibleVehicleRouteSteps.value.forEach((step) => {
        if (hasPoint(step.point)) {
          points.push(step.point);
        }
      });
      return normalizeRoutePoints(points);
    });
    const selectedVehicleRouteStep = computed(
      () =>
        visibleVehicleRouteSteps.value.find(
          (step) => step.key === selectedVehicleRouteStepKey.value,
        ) ?? null,
    );
    const operationMapChipLabel = computed(() => {
      const vehicleLabel = selectedVehicleRouteVehicleLabel.value || "対象車両";
      if (selectedVehicleRouteStep.value) {
        return `${vehicleLabel} / ${selectedVehicleRouteStep.value.arrivalDateTime} / ${selectedVehicleRouteStep.value.sequence}. ${selectedVehicleRouteStep.value.typeLabel} ${selectedVehicleRouteStep.value.locationLabel}`;
      }
      return `${vehicleLabel} / 運行ステップ`;
    });

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
      { immediate: true },
    );

    watch(
      selectedVehicleRouteSteps,
      (steps) => {
        if (!steps.length) {
          selectedVehicleRouteStepKey.value = "";
          return;
        }
        if (
          !steps.some((step) => step.key === selectedVehicleRouteStepKey.value)
        ) {
          selectedVehicleRouteStepKey.value = "";
        }
      },
      { immediate: true },
    );
    watch(
      visibleVehicleRouteSteps,
      (steps) => {
        if (!steps.length) {
          selectedVehicleRouteStepKey.value = "";
          return;
        }
        if (
          !steps.some((step) => step.key === selectedVehicleRouteStepKey.value)
        ) {
          selectedVehicleRouteStepKey.value = "";
        }
      },
      { immediate: true },
    );

    function selectRequest(requestId) {
      selectedRequestId.value = requestId;
      mapDisplayMode.value = "request";
      selectedVehicleRouteStepKey.value = "";
      refreshLeafletMap({ focusSelected: true });
    }

    function selectVehicleRouteStep(stepKey) {
      if (
        !stepKey ||
        !visibleVehicleRouteSteps.value.some((step) => step.key === stepKey)
      ) {
        return;
      }
      mapDisplayMode.value = "operation";
      selectedVehicleRouteStepKey.value =
        selectedVehicleRouteStepKey.value === stepKey ? "" : stepKey;
      refreshLeafletMap({ focusSelected: true });
    }

    function canCancelRequest(row) {
      return (
        row.status !== "CANCELLED" &&
        row.status !== "COMPLETED" &&
        row.status !== "PICKED_UP"
      );
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
        dropoffStopId: row.dropoffStopId,
      })),
    );

    const selectedDispatchOption = computed(
      () =>
        dispatchOptions.value.find(
          (option) => option.optionId === selectedDispatchOptionId.value,
        ) ?? null,
    );
    const dispatchOptionDateSections = computed(() => {
      const sectionIndex = new Map();
      const sections = [];
      dispatchOptions.value.forEach((option) => {
        const plannedDate =
          parseTimeValueMs(option?.plannedPickupAt ?? null) ??
          parseTimeValueMs(option?.plannedDropoffAt ?? null);
        const plannedAt = plannedDate === null ? null : new Date(plannedDate);
        const key = plannedAt ? formatDateKey(plannedAt) : "unknown";
        if (!sectionIndex.has(key)) {
          const nextSection = {
            dateKey: key,
            dateLabel: plannedAt ? formatDateLabel(plannedAt) : "日付未設定",
            options: [],
          };
          sectionIndex.set(key, nextSection);
          sections.push(nextSection);
        }
        sectionIndex.get(key).options.push(option);
      });
      return sections;
    });
    const callRideOptionDateSections = computed(() => {
      const sectionIndex = new Map();
      const sections = [];
      callRideOptions.value.forEach((option) => {
        const plannedDate =
          parseTimeValueMs(option?.plannedPickupAt ?? null) ??
          parseTimeValueMs(option?.plannedDropoffAt ?? null);
        const plannedAt = plannedDate === null ? null : new Date(plannedDate);
        const key = plannedAt ? formatDateKey(plannedAt) : "unknown";
        if (!sectionIndex.has(key)) {
          const nextSection = {
            dateKey: key,
            dateLabel: plannedAt ? formatDateLabel(plannedAt) : "日付未設定",
            options: [],
          };
          sectionIndex.set(key, nextSection);
          sections.push(nextSection);
        }
        sectionIndex.get(key).options.push(option);
      });
      return sections;
    });
    const selectedDispatchStrategyLabel = computed(() => {
      const label =
        typeof selectedDispatchOption.value?.strategyLabel === "string"
          ? selectedDispatchOption.value.strategyLabel.trim()
          : "";
      return label;
    });
    const previewSimulation = computed(
      () => dispatchPreview.value?.simulation ?? null,
    );
    const hasAssignablePreview = computed(
      () => dispatchPreview.value?.status === "ASSIGNABLE",
    );
    const previewStatusLabel = computed(() =>
      statusLabel(dispatchPreview.value?.status),
    );
    const previewVehicleLabel = computed(() =>
      resolveVehicleDisplayName(previewSimulation.value?.vehicleId ?? "-", {
        includeId: false,
      }),
    );
    const previewPickupClock = computed(() =>
      formatDateTimeLabel(previewSimulation.value?.plannedPickupAt),
    );
    const previewDropoffClock = computed(() =>
      formatDateTimeLabel(previewSimulation.value?.plannedDropoffAt),
    );
    const previewAlgorithmLabel = computed(() =>
      dispatchAlgorithmLabel(previewSimulation.value?.selectedAlgorithm),
    );
    const previewAlgorithmPhaseLabel = computed(() =>
      dispatchAlgorithmPhaseLabel(previewSimulation.value?.algorithmPhase),
    );
    const previewRouteDateKey = computed(() => {
      const baseTimeValue =
        selectedDispatchOption.value?.plannedPickupAt ??
        previewSimulation.value?.plannedPickupAt ??
        previewPayload.value?.desiredPickupAt ??
        previewPayload.value?.desiredDropoffAt ??
        null;
      const timestamp = parseTimeValueMs(baseTimeValue);
      if (timestamp === null) {
        return "";
      }
      return formatDateKey(new Date(timestamp));
    });
    const previewRouteAfterSteps = computed(() => {
      const routeAfter = Array.isArray(previewSimulation.value?.routeAfter)
        ? previewSimulation.value.routeAfter
        : [];
      if (!routeAfter.length) {
        return [];
      }
      const dateKey = previewRouteDateKey.value;
      const sameDateSteps = dateKey
        ? routeAfter.filter((step) => {
            const etaTimestamp = parseTimeValueMs(step?.etaAt ?? null);
            if (etaTimestamp === null) {
              return false;
            }
            return formatDateKey(new Date(etaTimestamp)) === dateKey;
          })
        : [];
      const sourceSteps = sameDateSteps.length ? sameDateSteps : routeAfter;
      return sourceSteps.map((step, index) => ({
        ...step,
        displaySequence: index + 1,
      }));
    });
    const previewDropoffSuggestion = computed(() => {
      const suggestion = previewSimulation.value?.desiredDropoffSuggestion;
      if (!suggestion || typeof suggestion !== "object") {
        return null;
      }
      const suggestedDropoffAt =
        typeof suggestion.suggestedDropoffAt === "string" &&
        suggestion.suggestedDropoffAt
          ? suggestion.suggestedDropoffAt
          : null;
      if (!suggestedDropoffAt) {
        return null;
      }
      const requestedDropoffAt =
        typeof suggestion.requestedDropoffAt === "string" &&
        suggestion.requestedDropoffAt
          ? suggestion.requestedDropoffAt
          : null;
      const exceededByMinutesRaw = Number(suggestion.exceededByMinutes);
      const exceededByMinutes =
        Number.isFinite(exceededByMinutesRaw) && exceededByMinutesRaw > 0
          ? Math.round(exceededByMinutesRaw)
          : null;
      const message =
        typeof suggestion.message === "string" && suggestion.message.trim()
          ? suggestion.message.trim()
          : "";
      return {
        requestedDropoffAt,
        suggestedDropoffAt,
        exceededByMinutes,
        message,
      };
    });
    const previewRejectDiagnostics = computed(() =>
      dispatchPreview.value?.status === "REJECTED"
        ? (dispatchPreview.value?.diagnostics ?? null)
        : null,
    );
    const previewRejectSummary = computed(() => {
      const diagnostics = previewRejectDiagnostics.value;
      if (!diagnostics) {
        return "";
      }
      const summary =
        typeof diagnostics.summary === "string"
          ? diagnostics.summary.trim()
          : "";
      if (summary) {
        return summary;
      }
      const inspected = Number(diagnostics.inspectedVehicleCount);
      const candidateCount = Number(diagnostics.candidateCount);
      if (Number.isFinite(candidateCount) && candidateCount > 0) {
        return `${Math.round(candidateCount)}件の候補ルートを評価しましたが、条件を満たす案がありません。`;
      }
      if (Number.isFinite(inspected) && inspected > 0) {
        return `${Math.round(inspected)}台を評価しましたが、条件を満たす案がありません。`;
      }
      return "";
    });
    const previewRejectBreakdown = computed(() => {
      const diagnostics = previewRejectDiagnostics.value;
      if (!diagnostics) {
        return [];
      }

      const breakdown = Array.isArray(diagnostics.breakdown)
        ? diagnostics.breakdown
        : [];
      const fromBreakdown = breakdown
        .map((item) => {
          const count = Number(item?.count);
          if (!Number.isFinite(count) || count <= 0) {
            return null;
          }
          const code = typeof item?.code === "string" ? item.code : "UNKNOWN";
          const ratio = Number(item?.ratioPercent);
          return {
            code,
            label: previewRejectionCodeLabel(code),
            count: Math.round(count),
            ratioPercent: Number.isFinite(ratio) ? Math.round(ratio) : null,
          };
        })
        .filter(Boolean);
      if (fromBreakdown.length) {
        return fromBreakdown;
      }

      const counts = diagnostics.rejectionCounts ?? {};
      const candidateCount = Number(diagnostics.candidateCount);
      const normalizedCandidateCount =
        Number.isFinite(candidateCount) && candidateCount > 0
          ? candidateCount
          : 0;
      return PREVIEW_REJECTION_ORDER.map((code) => {
        const count = Number(counts[code]);
        if (!Number.isFinite(count) || count <= 0) {
          return null;
        }
        return {
          code,
          label: previewRejectionCodeLabel(code),
          count: Math.round(count),
          ratioPercent:
            normalizedCandidateCount > 0
              ? Math.round((count / normalizedCandidateCount) * 100)
              : null,
        };
      }).filter(Boolean);
    });
    const previewRejectConstraintSummary = computed(() => {
      const constraints = previewRejectDiagnostics.value?.constraints;
      if (!constraints || typeof constraints !== "object") {
        return "";
      }
      const segments = [];
      const maxWait = Number(constraints.maxWaitMinutes);
      const maxDetour = Number(constraints.maxDetourMinutes);
      const maxAdditionalStops = Number(constraints.maxAdditionalStops);
      const maxOnboard = Number(constraints.maxOnboardPerVehicle);
      const candidateVehicleLimit = Number(constraints.candidateVehicleLimit);

      if (Number.isFinite(maxWait)) {
        segments.push(`最大待ち ${Math.round(maxWait)}分`);
      }
      if (Number.isFinite(maxDetour)) {
        segments.push(`最大迂回遅延 ${Math.round(maxDetour)}分`);
      }
      if (Number.isFinite(maxAdditionalStops)) {
        segments.push(`追加停留所 ${Math.round(maxAdditionalStops)}`);
      }
      if (Number.isFinite(maxOnboard)) {
        segments.push(`同乗上限 ${Math.round(maxOnboard)}人`);
      }
      if (Number.isFinite(candidateVehicleLimit)) {
        segments.push(`候補車両上限 ${Math.round(candidateVehicleLimit)}台`);
      }
      if (!segments.length) {
        return "";
      }
      return `判定条件: ${segments.join(" / ")}`;
    });
    const previewRejectCountermeasures = computed(() => {
      const diagnostics = previewRejectDiagnostics.value;
      if (!diagnostics) {
        return [];
      }
      const backendCandidates = Array.isArray(
        diagnostics.countermeasureCandidates,
      )
        ? diagnostics.countermeasureCandidates
            .map((item) => (typeof item === "string" ? item.trim() : ""))
            .filter(Boolean)
        : [];
      if (backendCandidates.length) {
        return backendCandidates.slice(0, 6);
      }

      const counts = diagnostics.rejectionCounts ?? {};
      const constraints = diagnostics.constraints ?? {};
      const observed = diagnostics.observed ?? {};
      const items = [];
      const addUnique = (text) => {
        if (!text || items.includes(text)) {
          return;
        }
        items.push(text);
      };
      const countOf = (code) => {
        const value = Number(counts[code]);
        return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
      };

      if (Number(diagnostics.activeVehicleCount) === 0) {
        addUnique(
          "稼働中の車両を ACTIVE に変更するか、車両を追加してください。",
        );
      }
      if (countOf("MAX_WAIT") > 0) {
        const minEta = Number(observed.minEtaPickupMinutes);
        const maxWait = Number(constraints.maxWaitMinutes);
        if (Number.isFinite(minEta) && Number.isFinite(maxWait)) {
          addUnique(
            `最短でも乗車まで約${Math.round(minEta)}分です。希望時刻調整または最大待ち時間(${Math.round(maxWait)}分)の見直しを検討してください。`,
          );
        } else {
          addUnique(
            "乗車希望時刻を調整するか、最大待ち時間の設定を見直してください。",
          );
        }
      }
      if (countOf("MAX_DETOUR") > 0) {
        const minDetour = Number(observed.minDetourMinutes);
        const maxDetour = Number(constraints.maxDetourMinutes);
        if (Number.isFinite(minDetour) && Number.isFinite(maxDetour)) {
          addUnique(
            `既存予約への最小遅延は約${Math.round(minDetour)}分です。地点変更または最大迂回遅延(${Math.round(maxDetour)}分)の見直しを検討してください。`,
          );
        } else {
          addUnique(
            "乗降地点を調整するか、最大迂回遅延の設定を見直してください。",
          );
        }
      }
      if (countOf("CAPACITY") > 0) {
        addUnique("人数を減らすか、同乗上限設定を見直してください。");
      }
      if (countOf("MAX_ADDITIONAL_STOPS") > 0) {
        addUnique(
          "追加停留所上限の緩和または既存予約完了後の再受付を検討してください。",
        );
      }
      if (countOf("CONSECUTIVE_PICKUP") > 0) {
        addUnique(
          "先行予約の降車後に再試算するか、乗車地点・時刻の調整を検討してください。",
        );
      }
      if (!items.length) {
        addUnique("車両現在地を更新して再試算してください。");
      }

      return items.slice(0, 6);
    });
    const previewRoutePoints = computed(() =>
      previewRouteAfterSteps.value.map((task) => task.point).filter(hasPoint),
    );
    const vehicleOfficeLocations = computed(() =>
      vehicles.value
        .map((vehicle) => {
          const sourcePoint = hasPoint(vehicle?.officePoint)
            ? vehicle.officePoint
            : hasPoint(vehicle?.homeBase)
              ? vehicle.homeBase
              : null;
          if (!sourcePoint) {
            return null;
          }
          const vehicleName =
            typeof vehicle?.name === "string" && vehicle.name.trim()
              ? vehicle.name.trim()
              : (vehicle?.id ?? "車両");
          return {
            vehicle,
            name: `${vehicleName} 事務所`,
            point: {
              lat: Number(sourcePoint.lat),
              lng: Number(sourcePoint.lng),
            },
          };
        })
        .filter(Boolean),
    );

    const mapSourcePoints = computed(() => {
      const points = [];
      vehicleOfficeLocations.value.forEach((office) =>
        points.push(office.point),
      );
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

    const hasStopData = computed(() =>
      stops.value.some((stop) => hasPoint(stop)),
    );

    function toPointText(lat, lng) {
      return `${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
    }

    function buildVehicleEditorItem(vehicle = {}) {
      const id = typeof vehicle.id === "string" ? vehicle.id.trim() : "";
      const name =
        typeof vehicle.name === "string" && vehicle.name.trim()
          ? vehicle.name.trim()
          : id;
      const iconColor = (() => {
        try {
          return normalizeColorHex(vehicle.iconColor, "#0284c7");
        } catch (_error) {
          return "#0284c7";
        }
      })();
      const officePoint = hasPoint(vehicle.officePoint)
        ? vehicle.officePoint
        : hasPoint(vehicle.homeBase)
          ? vehicle.homeBase
          : null;
      return {
        id,
        name,
        iconColor,
        officePoint: officePoint
          ? toPointText(officePoint.lat, officePoint.lng)
          : "",
        capacity: Number.isFinite(Number(vehicle.capacity))
          ? Number(vehicle.capacity)
          : 4,
        isExisting: Boolean(id),
      };
    }

    function addVehicleEditorRow() {
      vehicleEditor.value.push(
        buildVehicleEditorItem({
          id: "",
          name: "",
          iconColor: "#0284c7",
          officePoint: "",
          capacity: 4,
        }),
      );
    }

    function removeVehicleEditorRow(index) {
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= vehicleEditor.value.length
      ) {
        return;
      }
      if (vehicleEditor.value[index]?.isExisting) {
        return;
      }
      vehicleEditor.value.splice(index, 1);
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

      const pointText = isPickup
        ? form.value.pickupPoint
        : form.value.dropoffPoint;
      const currentTitle = normalizeLocationTitle(
        isPickup ? form.value.pickupTitle : form.value.dropoffTitle,
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
          lng: String(point.lng),
        });
        const response = await apiGet(
          `/api/geocode/reverse?${query.toString()}`,
        );
        if (locationTitleState.value[field].requestId !== requestId) {
          return;
        }
        const suggestedTitle =
          normalizeLocationTitle(response?.title) ||
          buildFreePointFallbackTitle(point);
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
      mapSelectionVehicleIndex.value = null;
    }

    function applyMapSelection(field, point) {
      if (
        field !== "pickup" &&
        field !== "dropoff" &&
        field !== "vehicleOffice"
      ) {
        return;
      }

      if (field === "vehicleOffice") {
        const index = Number(mapSelectionVehicleIndex.value);
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= vehicleEditor.value.length
        ) {
          throw new Error("車両事務所位置の選択対象が見つかりません。");
        }
        vehicleEditor.value[index].officePoint = toPointText(
          point.lat,
          point.lng,
        );
        cancelMapSelection();
        return;
      }

      const isPickup = field === "pickup";
      const mode = isPickup ? form.value.pickupMode : form.value.dropoffMode;

      if (mode === "FIXED_STOP") {
        const nearestStop = findNearestStop(point);
        if (!nearestStop) {
          throw new Error(
            "停留所データがないため、地図からバス停を選択できません。",
          );
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

    function toggleMapSelection(field, vehicleIndex = null) {
      if (
        field !== "pickup" &&
        field !== "dropoff" &&
        field !== "vehicleOffice"
      ) {
        return;
      }
      if (!ensureLeafletMap()) {
        return;
      }
      const nextVehicleIndex =
        field === "vehicleOffice" ? Number(vehicleIndex) : null;
      if (
        field === "vehicleOffice" &&
        (!Number.isInteger(nextVehicleIndex) ||
          nextVehicleIndex < 0 ||
          nextVehicleIndex >= vehicleEditor.value.length)
      ) {
        errorMessage.value = "対象の車両が見つかりません。";
        return;
      }
      if (
        mapSelectionField.value === field &&
        (field !== "vehicleOffice" ||
          mapSelectionVehicleIndex.value === nextVehicleIndex)
      ) {
        cancelMapSelection();
        return;
      }
      errorMessage.value = "";
      mapSelectionField.value = field;
      mapSelectionVehicleIndex.value =
        field === "vehicleOffice" ? nextVehicleIndex : null;
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
        attributionControl: true,
      });

      leaflet
        .tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: "&copy; OpenStreetMap contributors",
        })
        .addTo(leafletMap);

      mapLayers.stops = leaflet.layerGroup().addTo(leafletMap);
      mapLayers.office = leaflet.layerGroup().addTo(leafletMap);
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
          lng: Number(point.lng),
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

    function buildVehicleRouteCacheKey(vehicle) {
      const routePoints = (vehicle?.route ?? [])
        .map((task) => task?.point)
        .filter(hasPoint);
      return `vehicle:${vehicle?.id ?? ""}|${buildRouteCacheKey(routePoints)}`;
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

    function findNearestPolylineProjection(point, polyline) {
      if (!hasPoint(point)) {
        return null;
      }
      const normalized = normalizeRoutePoints(polyline);
      if (normalized.length < 2) {
        return null;
      }

      let nearest = null;
      for (let index = 0; index < normalized.length - 1; index += 1) {
        const start = normalized[index];
        const end = normalized[index + 1];
        const projection = projectPointOnSegmentMeters(point, start, end);
        if (!projection) {
          continue;
        }
        if (!nearest || projection.distanceMeters < nearest.distanceMeters) {
          nearest = {
            segmentIndex: index,
            distanceMeters: projection.distanceMeters,
            projectedPoint: projection.projectedPoint,
          };
        }
      }

      return nearest;
    }

    function buildOnRoutePolyline(currentPoint, cachedPolyline) {
      const projection = findNearestPolylineProjection(
        currentPoint,
        cachedPolyline,
      );
      if (!projection) {
        return null;
      }
      if (projection.distanceMeters > VEHICLE_ROUTE_ON_PATH_TOLERANCE_METERS) {
        return null;
      }

      const normalized = normalizeRoutePoints(cachedPolyline);
      const result = [
        {
          lat: Number(currentPoint.lat),
          lng: Number(currentPoint.lng),
        },
      ];
      if (
        hasPoint(projection.projectedPoint) &&
        distanceMeters(currentPoint, projection.projectedPoint) >
          ROUTE_POINT_SNAP_TOLERANCE_METERS
      ) {
        result.push({
          lat: Number(projection.projectedPoint.lat),
          lng: Number(projection.projectedPoint.lng),
        });
      }
      for (
        let index = projection.segmentIndex + 1;
        index < normalized.length;
        index += 1
      ) {
        result.push(normalized[index]);
      }

      const path = normalizeRoutePoints(result);
      if (path.length > 1) {
        return path;
      }
      return null;
    }

    const BUS_ICON_COLORS = [
      "#0284c7",
      "#059669",
      "#ea580c",
      "#7c3aed",
      "#dc2626",
      "#0f766e",
      "#b45309",
      "#2563eb",
    ];

    function hashVehicleColorSeed(value) {
      const text = String(value ?? "");
      let hash = 0;
      for (let i = 0; i < text.length; i += 1) {
        hash = (hash << 5) - hash + text.charCodeAt(i);
        hash |= 0;
      }
      return hash;
    }

    function resolveVehicleColor(vehicle) {
      try {
        const configured = normalizeColorHex(vehicle?.iconColor);
        if (configured) {
          return configured;
        }
      } catch (_error) {
        // Fallback to deterministic hashed color.
      }
      const seed = typeof vehicle?.id === "string" ? vehicle.id : "veh";
      const index =
        Math.abs(hashVehicleColorSeed(seed)) % BUS_ICON_COLORS.length;
      return BUS_ICON_COLORS[index];
    }

    function buildVehicleBusIcon({ leaflet, vehicle, isSelected = false }) {
      const color = resolveVehicleColor(vehicle);
      const size = isSelected ? 32 : 28;
      const borderColor = isSelected ? "#0f172a" : "#ffffff";

      return leaflet.divIcon({
        className: "rq-bus-icon",
        html:
          `<div style="width:${size}px;height:${size}px;border-radius:999px;` +
          `background:${color};border:2px solid ${borderColor};` +
          "box-shadow:0 3px 10px rgba(15,23,42,0.35);" +
          "display:flex;align-items:center;justify-content:center;" +
          'color:#ffffff;font-size:16px;line-height:1;">' +
          '<span class="mdi mdi-bus"></span></div>',
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
        popupAnchor: [0, -size / 2],
      });
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
        status: "pending",
      });

      try {
        const response = await apiPost("/api/routing/path", { points });
        const polyline = normalizeRoutePoints(response?.polyline);
        if (polyline.length > 1) {
          setRouteCacheEntry(cacheKey, {
            status: "ready",
            polyline,
          });
        } else {
          setRouteCacheEntry(cacheKey, {
            status: "failed",
            failedAt: Date.now(),
          });
        }
      } catch (_error) {
        setRouteCacheEntry(cacheKey, {
          status: "failed",
          failedAt: Date.now(),
        });
      } finally {
        scheduleRouteMapRefresh();
      }
    }

    function drawRoutePolyline({
      leaflet,
      layer,
      points,
      style,
      cacheKey = "",
      keepCurrentPointOnCachedRoute = false,
    }) {
      const normalized = normalizeRoutePoints(points);
      if (normalized.length < 2) {
        return;
      }

      const cachePoints =
        keepCurrentPointOnCachedRoute && normalized.length > 2
          ? normalized.slice(1)
          : normalized;
      const resolvedCacheKey = cacheKey || buildRouteCacheKey(cachePoints);
      const cached = routeGeometryCache.get(resolvedCacheKey);
      let drawPoints = normalized;
      if (
        cached?.status === "ready" &&
        Array.isArray(cached.polyline) &&
        cached.polyline.length > 1
      ) {
        if (keepCurrentPointOnCachedRoute) {
          const reused = buildOnRoutePolyline(normalized[0], cached.polyline);
          if (reused) {
            drawPoints = reused;
          } else {
            const connector = normalizeRoutePoints([
              normalized[0],
              cached.polyline[0],
            ]);
            if (connector.length > 1) {
              drawPoints = normalizeRoutePoints([
                ...connector,
                ...cached.polyline.slice(1),
              ]);
            } else {
              drawPoints = cached.polyline;
            }
          }
        } else {
          drawPoints = cached.polyline;
        }
      } else {
        void requestRouteGeometry(resolvedCacheKey, normalized);
      }

      leaflet.polyline(drawPoints.map(toLeafletLatLng), style).addTo(layer);
    }

    function refreshLeafletMap({
      fitToData = false,
      focusSelected = false,
    } = {}) {
      if (!ensureLeafletMap()) {
        return;
      }

      const leaflet = window.L;
      clearLeafletLayers();

      const requestRoutePoints = selectedRequest.value
        ? normalizeRoutePoints([
            selectedRequest.value.pickupPoint,
            selectedRequest.value.dropoffPoint,
          ])
        : [];
      const operationRoutePoints = selectedVehicleRoutePoints.value;
      const selectedStep = selectedVehicleRouteStep.value;
      const selectedRouteVehicle = selectedVehicleRoutePlan.value?.vehicleId
        ? (vehicleIndex.value.get(selectedVehicleRoutePlan.value.vehicleId) ??
          null)
        : null;
      const selectedRouteVehicleId = selectedRouteVehicle?.id ?? "";
      const isRequestRouteMode =
        mapDisplayMode.value === "request" && requestRoutePoints.length > 1;
      const selectedRoutePoints = isRequestRouteMode
        ? requestRoutePoints
        : operationRoutePoints;
      const selectedStepRouteIndex = selectedStep
        ? visibleVehicleRouteSteps.value.findIndex(
            (step) => step.key === selectedStep.key,
          )
        : -1;
      const selectedStepPointIndex =
        Number.isInteger(selectedStepRouteIndex) && selectedStepRouteIndex >= 0
          ? selectedStepRouteIndex + 1
          : -1;
      const selectedOperationFocusPoints =
        !isRequestRouteMode && selectedStepPointIndex >= 0
          ? normalizeRoutePoints([
              selectedRoutePoints[selectedStepPointIndex - 1],
              selectedRoutePoints[selectedStepPointIndex],
              selectedRoutePoints[selectedStepPointIndex + 1],
            ])
          : [];
      const selectedRouteFocusPoints = isRequestRouteMode
        ? requestRoutePoints
        : selectedOperationFocusPoints.length
          ? selectedOperationFocusPoints
          : selectedRoutePoints;

      const selectedStopIds = new Set();
      if (isRequestRouteMode) {
        if (selectedRequest.value?.pickupStopId) {
          selectedStopIds.add(selectedRequest.value.pickupStopId);
        }
        if (selectedRequest.value?.dropoffStopId) {
          selectedStopIds.add(selectedRequest.value.dropoffStopId);
        }
      }

      stops.value.forEach((stop) => {
        if (!hasPoint(stop)) {
          return;
        }
        const isSelected = selectedStopIds.has(stop.id);
        const onStopClick = () => {
          if (mapSelectionField.value) {
            applyMapSelection(mapSelectionField.value, {
              lat: stop.lat,
              lng: stop.lng,
            });
          }
        };

        leaflet
          .circleMarker(toLeafletLatLng(stop), {
            radius: isSelected ? 16 : 14,
            color: "transparent",
            weight: 0,
            fillColor: "transparent",
            fillOpacity: 0,
          })
          .on("click", onStopClick)
          .addTo(mapLayers.stops);

        leaflet
          .circleMarker(toLeafletLatLng(stop), {
            radius: isSelected ? 9 : 7.5,
            color: isSelected ? "#1d4ed8" : "#1e3a8a",
            weight: isSelected ? 3 : 2,
            fillColor: isSelected ? "#f97316" : "#facc15",
            fillOpacity: isSelected ? 0.98 : 0.9,
          })
          .bindTooltip(stop.name, { direction: "top", offset: [0, -6] })
          .on("click", onStopClick)
          .addTo(mapLayers.stops);
      });

      vehicleOfficeLocations.value.forEach((office) => {
        const officeColor = resolveVehicleColor(office.vehicle);
        leaflet
          .circleMarker(toLeafletLatLng(office.point), {
            radius: 7,
            color: "#0f172a",
            weight: 2,
            fillColor: officeColor,
            fillOpacity: 0.85,
          })
          .bindTooltip(office.name, {
            direction: "top",
            offset: [0, -8],
          })
          .bindPopup(
            `<strong>${office.name}</strong><br>ID: ${office.vehicle.id}<br>座標: ${formatCoordinate(office.point.lat)}, ${formatCoordinate(office.point.lng)}`,
          )
          .addTo(mapLayers.office);
      });

      vehicles.value.forEach((vehicle) => {
        if (!hasPoint(vehicle.currentLocation)) {
          return;
        }

        const vehicleName =
          typeof vehicle.name === "string" && vehicle.name.trim()
            ? vehicle.name.trim()
            : vehicle.id;
        const tooltipText = `${vehicleName} 現在地 ${formatTimeLabel(vehicle.lastLocationAt)}`;
        const vehicleColor = resolveVehicleColor(vehicle);

        const vehicleMarker = leaflet
          .marker(toLeafletLatLng(vehicle.currentLocation), {
            icon: buildVehicleBusIcon({
              leaflet,
              vehicle,
            }),
            zIndexOffset: 500,
          })
          .bindTooltip(tooltipText, {
            direction: "right",
            offset: [8, 0],
          })
          .bindPopup(
            `<strong>${vehicleName}</strong><br>ID: ${vehicle.id}<br>現在地: ${formatCoordinate(vehicle.currentLocation.lat)}, ${formatCoordinate(vehicle.currentLocation.lng)}<br>最終更新: ${vehicle.lastLocationAt ?? "-"}`,
          );
        vehicleMarker.addTo(mapLayers.vehicles);

        const isSelectedRouteVehicle = vehicle.id === selectedRouteVehicleId;
        const routeLatLngs = isSelectedRouteVehicle
          ? operationRoutePoints
          : [
              vehicle.currentLocation,
              ...(vehicle.route ?? []).map((task) => task.point),
            ].filter(hasPoint);
        if (routeLatLngs.length > 1) {
          drawRoutePolyline({
            leaflet,
            layer: mapLayers.vehicleRoutes,
            points: routeLatLngs,
            cacheKey: isSelectedRouteVehicle
              ? ""
              : buildVehicleRouteCacheKey(vehicle),
            keepCurrentPointOnCachedRoute: true,
            style: {
              color: vehicleColor,
              weight: 3,
              opacity: 0.38,
              dashArray: "8 8",
            },
          });
        }
      });

      if (hasAssignablePreview.value && previewSimulation.value) {
        const previewVehicle = vehicles.value.find(
          (vehicle) => vehicle.id === previewSimulation.value.vehicleId,
        );
        const previewPath = [
          previewVehicle?.currentLocation,
          ...previewRouteAfterSteps.value.map((task) => task.point),
        ].filter(hasPoint);

        if (previewPath.length > 1) {
          drawRoutePolyline({
            leaflet,
            layer: mapLayers.previewRoute,
            points: previewPath,
            style: {
              color: "#f59e0b",
              weight: 5,
              opacity: 0.8,
            },
          });
        }

        previewRouteAfterSteps.value.forEach((task) => {
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
              fillOpacity: 0.95,
            })
            .bindTooltip(
              `${task.displaySequence}. ${taskTypeLabel} ${task.locationLabel} (${formatTimeLabel(task.etaAt)})`,
              {
                direction: "top",
              },
            )
            .addTo(mapLayers.previewRoute);
        });
      }

      if (isRequestRouteMode) {
        mapRows.value
          .filter((row) => row.id !== selectedRequest.value?.id)
          .filter(
            (row) => row.status === "ASSIGNED" || row.status === "PICKED_UP",
          )
          .forEach((row) => {
            const routePoints = normalizeRoutePoints([
              row.pickupPoint,
              row.dropoffPoint,
            ]);
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
                opacity: 0.45,
              },
            });
          });
      }

      if (selectedRoutePoints.length > 1) {
        drawRoutePolyline({
          leaflet,
          layer: mapLayers.selectedRoute,
          points: selectedRoutePoints,
          ...(isRequestRouteMode
            ? {}
            : {
                keepCurrentPointOnCachedRoute: true,
              }),
          style: {
            color: "#ea580c",
            weight: 6,
            opacity: 0.9,
          },
        });
      }

      if (isRequestRouteMode) {
        if (
          selectedRequest.value?.pickupPoint &&
          hasPoint(selectedRequest.value.pickupPoint)
        ) {
          leaflet
            .circleMarker(toLeafletLatLng(selectedRequest.value.pickupPoint), {
              radius: 8,
              color: "#ecfdf5",
              weight: 2,
              fillColor: "#0f766e",
              fillOpacity: 0.95,
            })
            .bindTooltip(`乗車: ${selectedRequest.value.pickupLabel}`, {
              permanent: true,
              direction: "top",
              offset: [0, -8],
            })
            .addTo(mapLayers.focus);
        }
        if (
          selectedRequest.value?.dropoffPoint &&
          hasPoint(selectedRequest.value.dropoffPoint)
        ) {
          leaflet
            .circleMarker(toLeafletLatLng(selectedRequest.value.dropoffPoint), {
              radius: 8,
              color: "#fff7ed",
              weight: 2,
              fillColor: "#ea580c",
              fillOpacity: 0.95,
            })
            .bindTooltip(`降車: ${selectedRequest.value.dropoffLabel}`, {
              permanent: true,
              direction: "top",
              offset: [0, -8],
            })
            .addTo(mapLayers.focus);
        }
      } else {
        visibleVehicleRouteSteps.value.forEach((step) => {
          if (!hasPoint(step.point)) {
            return;
          }
          const isStepSelected = step.key === selectedVehicleRouteStepKey.value;
          leaflet
            .circleMarker(toLeafletLatLng(step.point), {
              radius: isStepSelected ? 8 : 6,
              color: isStepSelected ? "#fef3c7" : "#ffffff",
              weight: isStepSelected ? 2.5 : 2,
              fillColor: step.type === "PICKUP" ? "#047857" : "#b45309",
              fillOpacity: isStepSelected ? 0.95 : 0.85,
            })
            .bindTooltip(
              `${step.sequence}. ${step.type === "PICKUP" ? "乗車" : "降車"} ${step.locationLabel}`,
              {
                permanent: isStepSelected,
                direction: "top",
                offset: [0, -8],
              },
            )
            .addTo(mapLayers.focus);
        });
      }

      const allPoints = mapSourcePoints.value.map((point) =>
        toLeafletLatLng(point),
      );
      if ((fitToData || !hasInitialMapViewport) && allPoints.length) {
        leafletMap.fitBounds(leaflet.latLngBounds(allPoints).pad(0.15), {
          maxZoom: 15,
        });
        hasInitialMapViewport = true;
        return;
      }

      if (focusSelected && selectedRouteFocusPoints.length) {
        if (selectedRouteFocusPoints.length === 1) {
          leafletMap.flyTo(toLeafletLatLng(selectedRouteFocusPoints[0]), 16, {
            duration: 0.45,
          });
        } else {
          leafletMap.flyToBounds(
            leaflet
              .latLngBounds(selectedRouteFocusPoints.map(toLeafletLatLng))
              .pad(0.42),
            {
              maxZoom: 16,
              duration: 0.45,
            },
          );
        }
      }
    }

    async function refreshAll() {
      loading.value = true;
      errorMessage.value = "";

      try {
        const [
          state,
          stopRes,
          requestRes,
          callRes,
          profileRes,
          fareRes,
          vehicleRes,
        ] = await Promise.all([
          apiGet("/api/state"),
          apiGet("/api/stops"),
          apiGet("/api/ride-requests"),
          apiGet("/api/call-events"),
          apiGet("/api/service-profiles"),
          apiGet("/api/fare-policies"),
          apiGet("/api/vehicles"),
        ]);

        summary.value = state;
        stops.value = stopRes.data ?? [];
        requests.value = requestRes.data ?? [];
        callQueue.value = callRes.data ?? [];
        farePolicies.value = fareRes.data ?? [];
        vehicles.value = vehicleRes.data ?? [];

        const activeId = profileRes.activeServiceProfileId;
        const activeProfile =
          (profileRes.data ?? []).find((profile) => profile.id === activeId) ??
          profileRes.data?.[0] ??
          null;
        serviceProfile.value = activeProfile;

        if (activeProfile) {
          const farePolicy = farePolicies.value.find(
            (policy) => policy.id === activeProfile.farePolicyRef,
          );
          profileEditor.value = {
            id: activeProfile.id,
            maxAdvanceDays:
              activeProfile.reservationPolicy?.maxAdvanceDays ?? 14,
            maxActiveVehicles:
              activeProfile.fleetPolicy?.maxActiveVehicles ?? 10,
            maxOnboardPerVehicle:
              activeProfile.poolingPolicy?.maxOnboardPerVehicle ?? 4,
            cruiseSpeedKmh: activeProfile.dispatchPolicy?.cruiseSpeedKmh ?? 25,
            pickupServiceMinutes:
              activeProfile.dispatchPolicy?.pickupServiceMinutes ?? 0,
            dropoffServiceMinutes:
              activeProfile.dispatchPolicy?.dropoffServiceMinutes ?? 0,
            locationMode: activeProfile.locationPolicy?.mode ?? "HYBRID",
            fareModel: farePolicy?.model ?? "HYBRID",
            officeName: activeProfile.operationPolicy?.office?.name ?? "事務所",
            businessHoursEnabled:
              activeProfile.operationPolicy?.businessHours?.enabled === true,
            businessHoursStart:
              activeProfile.operationPolicy?.businessHours?.startLocalTime ??
              "08:00",
            businessHoursEnd:
              activeProfile.operationPolicy?.businessHours?.endLocalTime ??
              "18:00",
            idleReturnThresholdMinutes:
              activeProfile.operationPolicy?.idleReturnThresholdMinutes ?? 40,
            lunchBreakEnabled:
              activeProfile.operationPolicy?.lunchBreak?.enabled === true,
            lunchBreakStart:
              activeProfile.operationPolicy?.lunchBreak?.startLocalTime ??
              "11:00",
            lunchBreakEnd:
              activeProfile.operationPolicy?.lunchBreak?.endLocalTime ??
              "12:00",
          };
        }
        vehicleEditor.value = vehicles.value.map((vehicle) =>
          buildVehicleEditorItem(vehicle),
        );

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
          apiGet("/api/ride-requests"),
        ]);
        vehicles.value = vehicleRes.data ?? [];
        requests.value = requestRes.data ?? [];
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
        ...(title ? { title } : {}),
      };
    }

    function buildDispatchPayload() {
      const passengerName = form.value.passengerName.trim();
      const passengerPhone = form.value.passengerPhone.trim();
      const desiredTimeMode = normalizeDesiredTimeMode(
        form.value.desiredTimeMode,
      );
      const desiredTimeAt = buildDesiredTimeAtFromDateAndClock(
        form.value.desiredDate,
        `${form.value.desiredHour}:${form.value.desiredMinute}`,
        desiredTimeMode,
      );
      const serviceProfileId =
        serviceProfile.value?.id ?? summary.value.serviceProfileId ?? null;
      return {
        serviceProfileId,
        pickup: buildLocation(
          form.value.pickupMode,
          form.value.pickupStopId,
          form.value.pickupPoint,
          form.value.pickupTitle,
        ),
        dropoff: buildLocation(
          form.value.dropoffMode,
          form.value.dropoffStopId,
          form.value.dropoffPoint,
          form.value.dropoffTitle,
        ),
        partySize: Number(form.value.partySize),
        passenger:
          passengerName || passengerPhone
            ? {
                ...(passengerName ? { name: passengerName } : {}),
                ...(passengerPhone ? { phoneNumber: passengerPhone } : {}),
              }
            : null,
        requestType: desiredTimeRequestType(desiredTimeMode),
        desiredDropoffAt: desiredTimeMode === "DROPOFF" ? desiredTimeAt : null,
        desiredPickupAt: desiredTimeMode === "PICKUP" ? desiredTimeAt : null,
      };
    }

    function desiredDeltaLabel(option) {
      const pickupDelta = Number(option?.desiredPickupDeltaMinutes);
      if (Number.isFinite(pickupDelta)) {
        return `希望乗車との差 ${formatSignedMinutes(pickupDelta)}`;
      }
      const dropoffDelta = Number(option?.desiredDropoffDeltaMinutes);
      if (Number.isFinite(dropoffDelta)) {
        return `希望降車との差 ${formatSignedMinutes(dropoffDelta)}`;
      }
      return "";
    }

    function clearDispatchOptions() {
      dispatchOptions.value = [];
      selectedDispatchOptionId.value = "";
    }

    function buildDispatchPreviewFromOption(option) {
      if (!option || typeof option !== "object") {
        return null;
      }
      return {
        status: "ASSIGNABLE",
        simulation: {
          vehicleId: option.vehicleId ?? "-",
          selectedAlgorithm: option.selectedAlgorithm ?? null,
          algorithmPhase: option.algorithmPhase ?? null,
          primaryAlgorithm: option.primaryAlgorithm ?? null,
          fallbackAlgorithm: option.fallbackAlgorithm ?? null,
          score: option.score ?? null,
          detourMinutes: option.detourMinutes ?? null,
          etaPickupMinutes: option.etaPickupMinutes ?? null,
          etaDropoffMinutes: option.etaDropoffMinutes ?? null,
          plannedPickupAt: option.plannedPickupAt ?? null,
          plannedDropoffAt: option.plannedDropoffAt ?? null,
          routeAfter: Array.isArray(option.routeAfter) ? option.routeAfter : [],
          impactedRequests: Array.isArray(option.impactedRequests)
            ? option.impactedRequests
            : [],
        },
      };
    }

    function applySelectedDispatchOption() {
      const option = selectedDispatchOption.value;
      if (!option) {
        dispatchPreview.value = null;
        return;
      }
      dispatchPreview.value = buildDispatchPreviewFromOption(option);
      refreshLeafletMap({ focusSelected: true });
    }

    function clearDispatchPreview() {
      dispatchPreview.value = null;
      clearDispatchOptions();
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
        const result = await apiPost("/api/ride-requests/options", payload);
        previewDialogOpen.value = true;
        previewPayload.value = payload;
        previewDirty.value = false;

        if (
          result.status !== "ASSIGNABLE" ||
          !Array.isArray(result.options) ||
          !result.options.length
        ) {
          clearDispatchOptions();
          dispatchPreview.value = {
            status: "REJECTED",
            reason: result.reason ?? "NO_FEASIBLE_VEHICLE",
            diagnostics: result.diagnostics ?? null,
          };
          refreshLeafletMap({ focusSelected: true });
          return;
        }

        dispatchOptions.value = result.options;
        selectedDispatchOptionId.value = result.options[0].optionId;
        applySelectedDispatchOption();
      } catch (error) {
        clearDispatchOptions();
        dispatchPreview.value = null;
        errorMessage.value = error.message;
      } finally {
        loading.value = false;
      }
    }

    async function confirmDispatchRequest() {
      errorMessage.value = "";
      if (!hasAssignablePreview.value || !previewPayload.value) {
        errorMessage.value = "先に候補を算出してください。";
        return;
      }
      if (previewDirty.value) {
        errorMessage.value =
          "入力内容が変更されています。再試算してから追加してください。";
        return;
      }

      const selectedOption = selectedDispatchOption.value;
      if (!selectedOption) {
        errorMessage.value =
          "候補が未選択です。再試算して候補を選んでください。";
        return;
      }

      loading.value = true;
      try {
        const payload = {
          ...previewPayload.value,
          preferredVehicleId: selectedOption.vehicleId ?? null,
          requestType:
            selectedOption.requestType ??
            (previewPayload.value.desiredPickupAt ? "DEPART_AT" : "ARRIVE_BY"),
          desiredDropoffAt: selectedOption.desiredDropoffAt ?? null,
          desiredPickupAt: selectedOption.desiredPickupAt ?? null,
        };
        await apiPost("/api/ride-requests", payload);
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
        await apiPost(
          `/api/ride-requests/${encodeURIComponent(requestId)}/cancel`,
          {
            reason: "OPERATOR_CANCELLED",
          },
        );
        clearDispatchPreview();
        await refreshAll();
      } catch (error) {
        errorMessage.value = error.message;
      } finally {
        loading.value = false;
      }
    }

    function openResetRequestsDialog() {
      if (loading.value || !requestRows.value.length) {
        return;
      }
      resetRequestsDialogOpen.value = true;
    }

    function closeResetRequestsDialog() {
      resetRequestsDialogOpen.value = false;
    }

    async function resetRideRequests() {
      if (!requestRows.value.length) {
        resetRequestsDialogOpen.value = false;
        return;
      }

      errorMessage.value = "";
      loading.value = true;
      try {
        await apiPost("/api/ride-requests/reset", {
          reason: "OPERATOR_RESET",
        });
        resetRequestsDialogOpen.value = false;
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
            to: "0880-11-2222",
          },
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
      callDesiredPickupAt.value = null;
    }

    function buildPhoneRidePayload() {
      if (!callForm.value.pickupStopId || !callForm.value.dropoffStopId) {
        throw new Error("乗車/降車バス停を選択してください。");
      }
      if (callForm.value.pickupStopId === callForm.value.dropoffStopId) {
        throw new Error("乗車バス停と降車バス停は別にしてください。");
      }

      const partySize = Math.max(
        1,
        Math.trunc(Number(callForm.value.partySize) || 1),
      );
      const desiredTimeMode = normalizeDesiredTimeMode(
        callForm.value.desiredTimeMode,
      );
      const desiredTimeAt = buildDesiredTimeAtFromDateAndClock(
        callForm.value.desiredDate,
        `${callForm.value.desiredHour}:${callForm.value.desiredMinute}`,
        desiredTimeMode,
      );
      const serviceProfileId =
        serviceProfile.value?.id ?? summary.value.serviceProfileId ?? null;

      return {
        serviceProfileId,
        callerRaw: callForm.value.callerRaw,
        pickup: { mode: "FIXED_STOP", stopId: callForm.value.pickupStopId },
        dropoff: { mode: "FIXED_STOP", stopId: callForm.value.dropoffStopId },
        partySize,
        requestType: desiredTimeRequestType(desiredTimeMode),
        desiredDropoffAt: desiredTimeMode === "DROPOFF" ? desiredTimeAt : null,
        desiredPickupAt: desiredTimeMode === "PICKUP" ? desiredTimeAt : null,
      };
    }

    async function fetchPhoneRideOptions() {
      errorMessage.value = "";
      loading.value = true;
      try {
        const payload = buildPhoneRidePayload();
        const result = await apiPost("/api/phone-rides/options", payload);
        if (
          result.status !== "ASSIGNABLE" ||
          !Array.isArray(result.options) ||
          !result.options.length
        ) {
          clearPhoneRideOptions();
          errorMessage.value = previewReasonLabel(result.reason);
          return;
        }
        callRideOptions.value = result.options;
        selectedCallOptionId.value = result.options[0].optionId;
        callDesiredDropoffAt.value =
          result.desiredDropoffAt ?? payload.desiredDropoffAt ?? null;
        callDesiredPickupAt.value =
          result.desiredPickupAt ?? payload.desiredPickupAt ?? null;
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
        (option) => option.optionId === selectedCallOptionId.value,
      );
      if (!selectedOption) {
        errorMessage.value =
          "選択された候補が見つかりません。候補を再取得してください。";
        return;
      }

      loading.value = true;
      try {
        const payload = buildPhoneRidePayload();
        await apiPost("/api/phone-rides", {
          ...payload,
          desiredDropoffAt:
            callDesiredDropoffAt.value ?? payload.desiredDropoffAt,
          desiredPickupAt: callDesiredPickupAt.value ?? payload.desiredPickupAt,
          preferredVehicleId: selectedOption.vehicleId,
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
        const pickupServiceMinutes = Number(
          profileEditor.value.pickupServiceMinutes,
        );
        const dropoffServiceMinutes = Number(
          profileEditor.value.dropoffServiceMinutes,
        );
        const idleReturnThresholdMinutes = Number(
          profileEditor.value.idleReturnThresholdMinutes,
        );
        const officeName =
          typeof profileEditor.value.officeName === "string" &&
          profileEditor.value.officeName.trim()
            ? profileEditor.value.officeName.trim()
            : "事務所";
        const nextProfile = {
          ...serviceProfile.value,
          reservationPolicy: {
            ...serviceProfile.value.reservationPolicy,
            maxAdvanceDays: Number(profileEditor.value.maxAdvanceDays),
          },
          fleetPolicy: {
            ...serviceProfile.value.fleetPolicy,
            maxActiveVehicles: Number(profileEditor.value.maxActiveVehicles),
          },
          poolingPolicy: {
            ...serviceProfile.value.poolingPolicy,
            maxOnboardPerVehicle: Number(
              profileEditor.value.maxOnboardPerVehicle,
            ),
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
              Number.isFinite(dropoffServiceMinutes) &&
              dropoffServiceMinutes >= 0
                ? dropoffServiceMinutes
                : 0,
          },
          locationPolicy: {
            ...serviceProfile.value.locationPolicy,
            mode: profileEditor.value.locationMode,
          },
          operationPolicy: {
            ...(serviceProfile.value.operationPolicy ?? {}),
            timeZone:
              serviceProfile.value.operationPolicy?.timeZone ?? "Asia/Tokyo",
            office: {
              ...(serviceProfile.value.operationPolicy?.office ?? {}),
              name: officeName,
              point: null,
            },
            businessHours: {
              ...(serviceProfile.value.operationPolicy?.businessHours ?? {}),
              enabled: profileEditor.value.businessHoursEnabled === true,
              startLocalTime: profileEditor.value.businessHoursStart ?? "08:00",
              endLocalTime: profileEditor.value.businessHoursEnd ?? "18:00",
              requireDepartFromOffice: true,
              requireReturnToOffice: true,
            },
            idleReturnThresholdMinutes:
              Number.isFinite(idleReturnThresholdMinutes) &&
              idleReturnThresholdMinutes >= 0
                ? idleReturnThresholdMinutes
                : 40,
            lunchBreak: {
              ...(serviceProfile.value.operationPolicy?.lunchBreak ?? {}),
              enabled: profileEditor.value.lunchBreakEnabled === true,
              startLocalTime: profileEditor.value.lunchBreakStart ?? "11:00",
              endLocalTime: profileEditor.value.lunchBreakEnd ?? "12:00",
              requireReturnToOffice: true,
              departFromOfficeAtEnd: true,
            },
          },
          farePolicy: {
            ...(serviceProfile.value.farePolicy ?? {}),
            model: profileEditor.value.fareModel,
          },
        };

        await apiPost("/api/service-profiles", nextProfile);

        const currentFare = farePolicies.value.find(
          (policy) => policy.id === nextProfile.farePolicyRef,
        );
        if (currentFare) {
          await apiPost("/api/fare-policies", {
            ...currentFare,
            model: profileEditor.value.fareModel,
          });
        }

        const existingVehicleIds = new Set(
          vehicles.value
            .map((vehicle) =>
              typeof vehicle.id === "string" ? vehicle.id.trim() : "",
            )
            .filter(Boolean),
        );
        for (const vehicleEntry of vehicleEditor.value) {
          const id =
            typeof vehicleEntry.id === "string" ? vehicleEntry.id.trim() : "";
          const name =
            typeof vehicleEntry.name === "string"
              ? vehicleEntry.name.trim()
              : "";
          if (!id && !name) {
            continue;
          }
          if (!name) {
            throw new Error("車両名は必須です。");
          }
          const capacity = Number(vehicleEntry.capacity);
          const normalizedColor = normalizeColorHex(
            vehicleEntry.iconColor,
            "#0284c7",
          );
          const officePointText =
            typeof vehicleEntry.officePoint === "string"
              ? vehicleEntry.officePoint.trim()
              : "";
          const officePoint = officePointText
            ? parsePointText(officePointText)
            : null;
          const payload = {
            id: id || undefined,
            name,
            iconColor: normalizedColor ?? "#0284c7",
            capacity:
              Number.isFinite(capacity) && capacity > 0
                ? Math.trunc(capacity)
                : 4,
            officePoint,
            serviceProfileId: nextProfile.id,
          };

          if (id && existingVehicleIds.has(id)) {
            await apiPost(`/api/vehicles/${encodeURIComponent(id)}`, payload);
          } else {
            await apiPost("/api/vehicles", payload);
          }
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
      { deep: true },
    );

    watch(
      callForm,
      () => {
        clearPhoneRideOptions();
      },
      { deep: true },
    );

    watch(selectedDispatchOptionId, () => {
      if (!dispatchOptions.value.length) {
        return;
      }
      applySelectedDispatchOption();
    });

    watch(
      dispatchPreview,
      () => {
        refreshLeafletMap();
      },
      { deep: true },
    );
    watch(activePanelDateKey, () => {
      refreshLeafletMap({
        focusSelected: mapDisplayMode.value === "operation",
      });
    });

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
      },
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
      },
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
      dispatchTimeMenuOpen,
      callTimeMenuOpen,
      desiredTimeModeOptions,
      formDesiredTimeModeLabel,
      callDesiredTimeModeLabel,
      formDesiredTimeLabel,
      callDesiredTimeLabel,
      desiredHourOptions,
      desiredMinuteOptions,
      dispatchDateInputEl,
      callDateInputEl,
      formDesiredDateLabel,
      formDesiredDateWeekdayLabel,
      callDesiredDateLabel,
      callDesiredDateWeekdayLabel,
      openNativeDatePicker,
      dispatchOptions,
      dispatchOptionDateSections,
      selectedDispatchOptionId,
      selectedDispatchStrategyLabel,
      callRideOptions,
      callRideOptionDateSections,
      selectedCallOptionId,
      callDesiredDropoffAt,
      callDesiredPickupAt,
      desiredDeltaLabel,
      locationTitleState,
      vehicles,
      requests,
      dispatchPreview,
      previewDialogOpen,
      resetRequestsDialogOpen,
      previewDirty,
      previewSimulation,
      previewRouteAfterSteps,
      hasAssignablePreview,
      previewStatusLabel,
      previewVehicleLabel,
      previewPickupClock,
      previewDropoffClock,
      previewAlgorithmLabel,
      previewAlgorithmPhaseLabel,
      previewDropoffSuggestion,
      previewRejectDiagnostics,
      previewRejectSummary,
      previewRejectBreakdown,
      previewRejectConstraintSummary,
      previewRejectCountermeasures,
      callQueue,
      availableStops,
      locationInputOptions,
      locationPolicyOptions,
      fareModelOptions,
      topbarLocationModeTitle,
      pickupModeDescription,
      dropoffModeDescription,
      locationModeDescription,
      fareModelDescription,
      mapSelectionField,
      mapSelectionVehicleIndex,
      isMapPicking,
      mapSelectionHint,
      profileEditor,
      vehicleEditor,
      kpi,
      currentDateLabel,
      currentClockLabel,
      requestRows,
      requestDateSections,
      selectedRequestId,
      selectedRequest,
      mapDisplayMode,
      selectedVehicleRouteStepKey,
      operationMapChipLabel,
      selectedVehicleRouteVehicleLabel,
      selectedVehicleRouteSteps,
      selectedVehicleRouteDateSections,
      visibleVehicleRouteDateSections,
      selectedVehicleRouteEmptyLabel,
      activePanelDateKey,
      activePanelDateLabel,
      activePanelDateWeekdayLabel,
      hasPreviousPanelDate,
      hasNextPanelDate,
      visibleRequestDateSections,
      statusLabel,
      dispatchAlgorithmLabel,
      dispatchAlgorithmPhaseLabel,
      selectRequest,
      selectVehicleRouteStep,
      movePanelDate,
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
      openResetRequestsDialog,
      closeResetRequestsDialog,
      resetRideRequests,
      formatTimeLabel,
      formatDateTimeLabel,
      formatSignedMinutes,
      previewReasonLabel,
      previewRejectionCodeLabel,
      resolveVehicleDisplayName,
      simulateInboundCall,
      fetchPhoneRideOptions,
      createPhoneRide,
      addVehicleEditorRow,
      removeVehicleEditorRow,
      saveProfile,
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
      <div class="rq-setting-section mb-4">
        <div class="rq-setting-label mb-2">事務所・休憩</div>
        <v-text-field
          label="事務所名"
          v-model="profileEditor.officeName"
          density="compact"
          variant="outlined"
          hide-details
          class="mb-2"
        />
        <div class="rq-inline-help mb-1">
          事務所座標は下の「車両設定」ごとに管理します。
        </div>
        <v-switch
          v-model="profileEditor.businessHoursEnabled"
          color="primary"
          hide-details
          inset
          label="営業時間制約を有効化（事務所出発時刻・帰着時刻で判定）"
          class="mb-2"
        />
        <div class="rq-form-row">
          <v-text-field
            label="営業時間 開始"
            type="time"
            v-model="profileEditor.businessHoursStart"
            density="compact"
            variant="outlined"
            hide-details
            style="flex:1"
          />
          <v-text-field
            label="営業時間 終了"
            type="time"
            v-model="profileEditor.businessHoursEnd"
            density="compact"
            variant="outlined"
            hide-details
            style="flex:1"
          />
        </div>
        <v-switch
          v-model="profileEditor.lunchBreakEnabled"
          color="primary"
          hide-details
          inset
          label="昼休憩制約を有効化（11時まで戻れない/12時発で間に合わない予約を拒否）"
          class="mb-2"
        />
        <div class="rq-form-row">
          <v-text-field
            label="休憩開始"
            type="time"
            v-model="profileEditor.lunchBreakStart"
            density="compact"
            variant="outlined"
            hide-details
            style="flex:1"
          />
          <v-text-field
            label="休憩終了"
            type="time"
            v-model="profileEditor.lunchBreakEnd"
            density="compact"
            variant="outlined"
            hide-details
            style="flex:1"
          />
        </div>
        <v-text-field
          label="事務所へ戻る目安"
          type="number"
          v-model="profileEditor.idleReturnThresholdMinutes"
          suffix="分"
          density="compact"
          variant="outlined"
          hide-details
          class="mt-2"
        />
      </div>
      <div class="rq-setting-section mb-4">
        <div class="d-flex align-center justify-space-between mb-2">
          <div class="rq-setting-label mb-0">車両設定</div>
          <v-btn size="x-small" variant="tonal" color="primary" prepend-icon="mdi-plus" @click="addVehicleEditorRow">
            車両追加
          </v-btn>
        </div>
        <div v-for="(vehicle, index) in vehicleEditor" :key="'vehicle-editor-' + index" class="rq-setting-vehicle-card mb-2">
          <v-text-field
            label="車両ID（新規時のみ任意）"
            v-model="vehicle.id"
            density="compact"
            variant="outlined"
            hide-details
            :disabled="vehicle.isExisting"
            class="mb-2"
          />
          <v-text-field
            label="車両名"
            v-model="vehicle.name"
            density="compact"
            variant="outlined"
            hide-details
            class="mb-2"
          />
          <v-text-field
            label="アイコン色 (#RRGGBB)"
            v-model="vehicle.iconColor"
            density="compact"
            variant="outlined"
            hide-details
            class="mb-2"
          />
          <v-text-field
            label="事務所座標 (lat,lng)"
            v-model="vehicle.officePoint"
            density="compact"
            variant="outlined"
            hide-details
            placeholder="例: 32.990200,132.929500"
            class="mb-1"
          />
          <div class="rq-map-pick-row mb-2">
            <v-btn
              variant="tonal"
              color="primary"
              size="x-small"
              density="comfortable"
              prepend-icon="mdi-crosshairs-gps"
              class="rq-map-pick-btn"
              :class="{ 'is-active': mapSelectionField === 'vehicleOffice' && mapSelectionVehicleIndex === index }"
              @click="toggleMapSelection('vehicleOffice', index)"
            >
              {{ mapSelectionField === 'vehicleOffice' && mapSelectionVehicleIndex === index ? '地図選択を解除' : '地図で事務所位置を選択' }}
            </v-btn>
          </div>
          <div class="rq-form-row align-center">
            <v-text-field
              label="定員"
              type="number"
              min="1"
              v-model="vehicle.capacity"
              density="compact"
              variant="outlined"
              hide-details
              style="flex:1"
            />
            <v-btn
              variant="text"
              color="error"
              size="small"
              icon="mdi-delete-outline"
              :disabled="vehicle.isExisting"
              @click="removeVehicleEditorRow(index)"
            />
          </div>
        </div>
        <div class="rq-setting-help">
          既存車両は更新、新規行は追加されます。既存車両の削除は現在未対応です。
        </div>
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
        color="primary"
        variant="tonal"
        size="small"
        density="comfortable"
        prepend-icon="mdi-chart-box-outline"
        class="rq-analytics-link"
        href="/analytics/"
      >
        Analytics
      </v-btn>
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
            {{ previewStatusLabel }}
          </v-chip>
        </div>
        <div class="rq-preview-dialog-subtitle">オペレータ確認: この案で予約追加してよいか判断してください</div>
      </div>

      <v-card-text class="rq-preview-dialog-body">
        <template v-if="dispatchPreview.status === 'ASSIGNABLE' && previewSimulation">
          <div v-if="previewDirty" class="rq-preview-alert">
            入力内容が変更されています。再試算してから追加してください。
          </div>

          <div v-if="dispatchOptions.length" class="rq-form-section rq-call-options-panel mb-2">
            <div class="rq-preview-subtitle">予約候補（選択）</div>
            <div class="rq-call-options-list">
              <div
                v-for="section in dispatchOptionDateSections"
                :key="'dispatch-option-date-' + section.dateKey"
                class="rq-date-section"
              >
                <div class="rq-date-section-header">{{ section.dateLabel }}</div>
                <label
                  v-for="option in section.options"
                  :key="option.optionId"
                  class="rq-call-option-item"
                  :class="{ 'is-selected': selectedDispatchOptionId === option.optionId }"
                >
                  <input
                    type="radio"
                    name="dispatch-option"
                    :value="option.optionId"
                    v-model="selectedDispatchOptionId"
                  />
                  <div class="rq-call-option-body">
                    <div class="rq-call-option-top">
                      <span class="rq-call-option-vehicle">{{ option.strategyLabel }} / {{ resolveVehicleDisplayName(option.vehicleId) }}</span>
                      <span class="rq-call-option-pickup">乗車 {{ formatDateTimeLabel(option.plannedPickupAt) }}</span>
                    </div>
                    <div class="rq-call-option-meta">
                      <span>降車 {{ formatDateTimeLabel(option.plannedDropoffAt) }}</span>
                      <span>
                        計算 {{ dispatchAlgorithmLabel(option.selectedAlgorithm) }}
                        <template v-if="dispatchAlgorithmPhaseLabel(option.algorithmPhase)">
                          ({{ dispatchAlgorithmPhaseLabel(option.algorithmPhase) }})
                        </template>
                      </span>
                      <span v-if="desiredDeltaLabel(option)">
                        {{ desiredDeltaLabel(option) }}
                      </span>
                      <span v-else>{{ option.strategyDescription || '最短案内' }}</span>
                    </div>
                  </div>
                </label>
              </div>
            </div>
          </div>

          <div class="rq-preview-kpis">
            <div class="rq-preview-kpi">
              <span class="rq-preview-kpi-label">案内方針</span>
              <span class="rq-preview-kpi-value">{{ selectedDispatchStrategyLabel || '候補' }}</span>
            </div>
            <div class="rq-preview-kpi">
              <span class="rq-preview-kpi-label">計算アルゴリズム</span>
              <span class="rq-preview-kpi-value">
                {{ previewAlgorithmLabel }}
                <template v-if="previewAlgorithmPhaseLabel">
                  ({{ previewAlgorithmPhaseLabel }})
                </template>
              </span>
            </div>
            <div class="rq-preview-kpi">
              <span class="rq-preview-kpi-label">担当車両</span>
              <span class="rq-preview-kpi-value">{{ previewVehicleLabel }}</span>
            </div>
            <div class="rq-preview-kpi">
              <span class="rq-preview-kpi-label">乗車予定日時</span>
              <span class="rq-preview-kpi-value">{{ previewPickupClock }}</span>
            </div>
            <div class="rq-preview-kpi">
              <span class="rq-preview-kpi-label">降車予定日時</span>
              <span class="rq-preview-kpi-value">{{ previewDropoffClock }}</span>
            </div>
          </div>

          <div v-if="previewDropoffSuggestion" class="rq-preview-alert mt-2">
            <template v-if="previewDropoffSuggestion.message">
              {{ previewDropoffSuggestion.message }}
            </template>
            <template v-else>
              希望降車 {{ formatDateTimeLabel(previewDropoffSuggestion.requestedDropoffAt) }} に対して、
              最短の受付可能時刻は {{ formatDateTimeLabel(previewDropoffSuggestion.suggestedDropoffAt) }} です。
            </template>
            OK で提案時刻に自動調整して登録します。
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
                    <span>乗車 {{ formatDateTimeLabel(impact.pickupBeforeAt) }} → {{ formatDateTimeLabel(impact.pickupAfterAt) }}</span>
                    <span>降車 {{ formatDateTimeLabel(impact.dropoffBeforeAt) }} → {{ formatDateTimeLabel(impact.dropoffAfterAt) }}</span>
                  </div>
                </div>
              </div>
              <div v-else class="rq-inline-help">既存予約の時刻変化はありません。</div>
            </div>

            <div class="rq-preview-section">
              <div class="rq-preview-subtitle">ドライバー運行手順（最適）</div>
              <div class="rq-driver-steps">
                <div v-for="step in previewRouteAfterSteps" :key="step.displaySequence + '-' + step.requestId + '-' + step.type" class="rq-driver-step">
                  <span class="rq-step-index">{{ step.displaySequence }}</span>
                  <span class="rq-step-time">{{ formatDateTimeLabel(step.etaAt) }}</span>
                  <span class="rq-step-label">{{ step.type === 'PICKUP' ? '乗車' : '降車' }}: {{ step.locationLabel }}</span>
                </div>
              </div>
            </div>
          </div>
        </template>

        <template v-else>
          <div class="rq-preview-alert rq-preview-alert--error">{{ previewReasonLabel(dispatchPreview.reason) }}</div>
          <div v-if="previewRejectSummary" class="rq-preview-reject-summary">{{ previewRejectSummary }}</div>

          <div v-if="previewRejectBreakdown.length" class="rq-preview-reject-section">
            <div class="rq-preview-subtitle">受付不可の内訳</div>
            <div class="rq-preview-reject-list">
              <div v-for="item in previewRejectBreakdown" :key="'reject-' + item.code" class="rq-preview-reject-item">
                <span class="rq-preview-reject-item-label">{{ previewRejectionCodeLabel(item.code) }}</span>
                <span class="rq-preview-reject-item-meta">
                  {{ item.count }}件
                  <span v-if="item.ratioPercent !== null">({{ item.ratioPercent }}%)</span>
                </span>
              </div>
            </div>
          </div>

          <div v-if="previewRejectCountermeasures.length" class="rq-preview-reject-section">
            <div class="rq-preview-subtitle">対策候補</div>
            <ul class="rq-preview-countermeasure-list">
              <li v-for="(candidate, index) in previewRejectCountermeasures" :key="'countermeasure-' + index">
                {{ candidate }}
              </li>
            </ul>
          </div>

          <div v-if="previewRejectConstraintSummary" class="rq-inline-help">
            {{ previewRejectConstraintSummary }}
          </div>
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

  <v-dialog v-model="resetRequestsDialogOpen" max-width="460">
    <v-card>
      <v-card-title class="text-h6 d-flex align-center">
        <v-icon color="error" size="18" class="mr-2">mdi-alert</v-icon>
        予約案をリセット
      </v-card-title>
      <v-card-text>
        <div>右側の予約案をすべて削除します（{{ requestRows.length }}件）。</div>
        <div class="rq-danger-note mt-2">削除すると取り消しはできません。実行しますか？</div>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="closeResetRequestsDialog">キャンセル</v-btn>
        <v-btn color="error" :loading="loading" @click="resetRideRequests">
          削除してリセット
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
          <v-autocomplete
            v-if="form.pickupMode==='FIXED_STOP'"
            :items="availableStops"
            v-model="form.pickupStopId"
            item-title="title"
            item-value="value"
            :custom-filter="filterStopItem"
            density="compact"
            variant="outlined"
            hide-details
            placeholder="バス停を指定"
            no-data-text="一致するバス停がありません"
            auto-select-first
            clearable
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
          <v-autocomplete
            v-if="form.dropoffMode==='FIXED_STOP'"
            :items="availableStops"
            v-model="form.dropoffStopId"
            item-title="title"
            item-value="value"
            :custom-filter="filterStopItem"
            density="compact"
            variant="outlined"
            hide-details
            placeholder="バス停を指定"
            no-data-text="一致するバス停がありません"
            auto-select-first
            clearable
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

        <div class="rq-form-section">
          <div class="rq-form-label">予約日</div>
          <div class="rq-date-picker-trigger-wrap" @click="openNativeDatePicker('dispatch')">
            <input
              ref="dispatchDateInputEl"
              type="date"
              v-model="form.desiredDate"
              class="rq-date-picker-native-input"
              aria-label="予約日を選択"
            />
            <button
              type="button"
              class="rq-date-picker-trigger"
              tabindex="-1"
              aria-hidden="true"
            >
                <v-icon size="14" color="#0f766e">mdi-calendar-month-outline</v-icon>
                <span class="rq-date-picker-trigger-body">
                  <span class="rq-date-picker-trigger-date">{{ formDesiredDateLabel }}</span>
                  <span class="rq-date-picker-trigger-weekday">{{ formDesiredDateWeekdayLabel }}</span>
                </span>
                <v-icon size="13" color="#64748b">mdi-chevron-down</v-icon>
            </button>
          </div>
        </div>
        <div class="rq-form-row">
          <div class="rq-form-section" style="flex:1">
            <div class="rq-form-label">人数</div>
            <v-text-field type="number" min="1" v-model="form.partySize" density="compact" variant="outlined" hide-details />
            <div class="rq-form-label mt-2">{{ formDesiredTimeModeLabel }}</div>
            <v-menu
              v-model="dispatchTimeMenuOpen"
              :close-on-content-click="false"
              location="bottom start"
              offset="6"
            >
              <template #activator="{ props }">
                <v-text-field
                  v-bind="props"
                  :model-value="formDesiredTimeLabel"
                  readonly
                  density="compact"
                  variant="outlined"
                  hide-details
                  append-inner-icon="mdi-clock-outline"
                  class="rq-time-dropdown-activator"
                />
              </template>
              <div class="rq-time-dropdown-menu">
                <div class="rq-time-dropdown-grid">
                  <v-select
                    label="時"
                    :items="desiredHourOptions"
                    v-model="form.desiredHour"
                    density="compact"
                    variant="outlined"
                    hide-details
                  />
                  <v-select
                    label="分"
                    :items="desiredMinuteOptions"
                    v-model="form.desiredMinute"
                    density="compact"
                    variant="outlined"
                    hide-details
                  />
                </div>
                <div class="rq-time-dropdown-actions">
                  <v-btn size="x-small" variant="text" color="primary" @click="dispatchTimeMenuOpen = false">
                    閉じる
                  </v-btn>
                </div>
              </div>
            </v-menu>
          </div>
          <div class="rq-form-section" style="flex:1">
            <div class="rq-form-label">時刻指定基準</div>
            <v-select
              :items="desiredTimeModeOptions"
              v-model="form.desiredTimeMode"
              item-title="title"
              item-value="value"
              density="compact"
              variant="outlined"
              hide-details
            />
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

        <v-btn color="primary" block prepend-icon="mdi-calculator-variant-outline" :loading="loading" size="small" density="comfortable" @click="previewDispatchRequest" class="rq-submit-btn rq-action-btn">
          候補を試算
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
        <div class="rq-form-section">
          <div class="rq-form-label">予約日</div>
          <div class="rq-date-picker-trigger-wrap" @click="openNativeDatePicker('calls')">
            <input
              ref="callDateInputEl"
              type="date"
              v-model="callForm.desiredDate"
              class="rq-date-picker-native-input"
              aria-label="電話予約日を選択"
            />
            <button
              type="button"
              class="rq-date-picker-trigger"
              tabindex="-1"
              aria-hidden="true"
            >
                <v-icon size="14" color="#0f766e">mdi-calendar-month-outline</v-icon>
                <span class="rq-date-picker-trigger-body">
                  <span class="rq-date-picker-trigger-date">{{ callDesiredDateLabel }}</span>
                  <span class="rq-date-picker-trigger-weekday">{{ callDesiredDateWeekdayLabel }}</span>
                </span>
                <v-icon size="13" color="#64748b">mdi-chevron-down</v-icon>
            </button>
          </div>
        </div>
        <div class="rq-form-row">
          <div class="rq-form-section" style="flex:1">
            <div class="rq-form-label">人数</div>
            <v-text-field type="number" min="1" v-model="callForm.partySize" density="compact" variant="outlined" hide-details />
            <div class="rq-form-label mt-2">{{ callDesiredTimeModeLabel }}</div>
            <v-menu
              v-model="callTimeMenuOpen"
              :close-on-content-click="false"
              location="bottom start"
              offset="6"
            >
              <template #activator="{ props }">
                <v-text-field
                  v-bind="props"
                  :model-value="callDesiredTimeLabel"
                  readonly
                  density="compact"
                  variant="outlined"
                  hide-details
                  append-inner-icon="mdi-clock-outline"
                  class="rq-time-dropdown-activator"
                />
              </template>
              <div class="rq-time-dropdown-menu">
                <div class="rq-time-dropdown-grid">
                  <v-select
                    label="時"
                    :items="desiredHourOptions"
                    v-model="callForm.desiredHour"
                    density="compact"
                    variant="outlined"
                    hide-details
                  />
                  <v-select
                    label="分"
                    :items="desiredMinuteOptions"
                    v-model="callForm.desiredMinute"
                    density="compact"
                    variant="outlined"
                    hide-details
                  />
                </div>
                <div class="rq-time-dropdown-actions">
                  <v-btn size="x-small" variant="text" color="primary" @click="callTimeMenuOpen = false">
                    閉じる
                  </v-btn>
                </div>
              </div>
            </v-menu>
          </div>
          <div class="rq-form-section" style="flex:1">
            <div class="rq-form-label">時刻指定基準</div>
            <v-select
              :items="desiredTimeModeOptions"
              v-model="callForm.desiredTimeMode"
              item-title="title"
              item-value="value"
              density="compact"
              variant="outlined"
              hide-details
            />
          </div>
        </div>
        <div class="rq-form-section">
          <div class="rq-form-label">
            <v-icon size="14" color="#0f766e">mdi-map-marker-up</v-icon>乗車バス停
          </div>
          <v-autocomplete
            :items="availableStops"
            v-model="callForm.pickupStopId"
            item-title="title"
            item-value="value"
            :custom-filter="filterStopItem"
            density="compact"
            variant="outlined"
            hide-details
            placeholder="バス停を指定"
            no-data-text="一致するバス停がありません"
            auto-select-first
            clearable
          />
        </div>
        <div class="rq-form-section">
          <div class="rq-form-label">
            <v-icon size="14" color="#ea580c">mdi-map-marker-down</v-icon>降車バス停
          </div>
          <v-autocomplete
            :items="availableStops"
            v-model="callForm.dropoffStopId"
            item-title="title"
            item-value="value"
            :custom-filter="filterStopItem"
            density="compact"
            variant="outlined"
            hide-details
            placeholder="バス停を指定"
            no-data-text="一致するバス停がありません"
            auto-select-first
            clearable
          />
        </div>
        <v-btn color="secondary" block variant="tonal" prepend-icon="mdi-format-list-bulleted-square" :loading="loading" size="small" density="comfortable" @click="fetchPhoneRideOptions" class="rq-action-btn">
          時刻条件で候補取得
        </v-btn>
        <div class="rq-form-section rq-call-options-panel">
          <div class="rq-form-label">
            <v-icon size="14" color="#0f766e">mdi-bus-clock</v-icon>オペレータ案内候補（乗車日時）
          </div>
          <div v-if="callRideOptionDateSections.length" class="rq-call-options-list">
            <div
              v-for="section in callRideOptionDateSections"
              :key="'call-option-date-' + section.dateKey"
              class="rq-date-section"
            >
              <div class="rq-date-section-header">{{ section.dateLabel }}</div>
              <label
                v-for="option in section.options"
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
                    <span class="rq-call-option-vehicle">{{ resolveVehicleDisplayName(option.vehicleId) }}</span>
                    <span class="rq-call-option-pickup">ご案内乗車 {{ formatDateTimeLabel(option.plannedPickupAt) }}</span>
                  </div>
                  <div class="rq-call-option-meta">
                    <span>降車 {{ formatDateTimeLabel(option.plannedDropoffAt) }}</span>
                    <span>
                      計算 {{ dispatchAlgorithmLabel(option.selectedAlgorithm) }}
                      <template v-if="dispatchAlgorithmPhaseLabel(option.algorithmPhase)">
                        ({{ dispatchAlgorithmPhaseLabel(option.algorithmPhase) }})
                      </template>
                    </span>
                    <span v-if="desiredDeltaLabel(option)">
                      {{ desiredDeltaLabel(option) }}
                    </span>
                  </div>
                </div>
              </label>
            </div>
          </div>
          <div v-else class="rq-inline-help">
            人数・予約日・{{ callDesiredTimeModeLabel }}を入力して候補を取得してください。
          </div>
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
      <div v-if="mapDisplayMode === 'request' && selectedRequest" class="rq-map-selected-chip">
        <v-icon size="12" color="#0f766e">mdi-map-marker</v-icon>
        {{ selectedRequest.pickupLabel }}
        <v-icon size="12" class="mx-1">mdi-arrow-right-thin</v-icon>
        <v-icon size="12" color="#ea580c">mdi-map-marker</v-icon>
        {{ selectedRequest.dropoffLabel }}
      </div>
      <div v-else-if="mapDisplayMode === 'operation'" class="rq-map-selected-chip">
        <v-icon size="12" color="#0f766e">mdi-bus-clock</v-icon>
        {{ operationMapChipLabel }}
      </div>
      <div v-if="hasAssignablePreview && previewSimulation" class="rq-map-preview-chip">
        <v-icon size="12" color="#b45309">mdi-bus-clock</v-icon>
        試算: {{ previewVehicleLabel }} / 乗車 {{ previewPickupClock }} / 降車 {{ previewDropoffClock }}
      </div>
    </div>

    <!-- 右パネル: 予約リスト -->
    <div class="rq-panel rq-panel--right">
      <div class="rq-panel-header">
        <div class="rq-panel-title">予約案 <span class="rq-count-badge">{{ requestRows.length }}</span></div>
        <v-btn
          variant="outlined"
          color="error"
          density="compact"
          size="small"
          prepend-icon="mdi-trash-can-outline"
          class="rq-reset-btn"
          :disabled="loading || !requestRows.length"
          @click="openResetRequestsDialog"
        >
          リセット
        </v-btn>
      </div>

      <div v-if="activePanelDateKey" class="rq-panel-date-nav">
        <v-btn
          icon="mdi-chevron-left"
          variant="text"
          density="compact"
          size="small"
          class="rq-panel-date-nav-btn"
          :disabled="!hasPreviousPanelDate"
          @click="movePanelDate(-1)"
        />
        <div class="rq-panel-date-nav-body">
          <div class="rq-panel-date-nav-date">{{ activePanelDateLabel }}</div>
          <div class="rq-panel-date-nav-weekday">{{ activePanelDateWeekdayLabel }}</div>
        </div>
        <v-btn
          icon="mdi-chevron-right"
          variant="text"
          density="compact"
          size="small"
          class="rq-panel-date-nav-btn"
          :disabled="!hasNextPanelDate"
          @click="movePanelDate(1)"
        />
      </div>

      <div class="rq-driver-plan-panel">
        <div class="rq-driver-plan-header">
          <div class="rq-driver-plan-title">運行ステップ</div>
          <div class="rq-driver-plan-vehicle">{{ selectedVehicleRouteVehicleLabel }}</div>
        </div>
        <div v-if="visibleVehicleRouteDateSections.length" class="rq-driver-plan-list">
          <div
            v-for="section in visibleVehicleRouteDateSections"
            :key="'driver-step-date-' + section.dateKey"
            class="rq-date-section rq-date-section--compact"
          >
            <div class="rq-date-section-header">{{ section.dateLabel }}</div>
            <div
              v-for="step in section.steps"
              :key="step.key"
              class="rq-driver-plan-item"
              :class="{ 'is-active': mapDisplayMode === 'operation' && selectedVehicleRouteStepKey === step.key }"
              role="button"
              tabindex="0"
              @click="selectVehicleRouteStep(step.key)"
              @keydown.enter.prevent="selectVehicleRouteStep(step.key)"
            >
              <div class="rq-driver-plan-row">
                <span class="rq-driver-plan-kind" :class="step.typeBadgeClass">{{ step.typeLabel }}</span>
                <span class="rq-driver-plan-count">{{ step.passengerCount }}人</span>
                <span class="rq-driver-plan-location">{{ step.locationLabel }}</span>
              </div>
              <div class="rq-driver-plan-subrow">{{ step.requestLabel }}</div>
              <div class="rq-driver-plan-meta">
                <span class="rq-driver-plan-arrival">
                  <span>着 {{ step.arrivalLabel }}</span>
                </span>
                <span>待 {{ step.waitLabel }}</span>
                <span>移動 {{ step.moveDistanceLabel }} / {{ step.moveMinutesLabel }}</span>
                <span>車内 {{ step.onboardAfter }}人</span>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="rq-inline-help rq-driver-plan-empty">{{ selectedVehicleRouteEmptyLabel }}</div>
      </div>

      <div class="rq-request-list" v-if="visibleRequestDateSections.length">
        <div
          v-for="section in visibleRequestDateSections"
          :key="'request-date-' + section.dateKey"
          class="rq-date-section"
        >
          <div class="rq-date-section-header">{{ section.dateLabel }}</div>
          <button
            v-for="row in section.rows"
            :key="row.id"
            type="button"
            class="rq-request-item"
            :class="{ 'is-active': mapDisplayMode === 'request' && row.id === selectedRequestId }"
            @click="selectRequest(row.id)"
          >
            <div class="rq-req-top">
              <span class="rq-req-time">{{ row.displayTime }}</span>
              <span class="rq-req-subtime">降車 {{ row.dropoffDisplayTime }}</span>
              <div class="rq-req-actions">
                <v-chip :color="row.statusColor" size="x-small" variant="tonal" class="rq-req-status">
                  {{ row.statusLabel }}
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
              <span class="rq-req-date-meta">
                <v-icon size="11">mdi-calendar</v-icon>
                <span class="rq-req-date-meta-body">
                  <span>{{ row.displayTime }}</span>
                </span>
              </span>
              <span><v-icon size="11">mdi-bus</v-icon> {{ row.vehicleLabel }}</span>
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
                <template v-if="row.hasNextTask">
                  次の{{ row.nextTaskLabel }}まで 距離 {{ row.nextTaskTravelDistanceLabel ?? "算出中" }} / 時間 {{ row.nextTaskTravelMinutesLabel ?? "算出中" }}
                </template>
                <template v-else>次の乗降予定なし</template>
              </span>
              <span v-if="row.shouldReturnOffice" class="rq-req-metric">
                <v-icon size="12" color="#0369a1">mdi-office-building-marker-outline</v-icon>
                次の乗車まで {{ row.idleReturnThresholdMinutes }}分以上のため、事務所待機を推奨
              </span>
            </div>
          </button>
        </div>
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
            <div class="rq-call-meta">{{ c.id }} / {{ statusLabel(c.status) }}</div>
          </div>
        </div>
      </div>
      <div v-else class="rq-empty rq-empty--sm">
        <span class="text-caption" style="color:rgba(31,41,55,0.4)">待機中の着信なし</span>
      </div>
    </div>

  </div>
</v-app>
  `,
})
  .use(vuetify)
  .mount("#app");
