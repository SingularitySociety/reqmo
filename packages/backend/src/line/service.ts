import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { deflateSync } from "node:zlib";

import { normalizePhoneNumber } from "../telephony/phoneNumber.ts";

const LINE_REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";
const LINE_RICHMENU_ENDPOINT = "https://api.line.me/v2/bot/richmenu";
const LINE_RICHMENU_ALIAS_ENDPOINT = "https://api.line.me/v2/bot/richmenu/alias";
const LINE_RICHMENU_CONTENT_BASE = "https://api-data.line.me/v2/bot/richmenu";
const RICH_MENU_WIDTH = 2500;
const RICH_MENU_HEIGHT = 843;
const DEFAULT_REGISTER_RICHMENU_ALIAS = "reqmo_register_v3";
const DEFAULT_RESERVATION_RICHMENU_ALIAS = "reqmo_reservation_v4";
const richMenuAliasCache = new Map();
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

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

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

function buildBusMapUrl({ busMapUrl = "", publicBaseUrl = "" }) {
  const configured = normalizeHttpUrl(busMapUrl);
  if (configured) {
    return configured;
  }
  const base = normalizePublicBaseUrl(publicBaseUrl);
  if (!base) {
    return "";
  }
  return new URL("line-bus-map/", base).toString();
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

function resolveRequestPickupAt(request) {
  return (
    request?.assignment?.plannedPickupAt ??
    request?.timeWindow?.desiredPickupAt ??
    request?.createdAt ??
    null
  );
}

function resolveRequestDropoffAt(request) {
  return (
    request?.assignment?.plannedDropoffAt ??
    request?.timeWindow?.desiredDropoffAt ??
    null
  );
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

function normalizePersonName(name) {
  return normalizeTrimmedText(name);
}

function appendMiniAppModeQuery(miniAppUrl, mode = "") {
  const normalizedUrl = normalizeHttpUrl(miniAppUrl);
  const normalizedMode = normalizeTrimmedText(mode);
  if (!normalizedUrl) {
    return "";
  }
  if (!normalizedMode) {
    return normalizedUrl;
  }
  const url = new URL(normalizedUrl);
  url.searchParams.set("mode", normalizedMode);
  return url.toString();
}

function parseHexColor(color, fallback = "#2f855a") {
  const normalized = normalizeTrimmedText(color).replace(/^#/, "");
  const safe = /^[0-9a-fA-F]{6}$/.test(normalized) ? normalized : fallback.replace(/^#/, "");
  return {
    r: Number.parseInt(safe.slice(0, 2), 16),
    g: Number.parseInt(safe.slice(2, 4), 16),
    b: Number.parseInt(safe.slice(4, 6), 16)
  };
}

const FONT_5X7 = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"]
};

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildPngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length >>> 0, 0);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

function setRgbPixel(rgb, width, height, x, y, color) {
  const px = Math.trunc(Number(x));
  const py = Math.trunc(Number(y));
  if (px < 0 || py < 0 || px >= width || py >= height) {
    return;
  }
  const offset = (py * width + px) * 3;
  rgb[offset] = color.r;
  rgb[offset + 1] = color.g;
  rgb[offset + 2] = color.b;
}

function drawRect(rgb, width, height, x, y, rectWidth, rectHeight, color) {
  const startX = Math.max(0, Math.trunc(Number(x)));
  const startY = Math.max(0, Math.trunc(Number(y)));
  const endX = Math.min(width, startX + Math.max(0, Math.trunc(Number(rectWidth))));
  const endY = Math.min(height, startY + Math.max(0, Math.trunc(Number(rectHeight))));
  for (let py = startY; py < endY; py += 1) {
    for (let px = startX; px < endX; px += 1) {
      setRgbPixel(rgb, width, height, px, py, color);
    }
  }
}

function drawText({
  rgb,
  width,
  height,
  text = "",
  centerX = 0,
  centerY = 0,
  scale = 12,
  color = { r: 255, g: 255, b: 255 }
}) {
  const normalizedText = normalizeTrimmedText(text).toUpperCase();
  if (!normalizedText) {
    return;
  }
  const safeScale = Math.max(2, Math.trunc(Number(scale) || 12));
  const glyphWidth = 5 * safeScale;
  const glyphHeight = 7 * safeScale;
  const gap = safeScale;
  const totalWidth = normalizedText.length * glyphWidth + (normalizedText.length - 1) * gap;
  const startX = Math.trunc(Number(centerX) - totalWidth / 2);
  const startY = Math.trunc(Number(centerY) - glyphHeight / 2);

  let xOffset = startX;
  for (const char of normalizedText) {
    const pattern = FONT_5X7[char] ?? FONT_5X7[" "];
    for (let row = 0; row < pattern.length; row += 1) {
      const rowBits = pattern[row];
      for (let col = 0; col < rowBits.length; col += 1) {
        if (rowBits[col] !== "1") {
          continue;
        }
        drawRect(
          rgb,
          width,
          height,
          xOffset + col * safeScale,
          startY + row * safeScale,
          safeScale,
          safeScale,
          color
        );
      }
    }
    xOffset += glyphWidth + gap;
  }
}

function drawCircle(rgb, width, height, centerX, centerY, radius, color) {
  const cx = Math.trunc(Number(centerX));
  const cy = Math.trunc(Number(centerY));
  const r = Math.max(1, Math.trunc(Number(radius)));
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      if (dx * dx + dy * dy <= r * r) {
        setRgbPixel(rgb, width, height, cx + dx, cy + dy, color);
      }
    }
  }
}

function drawIcon({
  rgb,
  width,
  height,
  segment,
  icon = "DOT",
  color = { r: 255, g: 255, b: 255 }
}) {
  if (!segment) {
    return;
  }
  const segmentWidth = Math.max(1, segment.end - segment.start);
  const centerX = Math.floor((segment.start + segment.end) / 2);
  const centerY = Math.floor(height / 2);
  const unit = Math.max(8, Math.floor(Math.min(segmentWidth, height) / 10));
  const normalizedIcon = normalizeTrimmedText(icon).toUpperCase();

  if (normalizedIcon === "CHAT") {
    drawRect(rgb, width, height, centerX - unit * 3, centerY - unit * 2, unit * 6, unit * 4, color);
    drawRect(rgb, width, height, centerX - unit, centerY + unit * 2, unit * 2, unit, color);
    return;
  }
  if (normalizedIcon === "MINIAPP") {
    drawRect(rgb, width, height, centerX - unit * 3, centerY - unit * 3, unit * 6, unit * 6, color);
    drawRect(rgb, width, height, centerX - unit * 2, centerY - unit * 2, unit * 4, unit * 4, parseHexColor("#0f172a"));
    drawCircle(rgb, width, height, centerX, centerY + unit * 2, Math.max(2, Math.floor(unit * 0.45)), color);
    return;
  }
  if (normalizedIcon === "STATUS") {
    drawRect(rgb, width, height, centerX - unit * 3, centerY - unit * 3, unit * 6, unit * 6, color);
    drawRect(rgb, width, height, centerX - unit * 2, centerY - unit * 2, unit * 3, unit * 0.8, parseHexColor("#0f172a"));
    drawRect(rgb, width, height, centerX - unit * 2, centerY - unit * 0.4, unit * 4, unit * 0.8, parseHexColor("#0f172a"));
    drawRect(rgb, width, height, centerX - unit * 2, centerY + unit * 1.2, unit * 2.5, unit * 0.8, parseHexColor("#0f172a"));
    return;
  }
  if (normalizedIcon === "PROFILE") {
    drawCircle(rgb, width, height, centerX, centerY - unit * 1.4, Math.max(2, Math.floor(unit * 1.3)), color);
    drawRect(rgb, width, height, centerX - unit * 2.2, centerY, unit * 4.4, unit * 3.1, color);
    return;
  }
  if (normalizedIcon === "BUS") {
    drawRect(rgb, width, height, centerX - unit * 3.5, centerY - unit * 2, unit * 7, unit * 4, color);
    drawRect(rgb, width, height, centerX - unit * 2.8, centerY - unit * 1.2, unit * 5.2, unit * 1.6, parseHexColor("#0f172a"));
    drawCircle(rgb, width, height, centerX - unit * 2, centerY + unit * 2.4, Math.max(2, Math.floor(unit * 0.9)), parseHexColor("#0f172a"));
    drawCircle(rgb, width, height, centerX + unit * 2, centerY + unit * 2.4, Math.max(2, Math.floor(unit * 0.9)), parseHexColor("#0f172a"));
    return;
  }
  if (normalizedIcon === "REGISTER") {
    drawRect(rgb, width, height, centerX - unit * 3, centerY - unit * 3, unit * 6, unit * 6, color);
    drawRect(rgb, width, height, centerX - unit * 2, centerY - unit * 1.8, unit * 2.8, unit * 0.8, parseHexColor("#0f172a"));
    drawRect(rgb, width, height, centerX - unit * 2, centerY - unit * 0.2, unit * 3.6, unit * 0.8, parseHexColor("#0f172a"));
    drawRect(rgb, width, height, centerX - unit * 0.8, centerY + unit * 1.4, unit * 2, unit * 0.8, parseHexColor("#0f172a"));
    drawRect(rgb, width, height, centerX - unit * 0.2, centerY + unit * 0.8, unit * 0.8, unit * 2, parseHexColor("#0f172a"));
    return;
  }
  if (normalizedIcon === "HELP") {
    drawCircle(rgb, width, height, centerX, centerY - unit * 0.4, Math.max(2, Math.floor(unit * 2.3)), color);
    drawRect(rgb, width, height, centerX - unit * 0.5, centerY - unit * 1.4, unit, unit * 2.2, parseHexColor("#0f172a"));
    drawCircle(rgb, width, height, centerX, centerY + unit * 1.8, Math.max(2, Math.floor(unit * 0.55)), parseHexColor("#0f172a"));
    return;
  }

  drawCircle(rgb, width, height, centerX, centerY, Math.max(2, Math.floor(unit * 1.8)), color);
}

function createStripedPng({
  width = RICH_MENU_WIDTH,
  height = RICH_MENU_HEIGHT,
  segments = [],
  labels = [],
  icons = []
} = {}) {
  const safeWidth = Number.isFinite(Number(width)) ? Math.max(1, Math.trunc(Number(width))) : RICH_MENU_WIDTH;
  const safeHeight = Number.isFinite(Number(height)) ? Math.max(1, Math.trunc(Number(height))) : RICH_MENU_HEIGHT;
  const normalizedSegments = Array.isArray(segments) && segments.length
    ? segments
    : [{ ratio: 1, color: "#2f855a" }];

  const ratioTotal = normalizedSegments.reduce((sum, item) => sum + Math.max(0, Number(item?.ratio) || 0), 0) || 1;
  const segmentBounds = [];
  let offset = 0;
  normalizedSegments.forEach((item, index) => {
    const ratio = Math.max(0, Number(item?.ratio) || 0);
    const widthForSegment =
      index === normalizedSegments.length - 1
        ? safeWidth - offset
        : Math.max(0, Math.round((safeWidth * ratio) / ratioTotal));
    const colors = parseHexColor(item?.color ?? "#2f855a");
    const end = Math.min(safeWidth, offset + widthForSegment);
    segmentBounds.push({
      start: offset,
      end: index === normalizedSegments.length - 1 ? safeWidth : end,
      ...colors
    });
    offset = end;
  });

  if (segmentBounds[segmentBounds.length - 1].end < safeWidth) {
    segmentBounds[segmentBounds.length - 1].end = safeWidth;
  }

  const rgb = Buffer.alloc(safeWidth * safeHeight * 3);
  for (const segment of segmentBounds) {
    for (let y = 0; y < safeHeight; y += 1) {
      for (let x = segment.start; x < segment.end; x += 1) {
        setRgbPixel(rgb, safeWidth, safeHeight, x, y, segment);
      }
    }
  }

  const separatorColor = parseHexColor("#ffffff");
  segmentBounds.forEach((segment, index) => {
    if (index === 0) {
      return;
    }
    drawRect(
      rgb,
      safeWidth,
      safeHeight,
      segment.start - 3,
      0,
      6,
      safeHeight,
      separatorColor
    );
  });

  const labelColor = parseHexColor("#ffffff");
  const normalizedLabels = Array.isArray(labels) ? labels : [];
  normalizedLabels.forEach((label, index) => {
    const targetIndex = Number.isFinite(Number(label?.segmentIndex))
      ? Math.trunc(Number(label.segmentIndex))
      : index;
    const segment = segmentBounds[targetIndex];
    if (!segment) {
      return;
    }
    const text = normalizeTrimmedText(label?.text);
    if (!text) {
      return;
    }
    const widthPerChar = Math.max(16, Math.floor((segment.end - segment.start) / Math.max(text.length * 6, 6)));
    const scale = Math.max(9, Math.min(20, Math.floor(widthPerChar)));
    drawText({
      rgb,
      width: safeWidth,
      height: safeHeight,
      text,
      centerX: Math.floor((segment.start + segment.end) / 2),
      centerY: Math.floor(safeHeight / 2),
      scale,
      color: labelColor
    });
  });

  const normalizedIcons = Array.isArray(icons) ? icons : [];
  normalizedIcons.forEach((icon, index) => {
    const targetIndex = Number.isFinite(Number(icon?.segmentIndex))
      ? Math.trunc(Number(icon.segmentIndex))
      : index;
    const segment = segmentBounds[targetIndex];
    if (!segment) {
      return;
    }
    drawIcon({
      rgb,
      width: safeWidth,
      height: safeHeight,
      segment,
      icon: icon?.icon,
      color: labelColor
    });
  });

  const rowBytes = 1 + safeWidth * 3;
  const raw = Buffer.alloc(rowBytes * safeHeight);
  for (let y = 0; y < safeHeight; y += 1) {
    const rowOffset = y * rowBytes;
    raw[rowOffset] = 0;
    const rgbOffset = y * safeWidth * 3;
    rgb.copy(raw, rowOffset + 1, rgbOffset, rgbOffset + safeWidth * 3);
  }
  const compressed = deflateSync(raw, { level: 9 });

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(safeWidth, 0);
  ihdr.writeUInt32BE(safeHeight, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    signature,
    buildPngChunk("IHDR", ihdr),
    buildPngChunk("IDAT", compressed),
    buildPngChunk("IEND", Buffer.alloc(0))
  ]);
}

async function callLineApi({
  channelAccessToken,
  url,
  method = "GET",
  body = null,
  headers = {},
  allowNotFound = false,
  parseJson = true,
  fetchImpl = globalThis.fetch
}) {
  const token = normalizeTrimmedText(channelAccessToken);
  if (!token) {
    throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not configured");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available for LINE API call");
  }

  const requestHeaders = {
    Authorization: `Bearer ${token}`,
    ...headers
  };
  const response = await fetchImpl(url, {
    method,
    headers: requestHeaders,
    body
  });
  if (allowNotFound && response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`LINE API request failed: ${response.status} ${responseText}`);
  }
  if (!parseJson) {
    return {
      ok: true
    };
  }
  const raw = await response.text();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

async function resolveRichMenuIdByAlias({
  channelAccessToken,
  aliasId,
  fetchImpl
}) {
  const alias = normalizeTrimmedText(aliasId);
  if (!alias) {
    throw new Error("aliasId is required");
  }
  if (richMenuAliasCache.has(alias)) {
    return richMenuAliasCache.get(alias);
  }
  const result = await callLineApi({
    channelAccessToken,
    url: `${LINE_RICHMENU_ALIAS_ENDPOINT}/${encodeURIComponent(alias)}`,
    allowNotFound: true,
    fetchImpl
  });
  const richMenuId = normalizeTrimmedText(result?.richMenuId);
  if (richMenuId) {
    richMenuAliasCache.set(alias, richMenuId);
    return richMenuId;
  }
  return "";
}

async function createRichMenuWithAlias({
  channelAccessToken,
  aliasId,
  menuPayload,
  imageContent,
  fetchImpl
}) {
  const created = await callLineApi({
    channelAccessToken,
    url: LINE_RICHMENU_ENDPOINT,
    method: "POST",
    body: JSON.stringify(menuPayload),
    headers: {
      "Content-Type": "application/json"
    },
    fetchImpl
  });
  const richMenuId = normalizeTrimmedText(created?.richMenuId);
  if (!richMenuId) {
    throw new Error("richMenuId is missing from LINE API response");
  }

  await callLineApi({
    channelAccessToken,
    url: `${LINE_RICHMENU_CONTENT_BASE}/${encodeURIComponent(richMenuId)}/content`,
    method: "POST",
    body: imageContent,
    headers: {
      "Content-Type": "image/png"
    },
    parseJson: false,
    fetchImpl
  });

  try {
    await callLineApi({
      channelAccessToken,
      url: LINE_RICHMENU_ALIAS_ENDPOINT,
      method: "POST",
      body: JSON.stringify({
        richMenuAliasId: aliasId,
        richMenuId
      }),
      headers: {
        "Content-Type": "application/json"
      },
      parseJson: false,
      fetchImpl
    });
  } catch {
    const existing = await resolveRichMenuIdByAlias({
      channelAccessToken,
      aliasId,
      fetchImpl
    });
    if (existing) {
      return existing;
    }
    throw new Error(`Failed to create rich menu alias: ${aliasId}`);
  }

  richMenuAliasCache.set(aliasId, richMenuId);
  return richMenuId;
}

function buildLineRegistrationRichMenu({ miniAppUrl }) {
  const registerUrl = appendMiniAppModeQuery(miniAppUrl, "register");
  return {
    menuPayload: {
      size: {
        width: RICH_MENU_WIDTH,
        height: RICH_MENU_HEIGHT
      },
      selected: false,
      name: "reqmo-registration-menu",
      chatBarText: "初回登録",
      areas: [
        {
          bounds: {
            x: 0,
            y: 0,
            width: 1250,
            height: RICH_MENU_HEIGHT
          },
          action: {
            type: "uri",
            uri: registerUrl
          }
        },
        {
          bounds: {
            x: 1250,
            y: 0,
            width: 1250,
            height: RICH_MENU_HEIGHT
          },
          action: {
            type: "message",
            text: "ヘルプ"
          }
        }
      ]
    },
    imageContent: createStripedPng({
      segments: [
        { ratio: 1, color: "#0f766e" },
        { ratio: 1, color: "#1d4ed8" }
      ],
      icons: [
        { segmentIndex: 0, icon: "REGISTER" },
        { segmentIndex: 1, icon: "HELP" }
      ]
    })
  };
}

function buildLineReservationRichMenu({ miniAppUrl, busMapUrl = "" }) {
  const chatReserveText = "予約";
  const reserveUrl = appendMiniAppModeQuery(miniAppUrl, "reserve");
  const registerUrl = appendMiniAppModeQuery(miniAppUrl, "register");
  const normalizedBusMapUrl = normalizeHttpUrl(busMapUrl);
  return {
    menuPayload: {
      size: {
        width: RICH_MENU_WIDTH,
        height: RICH_MENU_HEIGHT
      },
      selected: false,
      name: "reqmo-reservation-menu",
      chatBarText: "予約メニュー",
      areas: [
        {
          bounds: {
            x: 0,
            y: 0,
            width: 500,
            height: RICH_MENU_HEIGHT
          },
          action: {
            type: "message",
            text: chatReserveText
          }
        },
        {
          bounds: {
            x: 500,
            y: 0,
            width: 500,
            height: RICH_MENU_HEIGHT
          },
          action: {
            type: "uri",
            uri: reserveUrl
          }
        },
        {
          bounds: {
            x: 1000,
            y: 0,
            width: 500,
            height: RICH_MENU_HEIGHT
          },
          action: {
            type: "message",
            text: "予約確認"
          }
        },
        {
          bounds: {
            x: 1500,
            y: 0,
            width: 500,
            height: RICH_MENU_HEIGHT
          },
          action: {
            type: "uri",
            uri: registerUrl
          }
        },
        {
          bounds: {
            x: 2000,
            y: 0,
            width: 500,
            height: RICH_MENU_HEIGHT
          },
          action: normalizedBusMapUrl
            ? {
                type: "uri",
                uri: normalizedBusMapUrl
              }
            : {
                type: "message",
                text: "バス位置"
              }
        }
      ]
    },
    imageContent: createStripedPng({
      segments: [
        { ratio: 1, color: "#0f766e" },
        { ratio: 1, color: "#1d4ed8" },
        { ratio: 1, color: "#b45309" },
        { ratio: 1, color: "#334155" },
        { ratio: 1, color: "#0f172a" }
      ],
      icons: [
        { segmentIndex: 0, icon: "CHAT" },
        { segmentIndex: 1, icon: "MINIAPP" },
        { segmentIndex: 2, icon: "STATUS" },
        { segmentIndex: 3, icon: "PROFILE" },
        { segmentIndex: 4, icon: "BUS" }
      ]
    })
  };
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
  const busMapUrl = buildBusMapUrl({
    busMapUrl: env.LINE_BUS_MAP_URL,
    publicBaseUrl
  });

  return {
    channelSecret: normalizeTrimmedText(env.LINE_CHANNEL_SECRET),
    channelAccessToken: normalizeTrimmedText(env.LINE_CHANNEL_ACCESS_TOKEN),
    liffId: normalizeTrimmedText(env.LINE_LIFF_ID),
    officialAccountId,
    friendAddUrl,
    miniAppUrl,
    busMapUrl,
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

function resolvePhoneIdentityForUser(repository, userId) {
  if (!userId) {
    return null;
  }
  if (typeof repository?.findPhoneIdentityByUserId === "function") {
    return repository.findPhoneIdentityByUserId(userId);
  }
  if (typeof repository?.listPhoneIdentities === "function") {
    return (
      repository
        .listPhoneIdentities()
        .find((identity) => identity?.userId === userId && identity?.blockStatus !== "BLOCKED") ?? null
    );
  }
  return null;
}

export function resolveLineUserRegistrationStatus({
  repository,
  lineUserId
}) {
  const normalizedLineUserId = normalizeLineUserId(lineUserId);
  const identity =
    typeof repository?.getLineIdentity === "function"
      ? repository.getLineIdentity(normalizedLineUserId)
      : null;
  const user =
    typeof repository?.findUserByLine === "function"
      ? repository.findUserByLine(normalizedLineUserId)
      : null;
  const linkedUserId = user?.id ?? identity?.userId ?? null;
  const phoneIdentity = resolvePhoneIdentityForUser(repository, linkedUserId);
  const hasName = Boolean(normalizePersonName(user?.name));
  const hasPhone = Boolean(phoneIdentity?.normalizedPhoneE164);
  return {
    isRegistered: Boolean(linkedUserId) && hasName && hasPhone,
    hasName,
    hasPhone,
    lineUserId: normalizedLineUserId || null,
    userId: linkedUserId,
    userName: normalizePersonName(user?.name) || null,
    normalizedPhoneE164: phoneIdentity?.normalizedPhoneE164 ?? null,
    missingFields: [
      ...(hasName ? [] : ["name"]),
      ...(hasPhone ? [] : ["phoneNumber"])
    ]
  };
}

export function registerLineMiniAppUser({
  repository,
  lineUserId,
  displayName = null,
  name,
  phoneNumber,
  defaultCountryCode = "+81"
}) {
  const normalizedLineUserId = normalizeLineUserId(lineUserId);
  if (!normalizedLineUserId) {
    throw new Error("lineUserId is required");
  }

  const normalizedName = normalizePersonName(name);
  if (!normalizedName) {
    throw new Error("name is required");
  }

  const normalizedPhoneE164 = normalizePhoneNumber(phoneNumber, defaultCountryCode);
  if (!normalizedPhoneE164) {
    throw new Error("phoneNumber is invalid");
  }

  const existing = ensureLineUserIdentity({
    repository,
    lineUserId: normalizedLineUserId,
    displayName,
    source: "LINE_MINIAPP_REGISTER"
  });

  let user = existing.user;
  if (typeof repository?.findUserByPhone === "function") {
    const byPhone = repository.findUserByPhone(normalizedPhoneE164);
    if (byPhone) {
      user = byPhone;
    }
  }

  if (!user || !user.id) {
    throw new Error("Failed to resolve user for registration");
  }

  if (typeof repository?.updateUser === "function") {
    user = repository.updateUser(user.id, { name: normalizedName }) ?? user;
  } else if (typeof repository?.addUser === "function") {
    user = repository.addUser({ ...user, name: normalizedName });
  }

  if (typeof repository?.linkPhoneIdentity !== "function") {
    throw new Error("repository.linkPhoneIdentity is required");
  }

  const identity = repository.linkLineIdentity({
    userId: user.id,
    lineUserId: normalizedLineUserId,
    source: "LINE_MINIAPP_REGISTER",
    verified: true,
    displayName: normalizeTrimmedText(displayName) || null
  });
  const phoneIdentity = repository.linkPhoneIdentity({
    userId: user.id,
    normalizedPhoneE164,
    source: "LINE_MINIAPP_REGISTER",
    verified: true
  });

  const registration = resolveLineUserRegistrationStatus({
    repository,
    lineUserId: normalizedLineUserId
  });

  return {
    status: "REGISTERED",
    user,
    identity,
    phoneIdentity,
    registration
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
  const pickupTimeLabel = `乗車予定 ${formatDateTime(resolveRequestPickupAt(rideRequest))}`;
  const dropoffTimeLabel = `降車予定 ${formatDateTime(resolveRequestDropoffAt(rideRequest))}`;
  const rideLabel = `${index + 1}. ${pickupTimeLabel}`;
  const routeLabel = `${resolveLocationLabel(repository, rideRequest.pickup)} -> ${resolveLocationLabel(
    repository,
    rideRequest.dropoff
  )}`;
  const statusLabel = `状態: ${resolveStatusLabel(rideRequest.status)}`;
  const requestIdLabel = `予約ID: ${rideRequest.id}`;
  return [rideLabel, dropoffTimeLabel, routeLabel, statusLabel, requestIdLabel];
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

  if (/^(予約|予約する|新規予約|予約登録|予約作成|チャット予約)$/i.test(normalized)) {
    return { type: "BOOK" };
  }

  if (/^(登録|初回登録|利用者登録|プロフィール登録)$/i.test(normalized)) {
    return { type: "REGISTER" };
  }

  const reservationPattern = /^(予約確認|予約状況|確認)$/;
  if (reservationPattern.test(normalized)) {
    return { type: "RESERVATION" };
  }

  if (/^(ヘルプ|help|\?)$/i.test(normalized)) {
    return { type: "HELP" };
  }

  if (/^(ミニアプリ|miniapp)$/i.test(normalized)) {
    return { type: "OPEN_MINIAPP" };
  }

  if (/^(バス位置|現在地|車両位置|運行位置)$/i.test(normalized)) {
    return { type: "BUS_LOCATION" };
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

export function buildLineHelpMessage({ miniAppUrl = "", busMapUrl = "" }) {
  const lines = [
    "使い方:",
    "・「予約」または「予約する」: チャットで新規予約を開始",
    "・「予約確認」: 直近の予約を表示",
    "・「バス位置」: 現在の車両位置マップを表示",
    "・「登録」: 初回登録フォームを表示",
    "・「ミニアプリ」: ミニアプリ予約画面を開く",
    "・「連携 08012345678」: 電話番号で利用者連携"
  ];
  if (miniAppUrl) {
    lines.push(`・ミニアプリ: ${miniAppUrl}`);
  }
  if (busMapUrl) {
    lines.push(`・バス位置マップ: ${busMapUrl}`);
  }
  return lines.join("\n");
}

export function buildLineWelcomeMessages({ miniAppUrl = "", busMapUrl = "" }) {
  const helpText = buildLineHelpMessage({ miniAppUrl, busMapUrl });
  const quickReplyItems = [
    {
      type: "action",
      action: {
        type: "message",
        label: "予約する",
        text: "予約"
      }
    },
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
  if (busMapUrl) {
    quickReplyItems.push({
      type: "action",
      action: {
        type: "uri",
        label: "バス位置",
        uri: busMapUrl
      }
    });
  }
  return [
    {
      type: "text",
      text: "友だち追加ありがとうございます。チャット予約・予約確認をご利用いただけます。",
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

export async function ensureLineRichMenuForUser({
  channelAccessToken,
  lineUserId,
  miniAppUrl = "",
  busMapUrl = "",
  isRegistered = false,
  env = process.env,
  fetchImpl = globalThis.fetch
}) {
  const normalizedLineUserId = normalizeLineUserId(lineUserId);
  if (!normalizedLineUserId) {
    throw new Error("lineUserId is required");
  }
  const normalizedMiniAppUrl = normalizeHttpUrl(miniAppUrl);
  if (!normalizedMiniAppUrl) {
    return {
      status: "SKIPPED",
      reason: "MISSING_MINIAPP_URL"
    };
  }
  const normalizedBusMapUrl = normalizeHttpUrl(busMapUrl);

  const registrationAlias =
    normalizeTrimmedText(env.LINE_RICHMENU_REGISTER_ALIAS_ID) || DEFAULT_REGISTER_RICHMENU_ALIAS;
  const reservationAlias =
    normalizeTrimmedText(env.LINE_RICHMENU_RESERVATION_ALIAS_ID) || DEFAULT_RESERVATION_RICHMENU_ALIAS;
  const targetAlias = isRegistered ? reservationAlias : registrationAlias;

  let richMenuId = await resolveRichMenuIdByAlias({
    channelAccessToken,
    aliasId: targetAlias,
    fetchImpl
  });

  if (!richMenuId) {
    const recipe = isRegistered
      ? buildLineReservationRichMenu({
          miniAppUrl: normalizedMiniAppUrl,
          busMapUrl: normalizedBusMapUrl
        })
      : buildLineRegistrationRichMenu({ miniAppUrl: normalizedMiniAppUrl });
    richMenuId = await createRichMenuWithAlias({
      channelAccessToken,
      aliasId: targetAlias,
      menuPayload: recipe.menuPayload,
      imageContent: recipe.imageContent,
      fetchImpl
    });
  }

  await callLineApi({
    channelAccessToken,
    url: `https://api.line.me/v2/bot/user/${encodeURIComponent(normalizedLineUserId)}/richmenu/${encodeURIComponent(richMenuId)}`,
    method: "POST",
    parseJson: false,
    fetchImpl
  });

  return {
    status: "LINKED",
    aliasId: targetAlias,
    richMenuId
  };
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
