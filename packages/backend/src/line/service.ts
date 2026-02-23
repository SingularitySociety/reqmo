import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { normalizePhoneNumber } from "../telephony/phoneNumber.ts";

const LINE_REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";
const ACTIVE_RIDE_STATUSES = new Set([
  "REQUESTED",
  "ASSIGNED",
  "PICKUP_PENDING",
  "PICKED_UP",
  "ONBOARD",
  "IN_PROGRESS"
]);
const STATUS_LABELS = {
  REQUESTED: "受付済み",
  ASSIGNED: "配車確定",
  PICKUP_PENDING: "迎車中",
  PICKED_UP: "乗車中",
  ONBOARD: "乗車中",
  IN_PROGRESS: "運行中",
  COMPLETED: "完了",
  CANCELLED: "取消"
};

function normalizeTrimmedText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeHttpUrl(value) {
  const text = normalizeTrimmedText(value);
  if (!text) {
    return "";
  }
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeOfficialAccountId(value) {
  const text = normalizeTrimmedText(value);
  if (!text) {
    return "";
  }
  if (text.startsWith("@")) {
    return text;
  }
  return `@${text.replace(/^@+/, "")}`;
}

function normalizePublicBaseUrl(requestBaseUrl = "") {
  const normalized = normalizeHttpUrl(requestBaseUrl);
  if (!normalized) {
    return "";
  }
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function buildFriendAddUrl({ friendAddUrl = "", officialAccountId = "" }) {
  const configured = normalizeHttpUrl(friendAddUrl);
  if (configured) {
    return configured;
  }
  const normalizedAccountId = normalizeOfficialAccountId(officialAccountId);
  if (!normalizedAccountId) {
    return "";
  }
  return `https://line.me/R/ti/p/${encodeURIComponent(normalizedAccountId)}`;
}

function buildMiniAppUrl({ miniAppUrl = "", publicBaseUrl = "" }) {
  const configured = normalizeHttpUrl(miniAppUrl);
  if (configured) {
    return configured;
  }
  const base = normalizePublicBaseUrl(publicBaseUrl);
  if (!base) {
    return "";
  }
  return new URL("line-reservation/", base).toString();
}

function toIsoOrNull(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function toTimestamp(value) {
  const iso = toIsoOrNull(value);
  if (!iso) {
    return Number.POSITIVE_INFINITY;
  }
  return new Date(iso).getTime();
}

function formatDateTime(value) {
  const iso = toIsoOrNull(value);
  if (!iso) {
    return "時刻未定";
  }
  const date = new Date(iso);
  return date.toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function normalizeLineUserId(lineUserId) {
  return normalizeTrimmedText(lineUserId);
}

function createLineScopedUserId(lineUserId) {
  const digest = createHash("sha256")
    .update(`line:${lineUserId}`)
    .digest("hex")
    .slice(0, 24);
  return `line_user_${digest}`;
}

function resolveRequestSortTime(request) {
  return Math.min(
    toTimestamp(request?.assignment?.plannedPickupAt),
    toTimestamp(request?.timeWindow?.desiredPickupAt),
    toTimestamp(request?.timeWindow?.desiredDropoffAt),
    toTimestamp(request?.createdAt)
  );
}

function resolveRequestTimeLabel(request) {
  if (request?.assignment?.plannedPickupAt) {
    return `乗車予定 ${formatDateTime(request.assignment.plannedPickupAt)}`;
  }
  if (request?.timeWindow?.desiredPickupAt) {
    return `希望乗車 ${formatDateTime(request.timeWindow.desiredPickupAt)}`;
  }
  if (request?.timeWindow?.desiredDropoffAt) {
    return `希望降車 ${formatDateTime(request.timeWindow.desiredDropoffAt)}`;
  }
  return `受付 ${formatDateTime(request?.createdAt)}`;
}

function resolveStatusLabel(status) {
  const normalized = normalizeTrimmedText(status).toUpperCase();
  return STATUS_LABELS[normalized] ?? (normalized || "不明");
}

function formatPoint(point) {
  if (!point || !Number.isFinite(Number(point.lat)) || !Number.isFinite(Number(point.lng))) {
    return "地点未設定";
  }
  return `${Number(point.lat).toFixed(5)},${Number(point.lng).toFixed(5)}`;
}

function resolveLocationLabel(repository, location) {
  if (!location || typeof location !== "object") {
    return "未設定";
  }
  const mode = normalizeTrimmedText(location.mode).toUpperCase();
  if (mode === "FIXED_STOP") {
    const stopId = normalizeTrimmedText(location.stopId);
    if (!stopId) {
      return "停留所未設定";
    }
    const stop = typeof repository?.findStopById === "function" ? repository.findStopById(stopId) : null;
    return stop?.name ?? stopId;
  }
  if (mode === "FREE_POINT") {
    const title = normalizeTrimmedText(location.title);
    if (title) {
      return title;
    }
    return formatPoint(location.point);
  }
  return normalizeTrimmedText(location.title) || "未設定";
}

function normalizeDisplayName(displayName, lineUserId) {
  const normalized = normalizeTrimmedText(displayName);
  if (normalized) {
    return normalized;
  }
  return `LINE利用者(${lineUserId.slice(-6)})`;
}

function normalizeMessageText(text) {
  return normalizeTrimmedText(text).replace(/\s+/g, " ");
}

export function resolveLineConfig({ env = process.env, requestBaseUrl = "" } = {}) {
  const publicBaseUrl = normalizePublicBaseUrl(
    env.LINE_PUBLIC_BASE_URL || requestBaseUrl || ""
  );
  const officialAccountId = normalizeOfficialAccountId(env.LINE_OFFICIAL_ACCOUNT_ID);
  const friendAddUrl = buildFriendAddUrl({
    friendAddUrl: env.LINE_FRIEND_ADD_URL,
    officialAccountId
  });
  const miniAppUrl = buildMiniAppUrl({
    miniAppUrl: env.LINE_MINIAPP_URL,
    publicBaseUrl
  });

  return {
    channelSecret: normalizeTrimmedText(env.LINE_CHANNEL_SECRET),
    channelAccessToken: normalizeTrimmedText(env.LINE_CHANNEL_ACCESS_TOKEN),
    liffId: normalizeTrimmedText(env.LINE_LIFF_ID),
    officialAccountId,
    friendAddUrl,
    miniAppUrl,
    publicBaseUrl,
    botEnabled:
      Boolean(normalizeTrimmedText(env.LINE_CHANNEL_SECRET)) &&
      Boolean(normalizeTrimmedText(env.LINE_CHANNEL_ACCESS_TOKEN))
  };
}

export function buildMiniAppUrlWithLineUser(miniAppUrl, lineUserId) {
  const normalizedMiniAppUrl = normalizeHttpUrl(miniAppUrl);
  const normalizedLineUserId = normalizeLineUserId(lineUserId);
  if (!normalizedMiniAppUrl) {
    return "";
  }
  if (!normalizedLineUserId) {
    return normalizedMiniAppUrl;
  }
  const url = new URL(normalizedMiniAppUrl);
  url.searchParams.set("lineUserId", normalizedLineUserId);
  return url.toString();
}

export function verifyLineWebhookSignature({ channelSecret, rawBody, signature }) {
  const secret = normalizeTrimmedText(channelSecret);
  const providedSignature = normalizeTrimmedText(signature);
  if (!secret || !providedSignature) {
    return false;
  }
  const payload = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(typeof rawBody === "string" ? rawBody : "", "utf-8");
  const expected = createHmac("sha256", secret).update(payload).digest("base64");
  const expectedBuffer = Buffer.from(expected, "utf-8");
  const providedBuffer = Buffer.from(providedSignature, "utf-8");
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

export function parseLineWebhookPayload(rawBody) {
  const payloadText = Buffer.isBuffer(rawBody)
    ? rawBody.toString("utf-8")
    : typeof rawBody === "string"
      ? rawBody
      : "";
  const parsed = JSON.parse(payloadText || "{}");
  const events = Array.isArray(parsed?.events) ? parsed.events : [];
  return {
    ...parsed,
    events
  };
}

export function ensureLineUserIdentity({
  repository,
  lineUserId,
  displayName = null,
  source = "LINE_MINIAPP"
}) {
  const normalizedLineUserId = normalizeLineUserId(lineUserId);
  if (!normalizedLineUserId) {
    throw new Error("lineUserId is required");
  }

  const existingIdentity =
    typeof repository?.getLineIdentity === "function"
      ? repository.getLineIdentity(normalizedLineUserId)
      : null;
  let user =
    typeof repository?.findUserByLine === "function"
      ? repository.findUserByLine(normalizedLineUserId)
      : null;

  if (!user) {
    const fallbackUserId = existingIdentity?.userId ?? createLineScopedUserId(normalizedLineUserId);
    user =
      typeof repository?.listUsers === "function"
        ? repository.listUsers().find((candidate) => candidate.id === fallbackUserId) ?? null
        : null;
    if (!user) {
      if (typeof repository?.addUser !== "function") {
        throw new Error("repository.addUser is required for LINE identity provisioning");
      }
      user = repository.addUser({
        id: fallbackUserId,
        name: normalizeDisplayName(displayName, normalizedLineUserId)
      });
    }
  }

  if (typeof repository?.linkLineIdentity !== "function") {
    throw new Error("repository.linkLineIdentity is required for LINE identity linkage");
  }

  const identity = repository.linkLineIdentity({
    userId: user.id,
    lineUserId: normalizedLineUserId,
    source,
    verified: true,
    displayName: normalizeTrimmedText(displayName) || null
  });

  return {
    user,
    identity
  };
}

export function listLineUserRideRequests({
  repository,
  userId,
  limit = 3
}) {
  const normalizedLimit = Math.min(Math.max(Math.trunc(Number(limit) || 3), 1), 10);
  const requests = typeof repository?.listRideRequests === "function"
    ? repository.listRideRequests().filter((request) => request.requesterId === userId)
    : [];

  const active = requests
    .filter((request) => ACTIVE_RIDE_STATUSES.has(normalizeTrimmedText(request?.status).toUpperCase()))
    .sort((left, right) => resolveRequestSortTime(left) - resolveRequestSortTime(right))
    .slice(0, normalizedLimit);

  if (active.length) {
    return active;
  }

  return requests
    .sort((left, right) => resolveRequestSortTime(right) - resolveRequestSortTime(left))
    .slice(0, normalizedLimit);
}

export function buildLineRideSummaryLines({ repository, rideRequest, index }) {
  const rideLabel = `${index + 1}. ${resolveRequestTimeLabel(rideRequest)}`;
  const routeLabel = `${resolveLocationLabel(repository, rideRequest.pickup)} -> ${resolveLocationLabel(
    repository,
    rideRequest.dropoff
  )}`;
  const statusLabel = `状態: ${resolveStatusLabel(rideRequest.status)}`;
  const requestIdLabel = `予約ID: ${rideRequest.id}`;
  return [rideLabel, routeLabel, statusLabel, requestIdLabel];
}

export function buildReservationSummaryText({
  repository,
  requests,
  displayName = ""
}) {
  const lines = [];
  const headingName = normalizeTrimmedText(displayName);
  lines.push(headingName ? `${headingName}さんの予約状況です。` : "予約状況です。");

  if (!Array.isArray(requests) || requests.length === 0) {
    lines.push("現在、確認できる予約はありません。");
    lines.push("新規予約はミニアプリからお願いします。");
    return lines.join("\n");
  }

  lines.push(`直近${requests.length}件を表示します。`);
  requests.forEach((request, index) => {
    lines.push(...buildLineRideSummaryLines({ repository, rideRequest: request, index }));
  });
  return lines.join("\n");
}

export function parseLineMessageCommand(text) {
  const normalized = normalizeMessageText(text);
  if (!normalized) {
    return { type: "UNKNOWN" };
  }

  const reservationPattern = /^(予約|予約確認|予約状況|確認)$/;
  if (reservationPattern.test(normalized)) {
    return { type: "RESERVATION" };
  }

  if (/^(ヘルプ|help|\?)$/i.test(normalized)) {
    return { type: "HELP" };
  }

  if (/^(ミニアプリ|miniapp)$/i.test(normalized)) {
    return { type: "OPEN_MINIAPP" };
  }

  const linkPattern = /^(連携|link)\s+(.+)$/i.exec(normalized);
  if (linkPattern) {
    return {
      type: "LINK_PHONE",
      phoneNumber: normalizeTrimmedText(linkPattern[2])
    };
  }

  return { type: "UNKNOWN" };
}

export function linkLineUserByPhone({
  repository,
  lineUserId,
  phoneNumber,
  defaultCountryCode = "+81",
  displayName = null
}) {
  const normalizedLineUserId = normalizeLineUserId(lineUserId);
  if (!normalizedLineUserId) {
    throw new Error("lineUserId is required");
  }
  const normalizedPhoneE164 = normalizePhoneNumber(phoneNumber, defaultCountryCode);
  if (!normalizedPhoneE164) {
    throw new Error("phoneNumber is invalid");
  }
  if (typeof repository?.findUserByPhone !== "function") {
    throw new Error("repository.findUserByPhone is required");
  }
  const user = repository.findUserByPhone(normalizedPhoneE164);
  if (!user) {
    return {
      status: "NOT_FOUND",
      normalizedPhoneE164
    };
  }
  if (typeof repository?.linkLineIdentity !== "function") {
    throw new Error("repository.linkLineIdentity is required");
  }
  const identity = repository.linkLineIdentity({
    userId: user.id,
    lineUserId: normalizedLineUserId,
    source: "LINE_MINIAPP_PHONE_LINK",
    verified: true,
    displayName: normalizeTrimmedText(displayName) || null
  });
  return {
    status: "LINKED",
    normalizedPhoneE164,
    user,
    identity
  };
}

export function buildLineHelpMessage({ miniAppUrl = "" }) {
  const lines = [
    "使い方:",
    "・「予約確認」: 直近の予約を表示",
    "・「連携 08012345678」: 電話番号で利用者連携"
  ];
  if (miniAppUrl) {
    lines.push(`・ミニアプリ: ${miniAppUrl}`);
  }
  return lines.join("\n");
}

export function buildLineWelcomeMessages({ miniAppUrl = "" }) {
  const helpText = buildLineHelpMessage({ miniAppUrl });
  const quickReplyItems = [
    {
      type: "action",
      action: {
        type: "message",
        label: "予約確認",
        text: "予約確認"
      }
    }
  ];
  if (miniAppUrl) {
    quickReplyItems.push({
      type: "action",
      action: {
        type: "uri",
        label: "ミニアプリ",
        uri: miniAppUrl
      }
    });
  }
  return [
    {
      type: "text",
      text: "友だち追加ありがとうございます。予約確認をご利用いただけます。",
      quickReply: {
        items: quickReplyItems
      }
    },
    {
      type: "text",
      text: helpText
    }
  ];
}

export async function sendLineReplyMessage({
  channelAccessToken,
  replyToken,
  messages,
  fetchImpl = globalThis.fetch
}) {
  const token = normalizeTrimmedText(channelAccessToken);
  const normalizedReplyToken = normalizeTrimmedText(replyToken);
  const normalizedMessages = Array.isArray(messages) ? messages.filter(Boolean).slice(0, 5) : [];

  if (!token) {
    throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not configured");
  }
  if (!normalizedReplyToken) {
    throw new Error("replyToken is required");
  }
  if (!normalizedMessages.length) {
    throw new Error("at least one message is required");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available for LINE API call");
  }

  const response = await fetchImpl(LINE_REPLY_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      replyToken: normalizedReplyToken,
      messages: normalizedMessages
    })
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`LINE reply API failed: ${response.status} ${bodyText}`);
  }

  return {
    status: "SENT",
    count: normalizedMessages.length
  };
}
