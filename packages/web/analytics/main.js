const { createApp, ref, computed, onMounted, onBeforeUnmount, watch } = Vue;
const { createVuetify } = Vuetify;

const vuetify = createVuetify({
  theme: {
    defaultTheme: "analytics",
    themes: {
      analytics: {
        dark: false,
        colors: {
          primary: "#0ea5e9",
          secondary: "#8b5cf6",
          success: "#10b981",
          warning: "#f59e0b",
          background: "#fafbfc",
          surface: "#ffffff"
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

const FISCAL_YEAR_START_MONTH_INDEX = 3;
const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const intFormatter = new Intl.NumberFormat("ja-JP");
const decimalFormatter = new Intl.NumberFormat("ja-JP", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1
});
const percentFormatter = new Intl.NumberFormat("ja-JP", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1
});
const dateTimeFormatter = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});

async function apiGet(path) {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status}`);
  }
  return response.json();
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toTimestamp(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  const timestamp = date.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function hasPoint(point) {
  return Boolean(point) && Number.isFinite(point.lat) && Number.isFinite(point.lng);
}

function resolvePoint(location, stopMap) {
  if (!location) {
    return null;
  }
  if (hasPoint(location.resolvedPoint)) {
    return location.resolvedPoint;
  }
  if (location.stopId && stopMap.has(location.stopId)) {
    const stop = stopMap.get(location.stopId);
    return hasPoint(stop) ? { lat: stop.lat, lng: stop.lng } : null;
  }
  if (hasPoint(location.point)) {
    return location.point;
  }
  return null;
}

function toRadians(value) {
  return (Number(value) * Math.PI) / 180;
}

function haversineKm(start, end) {
  if (!hasPoint(start) || !hasPoint(end)) {
    return null;
  }
  const earthRadiusKm = 6371;
  const dLat = toRadians(end.lat - start.lat);
  const dLng = toRadians(end.lng - start.lng);
  const lat1 = toRadians(start.lat);
  const lat2 = toRadians(end.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const a = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

function firstFinite(...values) {
  for (const value of values) {
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function normalizeStatus(value) {
  if (typeof value !== "string") {
    return "UNKNOWN";
  }
  const normalized = value.trim().toUpperCase();
  return normalized || "UNKNOWN";
}

function resolveFiscalYear(timestampMs) {
  if (!Number.isFinite(timestampMs)) {
    return null;
  }
  const date = new Date(timestampMs);
  const year = date.getFullYear();
  return date.getMonth() >= FISCAL_YEAR_START_MONTH_INDEX ? year : year - 1;
}

function formatFiscalYearLabel(year) {
  if (!Number.isFinite(year)) {
    return "年度不明";
  }
  return `${year}年度`;
}

function formatYearMonthLabel(key) {
  if (typeof key !== "string") {
    return "-";
  }
  const [year, month] = key.split("-");
  if (!year || !month) {
    return key;
  }
  return `${year}/${month}`;
}

function normalizePhone(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/[\s()\-]/g, "");
}

function resolveUserProfile(request) {
  const passenger = request?.passenger ?? {};
  const phoneRaw =
    passenger.phoneNumber ?? passenger.phone ?? passenger.tel ?? request?.callerE164 ?? null;
  const phone = normalizePhone(phoneRaw);
  if (phone) {
    return {
      key: `phone:${phone}`,
      label: phone,
      phone,
      isPhoneBased: true
    };
  }

  const requesterId =
    typeof request?.requesterId === "string" && request.requesterId.trim()
      ? request.requesterId.trim()
      : null;
  if (requesterId) {
    return {
      key: `requester:${requesterId}`,
      label: `ID:${requesterId}`,
      phone: null,
      isPhoneBased: false
    };
  }

  const passengerName =
    typeof passenger.name === "string" && passenger.name.trim() ? passenger.name.trim() : null;
  if (passengerName) {
    return {
      key: `name:${passengerName}`,
      label: passengerName,
      phone: null,
      isPhoneBased: false
    };
  }

  return {
    key: "unknown-user",
    label: "電話番号不明",
    phone: null,
    isPhoneBased: false
  };
}

function resolveStopInfo(location, stopMap, kind) {
  if (!location) {
    return {
      key: `${kind}:unknown`,
      label: "不明地点"
    };
  }

  if (location.stopId && stopMap.has(location.stopId)) {
    const stop = stopMap.get(location.stopId);
    return {
      key: `stop:${stop.id}`,
      label: stop.name || stop.id
    };
  }

  const title = typeof location.title === "string" ? location.title.trim() : "";
  if (title) {
    return {
      key: `title:${title}`,
      label: title
    };
  }

  const point = resolvePoint(location, stopMap);
  if (hasPoint(point)) {
    return {
      key: `point:${point.lat.toFixed(4)},${point.lng.toFixed(4)}`,
      label: `座標(${point.lat.toFixed(3)}, ${point.lng.toFixed(3)})`
    };
  }

  return {
    key: `${kind}:unknown`,
    label: "不明地点"
  };
}

function buildNormalizedRequest(request, stopMap) {
  const assignment = request?.assignment ?? {};
  const status = normalizeStatus(request?.status);

  const createdAtMs = toTimestamp(request?.createdAt);
  const plannedPickupAtMs = toTimestamp(assignment?.plannedPickupAt);
  const actualPickupAtMs = toTimestamp(assignment?.actualPickupAt);
  const plannedDropoffAtMs = toTimestamp(assignment?.plannedDropoffAt);
  const actualDropoffAtMs = toTimestamp(assignment?.actualDropoffAt);
  const desiredDropoffAtMs = toTimestamp(request?.timeWindow?.desiredDropoffAt);

  const pickupTimeMs = firstFinite(actualPickupAtMs, plannedPickupAtMs, desiredDropoffAtMs, createdAtMs);
  const referenceTimeMs = firstFinite(
    pickupTimeMs,
    actualDropoffAtMs,
    plannedDropoffAtMs,
    toTimestamp(request?.updatedAt)
  );

  const pickupPoint = resolvePoint(request?.pickup, stopMap);
  const dropoffPoint = resolvePoint(request?.dropoff, stopMap);
  const directDistanceKm = haversineKm(pickupPoint, dropoffPoint);

  const waitMinutesRaw =
    Number.isFinite(createdAtMs) && Number.isFinite(firstFinite(actualPickupAtMs, plannedPickupAtMs))
      ? (firstFinite(actualPickupAtMs, plannedPickupAtMs) - createdAtMs) / (60 * 1000)
      : null;
  const waitMinutes =
    Number.isFinite(waitMinutesRaw) && waitMinutesRaw >= 0 && waitMinutesRaw <= 24 * 60
      ? waitMinutesRaw
      : null;

  const pickupDeltaMinutes =
    Number.isFinite(actualPickupAtMs) && Number.isFinite(plannedPickupAtMs)
      ? (actualPickupAtMs - plannedPickupAtMs) / (60 * 1000)
      : null;
  const dropoffDeltaMinutes =
    Number.isFinite(actualDropoffAtMs) && Number.isFinite(plannedDropoffAtMs)
      ? (actualDropoffAtMs - plannedDropoffAtMs) / (60 * 1000)
      : null;
  const desiredDropoffDeltaMinutes =
    Number.isFinite(plannedDropoffAtMs) && Number.isFinite(desiredDropoffAtMs)
      ? (plannedDropoffAtMs - desiredDropoffAtMs) / (60 * 1000)
      : null;

  const scheduleDeltaMinutes = firstFinite(
    dropoffDeltaMinutes,
    pickupDeltaMinutes,
    desiredDropoffDeltaMinutes
  );

  const scheduleDeltaAbsMinutes = Number.isFinite(scheduleDeltaMinutes)
    ? Math.abs(scheduleDeltaMinutes)
    : null;

  const user = resolveUserProfile(request);
  const pickupStop = resolveStopInfo(request?.pickup, stopMap, "pickup");
  const dropoffStop = resolveStopInfo(request?.dropoff, stopMap, "dropoff");

  const accepted = status !== "REJECTED";
  const cancelled = status === "CANCELLED";
  const completed = status === "COMPLETED" || Number.isFinite(actualDropoffAtMs);

  return {
    id: request?.id ?? "unknown",
    status,
    channel: request?.channel ?? "UNKNOWN",
    user,
    pickupStop,
    dropoffStop,
    directDistanceKm: Number.isFinite(directDistanceKm) ? directDistanceKm : 0,
    waitMinutes,
    scheduleDeltaAbsMinutes,
    scheduleDeltaMinutes,
    pickupTimeMs,
    referenceTimeMs,
    fiscalYear: resolveFiscalYear(referenceTimeMs),
    accepted,
    cancelled,
    completed
  };
}

function buildNormalizedCall(callEvent) {
  const receivedAtMs = firstFinite(toTimestamp(callEvent?.receivedAt), toTimestamp(callEvent?.ringAt));
  return {
    id: callEvent?.id ?? "unknown",
    status: normalizeStatus(callEvent?.status),
    fiscalYear: resolveFiscalYear(receivedAtMs)
  };
}

function buildAnalyticsView({ requests, calls, selectedYear }) {
  const fiscalYearSet = new Set();
  requests.forEach((request) => {
    if (Number.isFinite(request.fiscalYear)) {
      fiscalYearSet.add(request.fiscalYear);
    }
  });
  calls.forEach((call) => {
    if (Number.isFinite(call.fiscalYear)) {
      fiscalYearSet.add(call.fiscalYear);
    }
  });

  const allFiscalYears = Array.from(fiscalYearSet.values()).sort((left, right) => right - left);
  const selectedYearValue = selectedYear === "ALL" ? "ALL" : Number(selectedYear);

  const scopedRequests =
    selectedYearValue === "ALL"
      ? requests
      : requests.filter((request) => request.fiscalYear === selectedYearValue);
  const scopedCalls =
    selectedYearValue === "ALL" ? calls : calls.filter((call) => call.fiscalYear === selectedYearValue);

  const callYearCounts = new Map();
  calls.forEach((call) => {
    if (!Number.isFinite(call.fiscalYear)) {
      return;
    }
    callYearCounts.set(call.fiscalYear, (callYearCounts.get(call.fiscalYear) ?? 0) + 1);
  });

  const yearlyMap = new Map();
  requests.forEach((request) => {
    if (!Number.isFinite(request.fiscalYear)) {
      return;
    }
    if (!yearlyMap.has(request.fiscalYear)) {
      yearlyMap.set(request.fiscalYear, {
        year: request.fiscalYear,
        label: formatFiscalYearLabel(request.fiscalYear),
        requestCount: 0,
        acceptedCount: 0,
        completedCount: 0,
        rejectedCount: 0,
        cancelledCount: 0,
        distanceKm: 0,
        waitSum: 0,
        waitCount: 0,
        deltaSum: 0,
        deltaCount: 0,
        users: new Set(),
        phoneUsers: new Set()
      });
    }

    const bucket = yearlyMap.get(request.fiscalYear);
    bucket.requestCount += 1;
    bucket.acceptedCount += request.accepted ? 1 : 0;
    bucket.completedCount += request.completed ? 1 : 0;
    bucket.rejectedCount += request.status === "REJECTED" ? 1 : 0;
    bucket.cancelledCount += request.cancelled ? 1 : 0;

    if (request.accepted && Number.isFinite(request.directDistanceKm) && request.directDistanceKm > 0) {
      bucket.distanceKm += request.directDistanceKm;
    }
    if (Number.isFinite(request.waitMinutes)) {
      bucket.waitSum += request.waitMinutes;
      bucket.waitCount += 1;
    }
    if (Number.isFinite(request.scheduleDeltaAbsMinutes)) {
      bucket.deltaSum += request.scheduleDeltaAbsMinutes;
      bucket.deltaCount += 1;
    }

    bucket.users.add(request.user.key);
    if (request.user.isPhoneBased) {
      bucket.phoneUsers.add(request.user.key);
    }
  });

  const yearlyRows = Array.from(yearlyMap.values())
    .sort((left, right) => right.year - left.year)
    .map((row) => ({
      ...row,
      avgWaitMinutes: row.waitCount ? row.waitSum / row.waitCount : null,
      avgDeltaMinutes: row.deltaCount ? row.deltaSum / row.deltaCount : null,
      completionRate: row.acceptedCount ? (row.completedCount / row.acceptedCount) * 100 : null,
      uniqueUsers: row.users.size,
      uniquePhoneUsers: row.phoneUsers.size,
      callCount: callYearCounts.get(row.year) ?? 0
    }));

  const maxYearlyRequestCount = yearlyRows.reduce(
    (maximum, row) => Math.max(maximum, row.requestCount),
    0
  );

  const monthlyMap = new Map();
  scopedRequests.forEach((request) => {
    if (!Number.isFinite(request.pickupTimeMs)) {
      return;
    }
    const date = new Date(request.pickupTimeMs);
    const key = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
    if (!monthlyMap.has(key)) {
      monthlyMap.set(key, {
        key,
        requestCount: 0,
        distanceKm: 0
      });
    }
    const bucket = monthlyMap.get(key);
    bucket.requestCount += 1;
    if (request.accepted && Number.isFinite(request.directDistanceKm) && request.directDistanceKm > 0) {
      bucket.distanceKm += request.directDistanceKm;
    }
  });

  const monthlyRows = Array.from(monthlyMap.values())
    .sort((left, right) => left.key.localeCompare(right.key))
    .slice(-18)
    .map((row) => ({
      ...row,
      label: formatYearMonthLabel(row.key)
    }));
  const maxMonthlyRequestCount = monthlyRows.reduce(
    (maximum, row) => Math.max(maximum, row.requestCount),
    0
  );

  const weekdayBuckets = WEEKDAY_LABELS.map((label, index) => ({
    weekday: index,
    label: `${label}曜日`,
    requestCount: 0,
    distanceKm: 0,
    waitSum: 0,
    waitCount: 0,
    users: new Set()
  }));

  const hourlyBuckets = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    hourLabel: `${pad2(hour)}時`,
    requestCount: 0,
    users: new Set()
  }));

  const heatmapMatrix = WEEKDAY_LABELS.map(() => Array.from({ length: 24 }, () => 0));

  scopedRequests.forEach((request) => {
    if (!Number.isFinite(request.pickupTimeMs)) {
      return;
    }
    const date = new Date(request.pickupTimeMs);
    const weekday = date.getDay();
    const hour = date.getHours();

    const weekdayBucket = weekdayBuckets[weekday];
    weekdayBucket.requestCount += 1;
    weekdayBucket.users.add(request.user.key);
    if (request.accepted && Number.isFinite(request.directDistanceKm) && request.directDistanceKm > 0) {
      weekdayBucket.distanceKm += request.directDistanceKm;
    }
    if (Number.isFinite(request.waitMinutes)) {
      weekdayBucket.waitSum += request.waitMinutes;
      weekdayBucket.waitCount += 1;
    }

    const hourlyBucket = hourlyBuckets[hour];
    hourlyBucket.requestCount += 1;
    hourlyBucket.users.add(request.user.key);

    heatmapMatrix[weekday][hour] += 1;
  });

  const scopedRequestCount = scopedRequests.length;
  const weekdayRows = weekdayBuckets.map((bucket) => ({
    ...bucket,
    sharePercent: scopedRequestCount ? (bucket.requestCount / scopedRequestCount) * 100 : 0,
    avgWaitMinutes: bucket.waitCount ? bucket.waitSum / bucket.waitCount : null,
    uniqueUsers: bucket.users.size
  }));
  const maxWeekdayCount = weekdayRows.reduce(
    (maximum, row) => Math.max(maximum, row.requestCount),
    0
  );

  const hourlyRows = hourlyBuckets.map((bucket) => ({
    ...bucket,
    uniqueUsers: bucket.users.size
  }));
  const maxHourlyCount = hourlyRows.reduce((maximum, row) => Math.max(maximum, row.requestCount), 0);

  const heatmapRows = heatmapMatrix.map((hours, weekday) => ({
    weekday,
    weekdayLabel: WEEKDAY_LABELS[weekday],
    cells: hours.map((count, hour) => ({ hour, count }))
  }));
  const maxHeatmapCount = heatmapMatrix.reduce(
    (maximum, row) => Math.max(maximum, ...row),
    0
  );

  const statusMap = new Map();
  scopedRequests.forEach((request) => {
    statusMap.set(request.status, (statusMap.get(request.status) ?? 0) + 1);
  });
  const statusRows = Array.from(statusMap.entries())
    .map(([status, count]) => ({
      status,
      count,
      sharePercent: scopedRequestCount ? (count / scopedRequestCount) * 100 : 0
    }))
    .sort((left, right) => right.count - left.count);

  const callStatusMap = new Map();
  scopedCalls.forEach((call) => {
    callStatusMap.set(call.status, (callStatusMap.get(call.status) ?? 0) + 1);
  });
  const callStatusRows = Array.from(callStatusMap.entries())
    .map(([status, count]) => ({
      status,
      count,
      sharePercent: scopedCalls.length ? (count / scopedCalls.length) * 100 : 0
    }))
    .sort((left, right) => right.count - left.count);

  const userMap = new Map();
  scopedRequests.forEach((request) => {
    if (!request.accepted) {
      return;
    }
    const key = request.user.key;
    if (!userMap.has(key)) {
      userMap.set(key, {
        key,
        label: request.user.label,
        phone: request.user.phone,
        isPhoneBased: request.user.isPhoneBased,
        rideCount: 0,
        completedCount: 0,
        cancelledCount: 0,
        distanceKm: 0,
        waitSum: 0,
        waitCount: 0,
        deltaSum: 0,
        deltaCount: 0,
        weekdayCounts: Array.from({ length: 7 }, () => 0),
        hourlyCounts: Array.from({ length: 24 }, () => 0),
        lastRideMs: null
      });
    }

    const bucket = userMap.get(key);
    bucket.rideCount += 1;
    bucket.completedCount += request.completed ? 1 : 0;
    bucket.cancelledCount += request.cancelled ? 1 : 0;

    if (Number.isFinite(request.directDistanceKm) && request.directDistanceKm > 0) {
      bucket.distanceKm += request.directDistanceKm;
    }
    if (Number.isFinite(request.waitMinutes)) {
      bucket.waitSum += request.waitMinutes;
      bucket.waitCount += 1;
    }
    if (Number.isFinite(request.scheduleDeltaAbsMinutes)) {
      bucket.deltaSum += request.scheduleDeltaAbsMinutes;
      bucket.deltaCount += 1;
    }
    if (Number.isFinite(request.pickupTimeMs)) {
      const date = new Date(request.pickupTimeMs);
      bucket.weekdayCounts[date.getDay()] += 1;
      bucket.hourlyCounts[date.getHours()] += 1;
      bucket.lastRideMs = Math.max(bucket.lastRideMs ?? 0, request.pickupTimeMs);
    }
  });

  const userRows = Array.from(userMap.values())
    .map((row) => {
      const maxWeekdayCountForRow = Math.max(...row.weekdayCounts);
      const maxHourlyCountForRow = Math.max(...row.hourlyCounts);
      const favoriteWeekdayIndex = row.weekdayCounts.findIndex(
        (count) => count === maxWeekdayCountForRow
      );
      const favoriteHourIndex = row.hourlyCounts.findIndex((count) => count === maxHourlyCountForRow);

      return {
        ...row,
        avgWaitMinutes: row.waitCount ? row.waitSum / row.waitCount : null,
        avgDistanceKm: row.rideCount ? row.distanceKm / row.rideCount : null,
        avgDeltaMinutes: row.deltaCount ? row.deltaSum / row.deltaCount : null,
        completionRate: row.rideCount ? (row.completedCount / row.rideCount) * 100 : null,
        favoriteWeekday:
          favoriteWeekdayIndex >= 0 && maxWeekdayCountForRow > 0
            ? `${WEEKDAY_LABELS[favoriteWeekdayIndex]}曜日`
            : "-",
        favoriteHour:
          favoriteHourIndex >= 0 && maxHourlyCountForRow > 0 ? `${pad2(favoriteHourIndex)}時` : "-"
      };
    })
    .sort((left, right) => {
      if (right.rideCount !== left.rideCount) {
        return right.rideCount - left.rideCount;
      }
      return (right.lastRideMs ?? 0) - (left.lastRideMs ?? 0);
    });

  const topUserRows = userRows.slice(0, 30);

  const stopMap = new Map();
  scopedRequests.forEach((request) => {
    if (!request.accepted) {
      return;
    }

    const stopPairs = [
      [request.pickupStop, "pickup"],
      [request.dropoffStop, "dropoff"]
    ];

    stopPairs.forEach(([stop, kind]) => {
      if (!stopMap.has(stop.key)) {
        stopMap.set(stop.key, {
          key: stop.key,
          label: stop.label,
          pickupCount: 0,
          dropoffCount: 0,
          users: new Set(),
          requestIds: new Set(),
          cancelledCount: 0,
          waitSum: 0,
          waitCount: 0,
          distanceSum: 0,
          distanceCount: 0
        });
      }

      const bucket = stopMap.get(stop.key);
      if (kind === "pickup") {
        bucket.pickupCount += 1;
      } else {
        bucket.dropoffCount += 1;
      }
      bucket.users.add(request.user.key);
      bucket.requestIds.add(request.id);
      if (request.cancelled) {
        bucket.cancelledCount += 1;
      }
      if (kind === "pickup" && Number.isFinite(request.waitMinutes)) {
        bucket.waitSum += request.waitMinutes;
        bucket.waitCount += 1;
      }
      if (Number.isFinite(request.directDistanceKm) && request.directDistanceKm > 0) {
        bucket.distanceSum += request.directDistanceKm;
        bucket.distanceCount += 1;
      }
    });
  });

  const stopRows = Array.from(stopMap.values())
    .map((row) => {
      const uniqueRequestCount = row.requestIds.size;
      const totalMovement = row.pickupCount + row.dropoffCount;
      return {
        ...row,
        totalMovement,
        uniqueUsers: row.users.size,
        uniqueRequestCount,
        avgWaitMinutes: row.waitCount ? row.waitSum / row.waitCount : null,
        avgDistanceKm: row.distanceCount ? row.distanceSum / row.distanceCount : null,
        cancellationRate: uniqueRequestCount ? (row.cancelledCount / uniqueRequestCount) * 100 : null
      };
    })
    .sort((left, right) => {
      if (right.totalMovement !== left.totalMovement) {
        return right.totalMovement - left.totalMovement;
      }
      return right.uniqueRequestCount - left.uniqueRequestCount;
    });

  const stopOnlyRows = stopRows.filter(
    (row) => typeof row.key === "string" && row.key.startsWith("stop:")
  );
  const topStops = stopOnlyRows.slice(0, 6);

  const acceptedScopedRequests = scopedRequests.filter((request) => request.accepted);
  const scopedUsers = new Set(acceptedScopedRequests.map((request) => request.user.key));
  const scopedPhoneUsers = new Set(
    acceptedScopedRequests.filter((request) => request.user.isPhoneBased).map((request) => request.user.key)
  );

  let totalDistanceKm = 0;
  let distanceCount = 0;
  let waitSum = 0;
  let waitCount = 0;
  let deltaSum = 0;
  let deltaCount = 0;
  let onTimeCount = 0;
  let completedCount = 0;

  acceptedScopedRequests.forEach((request) => {
    if (Number.isFinite(request.directDistanceKm) && request.directDistanceKm > 0) {
      totalDistanceKm += request.directDistanceKm;
      distanceCount += 1;
    }
    if (Number.isFinite(request.waitMinutes)) {
      waitSum += request.waitMinutes;
      waitCount += 1;
    }
    if (Number.isFinite(request.scheduleDeltaAbsMinutes)) {
      deltaSum += request.scheduleDeltaAbsMinutes;
      deltaCount += 1;
      if (request.scheduleDeltaAbsMinutes <= 10) {
        onTimeCount += 1;
      }
    }
    if (request.completed) {
      completedCount += 1;
    }
  });

  const busiestHour = hourlyRows.reduce(
    (current, row) => (row.requestCount > current.requestCount ? row : current),
    { hourLabel: "-", requestCount: 0 }
  );
  const busiestStop = stopOnlyRows[0] ?? null;

  const receivedCalls = scopedCalls.filter((call) => call.status === "RECEIVED").length;

  return {
    allFiscalYears,
    selectedYearValue,
    selectedYearLabel:
      selectedYearValue === "ALL" ? "全年度" : formatFiscalYearLabel(selectedYearValue),
    scopedRequestCount,
    scopedCallCount: scopedCalls.length,
    yearlyRows,
    maxYearlyRequestCount,
    monthlyRows,
    maxMonthlyRequestCount,
    weekdayRows,
    maxWeekdayCount,
    hourlyRows,
    maxHourlyCount,
    heatmapRows,
    maxHeatmapCount,
    statusRows,
    callStatusRows,
    userRows,
    topUserRows,
    topStops,
    stopRows,
    stopOnlyRows,
    kpis: {
      requestCount: scopedRequestCount,
      uniqueUsers: scopedUsers.size,
      phoneUsers: scopedPhoneUsers.size,
      totalDistanceKm,
      avgDistanceKm: distanceCount ? totalDistanceKm / distanceCount : null,
      avgWaitMinutes: waitCount ? waitSum / waitCount : null,
      avgDeltaMinutes: deltaCount ? deltaSum / deltaCount : null,
      completionRate: acceptedScopedRequests.length
        ? (completedCount / acceptedScopedRequests.length) * 100
        : null,
      onTimeRate: deltaCount ? (onTimeCount / deltaCount) * 100 : null,
      busiestHourLabel: busiestHour.hourLabel,
      busiestHourCount: busiestHour.requestCount,
      busiestStopLabel: busiestStop?.label ?? "バス停データなし",
      busiestStopMovement: busiestStop?.totalMovement ?? 0,
      callCount: scopedCalls.length,
      callReceivedRate: scopedCalls.length ? (receivedCalls / scopedCalls.length) * 100 : null
    }
  };
}

function formatInt(value, fallback = "-") {
  return Number.isFinite(value) ? intFormatter.format(Math.round(value)) : fallback;
}

function formatDecimal(value, fallback = "-") {
  return Number.isFinite(value) ? decimalFormatter.format(value) : fallback;
}

function formatPercent(value, fallback = "-") {
  return Number.isFinite(value) ? `${percentFormatter.format(value)}%` : fallback;
}

function formatKm(value, fallback = "-") {
  return Number.isFinite(value) ? `${decimalFormatter.format(value)} km` : fallback;
}

function formatMinutes(value, fallback = "-") {
  return Number.isFinite(value) ? `${decimalFormatter.format(value)} 分` : fallback;
}

const CHART_COLORS = [
  "#0ea5e9",
  "#8b5cf6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#06b6d4",
  "#a855f7",
  "#14b8a6"
];

const InteractiveChart = {
  name: "InteractiveChart",
  props: {
    config: {
      type: Object,
      required: true
    },
    height: {
      type: Number,
      default: 320
    }
  },
  setup(props) {
    const canvasEl = ref(null);
    let chart = null;

    function renderChart() {
      if (!canvasEl.value || !window.Chart || !props.config) {
        return;
      }
      const context = canvasEl.value.getContext("2d");
      if (!context) {
        return;
      }
      if (chart) {
        chart.destroy();
      }
      chart = new window.Chart(context, props.config);
    }

    onMounted(() => {
      renderChart();
    });

    watch(
      () => props.config,
      () => {
        renderChart();
      },
      { deep: true }
    );

    onBeforeUnmount(() => {
      if (chart) {
        chart.destroy();
        chart = null;
      }
    });

    return {
      canvasEl
    };
  },
  template: `
<div class="ra-chart-shell" :style="{ height: height + 'px' }">
  <canvas ref="canvasEl"></canvas>
</div>
  `
};

createApp({
  components: {
    InteractiveChart
  },
  setup() {
    const loading = ref(false);
    const errorMessage = ref("");
    const selectedYear = ref("ALL");
    const lastUpdatedAt = ref(null);

    const rideRequests = ref([]);
    const stops = ref([]);
    const callEvents = ref([]);
    const vehicles = ref([]);

    const stopIndex = computed(() => new Map(stops.value.map((stop) => [stop.id, stop])));

    const normalizedRequests = computed(() =>
      rideRequests.value.map((request) => buildNormalizedRequest(request, stopIndex.value))
    );
    const normalizedCalls = computed(() => callEvents.value.map((call) => buildNormalizedCall(call)));

    const analytics = computed(() =>
      buildAnalyticsView({
        requests: normalizedRequests.value,
        calls: normalizedCalls.value,
        selectedYear: selectedYear.value
      })
    );

    const yearOptions = computed(() => [
      { title: "全年度", value: "ALL" },
      ...analytics.value.allFiscalYears.map((year) => ({
        title: formatFiscalYearLabel(year),
        value: String(year)
      }))
    ]);

    watch(
      yearOptions,
      (options) => {
        const exists = options.some((option) => option.value === selectedYear.value);
        if (!exists) {
          selectedYear.value = "ALL";
        }
      },
      { deep: true }
    );

    const formattedLastUpdatedAt = computed(() =>
      lastUpdatedAt.value ? dateTimeFormatter.format(lastUpdatedAt.value) : "-"
    );

    const kpiCards = computed(() => {
      const scopedVehicleCount = Array.isArray(vehicles.value) ? vehicles.value.length : 0;
      return [
        {
          title: "予約件数",
          value: formatInt(analytics.value.kpis.requestCount),
          sub: `${analytics.value.selectedYearLabel} / 総リクエスト`
        },
        {
          title: "利用者数",
          value: formatInt(analytics.value.kpis.uniqueUsers),
          sub: `電話番号ベース ${formatInt(analytics.value.kpis.phoneUsers)} 人`
        },
        {
          title: "平均待ち時間",
          value: formatMinutes(analytics.value.kpis.avgWaitMinutes),
          sub: "予約作成から乗車予定/実績まで"
        },
        {
          title: "平均移動距離",
          value: formatKm(analytics.value.kpis.avgDistanceKm),
          sub: "乗車地点-降車地点の直線距離換算"
        },
        {
          title: "予定との差分",
          value: formatMinutes(analytics.value.kpis.avgDeltaMinutes),
          sub: `時間内到着率 ${formatPercent(analytics.value.kpis.onTimeRate)}`
        },
        {
          title: "完了率",
          value: formatPercent(analytics.value.kpis.completionRate),
          sub: `総移動距離 ${formatKm(analytics.value.kpis.totalDistanceKm)}`
        },
        {
          title: "最混雑時間",
          value: analytics.value.kpis.busiestHourLabel,
          sub: `${formatInt(analytics.value.kpis.busiestHourCount)} 件 / 保有車両 ${formatInt(scopedVehicleCount)} 台`
        },
        {
          title: "利用最多バス停",
          value: analytics.value.kpis.busiestStopLabel,
          sub: `出発/到着 合計 ${formatInt(analytics.value.kpis.busiestStopMovement)} 回`
        }
      ];
    });

    async function refresh() {
      loading.value = true;
      errorMessage.value = "";
      try {
        const [requestResponse, stopResponse, callResponse, vehicleResponse] = await Promise.all([
          apiGet("/api/ride-requests"),
          apiGet("/api/stops"),
          apiGet("/api/call-events"),
          apiGet("/api/vehicles")
        ]);

        rideRequests.value = Array.isArray(requestResponse.data) ? requestResponse.data : [];
        stops.value = Array.isArray(stopResponse.data) ? stopResponse.data : [];
        callEvents.value = Array.isArray(callResponse.data) ? callResponse.data : [];
        vehicles.value = Array.isArray(vehicleResponse.data) ? vehicleResponse.data : [];
        lastUpdatedAt.value = new Date();
      } catch (error) {
        errorMessage.value = error instanceof Error ? error.message : "分析データの取得に失敗しました。";
      } finally {
        loading.value = false;
      }
    }

    function trimLabel(value, maxLength = 14) {
      const text = typeof value === "string" ? value : "";
      return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
    }

    function chartIntegerTick(value) {
      return formatInt(Number(value));
    }

    const hasStatusData = computed(() => analytics.value.statusRows.some((row) => row.count > 0));
    const hasCallStatusData = computed(() =>
      analytics.value.callStatusRows.some((row) => row.count > 0)
    );

    const yearlyOverviewChartConfig = computed(() => ({
      type: "bar",
      data: {
        labels: analytics.value.yearlyRows.map((row) => row.label),
        datasets: [
          {
            type: "bar",
            label: "利用件数",
            data: analytics.value.yearlyRows.map((row) => row.requestCount),
            yAxisID: "yRequests",
            backgroundColor: "rgba(14, 165, 233, 0.68)",
            borderColor: "rgba(2, 132, 199, 0.95)",
            borderWidth: 1,
            borderRadius: 8,
            barPercentage: 0.68,
            categoryPercentage: 0.74
          },
          {
            type: "line",
            label: "完了率",
            data: analytics.value.yearlyRows.map((row) =>
              Number.isFinite(row.completionRate) ? row.completionRate : null
            ),
            yAxisID: "yRate",
            borderColor: "rgba(139, 92, 246, 0.95)",
            backgroundColor: "rgba(139, 92, 246, 0.2)",
            pointBackgroundColor: "#ffffff",
            pointBorderColor: "rgba(139, 92, 246, 0.95)",
            pointRadius: 3,
            pointHoverRadius: 5,
            tension: 0.28
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: "index",
          intersect: false
        },
        animation: {
          duration: 420,
          easing: "easeOutQuart"
        },
        plugins: {
          legend: {
            position: "top",
            labels: {
              usePointStyle: true,
              boxWidth: 10
            }
          },
          tooltip: {
            callbacks: {
              label(context) {
                if (context.dataset.yAxisID === "yRate") {
                  return `${context.dataset.label} ${formatPercent(context.parsed.y)}`;
                }
                return `${context.dataset.label} ${formatInt(context.parsed.y)}件`;
              }
            }
          }
        },
        scales: {
          yRequests: {
            beginAtZero: true,
            position: "left",
            ticks: {
              callback: chartIntegerTick
            },
            title: {
              display: true,
              text: "件数"
            }
          },
          yRate: {
            beginAtZero: true,
            max: 100,
            position: "right",
            grid: {
              drawOnChartArea: false
            },
            ticks: {
              callback: (value) => `${value}%`
            },
            title: {
              display: true,
              text: "完了率"
            }
          }
        },
        onClick(_event, activeElements) {
          if (!activeElements?.length) {
            return;
          }
          const row = analytics.value.yearlyRows[activeElements[0].index];
          if (!row?.year) {
            return;
          }
          selectedYear.value = String(row.year);
        }
      }
    }));

    const monthlyTrendChartConfig = computed(() => ({
      type: "line",
      data: {
        labels: analytics.value.monthlyRows.map((row) => row.label),
        datasets: [
          {
            label: "利用件数",
            data: analytics.value.monthlyRows.map((row) => row.requestCount),
            yAxisID: "yRequests",
            borderColor: "rgba(14, 165, 233, 0.95)",
            backgroundColor: "rgba(14, 165, 233, 0.14)",
            fill: true,
            tension: 0.32,
            pointRadius: 3,
            pointHoverRadius: 5
          },
          {
            type: "bar",
            label: "移動距離(km)",
            data: analytics.value.monthlyRows.map((row) => Number(row.distanceKm.toFixed(2))),
            yAxisID: "yDistance",
            backgroundColor: "rgba(16, 185, 129, 0.46)",
            borderColor: "rgba(5, 150, 105, 0.9)",
            borderWidth: 1,
            borderRadius: 6
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: "index",
          intersect: false
        },
        plugins: {
          legend: {
            position: "top",
            labels: {
              usePointStyle: true,
              boxWidth: 10
            }
          },
          tooltip: {
            callbacks: {
              label(context) {
                if (context.dataset.yAxisID === "yDistance") {
                  return `${context.dataset.label} ${formatKm(context.parsed.y)}`;
                }
                return `${context.dataset.label} ${formatInt(context.parsed.y)}件`;
              }
            }
          }
        },
        scales: {
          yRequests: {
            beginAtZero: true,
            position: "left",
            ticks: {
              callback: chartIntegerTick
            },
            title: {
              display: true,
              text: "件数"
            }
          },
          yDistance: {
            beginAtZero: true,
            position: "right",
            grid: {
              drawOnChartArea: false
            },
            ticks: {
              callback: (value) => `${value}km`
            },
            title: {
              display: true,
              text: "距離"
            }
          }
        }
      }
    }));

    const weekdayUsageChartConfig = computed(() => ({
      type: "bar",
      data: {
        labels: analytics.value.weekdayRows.map((row) => row.label),
        datasets: [
          {
            type: "bar",
            label: "利用件数",
            data: analytics.value.weekdayRows.map((row) => row.requestCount),
            yAxisID: "yRequests",
            backgroundColor: "rgba(14, 165, 233, 0.68)",
            borderColor: "rgba(2, 132, 199, 0.95)",
            borderWidth: 1,
            borderRadius: 8
          },
          {
            type: "line",
            label: "平均待ち時間",
            data: analytics.value.weekdayRows.map((row) =>
              Number.isFinite(row.avgWaitMinutes) ? row.avgWaitMinutes : null
            ),
            yAxisID: "yMinutes",
            borderColor: "rgba(249, 115, 22, 0.95)",
            backgroundColor: "rgba(249, 115, 22, 0.18)",
            pointBackgroundColor: "#ffffff",
            pointBorderColor: "rgba(249, 115, 22, 0.95)",
            pointRadius: 3,
            pointHoverRadius: 5,
            tension: 0.24
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: "index",
          intersect: false
        },
        plugins: {
          legend: {
            position: "top",
            labels: {
              usePointStyle: true,
              boxWidth: 10
            }
          },
          tooltip: {
            callbacks: {
              label(context) {
                if (context.dataset.yAxisID === "yMinutes") {
                  return `${context.dataset.label} ${formatMinutes(context.parsed.y)}`;
                }
                return `${context.dataset.label} ${formatInt(context.parsed.y)}件`;
              }
            }
          }
        },
        scales: {
          yRequests: {
            beginAtZero: true,
            position: "left",
            ticks: {
              callback: chartIntegerTick
            }
          },
          yMinutes: {
            beginAtZero: true,
            position: "right",
            grid: {
              drawOnChartArea: false
            },
            ticks: {
              callback: (value) => `${value}分`
            }
          }
        }
      }
    }));

    const hourlyUsageChartConfig = computed(() => ({
      type: "line",
      data: {
        labels: analytics.value.hourlyRows.map((row) => row.hourLabel),
        datasets: [
          {
            label: "利用件数",
            data: analytics.value.hourlyRows.map((row) => row.requestCount),
            yAxisID: "yRequests",
            borderColor: "rgba(139, 92, 246, 0.95)",
            backgroundColor: "rgba(139, 92, 246, 0.18)",
            fill: true,
            tension: 0.3,
            pointRadius: 2.5,
            pointHoverRadius: 5
          },
          {
            type: "bar",
            label: "利用者数",
            data: analytics.value.hourlyRows.map((row) => row.uniqueUsers),
            yAxisID: "yUsers",
            backgroundColor: "rgba(14, 165, 233, 0.26)",
            borderColor: "rgba(14, 165, 233, 0.85)",
            borderWidth: 1,
            borderRadius: 4
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: "index",
          intersect: false
        },
        plugins: {
          legend: {
            position: "top",
            labels: {
              usePointStyle: true,
              boxWidth: 10
            }
          },
          tooltip: {
            callbacks: {
              label(context) {
                return `${context.dataset.label} ${formatInt(context.parsed.y)}`;
              }
            }
          }
        },
        scales: {
          x: {
            ticks: {
              callback(value, index) {
                return index % 2 === 0 ? this.getLabelForValue(value) : "";
              }
            }
          },
          yRequests: {
            beginAtZero: true,
            position: "left",
            ticks: {
              callback: chartIntegerTick
            }
          },
          yUsers: {
            beginAtZero: true,
            position: "right",
            grid: {
              drawOnChartArea: false
            },
            ticks: {
              callback: chartIntegerTick
            }
          }
        }
      }
    }));

    const heatmapBubbleChartConfig = computed(() => {
      const maxCount = Math.max(analytics.value.maxHeatmapCount, 1);
      const points = analytics.value.heatmapRows.flatMap((row) =>
        row.cells
          .filter((cell) => cell.count > 0)
          .map((cell) => ({
            x: cell.hour,
            y: row.weekday,
            r: 5 + (cell.count / maxCount) * 14,
            count: cell.count
          }))
      );

      return {
        type: "bubble",
        data: {
          datasets: [
            {
              label: "利用密度",
              data: points,
              borderColor: "rgba(14, 165, 233, 0.92)",
              borderWidth: 1.2,
              backgroundColor(context) {
                const raw = context.raw ?? {};
                const ratio = clamp((raw.count ?? 0) / maxCount, 0, 1);
                const alpha = 0.18 + ratio * 0.7;
                return `rgba(14, 165, 233, ${alpha.toFixed(3)})`;
              },
              hoverBackgroundColor: "rgba(249, 115, 22, 0.8)"
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: false
            },
            tooltip: {
              callbacks: {
                title(items) {
                  const first = items?.[0];
                  const x = first?.raw?.x ?? 0;
                  const y = first?.raw?.y ?? 0;
                  return `${WEEKDAY_LABELS[y] ?? "-"}曜日 ${pad2(x)}時台`;
                },
                label(context) {
                  return `利用件数 ${formatInt(context.raw?.count ?? 0)}件`;
                }
              }
            }
          },
          scales: {
            x: {
              min: -0.5,
              max: 23.5,
              ticks: {
                stepSize: 1,
                callback(value) {
                  return Number(value) % 3 === 0 ? `${pad2(Number(value))}時` : "";
                }
              },
              title: {
                display: true,
                text: "時間帯"
              }
            },
            y: {
              min: -0.5,
              max: 6.5,
              reverse: true,
              ticks: {
                stepSize: 1,
                callback(value) {
                  return `${WEEKDAY_LABELS[Number(value)] ?? ""}曜`;
                }
              },
              title: {
                display: true,
                text: "曜日"
              }
            }
          }
        }
      };
    });

    const statusDoughnutChartConfig = computed(() => ({
      type: "doughnut",
      data: {
        labels: analytics.value.statusRows.map((row) => row.status),
        datasets: [
          {
            label: "予約ステータス",
            data: analytics.value.statusRows.map((row) => row.count),
            backgroundColor: analytics.value.statusRows.map(
              (_row, index) => CHART_COLORS[index % CHART_COLORS.length]
            ),
            borderWidth: 2,
            borderColor: "#ffffff",
            hoverOffset: 8
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "58%",
        plugins: {
          legend: {
            position: "right",
            labels: {
              usePointStyle: true,
              boxWidth: 10
            }
          },
          tooltip: {
            callbacks: {
              label(context) {
                const value = context.parsed ?? 0;
                const total = context.dataset.data.reduce((sum, current) => sum + current, 0);
                const ratio = total ? (value / total) * 100 : 0;
                return `${context.label}: ${formatInt(value)}件 (${formatPercent(ratio)})`;
              }
            }
          }
        }
      }
    }));

    const callStatusDoughnutChartConfig = computed(() => ({
      type: "doughnut",
      data: {
        labels: analytics.value.callStatusRows.map((row) => row.status),
        datasets: [
          {
            label: "電話ステータス",
            data: analytics.value.callStatusRows.map((row) => row.count),
            backgroundColor: analytics.value.callStatusRows.map(
              (_row, index) => CHART_COLORS[(index + 2) % CHART_COLORS.length]
            ),
            borderWidth: 2,
            borderColor: "#ffffff",
            hoverOffset: 8
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "58%",
        plugins: {
          legend: {
            position: "right",
            labels: {
              usePointStyle: true,
              boxWidth: 10
            }
          },
          tooltip: {
            callbacks: {
              label(context) {
                const value = context.parsed ?? 0;
                const total = context.dataset.data.reduce((sum, current) => sum + current, 0);
                const ratio = total ? (value / total) * 100 : 0;
                return `${context.label}: ${formatInt(value)}件 (${formatPercent(ratio)})`;
              }
            }
          }
        }
      }
    }));

    const stopUsageChartConfig = computed(() => {
      const rows = analytics.value.stopOnlyRows.slice(0, 10);
      return {
        type: "bar",
        data: {
          labels: rows.map((row) => trimLabel(row.label)),
          datasets: [
            {
              label: "乗車",
              data: rows.map((row) => row.pickupCount),
              backgroundColor: "rgba(14, 165, 233, 0.64)",
              borderColor: "rgba(2, 132, 199, 0.95)",
              borderWidth: 1,
              borderRadius: 6
            },
            {
              label: "降車",
              data: rows.map((row) => row.dropoffCount),
              backgroundColor: "rgba(249, 115, 22, 0.58)",
              borderColor: "rgba(234, 88, 12, 0.9)",
              borderWidth: 1,
              borderRadius: 6
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: "top",
              labels: {
                usePointStyle: true,
                boxWidth: 10
              }
            },
            tooltip: {
              callbacks: {
                label(context) {
                  return `${context.dataset.label} ${formatInt(context.parsed.y)}件`;
                }
              }
            }
          },
          scales: {
            x: {
              ticks: {
                autoSkip: false,
                maxRotation: 20,
                minRotation: 20
              }
            },
            y: {
              beginAtZero: true,
              ticks: {
                callback: chartIntegerTick
              },
              title: {
                display: true,
                text: "件数"
              }
            }
          }
        }
      };
    });

    onMounted(() => {
      refresh();
    });

    return {
      loading,
      errorMessage,
      selectedYear,
      yearOptions,
      analytics,
      formattedLastUpdatedAt,
      kpiCards,
      refresh,
      formatInt,
      formatDecimal,
      formatPercent,
      formatKm,
      formatMinutes,
      yearlyOverviewChartConfig,
      monthlyTrendChartConfig,
      weekdayUsageChartConfig,
      hourlyUsageChartConfig,
      heatmapBubbleChartConfig,
      hasStatusData,
      hasCallStatusData,
      statusDoughnutChartConfig,
      callStatusDoughnutChartConfig,
      stopUsageChartConfig
    };
  },
  template: `
<v-app class="ra-app">
  <div class="ra-bg ra-bg--left"></div>
  <div class="ra-bg ra-bg--right"></div>

  <header class="ra-header ra-fade">
    <div class="ra-heading">
      <a class="ra-back-link" href="/">
        <v-icon size="14">mdi-arrow-left</v-icon>
        運行コンソールへ戻る
      </a>
      <h1>利用統計ダッシュボード</h1>
      <p>
        年度・曜日・時間帯・待ち時間・予定差分・ユーザー別・バス停別を同時に可視化。
        電話番号がある利用者は電話番号ベースで集計しています。
      </p>
    </div>

    <div class="ra-controls">
      <v-select
        v-model="selectedYear"
        :items="yearOptions"
        item-title="title"
        item-value="value"
        label="表示年度"
        variant="outlined"
        density="compact"
        hide-details
      />
      <div class="ra-control-actions">
        <v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-refresh"
          :loading="loading"
          @click="refresh"
        >
          更新
        </v-btn>
        <v-btn
          color="secondary"
          variant="tonal"
          prepend-icon="mdi-map-outline"
          href="/"
        >
          配車画面
        </v-btn>
      </div>
      <div class="ra-updated">最終更新: {{ formattedLastUpdatedAt }}</div>
    </div>
  </header>

  <div v-if="errorMessage" class="ra-error ra-fade">
    <v-icon size="16">mdi-alert-circle-outline</v-icon>
    {{ errorMessage }}
  </div>

  <main class="ra-main">
    <section class="ra-kpi-grid ra-fade">
      <article v-for="card in kpiCards" :key="card.title" class="ra-kpi-card">
        <div class="ra-kpi-title">{{ card.title }}</div>
        <div class="ra-kpi-value">{{ card.value }}</div>
        <div class="ra-kpi-sub">{{ card.sub }}</div>
      </article>
    </section>

    <section class="ra-grid ra-grid--two ra-fade">
      <article class="ra-panel">
        <div class="ra-panel-head">
          <h2>年度別サマリー</h2>
          <span>{{ analytics.yearlyRows.length }} 年度</span>
        </div>
        <div v-if="analytics.yearlyRows.length" class="ra-chart-block">
          <interactive-chart :config="yearlyOverviewChartConfig" :height="300" />
          <div class="ra-chart-caption">
            棒グラフをクリックすると該当年度にフィルタできます。
          </div>
        </div>
        <div v-else class="ra-empty">年度別データがありません。</div>

        <div class="ra-table-wrap">
          <table class="ra-table ra-table--compact">
            <thead>
              <tr>
                <th>年度</th>
                <th>利用者数</th>
                <th>平均待ち</th>
                <th>平均差分</th>
                <th>完了率</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in analytics.yearlyRows.slice(0, 8)" :key="'year-row-' + row.year">
                <td>{{ row.label }}</td>
                <td>{{ formatInt(row.uniqueUsers) }}</td>
                <td>{{ formatMinutes(row.avgWaitMinutes) }}</td>
                <td>{{ formatMinutes(row.avgDeltaMinutes) }}</td>
                <td>{{ formatPercent(row.completionRate) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>

      <article class="ra-panel">
        <div class="ra-panel-head">
          <h2>月次推移</h2>
          <span>{{ analytics.selectedYearLabel }}</span>
        </div>
        <div v-if="analytics.monthlyRows.length" class="ra-chart-block">
          <interactive-chart :config="monthlyTrendChartConfig" :height="320" />
        </div>
        <div v-else class="ra-empty">月次データがありません。</div>

        <div class="ra-panel-note">
          時系列での予約件数の推移を表示しています。
        </div>
      </article>
    </section>

    <section class="ra-grid ra-grid--two ra-fade">
      <article class="ra-panel">
        <div class="ra-panel-head">
          <h2>曜日別利用状況</h2>
          <span>{{ analytics.selectedYearLabel }}</span>
        </div>
        <div class="ra-chart-block">
          <interactive-chart :config="weekdayUsageChartConfig" :height="300" />
        </div>
      </article>

      <article class="ra-panel">
        <div class="ra-panel-head">
          <h2>時間帯別利用状況</h2>
          <span>24時間</span>
        </div>
        <div class="ra-chart-block">
          <interactive-chart :config="hourlyUsageChartConfig" :height="300" />
        </div>
      </article>
    </section>

    <section class="ra-panel ra-fade">
      <div class="ra-panel-head">
        <h2>曜日 × 時間帯ヒートマップ</h2>
        <span>件数濃淡表示</span>
      </div>
      <div class="ra-chart-block">
        <interactive-chart :config="heatmapBubbleChartConfig" :height="360" />
        <div class="ra-chart-caption">
          バブルの大きさと濃さが利用件数を示します。ホバーで曜日・時間帯の件数を確認できます。
        </div>
      </div>
    </section>

    <section class="ra-grid ra-grid--two ra-fade">
      <article class="ra-panel">
        <div class="ra-panel-head">
          <h2>ステータス分布</h2>
          <span>{{ analytics.selectedYearLabel }}</span>
        </div>
        <div v-if="hasStatusData" class="ra-chart-block">
          <interactive-chart :config="statusDoughnutChartConfig" :height="300" />
        </div>
        <div v-else class="ra-empty">ステータスデータがありません。</div>
      </article>

      <article class="ra-panel">
        <div class="ra-panel-head">
          <h2>電話チャネル状況</h2>
          <span>{{ formatInt(analytics.kpis.callCount) }} コール</span>
        </div>
        <div class="ra-call-kpi">
          受理率 {{ formatPercent(analytics.kpis.callReceivedRate) }}
        </div>
        <div v-if="hasCallStatusData" class="ra-chart-block">
          <interactive-chart :config="callStatusDoughnutChartConfig" :height="300" />
        </div>
        <div v-else class="ra-empty">コールデータがありません。</div>
      </article>
    </section>

    <section class="ra-panel ra-fade">
      <div class="ra-panel-head">
        <h2>ユーザー別利用状況</h2>
        <span>上位 {{ analytics.topUserRows.length }} / 全{{ analytics.userRows.length }} ユーザー</span>
      </div>
      <div class="ra-table-wrap">
        <table class="ra-table">
          <thead>
            <tr>
              <th>#</th>
              <th>ユーザー</th>
              <th>利用回数</th>
              <th>完了率</th>
              <th>平均待ち</th>
              <th>平均移動距離</th>
              <th>よく使う曜日</th>
              <th>よく使う時間</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in analytics.topUserRows" :key="'user-' + row.key">
              <td>{{ index + 1 }}</td>
              <td>
                <div class="ra-user-cell">
                  <span>{{ row.label }}</span>
                  <v-chip v-if="row.isPhoneBased" size="x-small" color="primary" variant="tonal">電話番号</v-chip>
                </div>
              </td>
              <td>{{ formatInt(row.rideCount) }}</td>
              <td>{{ formatPercent(row.completionRate) }}</td>
              <td>{{ formatMinutes(row.avgWaitMinutes) }}</td>
              <td>{{ formatKm(row.avgDistanceKm) }}</td>
              <td>{{ row.favoriteWeekday }}</td>
              <td>{{ row.favoriteHour }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="ra-panel ra-fade">
      <div class="ra-panel-head">
        <h2>バス停別分析</h2>
        <span>全 {{ analytics.stopOnlyRows.length }} バス停</span>
      </div>
      <div v-if="analytics.stopOnlyRows.length" class="ra-chart-block">
        <interactive-chart :config="stopUsageChartConfig" :height="320" />
        <div class="ra-chart-caption">
          上位10バス停の乗車・降車件数です。凡例クリックで系列を切り替えできます。
        </div>
      </div>
      <div class="ra-stop-cards">
        <article v-for="stop in analytics.topStops" :key="'stop-card-' + stop.key" class="ra-stop-card">
          <div class="ra-stop-title">{{ stop.label }}</div>
          <div class="ra-stop-metrics">
            <span>総利用 {{ formatInt(stop.totalMovement) }}</span>
            <span>乗車 {{ formatInt(stop.pickupCount) }}</span>
            <span>降車 {{ formatInt(stop.dropoffCount) }}</span>
            <span>利用者 {{ formatInt(stop.uniqueUsers) }}</span>
          </div>
        </article>
      </div>
      <div class="ra-table-wrap">
        <table class="ra-table ra-table--compact">
          <thead>
            <tr>
              <th>バス停/地点</th>
              <th>総利用</th>
              <th>乗車</th>
              <th>降車</th>
              <th>利用者数</th>
              <th>平均待ち</th>
              <th>平均移動距離</th>
              <th>取消率</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in analytics.stopOnlyRows.slice(0, 20)" :key="'stop-row-' + row.key">
              <td>{{ row.label }}</td>
              <td>{{ formatInt(row.totalMovement) }}</td>
              <td>{{ formatInt(row.pickupCount) }}</td>
              <td>{{ formatInt(row.dropoffCount) }}</td>
              <td>{{ formatInt(row.uniqueUsers) }}</td>
              <td>{{ formatMinutes(row.avgWaitMinutes) }}</td>
              <td>{{ formatKm(row.avgDistanceKm) }}</td>
              <td>{{ formatPercent(row.cancellationRate) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>
</v-app>
  `
}).use(vuetify).mount("#app");
