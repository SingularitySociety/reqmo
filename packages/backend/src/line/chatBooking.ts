import { GraphAI } from "graphai";
import { geminiAgent } from "@graphai/gemini_agent";

import { cancelRideRequest, createRideRequest, listRideRequestOptions } from "../api/functions.ts";
import { normalizePhoneNumber } from "../telephony/phoneNumber.ts";
import { registerLineMiniAppUser } from "./service.ts";

const BOOKING_SESSION_VERSION = 1;
const DEFAULT_TIME_ZONE = "Asia/Tokyo";
const DEFAULT_COUNTRY_CODE = "+81";
const STOP_CANDIDATE_LIMIT = 5;
const MAX_PARTY_SIZE = 8;
const CANCELLABLE_RIDE_LIMIT = 3;
const CANCELLABLE_RIDE_STATUSES = new Set([
  "REQUESTED",
  "ASSIGNED",
  "PICKUP_PENDING",
  "IN_PROGRESS",
  "ONBOARD"
]);

const YES_PATTERN = /^(はい|うん|ok|okay|yes|y|お願い|お願いします|お願い致します|確定|予約して|予約して下さい|予約してください)$/i;
const NO_PATTERN = /^(いいえ|違う|ちがう|no|n|キャンセル|やめる|やめます|戻る|戻して)$/i;
const CANCEL_PATTERN = /^(予約キャンセル|予約中断|中断|やめる|キャンセル|cancel)$/i;

const JAPANESE_NUMBER_MAP = {
  "一": 1,
  "二": 2,
  "三": 3,
  "四": 4,
  "五": 5,
  "六": 6,
  "七": 7,
  "八": 8,
  "九": 9,
  "十": 10
};

const NLU_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: {
      anyOf: [{ type: "string" }, { type: "null" }]
    },
    confirmation: {
      anyOf: [{ type: "string" }, { type: "null" }]
    },
    selectedStopId: {
      anyOf: [{ type: "string" }, { type: "null" }]
    },
    pickupStopId: {
      anyOf: [{ type: "string" }, { type: "null" }]
    },
    dropoffStopId: {
      anyOf: [{ type: "string" }, { type: "null" }]
    },
    pickupHint: {
      anyOf: [{ type: "string" }, { type: "null" }]
    },
    dropoffHint: {
      anyOf: [{ type: "string" }, { type: "null" }]
    },
    desiredAtIso: {
      anyOf: [{ type: "string" }, { type: "null" }]
    },
    desiredMode: {
      anyOf: [{ type: "string" }, { type: "null" }]
    },
    partySize: {
      anyOf: [{ type: "number" }, { type: "null" }]
    },
    confidence: {
      anyOf: [{ type: "number" }, { type: "null" }]
    },
    notes: {
      anyOf: [{ type: "string" }, { type: "null" }]
    }
  }
};

function normalizeTrimmedText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeSessionPhase(value) {
  const phase = normalizeTrimmedText(value).toUpperCase();
  const known = new Set([
    "REGISTER_PHONE",
    "REGISTER_NAME",
    "ASK_PICKUP",
    "DISAMBIG_PICKUP",
    "CONFIRM_PICKUP",
    "ASK_DROPOFF",
    "DISAMBIG_DROPOFF",
    "CONFIRM_DROPOFF",
    "ASK_TIME_AND_PARTY",
    "ASK_TIME",
    "ASK_PARTY",
    "CONFIRM_BOOKING",
    "ASK_CANCEL_TARGET",
    "CONFIRM_CANCEL"
  ]);
  return known.has(phase) ? phase : "ASK_PICKUP";
}

function toIsoString(dateValue) {
  if (dateValue === null || dateValue === undefined || dateValue === "") {
    return null;
  }
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createInitialSession(now = new Date()) {
  const timestamp = now.toISOString();
  return {
    version: BOOKING_SESSION_VERSION,
    mode: "LINE_CHAT_BOOKING",
    phase: "REGISTER_PHONE",
    registration: {
      name: null,
      phoneNumber: null
    },
    slots: {
      pickupStopId: null,
      dropoffStopId: null,
      desiredAt: null,
      desiredMode: "PICKUP",
      partySize: null
    },
    prefill: {
      dropoffQuery: null
    },
    cancellation: {
      options: [],
      selectedRequestId: null
    },
    pending: {
      field: null,
      options: [],
      selectedStopId: null,
      selectedOption: null
    },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function normalizeSession(raw, now = new Date()) {
  if (!raw || typeof raw !== "object") {
    return createInitialSession(now);
  }
  const base = createInitialSession(now);
  const slots = raw.slots && typeof raw.slots === "object" ? raw.slots : {};
  const prefill = raw.prefill && typeof raw.prefill === "object" ? raw.prefill : {};
  const cancellation = raw.cancellation && typeof raw.cancellation === "object" ? raw.cancellation : {};
  const pending = raw.pending && typeof raw.pending === "object" ? raw.pending : {};
  const registration = raw.registration && typeof raw.registration === "object" ? raw.registration : {};

  const desiredModeRaw = normalizeTrimmedText(slots.desiredMode).toUpperCase();
  const desiredMode = desiredModeRaw === "DROPOFF" ? "DROPOFF" : "PICKUP";
  const desiredAt = toIsoString(slots.desiredAt);
  const partySizeNum = Number(slots.partySize);
  const partySize =
    Number.isFinite(partySizeNum) && partySizeNum > 0
      ? Math.min(MAX_PARTY_SIZE, Math.max(1, Math.trunc(partySizeNum)))
      : null;

  const normalizedPendingOptions = Array.isArray(pending.options)
    ? pending.options
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }
          const stopId = normalizeTrimmedText(item.stopId);
          const name = normalizeTrimmedText(item.name);
          if (!stopId || !name) {
            return null;
          }
          const scoreRaw = Number(item.score);
          const score = Number.isFinite(scoreRaw) ? scoreRaw : 0;
          return { stopId, name, score };
        })
        .filter(Boolean)
    : [];

  const normalizedSession = {
    ...base,
    version: BOOKING_SESSION_VERSION,
    phase: normalizeSessionPhase(raw.phase),
    registration: {
      name: normalizeTrimmedText(registration.name) || null,
      phoneNumber: normalizeTrimmedText(registration.phoneNumber) || null
    },
    slots: {
      pickupStopId: normalizeTrimmedText(slots.pickupStopId) || null,
      dropoffStopId: normalizeTrimmedText(slots.dropoffStopId) || null,
      desiredAt,
      desiredMode,
      partySize
    },
    prefill: {
      dropoffQuery: normalizeTrimmedText(prefill.dropoffQuery) || null
    },
    cancellation: {
      options: Array.isArray(cancellation.options)
        ? cancellation.options
            .map((item) => {
              if (!item || typeof item !== "object") {
                return null;
              }
              const requestId = normalizeTrimmedText(item.requestId);
              const pickupName = normalizeTrimmedText(item.pickupName);
              const dropoffName = normalizeTrimmedText(item.dropoffName);
              const pickupAt = toIsoString(item.pickupAt);
              const partySize = normalizePartySize(item.partySize) ?? 1;
              const status = normalizeTrimmedText(item.status).toUpperCase() || null;
              if (!requestId || !pickupName || !dropoffName) {
                return null;
              }
              return {
                requestId,
                pickupName,
                dropoffName,
                pickupAt,
                partySize,
                status
              };
            })
            .filter(Boolean)
        : [],
      selectedRequestId: normalizeTrimmedText(cancellation.selectedRequestId) || null
    },
    pending: {
      field: normalizeTrimmedText(pending.field) || null,
      options: normalizedPendingOptions,
      selectedStopId: normalizeTrimmedText(pending.selectedStopId) || null,
      selectedOption:
        pending.selectedOption && typeof pending.selectedOption === "object"
          ? {
              ...pending.selectedOption,
              vehicleId: normalizeTrimmedText(pending.selectedOption.vehicleId) || null,
              plannedPickupAt: toIsoString(pending.selectedOption.plannedPickupAt),
              plannedDropoffAt: toIsoString(pending.selectedOption.plannedDropoffAt),
              desiredAt: toIsoString(pending.selectedOption.desiredAt),
              desiredMode:
                normalizeTrimmedText(pending.selectedOption.desiredMode).toUpperCase() === "DROPOFF"
                  ? "DROPOFF"
                  : "PICKUP",
              partySize: (() => {
                const num = Number(pending.selectedOption.partySize);
                return Number.isFinite(num) && num > 0 ? Math.min(MAX_PARTY_SIZE, Math.max(1, Math.trunc(num))) : 1;
              })(),
              requestType: (() => {
                const requestType = normalizeTrimmedText(pending.selectedOption.requestType).toUpperCase();
                if (requestType === "ARRIVE_BY") {
                  return "ARRIVE_BY";
                }
                if (requestType === "ASAP") {
                  return "ASAP";
                }
                return "DEPART_AT";
              })()
            }
          : null
    },
    createdAt: toIsoString(raw.createdAt) ?? base.createdAt,
    updatedAt: toIsoString(raw.updatedAt) ?? base.updatedAt
  };

  return normalizedSession;
}

function touchSession(session, now = new Date()) {
  return {
    ...session,
    updatedAt: now.toISOString()
  };
}

function katakanaToHiragana(value) {
  return value.replace(/[\u30a1-\u30f6]/g, (char) => {
    return String.fromCharCode(char.charCodeAt(0) - 0x60);
  });
}

function normalizeJapaneseText(value) {
  const trimmed = normalizeTrimmedText(value).toLowerCase();
  if (!trimmed) {
    return "";
  }
  const hiragana = katakanaToHiragana(trimmed);
  return hiragana
    .replace(/[\s\u3000]/g, "")
    .replace(/[・･\-―ーｰ~〜.,。!?！？()（）「」『』【】\[\]\/]/g, "")
    .replace(/っ+/g, "っ");
}

function levenshteinDistance(left, right) {
  const a = normalizeTrimmedText(left);
  const b = normalizeTrimmedText(right);
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => new Array(cols).fill(0));

  for (let i = 0; i < rows; i += 1) {
    matrix[i][0] = i;
  }
  for (let j = 0; j < cols; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[rows - 1][cols - 1];
}

function computeStopMatchScore(query, stopName) {
  const normalizedQuery = normalizeJapaneseText(query);
  const normalizedStop = normalizeJapaneseText(stopName);
  if (!normalizedQuery || !normalizedStop) {
    return 0;
  }

  let score = 0;
  if (normalizedStop === normalizedQuery) {
    score = 1;
  }

  if (normalizedStop.includes(normalizedQuery)) {
    score = Math.max(score, 0.9);
  }
  if (normalizedQuery.includes(normalizedStop)) {
    score = Math.max(score, 0.82);
  }

  const distance = levenshteinDistance(normalizedQuery, normalizedStop);
  const maxLength = Math.max(normalizedQuery.length, normalizedStop.length);
  if (maxLength > 0) {
    score = Math.max(score, 1 - distance / maxLength);
  }

  const stopWords = normalizeTrimmedText(stopName)
    .split(/[\s\u3000・･()（）]+/)
    .map((word) => normalizeJapaneseText(word))
    .filter(Boolean);
  stopWords.forEach((word) => {
    if (!word) {
      return;
    }
    if (word === normalizedQuery) {
      score = Math.max(score, 0.99);
      return;
    }
    if (word.includes(normalizedQuery)) {
      score = Math.max(score, 0.93);
    }
    if (normalizedQuery.includes(word)) {
      score = Math.max(score, 0.86);
    }
    const wordDistance = levenshteinDistance(normalizedQuery, word);
    const wordLength = Math.max(normalizedQuery.length, word.length);
    if (wordLength > 0) {
      score = Math.max(score, 1 - wordDistance / wordLength);
    }
  });

  const queryWords = normalizeTrimmedText(query)
    .split(/[\s\u3000]+/)
    .map((word) => normalizeJapaneseText(word))
    .filter(Boolean);
  if (queryWords.length > 1) {
    const matchedWordCount = queryWords.reduce((count, word) => {
      return count + (normalizedStop.includes(word) ? 1 : 0);
    }, 0);
    score = Math.max(score, matchedWordCount / queryWords.length);
  }

  return Math.max(0, Math.min(1, score));
}

function buildStopCandidates(stops, text, limit = STOP_CANDIDATE_LIMIT) {
  if (!Array.isArray(stops) || !stops.length) {
    return [];
  }
  const normalizedText = normalizeTrimmedText(text);
  if (!normalizedText) {
    return [];
  }

  const candidates = stops
    .map((stop) => {
      const stopId = normalizeTrimmedText(stop?.id);
      const stopName = normalizeTrimmedText(stop?.name);
      if (!stopId || !stopName) {
        return null;
      }
      return {
        stopId,
        name: stopName,
        score: computeStopMatchScore(normalizedText, stopName)
      };
    })
    .filter(Boolean)
    .filter((candidate) => candidate.score >= 0.25)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.name.localeCompare(right.name, "ja-JP");
    })
    .slice(0, limit);

  return candidates;
}

function shouldAskStopDisambiguation(candidates) {
  if (!Array.isArray(candidates) || candidates.length <= 1) {
    return false;
  }
  const top = candidates[0];
  const second = candidates[1];
  if (!top || !second) {
    return false;
  }
  if (top.score >= 0.92 && top.score - second.score >= 0.12) {
    return false;
  }
  return true;
}

function resolveStopName(repository, stopId) {
  if (typeof repository?.findStopById !== "function") {
    return stopId;
  }
  const stop = repository.findStopById(stopId);
  return stop?.name ?? stopId;
}

function resolveLocationLabel(repository, location) {
  if (!location || typeof location !== "object") {
    return "未設定";
  }
  const mode = normalizeTrimmedText(location.mode).toUpperCase();
  if (mode === "FIXED_STOP") {
    const stopId = normalizeTrimmedText(location.stopId);
    return stopId ? resolveStopName(repository, stopId) : "停留所未設定";
  }
  if (mode === "FREE_POINT") {
    const title = normalizeTrimmedText(location.title);
    if (title) {
      return title;
    }
    const lat = Number(location?.point?.lat);
    const lng = Number(location?.point?.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return `${lat.toFixed(5)},${lng.toFixed(5)}`;
    }
  }
  return normalizeTrimmedText(location.title) || "未設定";
}

function formatTimeOnly(value, timeZone = DEFAULT_TIME_ZONE) {
  const iso = toIsoString(value);
  if (!iso) {
    return "時刻未定";
  }
  return new Date(iso).toLocaleTimeString("ja-JP", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function formatDateTime(value, timeZone = DEFAULT_TIME_ZONE) {
  const iso = toIsoString(value);
  if (!iso) {
    return "時刻未定";
  }
  return new Date(iso).toLocaleString("ja-JP", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function resolveRideRequestPickupAt(rideRequest) {
  return (
    rideRequest?.assignment?.plannedPickupAt ??
    rideRequest?.timeWindow?.desiredPickupAt ??
    rideRequest?.timeWindow?.desiredDropoffAt ??
    rideRequest?.createdAt ??
    null
  );
}

function isCancellableRideRequest(rideRequest) {
  const status = normalizeTrimmedText(rideRequest?.status).toUpperCase();
  return CANCELLABLE_RIDE_STATUSES.has(status);
}

function listCancellableRideRequests({
  repository,
  requesterId,
  limit = CANCELLABLE_RIDE_LIMIT
}) {
  const normalizedLimit = Math.min(Math.max(Math.trunc(Number(limit) || CANCELLABLE_RIDE_LIMIT), 1), 10);
  const requests =
    typeof repository?.listRideRequests === "function"
      ? repository.listRideRequests().filter((request) => request?.requesterId === requesterId)
      : [];

  return requests
    .filter((request) => isCancellableRideRequest(request))
    .sort((left, right) => {
      const leftTs = toTimestamp(resolveRideRequestPickupAt(left));
      const rightTs = toTimestamp(resolveRideRequestPickupAt(right));
      const leftComparable = Number.isFinite(leftTs) ? leftTs : Number.POSITIVE_INFINITY;
      const rightComparable = Number.isFinite(rightTs) ? rightTs : Number.POSITIVE_INFINITY;
      if (leftComparable !== rightComparable) {
        return leftComparable - rightComparable;
      }
      return normalizeTrimmedText(left?.id).localeCompare(normalizeTrimmedText(right?.id));
    })
    .slice(0, normalizedLimit);
}

function mapCancellationOptions({
  repository,
  requests
}) {
  if (!Array.isArray(requests)) {
    return [];
  }
  return requests
    .map((request) => {
      const requestId = normalizeTrimmedText(request?.id);
      const pickupName = resolveLocationLabel(repository, request?.pickup);
      const dropoffName = resolveLocationLabel(repository, request?.dropoff);
      const pickupAt = toIsoString(resolveRideRequestPickupAt(request));
      const partySize = normalizePartySize(request?.partySize) ?? 1;
      const status = normalizeTrimmedText(request?.status).toUpperCase() || null;
      if (!requestId) {
        return null;
      }
      return {
        requestId,
        pickupName,
        dropoffName,
        pickupAt,
        partySize,
        status
      };
    })
    .filter(Boolean);
}

function buildCancellationSelectionPrompt(options, { timeZone = DEFAULT_TIME_ZONE } = {}) {
  if (!Array.isArray(options) || !options.length) {
    return "キャンセル可能な予約が見つかりませんでした。";
  }
  const lines = ["どの予約をキャンセルしますか？"];
  options.forEach((option, index) => {
    const pickupAt = formatDateTime(option.pickupAt, timeZone);
    lines.push(
      `${index + 1}. ${option.pickupName} -> ${option.dropoffName} / ${pickupAt} / ${option.partySize}名`
    );
  });
  return lines.join("\n");
}

function buildCancellationConfirmPrompt(option, { timeZone = DEFAULT_TIME_ZONE } = {}) {
  if (!option) {
    return "キャンセル対象の予約が見つかりませんでした。";
  }
  const pickupAt = formatDateTime(option.pickupAt, timeZone);
  return `${option.pickupName}から${option.dropoffName}まで、${pickupAt}に${option.partySize}名の予約を取り消しします。よろしいですか？`;
}

function parseCancellationSelection(text) {
  const normalized = normalizeTrimmedText(text);
  if (!normalized) {
    return { index: null, requestId: null };
  }
  const requestIdMatch = normalized.match(/\b(req[_-][\w-]+)\b/i);
  const indexMatch = normalized.match(/(\d{1,2})\s*(?:番|ばん|件|つ)?/);
  return {
    index: indexMatch ? Number(indexMatch[1]) : null,
    requestId: requestIdMatch ? normalizeTrimmedText(requestIdMatch[1]) : null
  };
}

function resolveCancellationSelection({
  text,
  options
}) {
  if (!Array.isArray(options) || !options.length) {
    return null;
  }
  const parsed = parseCancellationSelection(text);
  if (parsed.requestId) {
    const byId = options.find(
      (option) => normalizeTrimmedText(option.requestId).toLowerCase() === parsed.requestId.toLowerCase()
    );
    if (byId) {
      return byId;
    }
  }
  if (Number.isFinite(parsed.index) && parsed.index >= 1 && parsed.index <= options.length) {
    return options[parsed.index - 1];
  }

  const scored = options
    .map((option) => {
      const signature = `${option.pickupName} ${option.dropoffName} ${formatDateTime(option.pickupAt)}`;
      return {
        option,
        score: computeStopMatchScore(text, signature)
      };
    })
    .sort((left, right) => right.score - left.score);
  if (scored[0]?.score >= 0.85) {
    return scored[0].option;
  }
  return null;
}

function resolveTimeZoneOffsetMs(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") {
      acc[part.type] = Number(part.value);
    }
    return acc;
  }, {});
  const utcFromZoned = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return utcFromZoned - date.getTime();
}

function zonedDateTimeToUtcIso({
  year,
  month,
  day,
  hour,
  minute,
  timeZone
}) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const guessDate = new Date(utcGuess);
  const offset = resolveTimeZoneOffsetMs(guessDate, timeZone);
  return new Date(utcGuess - offset).toISOString();
}

function getZonedDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") {
      acc[part.type] = Number(part.value);
    }
    return acc;
  }, {});

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function shiftDatePartsByDays(parts, deltaDays, timeZone) {
  const iso = zonedDateTimeToUtcIso({
    ...parts,
    timeZone
  });
  const shifted = new Date(iso);
  shifted.setUTCDate(shifted.getUTCDate() + deltaDays);
  return getZonedDateParts(shifted, timeZone);
}

function parseJapaneseNumeric(value) {
  const trimmed = normalizeTrimmedText(value);
  if (!trimmed) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }

  if (trimmed in JAPANESE_NUMBER_MAP) {
    return JAPANESE_NUMBER_MAP[trimmed];
  }

  if (/^[一二三四五六七八九]十$/.test(trimmed)) {
    const head = JAPANESE_NUMBER_MAP[trimmed[0]];
    return head * 10;
  }

  if (/^十[一二三四五六七八九]$/.test(trimmed)) {
    const tail = JAPANESE_NUMBER_MAP[trimmed[1]];
    return 10 + tail;
  }

  return null;
}

function parsePartySizeFromText(text) {
  const normalized = normalizeTrimmedText(text);
  if (!normalized) {
    return null;
  }

  const digitMatch = normalized.match(/(\d{1,2})\s*(名|人)/);
  if (digitMatch) {
    const num = Number(digitMatch[1]);
    if (Number.isFinite(num) && num > 0) {
      return Math.min(MAX_PARTY_SIZE, Math.max(1, Math.trunc(num)));
    }
  }

  const standaloneDigit = normalized.match(/^(\d{1,2})$/);
  if (standaloneDigit) {
    const num = Number(standaloneDigit[1]);
    if (Number.isFinite(num) && num > 0) {
      return Math.min(MAX_PARTY_SIZE, Math.max(1, Math.trunc(num)));
    }
  }

  const japaneseMatch = normalized.match(/([一二三四五六七八九十]{1,3})\s*(名|人)/);
  if (japaneseMatch) {
    const num = parseJapaneseNumeric(japaneseMatch[1]);
    if (Number.isFinite(num) && num > 0) {
      return Math.min(MAX_PARTY_SIZE, Math.max(1, Math.trunc(num)));
    }
  }

  return null;
}

function parsePhoneNumberCandidate(text, defaultCountryCode = DEFAULT_COUNTRY_CODE) {
  const normalized = normalizeTrimmedText(text);
  if (!normalized) {
    return null;
  }
  const compact = normalized
    .replace(/[^\d+]/g, "")
    .replace(/^00/, "+");
  if (!compact) {
    return null;
  }
  const normalizedPhone = normalizePhoneNumber(compact, defaultCountryCode);
  return normalizedPhone || null;
}

function parseNameCandidate(text) {
  const normalized = normalizeTrimmedText(text)
    .replace(/^名前(?:は|:|：)?/i, "")
    .replace(/^私(?:は|の名前は)?/i, "")
    .replace(/です$/i, "")
    .trim();
  if (!normalized) {
    return null;
  }
  if (/\d/.test(normalized)) {
    return null;
  }
  if (normalized.length > 40) {
    return null;
  }
  return normalized;
}

function parseConfirmation(text) {
  const normalized = normalizeTrimmedText(text);
  if (!normalized) {
    return "UNKNOWN";
  }
  if (YES_PATTERN.test(normalized)) {
    return "YES";
  }
  if (NO_PATTERN.test(normalized)) {
    return "NO";
  }
  return "UNKNOWN";
}

function parseDesiredMode(text) {
  const normalized = normalizeTrimmedText(text);
  if (!normalized) {
    return null;
  }
  if (/から.+まで/.test(normalized)) {
    return null;
  }
  if (/(到着|着きたい|までに|降車時刻|降車時間|着時刻|着時間)/.test(normalized)) {
    return "DROPOFF";
  }
  return null;
}

function sanitizeStopQuery(value) {
  const normalized = normalizeTrimmedText(value);
  if (!normalized) {
    return null;
  }

  const withoutTrailingMeta = normalized
    .replace(/[、,，。．!！?？]+$/g, "")
    .replace(
      /(?:\d{1,2}\s*時(?:\s*\d{1,2}\s*分)?|\d{1,2}[:：]\d{1,2}|[一二三四五六七八九十\d]{1,2}\s*(?:名|人)|昼ごろ|朝|夕方|夕刻|夜|今すぐ|できるだけ早く|最短|asap).*$/i,
      ""
    )
    .trim();

  if (!withoutTrailingMeta) {
    return null;
  }

  return withoutTrailingMeta
    .replace(/^(乗車(?:地|場所)?|出発(?:地|場所)?|from[:：]?)\s*/i, "")
    .replace(/^(降車(?:地|場所)?|目的地|to[:：]?)\s*/i, "")
    .trim();
}

function parseStopPairFromText(text) {
  const normalized = normalizeTrimmedText(text);
  if (!normalized) {
    return { pickupQuery: null, dropoffQuery: null };
  }

  const patterns = [
    /(.+?)から(.+?)(?:までに|まで|へ|に)(?=[\s、,，。．0-9一二三四五六七八九十]|$)/,
    /(.+?)[→＞>](.+?)(?:[、,，。．\s]|$)/
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) {
      continue;
    }
    const pickupQuery = sanitizeStopQuery(match[1]);
    const dropoffQuery = sanitizeStopQuery(match[2]);
    if (pickupQuery && dropoffQuery) {
      return {
        pickupQuery,
        dropoffQuery
      };
    }
  }

  return {
    pickupQuery: null,
    dropoffQuery: null
  };
}

function parseDesiredTimeFromText(text, { now = new Date(), timeZone = DEFAULT_TIME_ZONE } = {}) {
  const normalized = normalizeTrimmedText(text);
  if (!normalized) {
    return null;
  }

  if (/(今すぐ|すぐ|できるだけ早く|最短|asap)/i.test(normalized)) {
    const nearFuture = new Date(now.getTime() + 5 * 60 * 1000);
    return nearFuture.toISOString();
  }

  const dayOffset = (() => {
    if (/明後日|あさって/.test(normalized)) {
      return 2;
    }
    if (/明日|あした/.test(normalized)) {
      return 1;
    }
    return 0;
  })();

  let hour = null;
  let minute = 0;

  const hhmm = normalized.match(/(\d{1,2})[:：](\d{1,2})/);
  if (hhmm) {
    hour = Number(hhmm[1]);
    minute = Number(hhmm[2]);
  }

  if (hour === null) {
    const half = normalized.match(/(\d{1,2})\s*時\s*半/);
    if (half) {
      hour = Number(half[1]);
      minute = 30;
    }
  }

  if (hour === null) {
    const hourOnly = normalized.match(/(\d{1,2})\s*時(?:\s*(\d{1,2})\s*分)?/);
    if (hourOnly) {
      hour = Number(hourOnly[1]);
      minute = hourOnly[2] ? Number(hourOnly[2]) : 0;
    }
  }

  if (hour === null && /昼|正午/.test(normalized)) {
    hour = 12;
    minute = 0;
  }
  if (hour === null && /朝/.test(normalized)) {
    hour = 9;
    minute = 0;
  }
  if (hour === null && /夕方|夕刻/.test(normalized)) {
    hour = 17;
    minute = 0;
  }
  if (hour === null && /夜/.test(normalized)) {
    hour = 19;
    minute = 0;
  }

  if (hour === null || !Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  const zonedNow = getZonedDateParts(now, timeZone);
  let targetDate = shiftDatePartsByDays(zonedNow, dayOffset, timeZone);
  const targetIso = zonedDateTimeToUtcIso({
    year: targetDate.year,
    month: targetDate.month,
    day: targetDate.day,
    hour,
    minute,
    timeZone
  });

  if (dayOffset === 0) {
    const nowTs = now.getTime();
    const targetTs = new Date(targetIso).getTime();
    if (targetTs < nowTs + 5 * 60 * 1000) {
      targetDate = shiftDatePartsByDays(zonedNow, 1, timeZone);
      return zonedDateTimeToUtcIso({
        year: targetDate.year,
        month: targetDate.month,
        day: targetDate.day,
        hour,
        minute,
        timeZone
      });
    }
  }

  return targetIso;
}

function stripJsonFence(text) {
  const raw = normalizeTrimmedText(text);
  if (!raw) {
    return "";
  }
  if (!raw.startsWith("```")) {
    return raw;
  }
  return raw
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function parseJsonLoose(text) {
  const normalized = stripJsonFence(text);
  if (!normalized) {
    return null;
  }
  try {
    return JSON.parse(normalized);
  } catch {
    const firstBrace = normalized.indexOf("{");
    const lastBrace = normalized.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const sliced = normalized.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(sliced);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalizeDesiredIso(value) {
  const iso = toIsoString(value);
  return iso || null;
}

function normalizeDesiredMode(value) {
  const mode = normalizeTrimmedText(value).toUpperCase();
  if (mode === "PICKUP" || mode === "DROPOFF") {
    return mode;
  }
  return null;
}

function normalizePartySize(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return null;
  }
  return Math.min(MAX_PARTY_SIZE, Math.max(1, Math.trunc(num)));
}

function normalizeConfirmation(value) {
  const normalized = normalizeTrimmedText(value).toUpperCase();
  if (normalized === "YES" || normalized === "NO") {
    return normalized;
  }
  if (["OK", "TRUE", "AGREE"].includes(normalized)) {
    return "YES";
  }
  if (["FALSE", "REJECT"].includes(normalized)) {
    return "NO";
  }
  return "UNKNOWN";
}

function toCandidateBrief(candidates) {
  if (!Array.isArray(candidates)) {
    return [];
  }
  return candidates.map((candidate) => ({
    stopId: candidate.stopId,
    name: candidate.name,
    score: Number(candidate.score.toFixed(3))
  }));
}

function buildNluPrompt({
  text,
  phase,
  slots,
  stopCandidates,
  now,
  timeZone
}) {
  const context = {
    nowIso: now.toISOString(),
    timeZone,
    phase,
    slots,
    stopCandidates: toCandidateBrief(stopCandidates),
    userText: text
  };

  return [
    "あなたはLINE予約チャットの入力解析器です。",
    "必ずJSONだけを返してください。説明文は不要です。",
    "目的: ユーザー入力から確認(YES/NO)、停留所候補、人数、希望時刻を抽出する。",
    "selectedStopIdは stopCandidates の stopId から選んでください。候補外なら null。",
    "「AからBまで」のような入力では pickupHint=A, dropoffHint=B を設定する。",
    "desiredMode は PICKUP / DROPOFF / null。",
    "desiredAtIso は ISO8601 UTC文字列。推定不可なら null。",
    "partySize は 1-8 の整数。",
    "context:",
    JSON.stringify(context)
  ].join("\n");
}

export function resolveLineBookingConfig({ env = process.env } = {}) {
  const enabledRaw = normalizeTrimmedText(env.LINE_BOOKING_LLM_ENABLED || "true").toLowerCase();
  const enabled = enabledRaw !== "false";
  const apiKey =
    normalizeTrimmedText(env.LINE_BOOKING_LLM_API_KEY) ||
    normalizeTrimmedText(env.GOOGLE_GENAI_API_KEY);
  const model = normalizeTrimmedText(env.LINE_BOOKING_LLM_MODEL) || "gemini-2.5-flash";
  const temperatureRaw = Number(env.LINE_BOOKING_LLM_TEMPERATURE);
  const temperature = Number.isFinite(temperatureRaw)
    ? Math.min(1, Math.max(0, temperatureRaw))
    : 0;
  const timeZone = normalizeTrimmedText(env.LINE_BOOKING_TIMEZONE) || DEFAULT_TIME_ZONE;

  return {
    enabled,
    apiKey,
    model,
    temperature,
    timeZone,
    available: enabled && Boolean(apiKey)
  };
}

async function runBookingNlu({
  text,
  phase,
  slots,
  stopCandidates,
  config,
  now
}) {
  if (!config?.available) {
    return null;
  }

  const prompt = buildNluPrompt({
    text,
    phase,
    slots,
    stopCandidates,
    now,
    timeZone: config.timeZone
  });

  const graphData = {
    version: 0.5,
    nodes: {
      prompt: {
        value: prompt
      },
      llm: {
        agent: "geminiAgent",
        params: {
          model: config.model,
          temperature: config.temperature,
          response_format: {
            type: "json_schema",
            json_schema: {
              schema: NLU_RESPONSE_SCHEMA
            }
          }
        },
        inputs: {
          prompt: ":prompt"
        },
        isResult: true
      }
    }
  };

  try {
    const graph = new GraphAI(
      graphData,
      { geminiAgent },
      {
        config: {
          geminiAgent: {
            apiKey: config.apiKey
          }
        }
      }
    );
    const result = await graph.run();
    const llmText = normalizeTrimmedText(result?.llm?.text);
    return parseJsonLoose(llmText);
  } catch {
    return null;
  }
}

function mergeTurnUnderstanding({
  text,
  llmOutput,
  fallbackStopCandidates,
  pendingStopCandidates,
  now,
  timeZone
}) {
  const parsedConfirmation = parseConfirmation(text);
  const parsedPartySize = parsePartySizeFromText(text);
  const parsedDesiredTime = parseDesiredTimeFromText(text, { now, timeZone });
  const parsedDesiredMode = parseDesiredMode(text);

  const llm = llmOutput && typeof llmOutput === "object" ? llmOutput : {};

  const llmConfirmation = normalizeConfirmation(llm.confirmation);
  const confirmation = parsedConfirmation !== "UNKNOWN" ? parsedConfirmation : llmConfirmation;

  const llmPartySize = normalizePartySize(llm.partySize);
  const partySize = parsedPartySize ?? llmPartySize;

  const llmDesiredIso = normalizeDesiredIso(llm.desiredAtIso);
  const desiredAtIso = parsedDesiredTime ?? llmDesiredIso;

  const llmDesiredMode = normalizeDesiredMode(llm.desiredMode);
  const desiredMode = parsedDesiredMode ?? llmDesiredMode;

  const allCandidateIds = new Set([
    ...fallbackStopCandidates.map((candidate) => candidate.stopId),
    ...pendingStopCandidates.map((candidate) => candidate.stopId)
  ]);

  const llmSelectedStopId = normalizeTrimmedText(llm.selectedStopId);
  const llmPickupStopId = normalizeTrimmedText(llm.pickupStopId);
  const llmDropoffStopId = normalizeTrimmedText(llm.dropoffStopId);
  const llmPickupHint = sanitizeStopQuery(llm.pickupHint);
  const llmDropoffHint = sanitizeStopQuery(llm.dropoffHint);

  let selectedStopId = null;
  for (const candidate of [llmSelectedStopId, llmPickupStopId, llmDropoffStopId]) {
    if (candidate && allCandidateIds.has(candidate)) {
      selectedStopId = candidate;
      break;
    }
  }

  return {
    confirmation,
    partySize,
    desiredAtIso,
    desiredMode,
    selectedStopId,
    pickupHint: llmPickupHint,
    dropoffHint: llmDropoffHint
  };
}

function applyUnderstandingToSessionSlots(session, understanding) {
  if (!session || !understanding) {
    return;
  }
  if (understanding.desiredAtIso) {
    session.slots.desiredAt = understanding.desiredAtIso;
  }
  if (understanding.desiredMode) {
    session.slots.desiredMode = understanding.desiredMode;
  }
  if (understanding.partySize) {
    session.slots.partySize = understanding.partySize;
  }
}

function resolveCompositeStopQueries({ text, understanding }) {
  const parsed = parseStopPairFromText(text);
  const pickupQuery = parsed.pickupQuery || sanitizeStopQuery(understanding?.pickupHint);
  const dropoffQuery = parsed.dropoffQuery || sanitizeStopQuery(understanding?.dropoffHint);
  return {
    pickupQuery: pickupQuery || null,
    dropoffQuery: dropoffQuery || null
  };
}

function buildDisambiguationPrompt(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return "候補の停留所が見つかりませんでした。もう一度入力してください。";
  }
  const names = candidates.map((candidate) => candidate.name);
  if (names.length === 1) {
    return `${names[0]}ですね。よろしいですか？`;
  }
  if (names.length === 2) {
    return `${names[0]}ですか？${names[1]}ですか？`;
  }
  const [first, ...rest] = names;
  return `${first}ですか？${rest.join("、")}ですか？`;
}

function buildStopConfirmationPrompt(stopName) {
  return `${stopName}ですね。よろしいですか？`;
}

function buildTimeAndPartyPrompt() {
  return "何名、何時に乗りたいですか？";
}

function resolveBestCandidate({
  text,
  candidates,
  selectedStopIdFromNlu
}) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return null;
  }

  if (selectedStopIdFromNlu) {
    const byId = candidates.find((candidate) => candidate.stopId === selectedStopIdFromNlu);
    if (byId) {
      return byId;
    }
  }

  const scored = buildStopCandidates(
    candidates.map((candidate) => ({ id: candidate.stopId, name: candidate.name })),
    text,
    candidates.length
  );
  return scored[0] ?? null;
}

function toTimestamp(value) {
  const iso = toIsoString(value);
  if (!iso) {
    return null;
  }
  const ts = new Date(iso).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function resolveOptionRequestType(option, desiredMode = "PICKUP") {
  const requestType = normalizeTrimmedText(option?.requestType).toUpperCase();
  if (requestType === "ARRIVE_BY" || requestType === "DEPART_AT" || requestType === "ASAP") {
    return requestType;
  }
  return desiredMode === "DROPOFF" ? "ARRIVE_BY" : "DEPART_AT";
}

function resolveOptionDesiredAt(option, desiredAt, desiredMode = "PICKUP") {
  const requestType = resolveOptionRequestType(option, desiredMode);
  if (requestType === "ARRIVE_BY") {
    return toIsoString(option?.desiredDropoffAt ?? desiredAt);
  }
  if (requestType === "DEPART_AT") {
    return toIsoString(option?.desiredPickupAt ?? desiredAt);
  }
  return null;
}

function resolveOptionTargetAt(option, desiredMode = "PICKUP") {
  if (desiredMode === "DROPOFF") {
    return toTimestamp(option?.plannedDropoffAt);
  }
  return toTimestamp(option?.plannedPickupAt);
}

function selectBookingOption(options, { desiredAt, desiredMode = "PICKUP" } = {}) {
  if (!Array.isArray(options) || !options.length) {
    return null;
  }
  const desiredTimestamp = toTimestamp(desiredAt);
  const expectedRequestType = desiredMode === "DROPOFF" ? "ARRIVE_BY" : "DEPART_AT";
  const preferred = options.filter(
    (option) => resolveOptionRequestType(option, desiredMode) === expectedRequestType
  );
  const pool = preferred.length ? preferred : options;
  if (!Number.isFinite(desiredTimestamp)) {
    return pool[0] ?? null;
  }

  return pool
    .map((option, index) => {
      const targetAt = resolveOptionTargetAt(option, desiredMode);
      return {
        option,
        index,
        delta:
          Number.isFinite(targetAt) && Number.isFinite(desiredTimestamp)
            ? Math.abs(targetAt - desiredTimestamp)
            : Number.POSITIVE_INFINITY
      };
    })
    .sort((left, right) => {
      if (left.delta !== right.delta) {
        return left.delta - right.delta;
      }
      return left.index - right.index;
    })[0]?.option;
}

async function buildBookingOptionProposal({
  repository,
  serviceProfileId,
  requesterId,
  tenantId,
  passenger,
  session,
  context,
  timeZone
}) {
  const pickupStopId = session?.slots?.pickupStopId;
  const dropoffStopId = session?.slots?.dropoffStopId;
  const desiredAt = session?.slots?.desiredAt;
  const desiredMode = session?.slots?.desiredMode === "DROPOFF" ? "DROPOFF" : "PICKUP";
  const partySize = session?.slots?.partySize ?? 1;

  if (!pickupStopId || !dropoffStopId || !desiredAt) {
    return {
      status: "INVALID_STATE",
      messageText: "予約条件が不足しています。もう一度、何名・何時をご入力ください。"
    };
  }

  const options = await listRideRequestOptions({
    repository,
    serviceProfileId,
    tenantId,
    requesterId,
    pickup: { mode: "FIXED_STOP", stopId: pickupStopId },
    dropoff: { mode: "FIXED_STOP", stopId: dropoffStopId },
    partySize,
    passenger,
    channel: "LINE_CHAT",
    requestType: desiredMode === "DROPOFF" ? "ARRIVE_BY" : "DEPART_AT",
    desiredPickupAt: desiredMode === "PICKUP" ? desiredAt : null,
    desiredDropoffAt: desiredMode === "DROPOFF" ? desiredAt : null,
    optionLimit: 3,
    context
  });

  if (!options || options.status !== "ASSIGNABLE" || !Array.isArray(options.options) || !options.options.length) {
    return {
      status: "UNASSIGNABLE",
      messageText: "その条件では予約候補を見つけられませんでした。時間を変えてもう一度お願いします。"
    };
  }

  const selected = selectBookingOption(options.options, { desiredAt, desiredMode }) ?? options.options[0];
  const pickupName = resolveStopName(repository, pickupStopId);
  const dropoffName = resolveStopName(repository, dropoffStopId);
  const desiredLabel = formatDateTime(desiredAt, timeZone);
  const plannedPickupLabel = formatTimeOnly(selected.plannedPickupAt, timeZone);
  const plannedDropoffLabel = formatTimeOnly(selected.plannedDropoffAt, timeZone);
  const selectedRequestType = resolveOptionRequestType(selected, desiredMode);
  const selectedDesiredAt = resolveOptionDesiredAt(selected, desiredAt, desiredMode);

  return {
    status: "ASSIGNABLE",
    messageText:
      `${pickupName}から${dropoffName}まで、${desiredLabel}に${partySize}名であれば、` +
      `${plannedPickupLabel}で予約できます（降車予定 ${plannedDropoffLabel}）。` +
      "予約してよろしいでしょうか？最大15分程度遅れる場合もあります。",
    selectedOption: {
      vehicleId: selected.vehicleId ?? null,
      plannedPickupAt: toIsoString(selected.plannedPickupAt),
      plannedDropoffAt: toIsoString(selected.plannedDropoffAt),
      requestType: selectedRequestType,
      desiredAt: selectedDesiredAt,
      desiredMode,
      partySize
    }
  };
}

function getSessionFromRepository(repository, lineUserId) {
  if (typeof repository?.getLineChatSession === "function") {
    return repository.getLineChatSession(lineUserId);
  }
  return null;
}

function saveSessionToRepository(repository, lineUserId, session) {
  if (typeof repository?.upsertLineChatSession === "function") {
    repository.upsertLineChatSession(lineUserId, session);
  }
}

function clearSessionFromRepository(repository, lineUserId) {
  if (typeof repository?.clearLineChatSession === "function") {
    repository.clearLineChatSession(lineUserId);
  }
}

export function isLineBookingCancelText(text) {
  return CANCEL_PATTERN.test(normalizeTrimmedText(text));
}

export function shouldBypassBookingSession(commandType) {
  const bypass = new Set(["RESERVATION", "BUS_LOCATION", "HELP", "REGISTER", "OPEN_MINIAPP", "LINK_PHONE"]);
  return bypass.has(normalizeTrimmedText(commandType).toUpperCase());
}

function resolveRegistrationMissingStatus(registrationStatus = {}) {
  return {
    hasName: Boolean(registrationStatus?.hasName),
    hasPhone: Boolean(registrationStatus?.hasPhone),
    isRegistered: Boolean(registrationStatus?.isRegistered),
    userName: normalizeTrimmedText(registrationStatus?.userName) || null,
    normalizedPhoneE164: normalizeTrimmedText(registrationStatus?.normalizedPhoneE164) || null
  };
}

function initializeSessionForRegistration(session, registrationStatus) {
  const status = resolveRegistrationMissingStatus(registrationStatus);
  session.registration = {
    name: status.userName,
    phoneNumber: status.normalizedPhoneE164
  };
  if (!status.hasPhone) {
    session.phase = "REGISTER_PHONE";
    return {
      session,
      messageText: "予約の前に利用者登録を行います。電話番号を入力してください。"
    };
  }
  if (!status.hasName) {
    session.phase = "REGISTER_NAME";
    return {
      session,
      messageText: "ありがとうございます。続いてお名前を入力してください。"
    };
  }
  session.phase = "ASK_PICKUP";
  return {
    session,
    messageText: "バス停の予約をします。どこから乗りたいですか？"
  };
}

export function startLineChatBookingSession({
  repository,
  lineUserId,
  registrationStatus = {},
  now = new Date()
}) {
  const session = createInitialSession(now);
  const initialized = initializeSessionForRegistration(session, registrationStatus);
  saveSessionToRepository(repository, lineUserId, session);
  return {
    handled: true,
    clearSession: false,
    nextSession: initialized.session,
    messageText: initialized.messageText
  };
}

export function getLineChatBookingSession({ repository, lineUserId, now = new Date() }) {
  const raw = getSessionFromRepository(repository, lineUserId);
  if (!raw) {
    return null;
  }
  return normalizeSession(raw, now);
}

export function clearLineChatBookingSession({ repository, lineUserId }) {
  clearSessionFromRepository(repository, lineUserId);
}

function applySessionMutation({ repository, lineUserId, session, clearSession }) {
  if (clearSession) {
    clearSessionFromRepository(repository, lineUserId);
    return;
  }
  if (session) {
    saveSessionToRepository(repository, lineUserId, session);
  }
}

export async function handleLineChatBookingMessage({
  repository,
  serviceProfileId,
  lineUserId,
  requesterId,
  tenantId = "tenant_default",
  text,
  sessionState = null,
  registrationStatus = {},
  displayName = null,
  defaultCountryCode = DEFAULT_COUNTRY_CODE,
  startIfNeeded = false,
  startCancelIfNeeded = false,
  context = {},
  llmConfig = resolveLineBookingConfig(),
  passenger = null,
  now = new Date()
}) {
  const messageText = normalizeTrimmedText(text);
  const registration = resolveRegistrationMissingStatus(registrationStatus);
  if (!messageText) {
    return {
      handled: false,
      clearSession: false,
      nextSession: sessionState ? normalizeSession(sessionState, now) : null,
      messageText: ""
    };
  }

  const timeZone = llmConfig?.timeZone || DEFAULT_TIME_ZONE;
  let currentSession = sessionState ? normalizeSession(sessionState, now) : null;

  if (!currentSession && !startIfNeeded && !startCancelIfNeeded) {
    return {
      handled: false,
      clearSession: false,
      nextSession: null,
      messageText: ""
    };
  }

  if (!currentSession && startCancelIfNeeded) {
    const cancellableRequests = listCancellableRideRequests({
      repository,
      requesterId
    });
    const cancellationOptions = mapCancellationOptions({
      repository,
      requests: cancellableRequests
    });
    const nextSession = touchSession(
      {
        ...createInitialSession(now),
        phase: "ASK_CANCEL_TARGET",
        cancellation: {
          options: cancellationOptions,
          selectedRequestId: null
        }
      },
      now
    );
    applySessionMutation({
      repository,
      lineUserId,
      session: nextSession,
      clearSession: false
    });
    return {
      handled: true,
      clearSession: false,
      nextSession,
      messageText: buildCancellationSelectionPrompt(cancellationOptions, { timeZone })
    };
  }

  if (!currentSession && startIfNeeded) {
    const started = startLineChatBookingSession({
      repository,
      lineUserId,
      registrationStatus,
      now
    });
    return started;
  }

  if (isLineBookingCancelText(messageText) && !startCancelIfNeeded) {
    applySessionMutation({
      repository,
      lineUserId,
      session: null,
      clearSession: true
    });
    return {
      handled: true,
      clearSession: true,
      nextSession: null,
      messageText: "予約会話を終了しました。もう一度予約する場合は「予約」と送ってください。"
    };
  }

  if (startCancelIfNeeded) {
    const cancellableRequests = listCancellableRideRequests({
      repository,
      requesterId
    });
    const cancellationOptions = mapCancellationOptions({
      repository,
      requests: cancellableRequests
    });
    currentSession = touchSession(
      {
        ...createInitialSession(now),
        phase: "ASK_CANCEL_TARGET",
        cancellation: {
          options: cancellationOptions,
          selectedRequestId: null
        }
      },
      now
    );
    applySessionMutation({
      repository,
      lineUserId,
      session: currentSession,
      clearSession: false
    });
    return {
      handled: true,
      clearSession: false,
      nextSession: currentSession,
      messageText: buildCancellationSelectionPrompt(cancellationOptions, { timeZone })
    };
  }

  if (startIfNeeded) {
    currentSession = createInitialSession(now);
    const initialized = initializeSessionForRegistration(currentSession, registrationStatus);
    currentSession = touchSession(initialized.session, now);
    applySessionMutation({
      repository,
      lineUserId,
      session: currentSession,
      clearSession: false
    });
    return {
      handled: true,
      clearSession: false,
      nextSession: currentSession,
      messageText: initialized.messageText
    };
  }

  if (
    registration.isRegistered &&
    (currentSession.phase === "REGISTER_PHONE" || currentSession.phase === "REGISTER_NAME")
  ) {
    currentSession.phase = "ASK_PICKUP";
  }

  const allStops = typeof repository?.listStops === "function" ? repository.listStops() : [];
  const pendingCandidates = Array.isArray(currentSession?.pending?.options)
    ? currentSession.pending.options
    : [];
  const stopCandidates = buildStopCandidates(allStops, messageText, STOP_CANDIDATE_LIMIT);

  const llmOutput = await runBookingNlu({
    text: messageText,
    phase: currentSession.phase,
    slots: currentSession.slots,
    stopCandidates: pendingCandidates.length ? pendingCandidates : stopCandidates,
    config: llmConfig,
    now
  });

  const understanding = mergeTurnUnderstanding({
    text: messageText,
    llmOutput,
    fallbackStopCandidates: stopCandidates,
    pendingStopCandidates: pendingCandidates,
    now,
    timeZone
  });
  const compositeQueries = resolveCompositeStopQueries({
    text: messageText,
    understanding
  });
  const compositePickupCandidates = compositeQueries.pickupQuery
    ? buildStopCandidates(allStops, compositeQueries.pickupQuery, STOP_CANDIDATE_LIMIT)
    : [];
  const compositeDropoffCandidates = compositeQueries.dropoffQuery
    ? buildStopCandidates(allStops, compositeQueries.dropoffQuery, STOP_CANDIDATE_LIMIT)
    : [];

  const session = touchSession(clone(currentSession), now);
  applyUnderstandingToSessionSlots(session, understanding);
  if (
    !registration.isRegistered &&
    session.phase !== "REGISTER_PHONE" &&
    session.phase !== "REGISTER_NAME" &&
    session.phase !== "ASK_CANCEL_TARGET" &&
    session.phase !== "CONFIRM_CANCEL"
  ) {
    const initialized = initializeSessionForRegistration(session, registrationStatus);
    return {
      handled: true,
      clearSession: false,
      nextSession: initialized.session,
      messageText: initialized.messageText
    };
  }

  async function proposeWithCurrentSlots() {
    const proposal = await buildBookingOptionProposal({
      repository,
      serviceProfileId,
      requesterId,
      tenantId,
      passenger,
      session,
      context,
      timeZone
    });

    if (proposal.status !== "ASSIGNABLE") {
      session.phase = "ASK_TIME_AND_PARTY";
      session.pending = {
        field: null,
        options: [],
        selectedStopId: null,
        selectedOption: null
      };
      return {
        handled: true,
        clearSession: false,
        nextSession: session,
        messageText: proposal.messageText
      };
    }

    session.phase = "CONFIRM_BOOKING";
    session.pending = {
      field: "booking",
      options: [],
      selectedStopId: null,
      selectedOption: proposal.selectedOption
    };

    return {
      handled: true,
      clearSession: false,
      nextSession: session,
      messageText: proposal.messageText
    };
  }

  switch (session.phase) {
    case "ASK_CANCEL_TARGET": {
      const refreshedOptions = mapCancellationOptions({
        repository,
        requests: listCancellableRideRequests({
          repository,
          requesterId
        })
      });
      session.cancellation.options = refreshedOptions;
      session.cancellation.selectedRequestId = null;
      if (!refreshedOptions.length) {
        applySessionMutation({
          repository,
          lineUserId,
          session: null,
          clearSession: true
        });
        return {
          handled: true,
          clearSession: true,
          nextSession: null,
          messageText: "キャンセル可能な予約が見つかりませんでした。"
        };
      }
      const selected = resolveCancellationSelection({
        text: messageText,
        options: refreshedOptions
      });
      if (!selected) {
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: buildCancellationSelectionPrompt(refreshedOptions, { timeZone })
        };
      }
      session.phase = "CONFIRM_CANCEL";
      session.cancellation.selectedRequestId = selected.requestId;
      return {
        handled: true,
        clearSession: false,
        nextSession: session,
        messageText: buildCancellationConfirmPrompt(selected, { timeZone })
      };
    }

    case "CONFIRM_CANCEL": {
      const selectedRequestId = normalizeTrimmedText(session.cancellation?.selectedRequestId);
      const options = Array.isArray(session.cancellation?.options) ? session.cancellation.options : [];
      const selectedOption = options.find((option) => option.requestId === selectedRequestId) || null;

      if (understanding.confirmation === "YES") {
        if (!selectedOption) {
          session.phase = "ASK_CANCEL_TARGET";
          return {
            handled: true,
            clearSession: false,
            nextSession: session,
            messageText: buildCancellationSelectionPrompt(options, { timeZone })
          };
        }
        try {
          await cancelRideRequest({
            repository,
            requestId: selectedOption.requestId,
            reason: "PASSENGER_CANCELLED",
            context
          });
        } catch {
          session.phase = "ASK_CANCEL_TARGET";
          return {
            handled: true,
            clearSession: false,
            nextSession: session,
            messageText: "予約を取り消せませんでした。別の予約を選ぶか、時間をおいて再度お試しください。"
          };
        }

        applySessionMutation({
          repository,
          lineUserId,
          session: null,
          clearSession: true
        });
        return {
          handled: true,
          clearSession: true,
          nextSession: null,
          messageText: `${selectedOption.pickupName}から${selectedOption.dropoffName}までの予約を取り消しました。`
        };
      }

      if (understanding.confirmation === "NO") {
        session.phase = "ASK_CANCEL_TARGET";
        session.cancellation.selectedRequestId = null;
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: buildCancellationSelectionPrompt(options, { timeZone })
        };
      }

      const reselection = resolveCancellationSelection({
        text: messageText,
        options
      });
      if (reselection) {
        session.cancellation.selectedRequestId = reselection.requestId;
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: buildCancellationConfirmPrompt(reselection, { timeZone })
        };
      }

      return {
        handled: true,
        clearSession: false,
        nextSession: session,
        messageText: "予約を取り消しますか？「はい」または「いいえ」でお答えください。"
      };
    }

    case "REGISTER_PHONE": {
      const normalizedPhoneE164 = parsePhoneNumberCandidate(messageText, defaultCountryCode);
      if (!normalizedPhoneE164) {
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: "電話番号を確認できませんでした。例: 080-1234-5678"
        };
      }
      session.registration.phoneNumber = normalizedPhoneE164;

      const resolvedName = session.registration.name || registration.userName;
      if (!resolvedName) {
        session.phase = "REGISTER_NAME";
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: "ありがとうございます。続いてお名前を入力してください。"
        };
      }

      try {
        registerLineMiniAppUser({
          repository,
          lineUserId,
          displayName,
          name: resolvedName,
          phoneNumber: normalizedPhoneE164,
          defaultCountryCode
        });
      } catch {
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: "登録に失敗しました。電話番号を確認してもう一度入力してください。"
        };
      }

      session.registration.name = resolvedName;
      session.phase = "ASK_PICKUP";
      return {
        handled: true,
        clearSession: false,
        nextSession: session,
        messageText: "登録しました。バス停の予約をします。どこから乗りたいですか？"
      };
    }

    case "REGISTER_NAME": {
      const name = parseNameCandidate(messageText);
      if (!name) {
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: "お名前を入力してください。（例: 山田 花子）"
        };
      }
      session.registration.name = name;

      const resolvedPhone = session.registration.phoneNumber || registration.normalizedPhoneE164;
      if (!resolvedPhone) {
        session.phase = "REGISTER_PHONE";
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: "ありがとうございます。電話番号を入力してください。"
        };
      }

      try {
        registerLineMiniAppUser({
          repository,
          lineUserId,
          displayName,
          name,
          phoneNumber: resolvedPhone,
          defaultCountryCode
        });
      } catch {
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: "登録に失敗しました。お名前を確認してもう一度入力してください。"
        };
      }

      session.registration.phoneNumber = resolvedPhone;
      session.phase = "ASK_PICKUP";
      return {
        handled: true,
        clearSession: false,
        nextSession: session,
        messageText: "登録しました。バス停の予約をします。どこから乗りたいですか？"
      };
    }

    case "ASK_PICKUP": {
      const pickupCandidates = compositePickupCandidates.length ? compositePickupCandidates : stopCandidates;
      session.prefill.dropoffQuery =
        compositeQueries.dropoffQuery && compositeDropoffCandidates.length ? compositeQueries.dropoffQuery : null;

      if (!pickupCandidates.length) {
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: "乗車するバス停名が見つかりませんでした。もう一度入力してください。"
        };
      }
      if (shouldAskStopDisambiguation(pickupCandidates)) {
        session.phase = "DISAMBIG_PICKUP";
        session.pending = {
          field: "pickup",
          options: pickupCandidates,
          selectedStopId: null,
          selectedOption: null
        };
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: buildDisambiguationPrompt(pickupCandidates)
        };
      }
      const selected = pickupCandidates[0];
      session.phase = "CONFIRM_PICKUP";
      session.pending = {
        field: "pickup",
        options: pickupCandidates,
        selectedStopId: selected.stopId,
        selectedOption: null
      };
      return {
        handled: true,
        clearSession: false,
        nextSession: session,
        messageText: buildStopConfirmationPrompt(selected.name)
      };
    }

    case "DISAMBIG_PICKUP": {
      const selected = resolveBestCandidate({
        text: messageText,
        candidates: pendingCandidates,
        selectedStopIdFromNlu: understanding.selectedStopId
      });
      if (!selected) {
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: `候補から選んでください。${buildDisambiguationPrompt(pendingCandidates)}`
        };
      }
      session.phase = "CONFIRM_PICKUP";
      session.pending = {
        field: "pickup",
        options: pendingCandidates,
        selectedStopId: selected.stopId,
        selectedOption: null
      };
      return {
        handled: true,
        clearSession: false,
        nextSession: session,
        messageText: buildStopConfirmationPrompt(selected.name)
      };
    }

    case "CONFIRM_PICKUP": {
      if (understanding.confirmation === "YES") {
        const selectedStopId = session.pending?.selectedStopId;
        if (!selectedStopId) {
          session.phase = "ASK_PICKUP";
          return {
            handled: true,
            clearSession: false,
            nextSession: session,
            messageText: "もう一度、乗車するバス停を入力してください。"
          };
        }
        session.slots.pickupStopId = selectedStopId;
        const prefilledDropoffQuery = session.prefill?.dropoffQuery;
        session.prefill.dropoffQuery = null;
        if (prefilledDropoffQuery) {
          const prefilledCandidates = buildStopCandidates(allStops, prefilledDropoffQuery, STOP_CANDIDATE_LIMIT)
            .filter((candidate) => candidate.stopId !== selectedStopId);
          if (prefilledCandidates.length) {
            if (shouldAskStopDisambiguation(prefilledCandidates)) {
              session.phase = "DISAMBIG_DROPOFF";
              session.pending = {
                field: "dropoff",
                options: prefilledCandidates,
                selectedStopId: null,
                selectedOption: null
              };
              return {
                handled: true,
                clearSession: false,
                nextSession: session,
                messageText: buildDisambiguationPrompt(prefilledCandidates)
              };
            }
            const selectedDropoff = prefilledCandidates[0];
            session.phase = "CONFIRM_DROPOFF";
            session.pending = {
              field: "dropoff",
              options: prefilledCandidates,
              selectedStopId: selectedDropoff.stopId,
              selectedOption: null
            };
            return {
              handled: true,
              clearSession: false,
              nextSession: session,
              messageText: buildStopConfirmationPrompt(selectedDropoff.name)
            };
          }
        }

        session.phase = "ASK_DROPOFF";
        session.pending = {
          field: null,
          options: [],
          selectedStopId: null,
          selectedOption: null
        };
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: "どこまで行きたいですか？"
        };
      }

      if (understanding.confirmation === "NO") {
        session.phase = "ASK_PICKUP";
        session.prefill.dropoffQuery = null;
        session.pending = {
          field: null,
          options: [],
          selectedStopId: null,
          selectedOption: null
        };
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: "承知しました。どこから乗りたいですか？"
        };
      }

      const freshCandidates =
        compositePickupCandidates.length ? compositePickupCandidates : buildStopCandidates(allStops, messageText, STOP_CANDIDATE_LIMIT);
      session.prefill.dropoffQuery =
        compositeQueries.dropoffQuery && compositeDropoffCandidates.length ? compositeQueries.dropoffQuery : null;
      if (!freshCandidates.length) {
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: "はい/いいえでお答えいただくか、別の乗車バス停を入力してください。"
        };
      }
      if (shouldAskStopDisambiguation(freshCandidates)) {
        session.phase = "DISAMBIG_PICKUP";
        session.pending = {
          field: "pickup",
          options: freshCandidates,
          selectedStopId: null,
          selectedOption: null
        };
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: buildDisambiguationPrompt(freshCandidates)
        };
      }

      const selected = freshCandidates[0];
      session.pending = {
        field: "pickup",
        options: freshCandidates,
        selectedStopId: selected.stopId,
        selectedOption: null
      };
      return {
        handled: true,
        clearSession: false,
        nextSession: session,
        messageText: buildStopConfirmationPrompt(selected.name)
      };
    }

    case "ASK_DROPOFF": {
      const dropoffCandidates = compositeDropoffCandidates.length ? compositeDropoffCandidates : stopCandidates;
      if (!dropoffCandidates.length) {
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: "降車するバス停名が見つかりませんでした。もう一度入力してください。"
        };
      }
      if (shouldAskStopDisambiguation(dropoffCandidates)) {
        session.phase = "DISAMBIG_DROPOFF";
        session.pending = {
          field: "dropoff",
          options: dropoffCandidates,
          selectedStopId: null,
          selectedOption: null
        };
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: buildDisambiguationPrompt(dropoffCandidates)
        };
      }
      const selected = dropoffCandidates[0];
      session.phase = "CONFIRM_DROPOFF";
      session.pending = {
        field: "dropoff",
        options: dropoffCandidates,
        selectedStopId: selected.stopId,
        selectedOption: null
      };
      return {
        handled: true,
        clearSession: false,
        nextSession: session,
        messageText: buildStopConfirmationPrompt(selected.name)
      };
    }

    case "DISAMBIG_DROPOFF": {
      const selected = resolveBestCandidate({
        text: messageText,
        candidates: pendingCandidates,
        selectedStopIdFromNlu: understanding.selectedStopId
      });
      if (!selected) {
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: `候補から選んでください。${buildDisambiguationPrompt(pendingCandidates)}`
        };
      }
      session.phase = "CONFIRM_DROPOFF";
      session.pending = {
        field: "dropoff",
        options: pendingCandidates,
        selectedStopId: selected.stopId,
        selectedOption: null
      };
      return {
        handled: true,
        clearSession: false,
        nextSession: session,
        messageText: buildStopConfirmationPrompt(selected.name)
      };
    }

    case "CONFIRM_DROPOFF": {
      if (understanding.confirmation === "YES") {
        const selectedStopId = session.pending?.selectedStopId;
        if (!selectedStopId) {
          session.phase = "ASK_DROPOFF";
          return {
            handled: true,
            clearSession: false,
            nextSession: session,
            messageText: "もう一度、降車するバス停を入力してください。"
          };
        }
        if (session.slots.pickupStopId && selectedStopId === session.slots.pickupStopId) {
          session.phase = "ASK_DROPOFF";
          session.pending = {
            field: null,
            options: [],
            selectedStopId: null,
            selectedOption: null
          };
          return {
            handled: true,
            clearSession: false,
            nextSession: session,
            messageText: "乗車バス停と同じ停留所は指定できません。別の降車バス停を入力してください。"
          };
        }

        session.slots.dropoffStopId = selectedStopId;
        session.pending = {
          field: null,
          options: [],
          selectedStopId: null,
          selectedOption: null
        };

        if (session.slots.desiredAt && session.slots.partySize) {
          return proposeWithCurrentSlots();
        }
        if (!session.slots.desiredAt && session.slots.partySize) {
          session.phase = "ASK_TIME";
          return {
            handled: true,
            clearSession: false,
            nextSession: session,
            messageText: "何時に乗りたいですか？"
          };
        }
        if (session.slots.desiredAt && !session.slots.partySize) {
          session.phase = "ASK_PARTY";
          return {
            handled: true,
            clearSession: false,
            nextSession: session,
            messageText: "何名乗りますか？"
          };
        }

        session.phase = "ASK_TIME_AND_PARTY";
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: buildTimeAndPartyPrompt()
        };
      }

      if (understanding.confirmation === "NO") {
        session.phase = "ASK_DROPOFF";
        session.pending = {
          field: null,
          options: [],
          selectedStopId: null,
          selectedOption: null
        };
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: "承知しました。どこまで行きたいですか？"
        };
      }

      const freshCandidates =
        compositeDropoffCandidates.length ? compositeDropoffCandidates : buildStopCandidates(allStops, messageText, STOP_CANDIDATE_LIMIT);
      if (!freshCandidates.length) {
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: "はい/いいえでお答えいただくか、別の降車バス停を入力してください。"
        };
      }
      if (shouldAskStopDisambiguation(freshCandidates)) {
        session.phase = "DISAMBIG_DROPOFF";
        session.pending = {
          field: "dropoff",
          options: freshCandidates,
          selectedStopId: null,
          selectedOption: null
        };
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: buildDisambiguationPrompt(freshCandidates)
        };
      }

      const selected = freshCandidates[0];
      session.pending = {
        field: "dropoff",
        options: freshCandidates,
        selectedStopId: selected.stopId,
        selectedOption: null
      };
      return {
        handled: true,
        clearSession: false,
        nextSession: session,
        messageText: buildStopConfirmationPrompt(selected.name)
      };
    }

    case "ASK_TIME_AND_PARTY": {
      if (understanding.desiredAtIso) {
        session.slots.desiredAt = understanding.desiredAtIso;
      }
      if (understanding.desiredMode) {
        session.slots.desiredMode = understanding.desiredMode;
      }
      if (understanding.partySize) {
        session.slots.partySize = understanding.partySize;
      }

      if (!session.slots.desiredAt && !session.slots.partySize) {
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: "何時ごろ乗りたいですか？あわせて人数も教えてください。"
        };
      }

      if (!session.slots.desiredAt) {
        session.phase = "ASK_TIME";
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: "何時に乗りたいですか？"
        };
      }

      if (!session.slots.partySize) {
        session.phase = "ASK_PARTY";
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: "何名乗りますか？"
        };
      }

      return proposeWithCurrentSlots();
    }

    case "ASK_TIME": {
      if (!understanding.desiredAtIso) {
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: "何時に乗りたいですか？（例: 12時、12:30、昼ごろ）"
        };
      }
      session.slots.desiredAt = understanding.desiredAtIso;
      if (understanding.desiredMode) {
        session.slots.desiredMode = understanding.desiredMode;
      }

      if (!session.slots.partySize) {
        session.phase = "ASK_PARTY";
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: "何名乗りますか？"
        };
      }

      return proposeWithCurrentSlots();
    }

    case "ASK_PARTY": {
      if (!understanding.partySize) {
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: "人数を教えてください。（例: 1名、2名、3名）"
        };
      }
      session.slots.partySize = understanding.partySize;

      if (!session.slots.desiredAt) {
        session.phase = "ASK_TIME";
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: "何時に乗りたいですか？"
        };
      }

      return proposeWithCurrentSlots();
    }

    case "CONFIRM_BOOKING": {
      if (understanding.confirmation !== "YES") {
        if (understanding.confirmation === "NO") {
          session.phase = "ASK_TIME_AND_PARTY";
          session.pending = {
            field: null,
            options: [],
            selectedStopId: null,
            selectedOption: null
          };
          return {
            handled: true,
            clearSession: false,
            nextSession: session,
            messageText: "承知しました。時間または人数を変更します。何名、何時に乗りたいですか？"
          };
        }
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: "予約してよろしいですか？「はい」または「いいえ」でお答えください。"
        };
      }

      const selectedOption = session.pending?.selectedOption;
      if (!selectedOption) {
        session.phase = "ASK_TIME_AND_PARTY";
        return {
          handled: true,
          clearSession: false,
          nextSession: session,
          messageText: "予約候補の有効期限が切れました。もう一度、何名・何時をご入力ください。"
        };
      }

      const selectedRequestType =
        normalizeTrimmedText(selectedOption.requestType).toUpperCase() === "ARRIVE_BY"
          ? "ARRIVE_BY"
          : normalizeTrimmedText(selectedOption.requestType).toUpperCase() === "ASAP"
            ? "ASAP"
            : "DEPART_AT";
      const selectedDesiredAt = toIsoString(selectedOption.desiredAt ?? session.slots.desiredAt);

      const createResult = await createRideRequest({
        repository,
        serviceProfileId,
        tenantId,
        requesterId,
        pickup: { mode: "FIXED_STOP", stopId: session.slots.pickupStopId },
        dropoff: { mode: "FIXED_STOP", stopId: session.slots.dropoffStopId },
        partySize: selectedOption.partySize,
        passenger,
        channel: "LINE_CHAT",
        requestType: selectedRequestType,
        desiredPickupAt: selectedRequestType === "DEPART_AT" ? selectedDesiredAt : null,
        desiredDropoffAt: selectedRequestType === "ARRIVE_BY" ? selectedDesiredAt : null,
        preferredVehicleId: selectedOption.vehicleId,
        context
      });

      const rideRequest = createResult?.rideRequest ?? null;
      const pickupName = resolveStopName(repository, session.slots.pickupStopId);
      const dropoffName = resolveStopName(repository, session.slots.dropoffStopId);
      const plannedPickupLabel = formatTimeOnly(
        rideRequest?.assignment?.plannedPickupAt ?? selectedOption.plannedPickupAt,
        timeZone
      );
      const plannedDropoffLabel = formatTimeOnly(
        rideRequest?.assignment?.plannedDropoffAt ?? selectedOption.plannedDropoffAt,
        timeZone
      );
      const desiredLabel = formatDateTime(selectedDesiredAt, timeZone);

      applySessionMutation({
        repository,
        lineUserId,
        session: null,
        clearSession: true
      });

      return {
        handled: true,
        clearSession: true,
        nextSession: null,
        resultStatus: typeof createResult?.status === "string" ? createResult.status : null,
        createdRideRequest: rideRequest,
        messageText:
          `${pickupName}から${dropoffName}まで、${desiredLabel}に${selectedOption.partySize}名、` +
          `${plannedPickupLabel}で予約しました。降車予定は${plannedDropoffLabel}です。`
      };
    }

    default: {
      session.phase = "ASK_PICKUP";
      return {
        handled: true,
        clearSession: false,
        nextSession: session,
        messageText: "バス停の予約をします。どこから乗りたいですか？"
      };
    }
  }
}

export function persistLineChatBookingSession({
  repository,
  lineUserId,
  result
}) {
  if (!result?.handled) {
    return;
  }
  applySessionMutation({
    repository,
    lineUserId,
    session: result.nextSession,
    clearSession: result.clearSession === true
  });
}
