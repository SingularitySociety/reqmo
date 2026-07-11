const { createApp, ref, computed, onMounted, onBeforeUnmount, nextTick, watch } = Vue;
const { createVuetify } = Vuetify;

const vuetify = createVuetify({
  theme: {
    defaultTheme: "tuning",
    themes: {
      tuning: {
        dark: false,
        colors: {
          primary: "#2563eb",
          secondary: "#7c3aed",
          success: "#059669",
          warning: "#d97706",
          error: "#dc2626",
          background: "#f4f7fb",
          surface: "#ffffff"
        }
      }
    }
  }
});

const API_BASE = (() => {
  if (window.REQMO_API_BASE) return window.REQMO_API_BASE;
  if (window.location.protocol === "file:") return "http://localhost:18787";
  if (
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") &&
    window.location.port !== "18787"
  ) {
    return "http://localhost:18787";
  }
  return "";
})();

const PARAMETER_META = {
  "dispatchPolicy.weights.pickupDelay": {
    label: "乗車待ち時間の重視度",
    description: "迎えが遅い配車候補を避けます。大きいほど待ち時間を強く抑えます。",
    icon: "mdi-timer-sand"
  },
  "dispatchPolicy.weights.detour": {
    label: "全体の迂回抑制",
    description: "ルート全体が遠回りになる配車を避けます。",
    icon: "mdi-map-marker-distance"
  },
  "dispatchPolicy.weights.deadhead": {
    label: "空車移動の抑制",
    description: "乗客を乗せずに走る距離が長い車両を選びにくくします。",
    icon: "mdi-bus-stop-uncovered"
  },
  "dispatchPolicy.weights.rideTimeDetour": {
    label: "乗車中の遠回り抑制",
    description: "すでに乗っているお客様の車内時間が延びる配車を避けます。",
    icon: "mdi-account-clock"
  },
  "dispatchPolicy.weights.lateness": {
    label: "希望時刻の優先度",
    description: "希望する乗車・到着時刻から外れる配車を避けます。",
    icon: "mdi-calendar-clock"
  },
  "dispatchPolicy.weights.dropoffPriority": {
    label: "降車を先にする優先度",
    description: "新しい乗車を追加する前に、乗車中のお客様を降ろす判断を強めます。",
    icon: "mdi-account-arrow-right"
  },
  "dispatchPolicy.weights.existingDelaySum": {
    label: "既存乗客の遅延合計",
    description: "相乗りによる既存乗客全体の遅れを小さくします。",
    icon: "mdi-account-group"
  },
  "poolingPolicy.maxDetourMinutes": {
    label: "相乗りの最大迂回時間",
    description: "この時間を超える相乗りを禁止する運行上の制約です。",
    icon: "mdi-shield-clock"
  },
  "dispatchPolicy.maxWaitMinutes": {
    label: "許容する最大待ち時間",
    description: "この時間を超えて迎えに行く候補を配車対象から外します。",
    icon: "mdi-timer-alert"
  },
  "dispatchPolicy.candidateVehicleLimit": {
    label: "比較する候補車両数",
    description: "1件の予約で比較する車両数です。多いほど探索範囲が広がります。",
    icon: "mdi-bus-multiple"
  },
  "dispatchPolicy.algorithmPrimary": {
    label: "配車アルゴリズム",
    description: "通常の挿入探索または数理最適化を選びます。",
    icon: "mdi-state-machine"
  },
  "dispatchPolicy.highs.timeLimitSec": {
    label: "数理最適化の計算時間",
    description: "HiGHSが1回の判断に使える最大時間です。",
    icon: "mdi-speedometer"
  },
  "dispatchPolicy.cruiseSpeedKmh": {
    label: "想定走行速度",
    description: "実績から校正する平均速度です。通常は自動調整しません。",
    icon: "mdi-car-speed-limiter"
  },
  "dispatchPolicy.pickupServiceMinutes": {
    label: "乗車に必要な時間",
    description: "停車してから発車するまでの標準時間です。",
    icon: "mdi-account-plus"
  },
  "dispatchPolicy.dropoffServiceMinutes": {
    label: "降車に必要な時間",
    description: "停車してから降車が完了するまでの標準時間です。",
    icon: "mdi-account-minus"
  }
};

const EXPECTATION_LABELS = {
  mustAssign: "必ず配車する",
  preferredVehicleId: "希望車両",
  preferredVehicleRequired: "希望車両を必須にする",
  maxPickupWaitMinutes: "最大待ち時間",
  maxExistingPassengerDelayMinutes: "既存乗客の最大遅延",
  maxDesiredTimeDeviationMinutes: "希望時刻との差",
  dropoffExistingPassengersBeforeNewPickup: "既存乗客を先に降ろす",
  maxConsecutivePickups: "連続乗車回数の上限"
};

const REJECTION_REASON_LABELS = {
  CONSECUTIVE_PICKUP: "乗車が連続し、現在のルート構成では成立しない",
  CAPACITY: "同時乗車人数の上限を超える",
  MAX_WAIT: "乗車までの待ち時間上限を超える",
  MAX_DETOUR: "既存のお客様の迂回・遅延上限を超える",
  MAX_ADDITIONAL_STOPS: "追加できる停留所数の上限を超える",
  RESERVATION_WINDOW: "異なる予約日・時間帯の便を同じルートへ混在できない",
  OFFICE_BREAK_POLICY: "営業時間または事務所・休憩時間の運行条件に合わない",
  NO_FEASIBLE_VEHICLE: "条件をすべて満たす車両・ルートが見つからない",
  SCENARIO_EXECUTION_ERROR: "シナリオの実行中にエラーが発生した"
};

const FEEDBACK_EXAMPLES = [
  "待ち時間は10分以内にしたい",
  "乗車中のお客様の遠回りを5分以内にしたい",
  "新しい乗車より、乗車中のお客様の降車を先にしたい",
  "できるだけ空車で走る時間を減らしたい"
];

const TUNING_PRESETS = [
  {
    id: "balanced",
    title: "おすすめ",
    subtitle: "まずはこれ",
    description: "待ち時間・遠回り・空車移動をバランスよく調整します。",
    icon: "mdi-auto-fix",
    paths: [
      "dispatchPolicy.weights.detour",
      "dispatchPolicy.weights.deadhead",
      "dispatchPolicy.weights.rideTimeDetour",
      "dispatchPolicy.weights.lateness",
      "dispatchPolicy.weights.dropoffPriority",
      "dispatchPolicy.weights.existingDelaySum"
    ]
  },
  {
    id: "wait",
    title: "待ち時間を短く",
    subtitle: "迎えを優先",
    description: "乗車待ちと希望時刻を中心に調整します。",
    icon: "mdi-timer-sand",
    paths: [
      "dispatchPolicy.weights.pickupDelay",
      "dispatchPolicy.weights.deadhead",
      "dispatchPolicy.weights.lateness"
    ]
  },
  {
    id: "onboard",
    title: "乗車中の人を優先",
    subtitle: "連れ回しを抑制",
    description: "既存乗客の遠回りと遅延を中心に調整します。",
    icon: "mdi-account-heart",
    paths: [
      "dispatchPolicy.weights.detour",
      "dispatchPolicy.weights.rideTimeDetour",
      "dispatchPolicy.weights.dropoffPriority",
      "dispatchPolicy.weights.existingDelaySum"
    ]
  },
  {
    id: "efficiency",
    title: "走行効率を優先",
    subtitle: "空車・迂回を削減",
    description: "車両の無駄な移動を減らす方向で調整します。",
    icon: "mdi-leaf",
    paths: [
      "dispatchPolicy.weights.detour",
      "dispatchPolicy.weights.deadhead"
    ]
  }
];

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
  return payload;
}

const apiGet = (path) => api(path);
const apiPost = (path, body) => api(path, { method: "POST", body: JSON.stringify(body ?? {}) });
const clone = (value) => JSON.parse(JSON.stringify(value));
const pretty = (value) => JSON.stringify(value, null, 2);

function nextHourIso(offsetMinutes = 0) {
  const value = new Date(Date.now() + (60 + offsetMinutes) * 60 * 1000);
  value.setSeconds(0, 0);
  return value.toISOString();
}

function toDateTimeLocal(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

function fromDateTimeLocal(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : nextHourIso();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function seededRandom(seedText) {
  let seed = 2166136261;
  for (const char of String(seedText || "reqmo")) {
    seed ^= char.charCodeAt(0);
    seed = Math.imul(seed, 16777619);
  }
  return () => {
    seed += 0x6d2b79f5;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function hasPoint(point) {
  return Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lng));
}

createApp({
  setup() {
    const loading = ref(false);
    const running = ref(false);
    const error = ref("");
    const notice = ref("");
    const profiles = ref([]);
    const activeProfileId = ref("");
    const stops = ref([]);
    const suites = ref([]);
    const runs = ref([]);
    const recommendations = ref([]);
    const versions = ref([]);
    const selectedProfileId = ref("");
    const selectedSuiteId = ref("");
    const selectedRecommendationId = ref("");
    const parameterSpace = ref([]);
    const maxTrials = ref(24);
    const seed = ref("reqmo-tuning-v1");
    const feedbackText = ref("");
    const interpretedFeedback = ref(null);
    const suiteName = ref("地図で作成した配車確認シナリオ");
    const activateAt = ref("");
    const forceApproval = ref(false);
    const selectedRunResult = ref(null);
    const previewing = ref(false);
    const scenarioPreview = ref(null);
    const scenarioPreviewSignature = ref("");
    const scenarioDrafts = ref([]);
    const rawJsonText = ref("[]");
    const selectedScenarioId = ref("");
    const selectedBookingId = ref("");
    const mapPickMode = ref("");
    const randomBookingCount = ref(8);
    const randomTrainRatio = ref(75);
    const randomTimeSpanMinutes = ref(180);
    const randomGenerationSeed = ref("");
    const randomGenerationBaseAt = ref("");
    const mapReady = ref(false);
    const selectedTuningPreset = ref("balanced");

    let map = null;
    let stopLayer = null;
    let bookingLayer = null;
    let resultLayer = null;
    let idCounter = 0;

    const selectedRecommendation = computed(() =>
      recommendations.value.find((entry) => entry.id === selectedRecommendationId.value) ??
      selectedRunResult.value?.recommendation ??
      null
    );
    const selectedScenario = computed(() =>
      scenarioDrafts.value.find((entry) => entry.id === selectedScenarioId.value) ?? null
    );
    const selectedBooking = computed(() =>
      selectedScenario.value?.bookings?.find((entry) => entry.id === selectedBookingId.value) ?? null
    );
    const selectedProfile = computed(() =>
      profiles.value.find((entry) => entry.id === selectedProfileId.value) ?? null
    );
    const previewRequestSignature = computed(() => pretty({
      baseProfileId: selectedProfileId.value,
      scenarios: scenarioDrafts.value
    }));
    const previewIsCurrent = computed(() =>
      Boolean(scenarioPreview.value) && scenarioPreviewSignature.value === previewRequestSignature.value
    );
    const previewScenarioResult = computed(() =>
      scenarioPreview.value?.evaluation?.scenarioResults?.find(
        (entry) => entry.scenarioId === selectedScenarioId.value
      ) ?? null
    );
    const previewMetrics = computed(() => previewScenarioResult.value?.metrics ?? null);
    const previewVehicleRoutes = computed(() => {
      const routes = new Map();
      for (const outcome of previewScenarioResult.value?.outcomes ?? []) {
        if (outcome.selectedVehicleId && outcome.routeAfter?.length) {
          routes.set(outcome.selectedVehicleId, {
            vehicleId: outcome.selectedVehicleId,
            selectedAlgorithm: outcome.selectedAlgorithm,
            startPoint: outcome.vehicleStartPoint,
            tasks: outcome.routeAfter
          });
        }
      }
      return Array.from(routes.values());
    });
    const previewViolations = computed(() =>
      (previewScenarioResult.value?.outcomes ?? []).flatMap((outcome) =>
        (outcome.metrics?.violations ?? []).map((violation) => ({
          ...violation,
          bookingId: outcome.parentBookingId ?? outcome.bookingId
        }))
      )
    );
    const selectedBookingPreviewOutcomes = computed(() => {
      const bookingId = selectedBooking.value?.id;
      if (!bookingId) return [];
      return (previewScenarioResult.value?.outcomes ?? []).filter(
        (outcome) => (outcome.parentBookingId ?? outcome.bookingId) === bookingId
      );
    });
    const selectedBookingPreviewSummary = computed(() => {
      if (!previewIsCurrent.value || !selectedBookingPreviewOutcomes.value.length) {
        return "ルート確認後に、選択中の予約の配車結果がここへ表示されます。";
      }
      const outcomes = selectedBookingPreviewOutcomes.value;
      const rejected = outcomes.find((outcome) => outcome.status !== "ASSIGNED");
      if (rejected) return `配車できませんでした: ${rejectionReasonTitle(rejected)}`;
      const vehicles = [...new Set(outcomes.map((outcome) => outcome.selectedVehicleId).filter(Boolean))];
      const maxWait = Math.max(...outcomes.map((outcome) => Number(outcome.metrics?.pickupWaitMinutes) || 0));
      return `${vehicles.join("・")}へ配車 / 最大待ち時間 ${maxWait.toFixed(1)}分`;
    });
    const unlockedCount = computed(() => parameterSpace.value.filter((entry) => !entry.locked).length);
    const activeVersionId = computed(
      () => versions.value.find((entry) => entry.status === "ACTIVE")?.id ?? ""
    );
    const scenarioStats = computed(() => {
      const train = scenarioDrafts.value.filter((entry) => entry.partition === "TRAIN");
      const holdout = scenarioDrafts.value.filter((entry) => entry.partition === "HOLDOUT");
      return {
        scenarios: scenarioDrafts.value.length,
        bookings: scenarioDrafts.value.reduce((sum, entry) => sum + entry.bookings.length, 0),
        trainBookings: train.reduce((sum, entry) => sum + entry.bookings.length, 0),
        holdoutBookings: holdout.reduce((sum, entry) => sum + entry.bookings.length, 0)
      };
    });
    const journeyState = computed(() => ({
      scenario: previewIsCurrent.value,
      feedback: Boolean(interpretedFeedback.value),
      parameters: unlockedCount.value > 0,
      tested: Boolean(selectedRecommendation.value)
    }));
    const enabledParameterLabels = computed(() =>
      parameterSpace.value
        .filter((parameter) => !parameter.locked)
        .map((parameter) => parameterMeta(parameter).label)
    );
    const selectedBookingTargetLabel = computed(() => {
      if (!selectedScenario.value || !selectedBooking.value) return "予約を選択してください";
      return `${selectedScenario.value.name} / ${locationLabel(selectedBooking.value.pickup)} → ${bookingDropoffSummary(selectedBooking.value)}`;
    });
    const mapPickInstruction = computed(() => {
      if (!mapPickMode.value) return "";
      return mapPickMode.value === "pickup" ? "乗車" : "降車";
    });
    const expectationRows = computed(() =>
      Object.entries(interpretedFeedback.value?.expectations ?? {}).map(([key, value]) => ({
        key,
        label: EXPECTATION_LABELS[key] ?? key,
        value: typeof value === "boolean" ? (value ? "はい" : "いいえ") : value
      }))
    );
    const resultMetricCards = computed(() => {
      const baseline = selectedRecommendation.value?.baselineEvaluation?.metrics ?? {};
      const candidate = selectedRecommendation.value?.candidateEvaluation?.metrics ?? {};
      return [
        { key: "objectiveScore", label: "総合評価", baseline: baseline.objectiveScore, candidate: candidate.objectiveScore },
        { key: "hardViolationCount", label: "制約違反", baseline: baseline.hardViolationCount, candidate: candidate.hardViolationCount, integer: true },
        { key: "rejectedBookings", label: "配車不能", baseline: baseline.rejectedBookings, candidate: candidate.rejectedBookings, integer: true },
        { key: "maxPickupWaitMinutes", label: "最大待ち時間", baseline: baseline.maxPickupWaitMinutes, candidate: candidate.maxPickupWaitMinutes, suffix: "分" },
        { key: "maxExistingPassengerDelayMinutes", label: "既存乗客の最大遅延", baseline: baseline.maxExistingPassengerDelayMinutes, candidate: candidate.maxExistingPassengerDelayMinutes, suffix: "分" },
        { key: "totalRouteTravelMinutes", label: "合計走行時間", baseline: baseline.totalRouteTravelMinutes, candidate: candidate.totalRouteTravelMinutes, suffix: "分" }
      ];
    });

    function newId(prefix) {
      idCounter += 1;
      return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
    }

    function stopIndex() {
      return new Map(stops.value.map((stop) => [stop.id, stop]));
    }

    function normalizeBooking(booking, index) {
      const partySize = Math.max(1, Math.round(Number(booking?.partySize) || 1));
      const rawDropoffs = Array.isArray(booking?.dropoffs) && booking.dropoffs.length
        ? booking.dropoffs
        : [{
            id: `${booking?.id || `booking${index + 1}`}_dropoff_1`,
            dropoff: booking?.dropoff ?? {},
            partySize
          }];
      const dropoffs = rawDropoffs.map((group, groupIndex) => ({
        ...clone(group ?? {}),
        id: group?.id || newId(`dropoff${groupIndex + 1}`),
        dropoff: clone(group?.dropoff ?? group?.location ?? group ?? {}),
        partySize: Math.max(1, Math.round(Number(group?.partySize) || 1))
      }));
      return {
        ...clone(booking ?? {}),
        id: booking?.id || newId(`booking${index + 1}`),
        at: booking?.at || booking?.evaluationNowAt || nextHourIso(index * 10),
        pickup: clone(booking?.pickup ?? {}),
        dropoff: clone(dropoffs[0]?.dropoff ?? {}),
        dropoffs,
        partySize,
        sameVehicleRequired: booking?.sameVehicleRequired !== false,
        expectations: {
          mustAssign: true,
          maxPickupWaitMinutes: 15,
          ...(booking?.expectations ?? {})
        }
      };
    }

    function normalizeScenarios(scenarios) {
      return (Array.isArray(scenarios) ? scenarios : []).map((scenario, index) => ({
        ...clone(scenario ?? {}),
        id: scenario?.id || newId(`scenario${index + 1}`),
        name: scenario?.name || `シナリオ ${index + 1}`,
        partition: String(scenario?.partition).toUpperCase() === "HOLDOUT" ? "HOLDOUT" : "TRAIN",
        bookings: (scenario?.bookings ?? []).map(normalizeBooking)
      }));
    }

    function setScenarioDrafts(scenarios, fit = true) {
      scenarioDrafts.value = normalizeScenarios(scenarios);
      selectedScenarioId.value = scenarioDrafts.value[0]?.id ?? "";
      selectedBookingId.value = scenarioDrafts.value[0]?.bookings?.[0]?.id ?? "";
      mapPickMode.value = "";
      syncRawJson();
      nextTick(() => renderMap(fit));
    }

    function createBooking(index = 0, sourceStops = stops.value) {
      const pickup = sourceStops[index % Math.max(sourceStops.length, 1)];
      const dropoff = sourceStops[(index + 1) % Math.max(sourceStops.length, 1)] ?? pickup;
      return normalizeBooking({
        id: newId("booking"),
        at: nextHourIso(index * 15),
        pickup: pickup ? { mode: "FIXED_STOP", stopId: pickup.id } : {},
        dropoff: dropoff ? { mode: "FIXED_STOP", stopId: dropoff.id } : {},
        partySize: 1,
        expectations: {
          mustAssign: true,
          maxPickupWaitMinutes: Number(selectedProfile.value?.dispatchPolicy?.maxWaitMinutes) || 15,
          maxExistingPassengerDelayMinutes: 7
        }
      }, index);
    }

    function buildDefaultScenarios() {
      if (stops.value.length < 2) return;
      setScenarioDrafts([
        {
          id: newId("train"),
          name: "調整用の通常ケース",
          partition: "TRAIN",
          bookings: [createBooking(0)]
        },
        {
          id: newId("holdout"),
          name: "安全確認ケース",
          partition: "HOLDOUT",
          bookings: [createBooking(2)]
        }
      ]);
    }

    function createRandomBookings(count, random, offset = 0, baseAt = Date.now() + 60 * 60 * 1000) {
      const base = Number(baseAt);
      const maxSpan = Math.max(15, Number(randomTimeSpanMinutes.value) || 180);
      const bookings = [];
      for (let index = 0; index < count; index += 1) {
        const pickupIndex = Math.floor(random() * stops.value.length);
        let dropoffIndex = Math.floor(random() * stops.value.length);
        if (dropoffIndex === pickupIndex) dropoffIndex = (dropoffIndex + 1) % stops.value.length;
        const at = new Date(base + Math.floor(random() * maxSpan) * 60 * 1000).toISOString();
        const partySize = 1 + Math.floor(random() * 4);
        const shouldSplitDropoff = partySize >= 2 && stops.value.length >= 3 && random() < 0.45;
        const firstDropoffSize = shouldSplitDropoff
          ? 1 + Math.floor(random() * (partySize - 1))
          : partySize;
        let secondDropoffIndex = (dropoffIndex + 1) % stops.value.length;
        while (secondDropoffIndex === pickupIndex || secondDropoffIndex === dropoffIndex) {
          secondDropoffIndex = (secondDropoffIndex + 1) % stops.value.length;
        }
        const dropoffs = [{
          id: newId("dropoff"),
          dropoff: { mode: "FIXED_STOP", stopId: stops.value[dropoffIndex].id },
          partySize: firstDropoffSize
        }];
        if (shouldSplitDropoff) {
          dropoffs.push({
            id: newId("dropoff"),
            dropoff: { mode: "FIXED_STOP", stopId: stops.value[secondDropoffIndex].id },
            partySize: partySize - firstDropoffSize
          });
        }
        bookings.push(normalizeBooking({
          id: newId(`random${offset + index + 1}`),
          at,
          pickup: { mode: "FIXED_STOP", stopId: stops.value[pickupIndex].id },
          dropoff: { mode: "FIXED_STOP", stopId: stops.value[dropoffIndex].id },
          dropoffs,
          partySize,
          expectations: {
            mustAssign: true,
            maxPickupWaitMinutes: Number(selectedProfile.value?.dispatchPolicy?.maxWaitMinutes) || 15,
            maxExistingPassengerDelayMinutes: 5 + Math.floor(random() * 6)
          }
        }, offset + index));
      }
      return bookings.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    }

    function freshRandomGenerationSeed() {
      if (window.crypto?.getRandomValues) {
        const values = new Uint32Array(3);
        window.crypto.getRandomValues(values);
        return Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("-");
      }
      return `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
    }

    function buildRandomSuite(generationSeed, baseAt) {
      if (stops.value.length < 2) {
        error.value = "ランダム生成には停留所が2件以上必要です。";
        return;
      }
      const total = Math.min(40, Math.max(2, Number(randomBookingCount.value) || 8));
      const ratio = Math.min(90, Math.max(50, Number(randomTrainRatio.value) || 75));
      const trainCount = Math.min(total - 1, Math.max(1, Math.round(total * ratio / 100)));
      const holdoutCount = total - trainCount;
      const random = seededRandom(generationSeed);
      setScenarioDrafts([
        {
          id: newId("train_random"),
          name: `ランダム調整 ${trainCount}件`,
          partition: "TRAIN",
          bookings: createRandomBookings(trainCount, random, 0, baseAt)
        },
        {
          id: newId("holdout_random"),
          name: `ランダム安全確認 ${holdoutCount}件`,
          partition: "HOLDOUT",
          bookings: createRandomBookings(holdoutCount, random, trainCount, baseAt)
        }
      ]);
      notice.value = `${total}件の予約を新しい乱数シードから生成しました。`;
    }

    function generateRandomSuite() {
      randomGenerationSeed.value = freshRandomGenerationSeed();
      const base = new Date(Date.now() + 60 * 60 * 1000);
      base.setSeconds(0, 0);
      randomGenerationBaseAt.value = base.toISOString();
      buildRandomSuite(randomGenerationSeed.value, base.getTime());
    }

    function reproduceRandomSuite() {
      if (!randomGenerationSeed.value || !randomGenerationBaseAt.value) return;
      buildRandomSuite(randomGenerationSeed.value, new Date(randomGenerationBaseAt.value).getTime());
      notice.value = "表示中の生成IDから同じ予約パターンを再現しました。";
    }

    async function refresh() {
      loading.value = true;
      error.value = "";
      try {
        const previousActiveProfileId = activeProfileId.value;
        const [profileRes, stopRes, suiteRes, runRes, recRes, versionRes] = await Promise.all([
          apiGet("/api/service-profiles"),
          apiGet("/api/stops"),
          apiGet("/api/tuning/scenario-suites"),
          apiGet("/api/tuning/runs"),
          apiGet("/api/tuning/recommendations"),
          apiGet("/api/tuning/profile-versions")
        ]);
        profiles.value = profileRes.data ?? [];
        activeProfileId.value = profileRes.activeServiceProfileId ?? "";
        stops.value = stopRes.data ?? [];
        suites.value = (suiteRes.data ?? []).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        runs.value = (runRes.data ?? []).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        recommendations.value = (recRes.data ?? []).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        versions.value = (versionRes.data ?? []).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        const selectedProfileStillExists = profiles.value.some(
          (profile) => profile.id === selectedProfileId.value
        );
        if (
          !selectedProfileId.value ||
          !selectedProfileStillExists ||
          (previousActiveProfileId &&
            selectedProfileId.value === previousActiveProfileId &&
            activeProfileId.value !== previousActiveProfileId)
        ) {
          selectedProfileId.value = activeProfileId.value || profiles.value[0]?.id || "";
        }
        selectedSuiteId.value ||= suites.value[0]?.id || "";
        selectedRecommendationId.value ||= recommendations.value[0]?.id || "";
        if (!scenarioDrafts.value.length) buildDefaultScenarios();
        await loadParameterSpace();
        await nextTick();
        renderMap(false);
      } catch (cause) {
        error.value = cause.message;
      } finally {
        loading.value = false;
      }
    }

    async function loadParameterSpace() {
      if (!selectedProfileId.value) return;
      const response = await apiGet(
        `/api/tuning/parameter-space?profileId=${encodeURIComponent(selectedProfileId.value)}`
      );
      parameterSpace.value = (response.data ?? []).map((parameter) => ({
        ...parameter,
        _safeMin: parameter.min,
        _safeMax: parameter.max
      }));
    }

    async function loadSelectedSuite() {
      if (!selectedSuiteId.value) return;
      error.value = "";
      try {
        const suite = await apiGet(`/api/tuning/scenario-suites/${encodeURIComponent(selectedSuiteId.value)}`);
        suiteName.value = suite.name || suiteName.value;
        randomGenerationSeed.value = suite.generationMeta?.seed ?? "";
        randomGenerationBaseAt.value = suite.generationMeta?.baseAt ?? "";
        setScenarioDrafts(suite.scenarios ?? []);
        notice.value = "保存済みシナリオを編集画面へ読み込みました。";
      } catch (cause) {
        error.value = cause.message;
      }
    }

    function parameterMeta(parameterOrPath) {
      const path = typeof parameterOrPath === "string" ? parameterOrPath : parameterOrPath?.path;
      return PARAMETER_META[path] ?? {
        label: path,
        description: "安全範囲の中でAIが候補値を探索します。",
        icon: "mdi-tune-variant"
      };
    }

    function toggleParameter(parameter, enabled) {
      parameter.locked = !enabled;
      selectedTuningPreset.value = "custom";
    }

    function updateParameterRange(parameter, values) {
      if (!Array.isArray(values) || values.length !== 2) return;
      parameter.min = Number(values[0]);
      parameter.max = Number(values[1]);
    }

    function applyTuningPreset(presetId) {
      const preset = TUNING_PRESETS.find((entry) => entry.id === presetId);
      if (!preset) return;
      const enabledPaths = new Set(preset.paths);
      for (const parameter of parameterSpace.value) {
        parameter.locked = !enabledPaths.has(parameter.path);
      }
      selectedTuningPreset.value = preset.id;
      notice.value = `「${preset.title}」の調整方針を選びました。`;
    }

    function useFeedbackExample(text) {
      feedbackText.value = text;
    }

    function scrollToSection(id) {
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function generateQuickStartScenarios() {
      generateRandomSuite();
      nextTick(() => scrollToSection("scenario-studio"));
    }

    function selectScenario(scenario) {
      selectedScenarioId.value = scenario.id;
      selectedBookingId.value = scenario.bookings[0]?.id ?? "";
      mapPickMode.value = "";
      nextTick(() => renderMap(true));
    }

    function selectBooking(booking) {
      selectedBookingId.value = booking.id;
      mapPickMode.value = "";
      nextTick(() => renderMap(false));
    }

    function addScenario(partition = "TRAIN") {
      const scenario = {
        id: newId(partition.toLowerCase()),
        name: partition === "HOLDOUT" ? "新しい安全確認ケース" : "新しい調整ケース",
        partition,
        bookings: [createBooking(scenarioStats.value.bookings)]
      };
      scenarioDrafts.value.push(scenario);
      selectScenario(scenario);
    }

    function removeScenario() {
      const scenario = selectedScenario.value;
      if (!scenario || scenarioDrafts.value.length <= 1) return;
      if (!window.confirm(`「${scenario.name}」を削除しますか？`)) return;
      const index = scenarioDrafts.value.findIndex((entry) => entry.id === scenario.id);
      scenarioDrafts.value.splice(index, 1);
      selectScenario(scenarioDrafts.value[Math.max(0, index - 1)]);
    }

    function addBooking() {
      const scenario = selectedScenario.value;
      if (!scenario) return;
      const booking = createBooking(scenarioStats.value.bookings);
      scenario.bookings.push(booking);
      selectBooking(booking);
    }

    function duplicateBooking() {
      if (!selectedScenario.value || !selectedBooking.value) return;
      const copy = normalizeBooking({
        ...clone(selectedBooking.value),
        id: newId("booking_copy"),
        at: new Date(new Date(selectedBooking.value.at).getTime() + 10 * 60 * 1000).toISOString()
      }, selectedScenario.value.bookings.length);
      selectedScenario.value.bookings.push(copy);
      selectBooking(copy);
    }

    function removeBooking() {
      const scenario = selectedScenario.value;
      const booking = selectedBooking.value;
      if (!scenario || !booking || scenario.bookings.length <= 1) return;
      const index = scenario.bookings.findIndex((entry) => entry.id === booking.id);
      scenario.bookings.splice(index, 1);
      selectBooking(scenario.bookings[Math.max(0, index - 1)]);
    }

    function locationPoint(location) {
      if (hasPoint(location?.point)) return { lat: Number(location.point.lat), lng: Number(location.point.lng) };
      if (hasPoint(location?.resolvedPoint)) return { lat: Number(location.resolvedPoint.lat), lng: Number(location.resolvedPoint.lng) };
      const stop = location?.stopId ? stopIndex().get(location.stopId) : null;
      return hasPoint(stop) ? { lat: Number(stop.lat), lng: Number(stop.lng) } : null;
    }

    function locationLabel(location) {
      const stop = location?.stopId ? stopIndex().get(location.stopId) : null;
      if (stop) return stop.name || stop.id;
      const point = locationPoint(location);
      return point ? `地図指定 ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}` : "未設定";
    }

    function dropoffGroups(booking) {
      return Array.isArray(booking?.dropoffs) ? booking.dropoffs : [];
    }

    function dropoffTotal(booking) {
      return dropoffGroups(booking).reduce(
        (sum, group) => sum + Math.max(0, Math.round(Number(group?.partySize) || 0)),
        0
      );
    }

    function dropoffBalanceClass(booking) {
      return dropoffTotal(booking) === Number(booking?.partySize) ? "is-balanced" : "is-unbalanced";
    }

    function bookingDropoffSummary(booking) {
      const groups = dropoffGroups(booking);
      if (!groups.length) return "降車未設定";
      const labels = groups.map((group) => `${locationLabel(group.dropoff)} ${group.partySize}人`);
      return labels.length <= 2 ? labels.join(" / ") : `${labels.slice(0, 2).join(" / ")} ほか${labels.length - 2}か所`;
    }

    function bookingFlowLabel(booking) {
      return `乗${booking?.partySize ?? 0} → 降${dropoffGroups(booking).map((group) => group.partySize).join("+") || 0}`;
    }

    function syncPrimaryDropoff(booking) {
      if (booking) booking.dropoff = clone(dropoffGroups(booking)[0]?.dropoff ?? {});
    }

    function locationStopValue(booking, kind) {
      return booking?.[kind]?.stopId ?? null;
    }

    function dropoffStopValue(group) {
      return group?.dropoff?.stopId ?? null;
    }

    function setBookingStop(booking, kind, stopId) {
      const stop = stopIndex().get(stopId);
      if (!booking || !stop) return;
      booking[kind] = { mode: "FIXED_STOP", stopId: stop.id };
      mapPickMode.value = "";
      nextTick(() => renderMap(false));
    }

    function setDropoffStop(booking, group, stopId) {
      const stop = stopIndex().get(stopId);
      if (!booking || !group || !stop) return;
      group.dropoff = { mode: "FIXED_STOP", stopId: stop.id };
      syncPrimaryDropoff(booking);
      mapPickMode.value = "";
      nextTick(() => renderMap(false));
    }

    function setBookingMapPoint(target, point) {
      if (!selectedBooking.value || !hasPoint(point)) return;
      const location = { mode: "FREE_POINT", point: { lat: Number(point.lat), lng: Number(point.lng) } };
      if (target === "pickup") {
        selectedBooking.value.pickup = location;
      } else {
        const groupId = String(target).replace(/^dropoff:/, "");
        const group = dropoffGroups(selectedBooking.value).find((entry) => entry.id === groupId);
        if (group) group.dropoff = location;
        syncPrimaryDropoff(selectedBooking.value);
      }
      mapPickMode.value = "";
      nextTick(() => renderMap(false));
    }

    function toggleMapPick(kind) {
      if (!selectedBooking.value) return;
      mapPickMode.value = mapPickMode.value === kind ? "" : kind;
    }

    function toggleDropoffMapPick(group) {
      if (!selectedBooking.value || !group) return;
      toggleMapPick(`dropoff:${group.id}`);
    }

    function isDropoffMapPick(group) {
      return Boolean(group) && mapPickMode.value === `dropoff:${group.id}`;
    }

    function setPickupPartySize(booking, value) {
      if (!booking) return;
      const groups = dropoffGroups(booking);
      const nextSize = Math.max(groups.length || 1, Math.round(Number(value) || 1));
      const difference = nextSize - dropoffTotal(booking);
      booking.partySize = nextSize;
      if (!groups.length) return;
      if (difference >= 0) {
        groups.at(-1).partySize += difference;
      } else {
        let remaining = -difference;
        for (const group of [...groups].reverse()) {
          const reducible = Math.max(0, group.partySize - 1);
          const reduction = Math.min(reducible, remaining);
          group.partySize -= reduction;
          remaining -= reduction;
          if (!remaining) break;
        }
      }
    }

    function setDropoffPartySize(group, value) {
      if (group) group.partySize = Math.max(1, Math.round(Number(value) || 1));
    }

    function canSplitDropoff(booking) {
      return dropoffGroups(booking).some((group) => Number(group.partySize) >= 2);
    }

    function addDropoffGroup(booking) {
      if (!booking) return;
      const groups = dropoffGroups(booking);
      const source = [...groups].sort((left, right) => Number(right.partySize) - Number(left.partySize))[0];
      if (!source || Number(source.partySize) < 2) return;
      const splitSize = Math.floor(Number(source.partySize) / 2);
      source.partySize -= splitSize;
      const usedStopIds = new Set([booking.pickup?.stopId, ...groups.map((group) => group.dropoff?.stopId)]);
      const nextStop = stops.value.find((stop) => !usedStopIds.has(stop.id)) ?? stops.value[0];
      groups.push({
        id: newId("dropoff"),
        dropoff: nextStop ? { mode: "FIXED_STOP", stopId: nextStop.id } : {},
        partySize: splitSize
      });
      syncPrimaryDropoff(booking);
      nextTick(() => renderMap(false));
    }

    function removeDropoffGroup(booking, group) {
      const groups = dropoffGroups(booking);
      if (!booking || !group || groups.length <= 1) return;
      const index = groups.findIndex((entry) => entry.id === group.id);
      if (index < 0) return;
      const [removed] = groups.splice(index, 1);
      groups[Math.max(0, index - 1)].partySize += Number(removed.partySize) || 0;
      syncPrimaryDropoff(booking);
      mapPickMode.value = "";
      nextTick(() => renderMap(false));
    }

    function balanceDropoffs(booking) {
      const groups = dropoffGroups(booking);
      if (!booking || !groups.length) return;
      const total = Math.max(groups.length, Math.round(Number(booking.partySize) || groups.length));
      booking.partySize = total;
      groups.forEach((group) => { group.partySize = 1; });
      groups.at(-1).partySize += total - groups.length;
    }

    function bookingDateTimeLocal(booking) {
      return toDateTimeLocal(booking?.at);
    }

    function setBookingDateTime(booking, value) {
      if (booking) booking.at = fromDateTimeLocal(value);
    }

    function syncRawJson() {
      rawJsonText.value = pretty(scenarioDrafts.value);
    }

    function applyRawJson() {
      try {
        const parsed = JSON.parse(rawJsonText.value);
        setScenarioDrafts(parsed);
        notice.value = "JSONの内容をビジュアル編集画面へ反映しました。";
      } catch (cause) {
        error.value = `JSONを読み込めません: ${cause.message}`;
      }
    }

    function validateScenarios() {
      if (!scenarioDrafts.value.length) throw new Error("シナリオを1件以上作成してください。");
      for (const scenario of scenarioDrafts.value) {
        if (!scenario.bookings.length) throw new Error(`${scenario.name} に予約がありません。`);
        for (const booking of scenario.bookings) {
          const groups = dropoffGroups(booking);
          if (!locationPoint(booking.pickup) || !groups.length || groups.some((group) => !locationPoint(group.dropoff))) {
            throw new Error(`${scenario.name} の乗車・降車地点を設定してください。`);
          }
          if (dropoffTotal(booking) !== Number(booking.partySize)) {
            throw new Error(`${scenario.name} の「${locationLabel(booking.pickup)}」は、乗車${booking.partySize}人と降車合計${dropoffTotal(booking)}人が一致していません。`);
          }
        }
      }
    }

    function formatPreviewTime(value, etaMinutes = null) {
      const date = value ? new Date(value) : null;
      if (date && !Number.isNaN(date.getTime())) {
        return new Intl.DateTimeFormat("ja-JP", {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        }).format(date);
      }
      return etaMinutes !== null && etaMinutes !== undefined && Number.isFinite(Number(etaMinutes))
        ? `約${Number(etaMinutes).toFixed(1)}分後`
        : "時刻未定";
    }

    function previewTaskTypeLabel(task) {
      return task?.type === "PICKUP" ? "乗車" : task?.type === "DROPOFF" ? "降車" : task?.type ?? "移動";
    }

    function previewTaskPassengerLabel(task) {
      const loadChange = Number(task?.loadChange);
      if (!Number.isFinite(loadChange) || loadChange === 0) return "";
      return `${loadChange > 0 ? "+" : ""}${loadChange}人`;
    }

    function rejectionReasonTitle(outcome) {
      return REJECTION_REASON_LABELS[outcome?.reason] ?? outcome?.reason ?? "配車条件を満たす案がありません";
    }

    function rejectionReasonSummary(outcome) {
      return outcome?.diagnostics?.summary || rejectionReasonTitle(outcome);
    }

    function rejectionBreakdown(outcome) {
      const diagnostics = outcome?.diagnostics ?? {};
      const breakdown = Array.isArray(diagnostics.breakdown) && diagnostics.breakdown.length
        ? diagnostics.breakdown
        : Object.entries(diagnostics.rejectionCounts ?? {}).map(([code, count]) => ({ code, count }));
      return breakdown
        .map((entry) => ({
          code: entry.code,
          label: REJECTION_REASON_LABELS[entry.code] ?? entry.code,
          count: Math.max(0, Math.round(Number(entry.count) || 0)),
          ratioPercent: Number.isFinite(Number(entry.ratioPercent))
            ? Math.round(Number(entry.ratioPercent))
            : null
        }))
        .filter((entry) => entry.count > 0)
        .sort((left, right) => right.count - left.count);
    }

    function rejectionConstraintSummary(outcome) {
      const constraints = outcome?.diagnostics?.constraints ?? {};
      const segments = [];
      const append = (value, label, suffix = "") => {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) segments.push(`${label}${Math.round(numeric)}${suffix}`);
      };
      append(constraints.maxWaitMinutes, "最大待ち ", "分");
      append(constraints.maxDetourMinutes, "最大迂回遅延 ", "分");
      append(constraints.maxAdditionalStops, "追加停留所 ", "か所");
      append(constraints.maxOnboardPerVehicle, "同乗上限 ", "人");
      return segments.join(" / ");
    }

    function rejectionCountermeasures(outcome) {
      return Array.isArray(outcome?.diagnostics?.countermeasureCandidates)
        ? outcome.diagnostics.countermeasureCandidates
        : [];
    }

    async function previewCurrentRoutes() {
      if (!selectedProfileId.value) return;
      previewing.value = true;
      error.value = "";
      notice.value = "現在の設定で配車ルートを計算しています。";
      try {
        validateScenarios();
        const signature = previewRequestSignature.value;
        const response = await apiPost("/api/tuning/preview", {
          baseProfileId: selectedProfileId.value,
          name: suiteName.value,
          description: "チューニング前のルート確認",
          scenarios: clone(scenarioDrafts.value)
        });
        scenarioPreview.value = response;
        scenarioPreviewSignature.value = signature;
        const assigned = Number(response.evaluation?.metrics?.assignedBookings) || 0;
        const total = Number(response.evaluation?.metrics?.totalBookings) || 0;
        notice.value = `現在設定の配車を確認しました（${assigned}/${total}グループ配車）。地図と乗降順を確認してください。`;
        await nextTick();
        renderMap(true);
      } catch (cause) {
        error.value = cause.message;
      } finally {
        previewing.value = false;
      }
    }

    async function persistSuite() {
      validateScenarios();
      const response = await apiPost("/api/tuning/scenario-suites", {
        name: suiteName.value,
        description: `地図から作成: ${scenarioStats.value.bookings}予約`,
        generationMeta: randomGenerationSeed.value
          ? {
              type: "RANDOM",
              seed: randomGenerationSeed.value,
              baseAt: randomGenerationBaseAt.value
            }
          : null,
        scenarios: clone(scenarioDrafts.value)
      });
      selectedSuiteId.value = response.suite.id;
      return response.suite;
    }

    async function saveSuite() {
      error.value = "";
      notice.value = "";
      try {
        await persistSuite();
        notice.value = "現在の車両状態と地図上の予約をシナリオとして保存しました。";
        await refresh();
      } catch (cause) {
        error.value = cause.message;
      }
    }

    function parameterPayload() {
      return parameterSpace.value.map((parameter) =>
        Object.fromEntries(Object.entries(parameter).filter(([key]) => !key.startsWith("_")))
      );
    }

    async function executeTuning(scenarioSuiteId) {
      const response = await apiPost("/api/tuning/runs", {
        scenarioSuiteId,
        baseProfileId: selectedProfileId.value,
        parameterSpace: parameterPayload(),
        maxTrials: Number(maxTrials.value),
        seed: seed.value,
        actor: "tuning-web"
      });
      selectedRunResult.value = response;
      selectedRecommendationId.value = response.recommendation.id;
      return response;
    }

    async function runTuning() {
      if (!selectedSuiteId.value || !selectedProfileId.value) return;
      running.value = true;
      error.value = "";
      notice.value = "候補パラメータを隔離環境で評価しています。";
      try {
        const response = await executeTuning(selectedSuiteId.value);
        notice.value = `探索が完了しました（${response.trials.length}試行）。地図には候補ルートを緑色で表示します。`;
        await refresh();
        nextTick(() => renderMap(true));
      } catch (cause) {
        error.value = cause.message;
      } finally {
        running.value = false;
      }
    }

    async function saveAndRunTuning() {
      if (!selectedProfileId.value) return;
      running.value = true;
      error.value = "";
      notice.value = "シナリオを保存し、隔離環境で探索しています。";
      try {
        const suite = await persistSuite();
        const response = await executeTuning(suite.id);
        notice.value = `探索が完了しました（${response.trials.length}試行）。結果を地図と指標で確認してください。`;
        await refresh();
        nextTick(() => renderMap(true));
      } catch (cause) {
        error.value = cause.message;
      } finally {
        running.value = false;
      }
    }

    async function interpretFeedback() {
      if (!feedbackText.value.trim()) return;
      error.value = "";
      notice.value = "";
      try {
        interpretedFeedback.value = await apiPost("/api/tuning/feedback/interpret", {
          text: feedbackText.value
        });
        notice.value = "評価文から条件を抽出しました。内容を確認して選択中の予約へ反映できます。";
      } catch (cause) {
        error.value = cause.message;
      }
    }

    function applyFeedbackToSelectedBooking() {
      if (!interpretedFeedback.value?.expectations || !selectedBooking.value) return;
      selectedBooking.value.expectations = {
        ...(selectedBooking.value.expectations ?? {}),
        ...interpretedFeedback.value.expectations
      };
      notice.value = "抽出した期待条件を選択中の予約へ反映しました。";
    }

    function applyFeedbackToAllBookings() {
      if (!interpretedFeedback.value?.expectations) return;
      for (const scenario of scenarioDrafts.value) {
        for (const booking of scenario.bookings) {
          booking.expectations = {
            ...(booking.expectations ?? {}),
            ...interpretedFeedback.value.expectations
          };
        }
      }
      notice.value = `抽出した期待条件を${scenarioStats.value.bookings}件すべての予約へ反映しました。`;
    }

    async function approveRecommendation() {
      const recommendation = selectedRecommendation.value;
      if (!recommendation) return;
      error.value = "";
      try {
        const response = await apiPost(
          `/api/tuning/recommendations/${encodeURIComponent(recommendation.id)}/approve`,
          {
            force: forceApproval.value,
            activateAt: activateAt.value ? new Date(activateAt.value).toISOString() : null,
            actor: "tuning-web"
          }
        );
        if (response.status === "ACTIVE" && response.activeServiceProfileId) {
          selectedProfileId.value = response.activeServiceProfileId;
          activeProfileId.value = response.activeServiceProfileId;
        }
        await refresh();
        notice.value = response.status === "SCHEDULED"
          ? "新しいプロファイルの適用を予約しました。指定時刻までは現在の設定で再確認します。"
          : `新しいプロファイル「${response.activeServiceProfileId}」を有効化しました。次の再確認からこの設定を使用します。`;
      } catch (cause) {
        error.value = cause.message;
      }
    }

    async function rollback(version) {
      if (!window.confirm(`${version.profileId} へ戻しますか？`)) return;
      error.value = "";
      try {
        const response = await apiPost("/api/tuning/rollback", {
          versionId: version.id,
          actor: "tuning-web",
          reason: "管理画面からのロールバック"
        });
        if (response.activeServiceProfileId) {
          selectedProfileId.value = response.activeServiceProfileId;
          activeProfileId.value = response.activeServiceProfileId;
        }
        await refresh();
        notice.value = `${version.profileId} へロールバックしました。次の再確認からこの設定を使用します。`;
      } catch (cause) {
        error.value = cause.message;
      }
    }

    function metricLabel(metrics, key) {
      const value = Number(metrics?.[key] ?? 0);
      return Number.isFinite(value) ? value.toFixed(key.includes("Rate") ? 2 : 1) : "-";
    }

    function formatMetricCard(value, card) {
      const numeric = Number(value ?? 0);
      const formatted = card.integer ? Math.round(numeric) : numeric.toFixed(1);
      return `${formatted}${card.suffix ?? ""}`;
    }

    function metricTrendClass(card) {
      const baseline = Number(card.baseline ?? 0);
      const candidate = Number(card.candidate ?? 0);
      if (candidate < baseline) return "is-improved";
      if (candidate > baseline) return "is-worse";
      return "is-same";
    }

    function markerIcon(kind, number, selected) {
      return L.divIcon({
        className: "rt-map-marker-shell",
        html: `<span class="rt-map-marker is-${kind} ${selected ? "is-selected" : ""}"><b>${number}</b>${kind === "pickup" ? "乗" : "降"}</span>`,
        iconSize: [38, 38],
        iconAnchor: [19, 19]
      });
    }

    function initMap() {
      if (map || !window.L || !document.getElementById("tuning-map")) return;
      map = L.map("tuning-map", { zoomControl: true, preferCanvas: true });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors"
      }).addTo(map);
      stopLayer = L.layerGroup().addTo(map);
      bookingLayer = L.layerGroup().addTo(map);
      resultLayer = L.layerGroup().addTo(map);
      map.on("click", (event) => {
        if (mapPickMode.value) setBookingMapPoint(mapPickMode.value, event.latlng);
      });
      map.setView([32.991, 132.934], 13);
      mapReady.value = true;
    }

    function renderStops() {
      if (!stopLayer) return;
      stopLayer.clearLayers();
      for (const stop of stops.value) {
        if (!hasPoint(stop)) continue;
        const marker = L.circleMarker([Number(stop.lat), Number(stop.lng)], {
          radius: 3.5,
          color: "#475569",
          fillColor: "#ffffff",
          fillOpacity: 0.9,
          weight: 1.2,
          bubblingMouseEvents: false
        }).addTo(stopLayer);
        marker.bindTooltip(stop.name || stop.id, { direction: "top", offset: [0, -3] });
        marker.on("click", () => {
          if (mapPickMode.value === "pickup") {
            setBookingStop(selectedBooking.value, "pickup", stop.id);
          } else if (mapPickMode.value.startsWith("dropoff:")) {
            const groupId = mapPickMode.value.replace(/^dropoff:/, "");
            const group = dropoffGroups(selectedBooking.value).find((entry) => entry.id === groupId);
            setDropoffStop(selectedBooking.value, group, stop.id);
          }
        });
      }
    }

    function renderResultRoutes() {
      if (!resultLayer) return;
      resultLayer.clearLayers();
      const recommendation = selectedRecommendation.value;
      const scenario = selectedScenario.value;
      if (!scenario) return;
      const layers = [];
      if (previewIsCurrent.value) {
        layers.push({
          evaluation: scenarioPreview.value?.evaluation,
          color: "#0284c7",
          dashArray: null,
          label: "現在設定の配車ルート",
          weight: 6,
          opacity: 0.88
        });
      }
      if (recommendation) {
        layers.push(
          { evaluation: recommendation.baselineEvaluation, color: "#64748b", dashArray: "7 8", label: "変更前ルート", weight: 3, opacity: 0.55 },
          { evaluation: recommendation.candidateEvaluation, color: "#059669", dashArray: null, label: "候補ルート", weight: 5, opacity: 0.82 }
        );
      }
      for (const layer of layers) {
        const result = layer.evaluation?.scenarioResults?.find((entry) => entry.scenarioId === scenario.id);
        const routes = new Map();
        for (const outcome of result?.outcomes ?? []) {
          if (outcome.selectedVehicleId && outcome.routeAfter?.length) {
            routes.set(outcome.selectedVehicleId, outcome);
          }
        }
        for (const [vehicleId, outcome] of routes) {
          const points = [outcome.vehicleStartPoint, ...(outcome.routeAfter ?? []).map((task) => task.point)]
            .filter(hasPoint);
          if (points.length < 2) continue;
          L.polyline(points.map((point) => [Number(point.lat), Number(point.lng)]), {
            color: layer.color,
            weight: layer.weight,
            opacity: layer.opacity,
            dashArray: layer.dashArray
          }).bindTooltip(`${layer.label}: ${vehicleId}`).addTo(resultLayer);
        }
      }
    }

    function renderBookings(fit = false) {
      if (!bookingLayer) return;
      bookingLayer.clearLayers();
      const scenario = selectedScenario.value;
      if (!scenario) return;
      const bounds = [];
      scenario.bookings.forEach((booking, index) => {
        const pickup = locationPoint(booking.pickup);
        const groups = dropoffGroups(booking);
        const selected = booking.id === selectedBookingId.value;
        if (pickup) {
          bounds.push([pickup.lat, pickup.lng]);
          L.marker([pickup.lat, pickup.lng], { icon: markerIcon("pickup", booking.partySize, selected) })
            .bindPopup(`<strong>予約 ${index + 1}</strong><br>乗車: ${escapeHtml(locationLabel(booking.pickup))}<br><b>${booking.partySize}人が乗車</b>`)
            .on("click", () => selectBooking(booking))
            .addTo(bookingLayer);
        }
        groups.forEach((group, groupIndex) => {
          const dropoff = locationPoint(group.dropoff);
          if (!dropoff) return;
          bounds.push([dropoff.lat, dropoff.lng]);
          L.marker([dropoff.lat, dropoff.lng], { icon: markerIcon("dropoff", group.partySize, selected) })
            .bindPopup(`<strong>予約 ${index + 1}・降車 ${groupIndex + 1}</strong><br>${escapeHtml(locationLabel(group.dropoff))}<br><b>${group.partySize}人が降車</b>`)
            .on("click", () => selectBooking(booking))
            .addTo(bookingLayer);
          if (pickup) {
            L.polyline([[pickup.lat, pickup.lng], [dropoff.lat, dropoff.lng]], {
              color: selected ? "#2563eb" : "#94a3b8",
              weight: selected ? 4 : 2,
              opacity: selected ? 0.9 : 0.55,
              dashArray: groupIndex === 0 && selected ? null : "5 7"
            }).on("click", () => selectBooking(booking)).addTo(bookingLayer);
          }
        });
      });
      if (fit && bounds.length) map.fitBounds(bounds, { padding: [36, 36], maxZoom: 15 });
    }

    function renderMap(fit = false) {
      initMap();
      if (!map) return;
      renderStops();
      renderBookings(fit);
      renderResultRoutes();
      window.setTimeout(() => map?.invalidateSize(), 0);
    }

    watch(scenarioDrafts, () => {
      syncRawJson();
      nextTick(() => renderMap(false));
    }, { deep: true });
    watch([selectedScenarioId, selectedBookingId], () => nextTick(() => renderMap(false)));
    watch(selectedRecommendation, () => nextTick(() => renderMap(false)));
    watch([scenarioPreview, previewIsCurrent], () => nextTick(() => renderMap(false)));

    onMounted(async () => {
      await refresh();
      await nextTick();
      renderMap(true);
    });

    onBeforeUnmount(() => {
      if (map) {
        map.remove();
        map = null;
      }
    });

    return {
      loading, running, previewing, error, notice, profiles, activeProfileId, stops, suites, runs,
      recommendations, versions, selectedProfileId, selectedSuiteId,
      selectedRecommendationId, parameterSpace, maxTrials, seed, feedbackText,
      interpretedFeedback, suiteName, rawJsonText, activateAt, forceApproval,
      selectedRecommendation, selectedScenario, selectedBooking, selectedScenarioId,
      selectedBookingId, scenarioDrafts, scenarioStats, randomBookingCount,
      randomTrainRatio, randomTimeSpanMinutes, randomGenerationSeed, mapPickMode, mapPickInstruction, mapReady, expectationRows,
      scenarioPreview, previewIsCurrent, previewScenarioResult, previewMetrics,
      previewVehicleRoutes, previewViolations, selectedBookingPreviewOutcomes,
      selectedBookingPreviewSummary, resultMetricCards, unlockedCount, activeVersionId, journeyState,
      enabledParameterLabels, selectedBookingTargetLabel, selectedTuningPreset,
      feedbackExamples: FEEDBACK_EXAMPLES, tuningPresets: TUNING_PRESETS,
      refresh, loadParameterSpace,
      loadSelectedSuite, parameterMeta, toggleParameter, updateParameterRange,
      applyTuningPreset, useFeedbackExample, scrollToSection, generateQuickStartScenarios,
      generateRandomSuite, reproduceRandomSuite, selectScenario, selectBooking, addScenario, removeScenario,
      addBooking, duplicateBooking, removeBooking, locationLabel, locationStopValue,
      dropoffGroups, dropoffTotal, dropoffBalanceClass, bookingDropoffSummary, bookingFlowLabel,
      dropoffStopValue, setBookingStop, setDropoffStop, toggleMapPick, toggleDropoffMapPick,
      isDropoffMapPick, setPickupPartySize, setDropoffPartySize, canSplitDropoff,
      addDropoffGroup, removeDropoffGroup, balanceDropoffs, bookingDateTimeLocal,
      setBookingDateTime, syncRawJson, applyRawJson, previewCurrentRoutes,
      formatPreviewTime, previewTaskTypeLabel, previewTaskPassengerLabel,
      rejectionReasonTitle, rejectionReasonSummary, rejectionBreakdown,
      rejectionConstraintSummary, rejectionCountermeasures,
      saveSuite, runTuning,
      saveAndRunTuning, interpretFeedback, applyFeedbackToSelectedBooking,
      applyFeedbackToAllBookings,
      approveRecommendation, rollback, metricLabel, formatMetricCard,
      metricTrendClass, pretty
    };
  },
  template: `
    <v-app>
      <v-main class="rt-page">
        <header class="rt-header">
          <div>
            <a class="rt-back" href="/"><v-icon size="18">mdi-arrow-left</v-icon> 配車管理へ戻る</a>
            <h1><span>AI</span> 配車チューニング</h1>
            <p>地図で予約パターンを作り、同じ条件を繰り返し再生して配車ルールを調整します。</p>
          </div>
          <div class="rt-header-actions">
            <v-chip color="primary" variant="tonal">有効: {{ activeProfileId }}</v-chip>
            <v-btn prepend-icon="mdi-refresh" variant="outlined" :loading="loading" @click="refresh">更新</v-btn>
          </div>
        </header>

        <v-alert v-if="error" type="error" closable class="mb-4 rt-wide" @click:close="error=''">{{ error }}</v-alert>
        <v-alert v-if="notice" type="info" closable class="mb-4 rt-wide" @click:close="notice=''">{{ notice }}</v-alert>

        <section class="rt-onboarding rt-wide">
          <div class="rt-onboarding-head">
            <div><v-icon color="primary" size="30">mdi-map-marker-path</v-icon><span><strong>説明書なしで、4ステップで試せます</strong><small>ここではAIモデルを学習させません。予約を何度も再生して、配車設定の良い値を探します。</small></span></div>
            <v-btn color="primary" prepend-icon="mdi-dice-multiple" @click="generateQuickStartScenarios">まず8件を自動作成</v-btn>
          </div>
          <div class="rt-journey">
            <button type="button" :class="{ 'is-done': journeyState.scenario }" @click="scrollToSection('scenario-studio')">
              <b>1</b><span><strong>予約とルートを確認</strong><small>地図で作成・事前実行</small></span><v-icon>{{ journeyState.scenario ? 'mdi-check-circle' : 'mdi-chevron-right' }}</v-icon>
            </button>
            <button type="button" :class="{ 'is-done': journeyState.feedback }" @click="scrollToSection('ai-guidance')">
              <b>2</b><span><strong>良い配車を伝える</strong><small>普通の日本語でOK</small></span><v-icon>{{ journeyState.feedback ? 'mdi-check-circle' : 'mdi-chevron-right' }}</v-icon>
            </button>
            <button type="button" :class="{ 'is-done': journeyState.parameters }" @click="scrollToSection('tuning-policy')">
              <b>3</b><span><strong>調整方針を選ぶ</strong><small>迷ったら「おすすめ」</small></span><v-icon>{{ journeyState.parameters ? 'mdi-check-circle' : 'mdi-chevron-right' }}</v-icon>
            </button>
            <button type="button" :class="{ 'is-done': journeyState.tested }" @click="scrollToSection('tuning-policy')">
              <b>4</b><span><strong>テストする</strong><small>本番に影響しません</small></span><v-icon>{{ journeyState.tested ? 'mdi-check-circle' : 'mdi-chevron-right' }}</v-icon>
            </button>
          </div>
          <div class="rt-concepts">
            <div><v-icon color="primary">mdi-flask-outline</v-icon><span><strong>調整用ケース</strong><small>候補設定を比べるために繰り返し使う予約です。</small></span></div>
            <div><v-icon color="warning">mdi-shield-check-outline</v-icon><span><strong>安全確認用ケース</strong><small>最後だけ使い、別の予約でも悪化しないことを確認します。</small></span></div>
            <div><v-icon color="secondary">mdi-message-text-outline</v-icon><span><strong>AIへの希望</strong><small>「10分以内」など、何を良い配車とするかを伝えます。</small></span></div>
            <div><v-icon color="success">mdi-magnify-expand</v-icon><span><strong>探索</strong><small>安全範囲の値を何通りも試し、最も良い設定を探す処理です。</small></span></div>
          </div>
        </section>

        <section class="rt-summary rt-wide">
          <div><v-icon>mdi-map-marker-path</v-icon><span>シナリオ</span><strong>{{ scenarioStats.scenarios }}</strong></div>
          <div><v-icon>mdi-account-arrow-right</v-icon><span>予約</span><strong>{{ scenarioStats.bookings }}</strong></div>
          <div><v-icon color="primary">mdi-flask-outline</v-icon><span>調整用</span><strong>{{ scenarioStats.trainBookings }}</strong></div>
          <div><v-icon color="warning">mdi-shield-check</v-icon><span>安全確認用</span><strong>{{ scenarioStats.holdoutBookings }}</strong></div>
        </section>

        <v-card id="scenario-studio" class="rt-card mt-5 rt-anchor" rounded="xl">
          <v-card-title class="rt-card-heading">
            <div><span class="rt-step">1</span><span>予約を作り、現在の配車ルートを確認する<small>乗降地点を設定したら、AIへ希望を伝える前に現在の配車を再生</small></span></div>
            <v-btn color="primary" variant="tonal" prepend-icon="mdi-content-save" @click="saveSuite">シナリオ保存</v-btn>
          </v-card-title>
          <v-card-text>
            <div class="rt-generator">
              <v-text-field v-model="suiteName" label="シナリオセット名" hide-details />
              <v-text-field v-model.number="randomBookingCount" type="number" min="2" max="40" label="予約件数" hide-details />
              <v-text-field v-model.number="randomTrainRatio" type="number" min="50" max="90" suffix="%" label="調整用の割合" hide-details />
              <v-text-field v-model.number="randomTimeSpanMinutes" type="number" min="15" max="720" suffix="分" label="時間帯の幅" hide-details />
              <v-btn size="large" color="secondary" prepend-icon="mdi-dice-multiple" @click="generateRandomSuite()">ランダム生成</v-btn>
            </div>
            <div class="rt-generator-note">
              <span>クリックするたびに暗号学的乱数から新しい予約を作ります。生成後に地図上で自由に修正できます。</span>
              <template v-if="randomGenerationSeed">
                <v-chip size="x-small" variant="tonal">生成ID: {{ randomGenerationSeed }}</v-chip>
                <v-btn size="x-small" variant="text" prepend-icon="mdi-replay" @click="reproduceRandomSuite">同じパターンを再現</v-btn>
              </template>
            </div>

            <div class="rt-studio">
              <section class="rt-map-panel">
                <div class="rt-map-head">
                  <div>
                    <strong>{{ selectedScenario?.name || 'シナリオ未選択' }}</strong>
                    <span v-if="mapPickMode">地図をクリックして{{ mapPickInstruction }}地点を指定</span>
                    <span v-else>乗・降マーカー内の数字は、その地点で乗り降りする人数です</span>
                  </div>
                  <v-chip v-if="selectedScenario" size="small" :color="selectedScenario.partition === 'TRAIN' ? 'primary' : 'warning'">
                    {{ selectedScenario.partition === 'TRAIN' ? '調整用' : '安全確認用' }}
                  </v-chip>
                </div>
                <div id="tuning-map" :class="{ 'is-picking': mapPickMode }" aria-label="配車チューニング用地図"></div>
                <div class="rt-map-legend">
                  <span><i class="is-pickup"></i>乗車</span>
                  <span><i class="is-dropoff"></i>降車</span>
                  <span><i class="is-preview"></i>現在設定のルート</span>
                  <span><i class="is-baseline"></i>変更前ルート</span>
                  <span><i class="is-candidate"></i>候補ルート</span>
                </div>
              </section>

              <section class="rt-builder">
                <div class="rt-scenario-tabs">
                  <button v-for="scenario in scenarioDrafts" :key="scenario.id" type="button"
                    :class="{ 'is-active': scenario.id === selectedScenarioId }" @click="selectScenario(scenario)">
                    <span>{{ scenario.name }}</span><small>{{ scenario.partition === 'TRAIN' ? '調整用' : '安全確認' }} · {{ scenario.bookings.length }}件</small>
                  </button>
                  <v-menu>
                    <template #activator="{ props }"><v-btn v-bind="props" prepend-icon="mdi-plus" variant="tonal" size="small">ケース追加</v-btn></template>
                    <v-list density="compact">
                      <v-list-item title="調整用ケースを追加" subtitle="設定を探すために使う予約" @click="addScenario('TRAIN')" />
                      <v-list-item title="安全確認用ケースを追加" subtitle="別の予約でも悪化しないか確認" @click="addScenario('HOLDOUT')" />
                    </v-list>
                  </v-menu>
                </div>

                <template v-if="selectedScenario">
                  <div class="rt-scenario-settings">
                    <v-text-field v-model="selectedScenario.name" label="シナリオ名" density="compact" hide-details />
                    <v-select v-model="selectedScenario.partition" :items="[{title:'調整用（設定を探す）',value:'TRAIN'},{title:'安全確認用（悪化を防ぐ）',value:'HOLDOUT'}]" label="このケースの役割" density="compact" hide-details />
                    <v-btn icon="mdi-delete-outline" variant="text" color="error" :disabled="scenarioDrafts.length <= 1" @click="removeScenario" />
                  </div>

                  <div class="rt-booking-workspace">
                    <aside class="rt-booking-list">
                      <button v-for="(booking, index) in selectedScenario.bookings" :key="booking.id" type="button"
                        :class="{ 'is-active': booking.id === selectedBookingId }" @click="selectBooking(booking)">
                        <b>{{ index + 1 }}</b>
                        <span><strong>{{ locationLabel(booking.pickup) }}</strong><small>→ {{ bookingDropoffSummary(booking) }}</small></span>
                        <em>{{ bookingFlowLabel(booking) }}</em>
                      </button>
                      <v-btn block variant="tonal" prepend-icon="mdi-plus" @click="addBooking">予約を追加</v-btn>
                    </aside>

                    <div v-if="selectedBooking" class="rt-booking-editor">
                      <div class="rt-editor-head">
                        <div><strong>予約を編集</strong><small>{{ selectedBooking.id }}</small></div>
                        <div>
                          <v-btn icon="mdi-content-copy" size="small" variant="text" title="複製" @click="duplicateBooking" />
                          <v-btn icon="mdi-delete-outline" size="small" variant="text" color="error" title="削除" :disabled="selectedScenario.bookings.length <= 1" @click="removeBooking" />
                        </div>
                      </div>
                      <div class="rt-location-grid">
                        <div class="rt-location-card is-pickup">
                          <span class="rt-location-kicker">乗車地点</span>
                          <v-select :model-value="locationStopValue(selectedBooking, 'pickup')" :items="stops" item-title="name" item-value="id" label="停留所" density="compact" hide-details @update:model-value="setBookingStop(selectedBooking, 'pickup', $event)" />
                          <small>{{ locationLabel(selectedBooking.pickup) }}</small>
                          <v-text-field :model-value="selectedBooking.partySize" type="number" :min="dropoffGroups(selectedBooking).length" max="20" suffix="人" label="ここで乗る人数" density="compact" hide-details @update:model-value="setPickupPartySize(selectedBooking, $event)" />
                          <v-btn block size="small" :color="mapPickMode === 'pickup' ? 'primary' : undefined" variant="tonal" prepend-icon="mdi-map-marker-plus" @click="toggleMapPick('pickup')">
                            {{ mapPickMode === 'pickup' ? '地図をクリックしてください' : '地図から選ぶ' }}
                          </v-btn>
                        </div>
                        <div class="rt-flow-arrow"><v-icon>mdi-arrow-right</v-icon><small>同じ車両</small></div>
                        <div class="rt-dropoff-panel">
                          <div class="rt-dropoff-head">
                            <div><strong>降車先と人数</strong><small>途中で降りる人数ごとに分けます</small></div>
                            <v-btn size="small" color="secondary" variant="tonal" prepend-icon="mdi-call-split" :disabled="!canSplitDropoff(selectedBooking)" @click="addDropoffGroup(selectedBooking)">降車先を分ける</v-btn>
                          </div>
                          <div v-for="(group, groupIndex) in dropoffGroups(selectedBooking)" :key="group.id" class="rt-dropoff-row">
                            <span class="rt-dropoff-number">{{ groupIndex + 1 }}</span>
                            <div class="rt-dropoff-fields">
                              <v-select :model-value="dropoffStopValue(group)" :items="stops" item-title="name" item-value="id" :label="'降車先 ' + (groupIndex + 1)" density="compact" hide-details @update:model-value="setDropoffStop(selectedBooking, group, $event)" />
                              <v-text-field :model-value="group.partySize" type="number" min="1" max="20" suffix="人" label="降りる人数" density="compact" hide-details @update:model-value="setDropoffPartySize(group, $event)" />
                            </div>
                            <small>{{ locationLabel(group.dropoff) }}</small>
                            <div class="rt-dropoff-actions">
                              <v-btn size="small" :color="isDropoffMapPick(group) ? 'secondary' : undefined" variant="tonal" prepend-icon="mdi-map-marker-plus" @click="toggleDropoffMapPick(group)">
                                {{ isDropoffMapPick(group) ? '地図をクリック' : '地図から選ぶ' }}
                              </v-btn>
                              <v-btn icon="mdi-delete-outline" size="small" variant="text" color="error" title="この降車先を削除" :disabled="dropoffGroups(selectedBooking).length <= 1" @click="removeDropoffGroup(selectedBooking, group)" />
                            </div>
                          </div>
                          <div class="rt-passenger-balance" :class="dropoffBalanceClass(selectedBooking)">
                            <v-icon>{{ dropoffTotal(selectedBooking) === Number(selectedBooking.partySize) ? 'mdi-check-circle' : 'mdi-alert-circle' }}</v-icon>
                            <span><strong>乗車 {{ selectedBooking.partySize }}人</strong><small>降車合計 {{ dropoffTotal(selectedBooking) }}人</small></span>
                            <v-btn v-if="dropoffTotal(selectedBooking) !== Number(selectedBooking.partySize)" size="x-small" variant="text" @click="balanceDropoffs(selectedBooking)">人数を合わせる</v-btn>
                          </div>
                        </div>
                      </div>
                      <div class="rt-booking-fields">
                        <v-text-field :model-value="bookingDateTimeLocal(selectedBooking)" type="datetime-local" label="予約を投入する時刻" density="compact" hide-details @update:model-value="setBookingDateTime(selectedBooking, $event)" />
                        <v-text-field v-model.number="selectedBooking.expectations.maxPickupWaitMinutes" type="number" min="0" max="60" suffix="分" label="期待する最大待ち時間" density="compact" hide-details />
                        <v-switch v-model="selectedBooking.expectations.mustAssign" color="success" label="必ず配車できること" density="compact" hide-details />
                      </div>
                    </div>
                  </div>
                </template>
              </section>
            </div>

            <section id="route-preview" class="rt-route-preview" :class="{ 'is-ready': previewIsCurrent }">
              <div class="rt-route-preview-head">
                <div>
                  <v-icon color="primary" size="30">mdi-bus-clock</v-icon>
                  <span>
                    <strong>現在の設定では、どう配車されるか？</strong>
                    <small>現在有効な配車設定で全シナリオを1回再生します。本番データは変更しません。</small>
                  </span>
                </div>
                <div class="rt-route-preview-actions">
                  <v-chip v-if="previewIsCurrent" size="small" color="primary" variant="tonal">使用設定: {{ scenarioPreview.profileId }}</v-chip>
                  <v-btn size="large" color="primary" prepend-icon="mdi-play-circle-outline" :loading="previewing" @click="previewCurrentRoutes">
                    {{ previewIsCurrent ? '現在の設定でもう一度確認' : '現在の設定で配車を確認' }}
                  </v-btn>
                </div>
              </div>

              <div v-if="!scenarioPreview" class="rt-preview-empty">
                <v-icon size="42" color="primary">mdi-map-search-outline</v-icon>
                <span><strong>まず、作成した予約を現在の設定で走らせます</strong><small>バス、ルート、乗降順、予定時刻、待ち時間を確認した後に、改善したい点をAIへ伝えます。</small></span>
              </div>

              <v-alert v-else-if="!previewIsCurrent" type="warning" variant="tonal" density="compact" class="mt-3">
                予約内容または配車プロファイルが変更されています。AIへ進む前に、現在の設定でもう一度確認してください。
              </v-alert>

              <template v-else>
                <div class="rt-preview-metrics">
                  <div><span>配車できたグループ</span><strong>{{ previewMetrics?.assignedBookings || 0 }} / {{ previewMetrics?.totalBookings || 0 }}</strong></div>
                  <div><span>最大待ち時間</span><strong>{{ Number(previewMetrics?.maxPickupWaitMinutes || 0).toFixed(1) }}分</strong></div>
                  <div :class="{ 'has-problem': previewMetrics?.hardViolationCount }"><span>条件違反</span><strong>{{ previewMetrics?.hardViolationCount || 0 }}件</strong></div>
                  <div :class="{ 'has-problem': previewMetrics?.rejectedBookings }"><span>配車不能</span><strong>{{ previewMetrics?.rejectedBookings || 0 }}件</strong></div>
                </div>

                <div class="rt-selected-preview">
                  <v-icon color="secondary">mdi-account-search-outline</v-icon>
                  <span><small>選択中の予約</small><strong>{{ selectedBookingPreviewSummary }}</strong></span>
                </div>

                <div v-if="previewVehicleRoutes.length" class="rt-preview-routes">
                  <article v-for="route in previewVehicleRoutes" :key="route.vehicleId">
                    <header>
                      <span><v-icon color="primary">mdi-bus</v-icon><strong>{{ route.vehicleId }}</strong></span>
                      <v-chip size="x-small" variant="tonal">{{ route.selectedAlgorithm }}</v-chip>
                    </header>
                    <div class="rt-route-timeline">
                      <div class="rt-route-task is-start">
                        <b><v-icon size="16">mdi-bus-marker</v-icon></b>
                        <span><strong>バス現在地から出発</strong><small>選択された車両の出発地点</small></span>
                        <em>開始</em>
                      </div>
                      <div v-for="(task, taskIndex) in route.tasks" :key="task.requestId + '-' + task.type + '-' + taskIndex" class="rt-route-task" :class="task.type === 'PICKUP' ? 'is-pickup' : 'is-dropoff'">
                        <b>{{ taskIndex + 1 }}</b>
                        <span><strong>{{ previewTaskTypeLabel(task) }} · {{ task.locationLabel || '地点未設定' }}</strong><small>{{ task.requestLabel || task.requestId }} <template v-if="previewTaskPassengerLabel(task)">/ {{ previewTaskPassengerLabel(task) }}</template></small></span>
                        <em>{{ formatPreviewTime(task.etaAt, task.etaMinutes) }}</em>
                      </div>
                    </div>
                  </article>
                </div>

                <v-alert v-else type="error" variant="tonal" density="compact" class="mt-3">
                  選択中のシナリオでは配車ルートを作れませんでした。下の配車結果と条件違反を確認してください。
                </v-alert>

                <div class="rt-preview-outcomes">
                  <div v-for="outcome in previewScenarioResult?.outcomes || []" :key="outcome.bookingId" :class="outcome.status === 'ASSIGNED' ? 'is-assigned' : 'is-rejected'">
                    <span><strong>{{ outcome.status === 'ASSIGNED' ? '配車済み' : '配車不能' }}</strong><small>{{ outcome.parentBookingId || outcome.bookingId }} · {{ outcome.partySize || '-' }}人</small></span>
                    <span><small>車両</small><strong>{{ outcome.selectedVehicleId || '-' }}</strong></span>
                    <span><small>乗車予定</small><strong>{{ formatPreviewTime(outcome.plannedPickupAt) }}</strong></span>
                    <span><small>降車予定</small><strong>{{ formatPreviewTime(outcome.plannedDropoffAt) }}</strong></span>
                    <span><small>待ち時間</small><strong>{{ Number(outcome.metrics?.pickupWaitMinutes || 0).toFixed(1) }}分</strong></span>
                    <div v-if="outcome.status !== 'ASSIGNED'" class="rt-outcome-rejection">
                      <div class="rt-outcome-rejection-head">
                        <v-icon color="error">mdi-alert-circle</v-icon>
                        <span><small>配車不能の主な原因</small><strong>{{ rejectionReasonTitle(outcome) }}</strong></span>
                      </div>
                      <p>{{ rejectionReasonSummary(outcome) }}</p>
                      <div v-if="rejectionBreakdown(outcome).length" class="rt-rejection-breakdown">
                        <span v-for="item in rejectionBreakdown(outcome)" :key="item.code">
                          <b>{{ item.label }}</b><small>{{ item.count }}候補<template v-if="item.ratioPercent !== null">（{{ item.ratioPercent }}%）</template></small>
                        </span>
                      </div>
                      <small v-if="rejectionConstraintSummary(outcome)" class="rt-rejection-constraints">判定条件: {{ rejectionConstraintSummary(outcome) }}</small>
                      <div v-if="rejectionCountermeasures(outcome).length" class="rt-rejection-countermeasures">
                        <strong>改善するには</strong>
                        <ul><li v-for="item in rejectionCountermeasures(outcome)" :key="item">{{ item }}</li></ul>
                      </div>
                    </div>
                  </div>
                </div>

                <div v-if="previewViolations.length" class="rt-preview-violations">
                  <strong><v-icon size="20">mdi-alert-circle-outline</v-icon> 現在の配車で改善が必要な点</strong>
                  <div v-for="(violation, violationIndex) in previewViolations" :key="violation.code + violationIndex">
                    <b>{{ violation.code }}</b><span>{{ violation.message }}</span>
                  </div>
                </div>

                <div class="rt-preview-next">
                  <span><strong>このルートを見て、何を変えたいですか？</strong><small>例: 「2人を降ろしてから残り2人を迎えに戻らず、4人を一度に乗せたい」</small></span>
                  <v-btn color="secondary" size="large" append-icon="mdi-arrow-down" @click="scrollToSection('ai-guidance')">改善希望をAIに伝える</v-btn>
                </div>
              </template>
            </section>

            <v-expansion-panels class="mt-4" variant="accordion">
              <v-expansion-panel>
                <v-expansion-panel-title><v-icon class="mr-2">mdi-code-json</v-icon>上級者向け: シナリオJSONを確認・編集</v-expansion-panel-title>
                <v-expansion-panel-text>
                  <v-textarea v-model="rawJsonText" rows="12" class="rt-mono" />
                  <v-btn variant="tonal" prepend-icon="mdi-import" @click="applyRawJson">JSONを地図へ反映</v-btn>
                </v-expansion-panel-text>
              </v-expansion-panel>
            </v-expansion-panels>
          </v-card-text>
        </v-card>

        <v-card id="ai-guidance" class="rt-card mt-5 rt-anchor rt-ai-card" rounded="xl">
          <v-card-title class="rt-card-heading">
            <div><span class="rt-step">2</span><span>運行担当者の希望をAIに伝える<small>パラメータ名ではなく「どんな配車なら良いか」を普通の日本語で入力</small></span></div>
            <v-chip size="small" color="secondary" variant="tonal">入力は選択中の1予約へ反映</v-chip>
          </v-card-title>
          <v-card-text>
            <v-alert v-if="!previewIsCurrent" type="warning" variant="tonal" density="comfortable" class="mb-4">
              <strong>先に現在の配車ルートを確認してください。</strong> 予約を変更した場合も再確認が必要です。
              <template #append><v-btn variant="text" color="warning" @click="scrollToSection('route-preview')">ルート確認へ戻る</v-btn></template>
            </v-alert>
            <v-alert v-else type="success" variant="tonal" density="compact" class="mb-4">
              現在のルートを確認済みです。選択中の予約は「{{ selectedBookingPreviewSummary }}」です。この結果の改善点を入力してください。
            </v-alert>
            <div class="rt-ai-layout">
              <section class="rt-ai-input">
                <div class="rt-ai-help">
                  <v-icon color="secondary">mdi-lightbulb-on-outline</v-icon>
                  <span><strong>何を書けばよいですか？</strong><small>時間の上限、優先したい順番、希望車両などを書いてください。AIが評価できる条件に変換します。</small></span>
                </div>
                <div class="rt-example-prompts">
                  <button v-for="example in feedbackExamples" :key="example" type="button" @click="useFeedbackExample(example)">{{ example }}</button>
                </div>
                <v-textarea v-model="feedbackText" class="rt-ai-textarea" label="この予約で期待する配車結果" placeholder="例: 待ち時間は10分以内。新しい乗車より、乗車中のお客様の降車を先にしたい" rows="7" auto-grow />
                <div class="rt-ai-target">
                  <span><small>反映先の予約</small><strong>{{ selectedBookingTargetLabel }}</strong></span>
                  <v-btn size="large" color="secondary" prepend-icon="mdi-creation" :disabled="!feedbackText || !previewIsCurrent" @click="interpretFeedback">AIで条件に変換</v-btn>
                </div>
              </section>

              <section class="rt-ai-result" :class="{ 'has-result': interpretedFeedback }">
                <template v-if="interpretedFeedback">
                  <div class="rt-ai-result-head">
                    <span><v-icon color="success">mdi-check-decagram</v-icon><strong>AIが読み取った条件</strong></span>
                    <v-chip size="small" :color="interpretedFeedback.source === 'GEMINI' ? 'success' : 'warning'">{{ interpretedFeedback.source }}</v-chip>
                  </div>
                  <p>{{ interpretedFeedback.summary }}</p>
                  <div class="rt-expectations">
                    <div v-for="row in expectationRows" :key="row.key"><span>{{ row.label }}</span><strong>{{ row.value }}</strong></div>
                  </div>
                  <v-alert v-if="interpretedFeedback?.warnings?.length" type="warning" variant="tonal" density="compact" class="mt-3">{{ interpretedFeedback.warnings.join(' / ') }}</v-alert>
                  <div class="rt-ai-apply-actions mt-4">
                    <v-btn size="large" color="success" prepend-icon="mdi-check" :disabled="!selectedBooking" @click="applyFeedbackToSelectedBooking">この予約へ反映</v-btn>
                    <v-btn size="large" variant="tonal" color="success" prepend-icon="mdi-check-all" :disabled="!scenarioStats.bookings" @click="applyFeedbackToAllBookings">全{{ scenarioStats.bookings }}件へ反映</v-btn>
                  </div>
                  <small class="rt-ai-safety">AIの抽出結果を確認してから反映するため、意図しない条件が自動適用されることはありません。</small>
                </template>
                <template v-else>
                  <div class="rt-ai-empty">
                    <v-icon size="54" color="secondary">mdi-message-processing-outline</v-icon>
                    <strong>ここに変換結果が表示されます</strong>
                    <span>左の例文を押すだけでも試せます。AIへの希望は、パラメータの値ではなくテストの合格条件になります。</span>
                  </div>
                </template>
              </section>
            </div>
          </v-card-text>
        </v-card>

        <v-card id="tuning-policy" class="rt-card mt-5 rt-anchor" rounded="xl">
          <v-card-title class="rt-card-heading">
            <div><span class="rt-step">3</span><span>調整方針を選ぶ<small>探索とは、安全な範囲で設定を何通りも試すことです</small></span></div>
            <v-chip color="primary" variant="tonal">{{ unlockedCount }}項目を自動調整</v-chip>
          </v-card-title>
          <v-card-text>
            <v-alert type="info" variant="tonal" class="rt-policy-explanation">
              <strong>迷ったら「おすすめ」のままで構いません。</strong> 調整用ケースで良い値を探し、安全確認用ケースで別の予約にも悪影響がないかを確認します。
            </v-alert>
            <div class="rt-presets">
              <button v-for="preset in tuningPresets" :key="preset.id" type="button" :class="{ 'is-active': selectedTuningPreset === preset.id }" @click="applyTuningPreset(preset.id)">
                <v-icon>{{ preset.icon }}</v-icon>
                <span><small>{{ preset.subtitle }}</small><strong>{{ preset.title }}</strong><em>{{ preset.description }}</em></span>
                <v-icon class="rt-preset-check">{{ selectedTuningPreset === preset.id ? 'mdi-check-circle' : 'mdi-circle-outline' }}</v-icon>
              </button>
            </div>
            <div class="rt-enabled-parameters">
              <span>このテストでAIが動かす項目</span>
              <div><v-chip v-for="label in enabledParameterLabels" :key="label" size="small" color="primary" variant="tonal">{{ label }}</v-chip></div>
            </div>

            <v-expansion-panels class="mt-4" variant="accordion">
              <v-expansion-panel>
                <v-expansion-panel-title><v-icon class="mr-2">mdi-tune-variant</v-icon>詳細設定（必要な場合だけ開く）</v-expansion-panel-title>
                <v-expansion-panel-text>
                  <div class="rt-parameters">
                    <article v-for="parameter in parameterSpace" :key="parameter.path" class="rt-parameter" :class="{ 'is-enabled': !parameter.locked, 'is-constraint': parameter.policyConstraint }">
                      <div class="rt-parameter-title">
                        <v-icon :color="!parameter.locked ? 'primary' : undefined">{{ parameterMeta(parameter).icon }}</v-icon>
                        <div><strong>{{ parameterMeta(parameter).label }}</strong><small>{{ parameterMeta(parameter).description }}</small></div>
                        <v-switch :model-value="!parameter.locked" color="success" label="AI調整" hide-details density="compact" @update:model-value="toggleParameter(parameter, $event)" />
                      </div>
                      <div class="rt-current-value"><span>現在値</span><strong>{{ parameter.current ?? '-' }}</strong></div>
                      <template v-if="parameter.type !== 'categorical'">
                        <v-range-slider :model-value="[Number(parameter.min), Number(parameter.max)]" :min="parameter._safeMin" :max="parameter._safeMax" :step="parameter.step" :disabled="parameter.locked" color="primary" thumb-label="always" hide-details @update:model-value="updateParameterRange(parameter, $event)" />
                        <div class="rt-range-label"><span>安全下限 {{ parameter._safeMin }}</span><span>探索範囲 {{ parameter.min }}〜{{ parameter.max }}</span><span>安全上限 {{ parameter._safeMax }}</span></div>
                      </template>
                      <v-select v-else v-model="parameter.values" :items="['INSERTION','HIGHS']" multiple :disabled="parameter.locked" label="探索候補" density="compact" hide-details />
                      <div class="rt-parameter-tags">
                        <v-chip v-if="parameter.policyConstraint" size="x-small" color="warning">運行制約</v-chip>
                        <v-chip v-if="parameter.calibrationOnly" size="x-small">実績で校正</v-chip>
                        <code>{{ parameter.path }}</code>
                      </div>
                    </article>
                  </div>
                </v-expansion-panel-text>
              </v-expansion-panel>
              <v-expansion-panel>
                <v-expansion-panel-title><v-icon class="mr-2">mdi-cog-outline</v-icon>過去のテスト・試行回数・再現設定</v-expansion-panel-title>
                <v-expansion-panel-text>
                  <div class="rt-saved-suite">
                    <v-select v-model="selectedSuiteId" :items="suites" item-title="name" item-value="id" label="保存済みテスト" hide-details />
                    <v-btn variant="tonal" prepend-icon="mdi-folder-open" :disabled="!selectedSuiteId" @click="loadSelectedSuite">地図へ読込</v-btn>
                  </div>
                  <div class="rt-run-controls mt-4">
                    <v-select v-model="selectedProfileId" :items="profiles" item-title="name" item-value="id" label="現在の配車設定" @update:model-value="loadParameterSpace" />
                    <v-text-field v-model.number="maxTrials" type="number" min="1" max="100" label="試す設定の数" />
                    <v-text-field v-model="seed" label="同じ探索を再現するID" />
                  </div>
                </v-expansion-panel-text>
              </v-expansion-panel>
            </v-expansion-panels>

            <div class="rt-run-action">
              <span class="rt-run-step">4</span>
              <div><strong>この条件でテストを実行</strong><span>{{ scenarioStats.bookings }}件の予約で最大{{ maxTrials }}通りを比較します。実運行の予約や車両は変更しません。</span></div>
              <v-btn size="x-large" color="primary" prepend-icon="mdi-play-circle" :loading="running" :disabled="!scenarioStats.bookings || !unlockedCount" @click="saveAndRunTuning">テストを開始</v-btn>
            </div>
          </v-card-text>
        </v-card>

        <v-card v-if="selectedRecommendation" class="rt-card mt-5" rounded="xl">
          <v-card-title class="rt-card-heading">
            <div><span class="rt-step">5</span><span>改善結果を比較<small>小さい値ほど良い指標です</small></span></div>
            <v-select v-model="selectedRecommendationId" :items="recommendations" item-title="id" item-value="id" label="結果を選択" density="compact" hide-details class="rt-result-select" />
          </v-card-title>
          <v-card-text>
            <div class="rt-status-row">
              <v-chip :color="selectedRecommendation.eligibility?.eligible ? 'success' : 'warning'">
                {{ selectedRecommendation.eligibility?.eligible ? '安全確認に合格' : '追加確認が必要' }}
              </v-chip>
              <strong>{{ selectedRecommendation.explanation?.headline }}</strong>
            </div>
            <div class="rt-comparison">
              <article v-for="card in resultMetricCards" :key="card.key" :class="metricTrendClass(card)">
                <span>{{ card.label }}</span>
                <div><small>変更前</small><strong>{{ formatMetricCard(card.baseline, card) }}</strong></div>
                <v-icon>mdi-arrow-right</v-icon>
                <div><small>候補</small><strong>{{ formatMetricCard(card.candidate, card) }}</strong></div>
              </article>
            </div>
            <v-alert type="info" variant="tonal" class="mt-4">
              <ul><li v-for="point in selectedRecommendation.explanation?.points ?? []" :key="point">{{ point }}</li></ul>
            </v-alert>
            <v-table density="compact" class="mt-4 rt-diff-table">
              <thead><tr><th>調整項目</th><th>変更前</th><th></th><th>変更後</th></tr></thead>
              <tbody><tr v-for="diff in selectedRecommendation.parameterDiff" :key="diff.path"><td><strong>{{ parameterMeta(diff.path).label }}</strong><small>{{ diff.path }}</small></td><td>{{ diff.before }}</td><td><v-icon size="18">mdi-arrow-right</v-icon></td><td>{{ diff.after }}</td></tr></tbody>
            </v-table>
            <v-alert v-for="warning in selectedRecommendation.eligibility?.warnings ?? []" :key="warning" type="warning" variant="tonal" density="compact" class="mt-2">{{ warning }}</v-alert>
            <div class="rt-approval mt-4">
              <v-text-field v-model="activateAt" type="datetime-local" label="適用日時（空欄は即時）" hide-details />
              <v-checkbox v-model="forceApproval" label="安全確認未合格でも強制承認" hide-details />
              <v-btn color="success" prepend-icon="mdi-check-decagram" :disabled="!selectedRecommendation.parameterDiff?.length" @click="approveRecommendation">承認して適用</v-btn>
            </div>
          </v-card-text>
        </v-card>

        <v-card class="rt-card mt-5" rounded="xl">
          <v-card-title><span class="rt-step">6</span> バージョンとロールバック</v-card-title>
          <v-card-text>
            <v-table density="compact">
              <thead><tr><th>状態</th><th>プロファイル</th><th>作成日時</th><th></th></tr></thead>
              <tbody>
                <tr v-for="version in versions" :key="version.id">
                  <td><v-chip size="small" :color="version.status === 'ACTIVE' ? 'success' : undefined">{{ version.status }}</v-chip></td>
                  <td>{{ version.profileId }}</td><td>{{ version.createdAt }}</td>
                  <td><v-btn size="small" variant="text" color="warning" :disabled="version.status !== 'ARCHIVED' || version.id === activeVersionId" @click="rollback(version)">この版へ戻す</v-btn></td>
                </tr>
              </tbody>
            </v-table>
          </v-card-text>
        </v-card>
      </v-main>
    </v-app>
  `
}).use(vuetify).mount("#app");
