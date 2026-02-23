import http from "node:http";
import { URL } from "node:url";

import { createDefaultServiceProfile } from "../../../shared/src/defaults.ts";
import { createRepositoryFromEnv } from "../repository/factory.ts";
import { InMemoryRepository } from "../repository/inMemoryRepository.ts";
import { loadConfiguredSeedData } from "../seed/configSeedLoader.ts";
import {
  cancelRideRequest,
  createRideRequest,
  createVehicle,
  listRideRequestOptions,
  listPhoneRideOptions,
  previewRideRequest,
  createPhoneRideRequest,
  recordVehiclePassengerEvent,
  resetRideRequests,
  getRoutePath,
  ingestCall,
  linkPhoneIdentity,
  updateVehicleLocation,
  updateVehicleConfig,
  upsertFarePolicy,
  upsertServiceProfile,
  upsertTelephonyConfig
} from "./functions.ts";
import { createRoutingContextFromEnv } from "../routing/service.ts";
import { reverseGeocodePoint } from "../location/reverseGeocode.ts";
import { getHighsRuntimeDiagnostics } from "../dispatch/highs.ts";
import {
  buildLineHelpMessage,
  buildLineWelcomeMessages,
  buildMiniAppUrlWithLineUser,
  buildReservationSummaryText,
  ensureLineUserIdentity,
  linkLineUserByPhone,
  listLineUserRideRequests,
  parseLineMessageCommand,
  parseLineWebhookPayload,
  resolveLineConfig,
  sendLineReplyMessage,
  verifyLineWebhookSignature
} from "../line/service.ts";

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function writeCorsHeaders(res, origin = "*") {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Line-Signature");
}

async function parseJsonBody(req) {
  if (req && typeof req === "object") {
    const parsedBody = req.body;
    if (parsedBody && typeof parsedBody === "object") {
      return parsedBody;
    }
    if (typeof parsedBody === "string") {
      return parsedBody.trim() ? JSON.parse(parsedBody) : {};
    }

    const rawBody = req.rawBody;
    if (Buffer.isBuffer(rawBody)) {
      const rawText = rawBody.toString("utf-8").trim();
      return rawText ? JSON.parse(rawText) : {};
    }
    if (typeof rawBody === "string") {
      const rawText = rawBody.trim();
      return rawText ? JSON.parse(rawText) : {};
    }
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return JSON.parse(raw);
}

async function parseRawBody(req) {
  if (req && typeof req === "object") {
    if (Buffer.isBuffer(req.rawBody)) {
      return req.rawBody;
    }
    if (typeof req.rawBody === "string") {
      return Buffer.from(req.rawBody, "utf-8");
    }
    if (typeof req.body === "string") {
      return Buffer.from(req.body, "utf-8");
    }
    if (req.body && typeof req.body === "object") {
      return Buffer.from(JSON.stringify(req.body), "utf-8");
    }
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  if (!chunks.length) {
    return Buffer.from("", "utf-8");
  }
  return Buffer.concat(chunks);
}

function readRequestHeader(req, name) {
  if (!req || typeof req !== "object") {
    return "";
  }
  const headers = req.headers ?? {};
  const direct = headers[name];
  if (typeof direct === "string") {
    return direct;
  }
  if (Array.isArray(direct)) {
    return direct[0] ?? "";
  }
  const normalized = headers[name.toLowerCase()];
  if (typeof normalized === "string") {
    return normalized;
  }
  if (Array.isArray(normalized)) {
    return normalized[0] ?? "";
  }
  return "";
}

function resolveRequestBaseUrl(req) {
  const host = readRequestHeader(req, "x-forwarded-host") || readRequestHeader(req, "host");
  if (!host) {
    return "";
  }
  const forwardedProto = readRequestHeader(req, "x-forwarded-proto");
  const protocol = forwardedProto ? forwardedProto.split(",")[0].trim() : "https";
  const normalizedProtocol = protocol === "http" || protocol === "https" ? protocol : "https";
  return `${normalizedProtocol}://${host}`;
}

async function flushRepository(repository) {
  if (typeof repository.flush === "function") {
    await repository.flush();
  }
}

function normalizePointInput(input) {
  if (!input) {
    return null;
  }
  if (typeof input === "object" && input.lat !== undefined && input.lng !== undefined) {
    const lat = Number(input.lat);
    const lng = Number(input.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { lat, lng };
    }
    return null;
  }
  if (typeof input === "string") {
    const [latRaw, lngRaw] = input.split(",").map((part) => part.trim());
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { lat, lng };
    }
    return null;
  }
  return null;
}

export function seedDemoData(repository) {
  repository.addStop({ id: "stop_a", name: "Demo Stop A", lat: 35.681236, lng: 139.767125 });
  repository.addStop({ id: "stop_b", name: "Demo Stop B", lat: 35.689487, lng: 139.691706 });
  repository.addVehicle({
    id: "veh_1",
    status: "ACTIVE",
    capacity: 4,
    onboardCount: 0,
    currentLocation: { lat: 32.9902, lng: 132.9295 },
    route: []
  });
  repository.addUser({ id: "user_phone_1", name: "Phone User" });

  const profile = createDefaultServiceProfile();
  upsertServiceProfile({ repository, profile });

  linkPhoneIdentity({
    repository,
    serviceProfileId: profile.id,
    userId: "user_phone_1",
    phoneNumber: "08011112222"
  });

  return profile.id;
}

export function seedConfiguredData(repository, options = {}) {
  const {
    bundlePath = process.env.SEED_BUNDLE_PATH,
    stopsPath = process.env.SEED_STOPS_PATH,
    serviceProfilePath = process.env.SEED_SERVICE_PROFILE_PATH,
    farePolicyPath = process.env.SEED_FARE_POLICY_PATH,
    telephonyConfigPath = process.env.SEED_TELEPHONY_CONFIG_PATH,
    overwriteExisting = process.env.SEED_OVERWRITE_EXISTING === "true"
  } = options;

  const loaded = loadConfiguredSeedData({
    repository,
    bundlePath,
    stopsPath,
    serviceProfilePath,
    farePolicyPath,
    telephonyConfigPath,
    overwriteExisting
  });

  const stopsCountAfterLoad = repository.listStops().length;
  if (stopsCountAfterLoad === 0) {
    return {
      profileId: seedDemoData(repository),
      source: "demo-fallback",
      stopsCount: repository.listStops().length
    };
  }

  const resolvedProfile =
    repository.getServiceProfile(loaded.profileId) ??
    repository.listServiceProfiles()[0] ??
    null;
  const profileId = resolvedProfile?.id ?? loaded.profileId;

  if (!repository.listVehicles().length) {
    const primaryStop = repository.listStops()[0];
    repository.addVehicle({
      id: "demo_bus_01",
      status: "ACTIVE",
      capacity: 8,
      onboardCount: 0,
      currentLocation: primaryStop
        ? { lat: primaryStop.lat, lng: primaryStop.lng }
        : { lat: 35.681236, lng: 139.767125 },
      route: []
    });
  }

  if (!repository.listUsers().length) {
    repository.addUser({ id: "operator_seed_user", name: "Operator Caller" });
  }

  return {
    ...loaded,
    profileId,
    stopsCount: stopsCountAfterLoad
  };
}

function normalizeOptionalId(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function resolveActiveServiceProfileId({
  repository,
  requestedServiceProfileId,
  seededProfileId
}) {
  const profiles = repository.listServiceProfiles();
  const profileIds = new Set(profiles.map((profile) => profile.id));

  const requestedId = normalizeOptionalId(requestedServiceProfileId);
  if (requestedId && profileIds.has(requestedId)) {
    return requestedId;
  }

  const seededId = normalizeOptionalId(seededProfileId);
  if (seededId && seededId !== "weekday_default_v1" && profileIds.has(seededId)) {
    return seededId;
  }

  if (profileIds.has("shimanto_weekday_v1")) {
    return "shimanto_weekday_v1";
  }

  if (seededId && profileIds.has(seededId)) {
    return seededId;
  }

  const fallbackSeededId = seededId || null;
  const fallbackRequestedId = requestedId || null;
  return profiles[0]?.id ?? fallbackSeededId ?? fallbackRequestedId;
}

function toRideInput(body) {
  function parseLocationTitle(value) {
    const title = typeof value === "string" ? value.trim() : "";
    return title || null;
  }

  function parsePoint(value) {
    return normalizePointInput(value);
  }

  function normalizeLocation(input) {
    if (!input || !input.mode) {
      throw new Error("pickup/dropoff requires mode");
    }
    const title = parseLocationTitle(input.title);
    if (input.mode === "FIXED_STOP") {
      return {
        mode: "FIXED_STOP",
        stopId: input.stopId,
        ...(title ? { title } : {})
      };
    }
    return {
      mode: "FREE_POINT",
      point: parsePoint(input.point),
      ...(title ? { title } : {})
    };
  }

  return {
    pickup: normalizeLocation(body.pickup),
    dropoff: normalizeLocation(body.dropoff)
  };
}

function normalizePassenger(passengerInput) {
  if (!passengerInput || typeof passengerInput !== "object") {
    return null;
  }

  const name = typeof passengerInput.name === "string" ? passengerInput.name.trim() : "";
  const phoneNumber = typeof passengerInput.phoneNumber === "string" ? passengerInput.phoneNumber.trim() : "";

  if (!name && !phoneNumber) {
    return null;
  }

  return {
    ...(name ? { name } : {}),
    ...(phoneNumber ? { phoneNumber } : {})
  };
}

function normalizeLineMiniAppStopId(value, fieldName) {
  const stopId = typeof value === "string" ? value.trim() : "";
  if (!stopId) {
    throw new Error(`${fieldName} is required`);
  }
  return stopId;
}

function normalizeLineMiniAppDesiredMode(value) {
  const mode = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (mode !== "PICKUP" && mode !== "DROPOFF") {
    throw new Error("desiredMode must be PICKUP or DROPOFF");
  }
  return mode;
}

function normalizeLineMiniAppDesiredAt(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    throw new Error("desiredAt is required");
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("desiredAt must be a valid datetime");
  }
  return parsed.toISOString();
}

function resolveLineMiniAppTenantId(value) {
  const requested = typeof value === "string" ? value.trim() : "";
  if (requested) {
    return requested;
  }
  const configured =
    typeof process.env.REQMO_TENANT_ID === "string"
      ? process.env.REQMO_TENANT_ID.trim()
      : "";
  return configured || "tenant_default";
}

function resolveLinePublicConfig(req) {
  const config = resolveLineConfig({
    requestBaseUrl: resolveRequestBaseUrl(req)
  });
  return {
    liffId: config.liffId,
    miniAppUrl: config.miniAppUrl,
    friendAddUrl: config.friendAddUrl,
    officialAccountId: config.officialAccountId,
    botEnabled: config.botEnabled
  };
}

function resolveLineUserIdFromEvent(event) {
  const userId =
    event?.source && typeof event.source === "object"
      ? event.source.userId
      : null;
  return typeof userId === "string" ? userId.trim() : "";
}

function resolveRidePrimaryTime(rideRequest) {
  return (
    rideRequest?.assignment?.plannedPickupAt ??
    rideRequest?.timeWindow?.desiredPickupAt ??
    rideRequest?.timeWindow?.desiredDropoffAt ??
    rideRequest?.createdAt ??
    null
  );
}

function resolveRideStatusLabel(status) {
  const normalized = typeof status === "string" ? status.trim().toUpperCase() : "";
  const labels = {
    REQUESTED: "受付済み",
    ASSIGNED: "配車確定",
    PICKUP_PENDING: "迎車中",
    PICKED_UP: "乗車中",
    ONBOARD: "乗車中",
    IN_PROGRESS: "運行中",
    COMPLETED: "完了",
    CANCELLED: "取消"
  };
  return labels[normalized] ?? (normalized || "不明");
}

function resolveLocationLabelForResponse(repository, location) {
  if (!location || typeof location !== "object") {
    return "未設定";
  }
  if (location.mode === "FIXED_STOP" && typeof location.stopId === "string") {
    const stop = typeof repository.findStopById === "function"
      ? repository.findStopById(location.stopId)
      : null;
    return stop?.name ?? location.stopId;
  }
  if (location.mode === "FREE_POINT") {
    if (typeof location.title === "string" && location.title.trim()) {
      return location.title.trim();
    }
    const point = location.point;
    if (
      point &&
      Number.isFinite(Number(point.lat)) &&
      Number.isFinite(Number(point.lng))
    ) {
      return `${Number(point.lat).toFixed(5)},${Number(point.lng).toFixed(5)}`;
    }
  }
  return typeof location.title === "string" && location.title.trim()
    ? location.title.trim()
    : "未設定";
}

function serializeLineReservation(repository, rideRequest) {
  return {
    id: rideRequest.id,
    status: rideRequest.status,
    statusLabel: resolveRideStatusLabel(rideRequest.status),
    pickupLabel: resolveLocationLabelForResponse(repository, rideRequest.pickup),
    dropoffLabel: resolveLocationLabelForResponse(repository, rideRequest.dropoff),
    primaryTimeAt: resolveRidePrimaryTime(rideRequest),
    desiredPickupAt: rideRequest?.timeWindow?.desiredPickupAt ?? null,
    desiredDropoffAt: rideRequest?.timeWindow?.desiredDropoffAt ?? null,
    plannedPickupAt: rideRequest?.assignment?.plannedPickupAt ?? null,
    plannedDropoffAt: rideRequest?.assignment?.plannedDropoffAt ?? null
  };
}

function buildLineMiniAppSession({
  repository,
  lineUserId,
  displayName = null
}) {
  const { user, identity } = ensureLineUserIdentity({
    repository,
    lineUserId,
    displayName,
    source: "LINE_MINIAPP"
  });
  const reservations = listLineUserRideRequests({
    repository,
    userId: user.id,
    limit: 5
  });
  return {
    lineUserId,
    user: {
      id: user.id,
      name: user.name ?? null
    },
    identity: {
      source: identity.source ?? null,
      verified: identity.verified === true,
      displayName: identity.displayName ?? null,
      lastSeenAt: identity.lastSeenAt ?? null
    },
    reservations: reservations.map((rideRequest) => serializeLineReservation(repository, rideRequest)),
    summaryText: buildReservationSummaryText({
      repository,
      requests: reservations,
      displayName: user.name ?? identity.displayName ?? ""
    })
  };
}

function resolveDefaultCountryCode(repository, serviceProfileId) {
  const profile = typeof repository?.getServiceProfile === "function"
    ? repository.getServiceProfile(serviceProfileId)
    : null;
  const policyCode =
    typeof profile?.telephonyPolicy?.defaultCountryCode === "string"
      ? profile.telephonyPolicy.defaultCountryCode.trim()
      : "";
  if (policyCode) {
    return policyCode;
  }
  const configs = typeof repository?.listTelephonyConfigs === "function"
    ? repository.listTelephonyConfigs()
    : [];
  const fallbackCode =
    typeof configs?.[0]?.defaultCountryCode === "string"
      ? configs[0].defaultCountryCode.trim()
      : "";
  return fallbackCode || "+81";
}

function buildLineQuickReplyForReservation({ miniAppUrl }) {
  const items = [
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
    items.push({
      type: "action",
      action: {
        type: "uri",
        label: "ミニアプリ",
        uri: miniAppUrl
      }
    });
  }
  return {
    items
  };
}

async function handleLineWebhookEvent({
  repository,
  serviceProfileId,
  config,
  event
}) {
  const replyToken = typeof event?.replyToken === "string" ? event.replyToken.trim() : "";
  if (!replyToken) {
    return {
      status: "SKIPPED",
      reason: "MISSING_REPLY_TOKEN"
    };
  }

  const lineUserId = resolveLineUserIdFromEvent(event);
  if (!lineUserId) {
    return {
      status: "SKIPPED",
      reason: "MISSING_LINE_USER_ID"
    };
  }

  const miniAppUrl = buildMiniAppUrlWithLineUser(config.miniAppUrl, lineUserId);

  if (event.type === "follow") {
    ensureLineUserIdentity({
      repository,
      lineUserId,
      source: "LINE_FOLLOW"
    });
    await sendLineReplyMessage({
      channelAccessToken: config.channelAccessToken,
      replyToken,
      messages: buildLineWelcomeMessages({ miniAppUrl })
    });
    return {
      status: "REPLIED",
      type: "follow"
    };
  }

  if (event.type !== "message" || event?.message?.type !== "text") {
    return {
      status: "SKIPPED",
      reason: "UNSUPPORTED_EVENT"
    };
  }

  const text = typeof event.message.text === "string" ? event.message.text : "";
  const command = parseLineMessageCommand(text);
  const { user, identity } = ensureLineUserIdentity({
    repository,
    lineUserId,
    source: "LINE_CHAT"
  });

  if (command.type === "RESERVATION") {
    const requests = listLineUserRideRequests({
      repository,
      userId: user.id,
      limit: 3
    });
    await sendLineReplyMessage({
      channelAccessToken: config.channelAccessToken,
      replyToken,
      messages: [
        {
          type: "text",
          text: buildReservationSummaryText({
            repository,
            requests,
            displayName: user.name ?? identity.displayName ?? ""
          }),
          quickReply: buildLineQuickReplyForReservation({ miniAppUrl })
        }
      ]
    });
    return {
      status: "REPLIED",
      type: "reservation"
    };
  }

  if (command.type === "LINK_PHONE") {
    const linked = linkLineUserByPhone({
      repository,
      lineUserId,
      phoneNumber: command.phoneNumber,
      defaultCountryCode: resolveDefaultCountryCode(repository, serviceProfileId),
      displayName: user.name ?? identity.displayName ?? null
    });
    if (linked.status === "NOT_FOUND") {
      await sendLineReplyMessage({
        channelAccessToken: config.channelAccessToken,
        replyToken,
        messages: [
          {
            type: "text",
            text: `電話番号(${command.phoneNumber})に紐づく利用者が見つかりませんでした。窓口で登録後に再度お試しください。`
          }
        ]
      });
      return {
        status: "REPLIED",
        type: "link-not-found"
      };
    }
    const requests = listLineUserRideRequests({
      repository,
      userId: linked.user.id,
      limit: 3
    });
    await sendLineReplyMessage({
      channelAccessToken: config.channelAccessToken,
      replyToken,
      messages: [
        {
          type: "text",
          text:
            `電話番号を連携しました (${linked.normalizedPhoneE164})\n` +
            buildReservationSummaryText({
              repository,
              requests,
              displayName: linked.user.name ?? identity.displayName ?? ""
            }),
          quickReply: buildLineQuickReplyForReservation({ miniAppUrl })
        }
      ]
    });
    return {
      status: "REPLIED",
      type: "link-success"
    };
  }

  if (command.type === "OPEN_MINIAPP") {
    await sendLineReplyMessage({
      channelAccessToken: config.channelAccessToken,
      replyToken,
      messages: [
        {
          type: "text",
          text: miniAppUrl ? `ミニアプリはこちらです。\n${miniAppUrl}` : "ミニアプリURLが未設定です。"
        }
      ]
    });
    return {
      status: "REPLIED",
      type: "open-miniapp"
    };
  }

  await sendLineReplyMessage({
    channelAccessToken: config.channelAccessToken,
    replyToken,
    messages: [
      {
        type: "text",
        text: buildLineHelpMessage({ miniAppUrl })
      }
    ]
  });
  return {
    status: "REPLIED",
    type: command.type === "HELP" ? "help" : "fallback"
  };
}

export function createReqmoServer({
  repository = new InMemoryRepository(),
  serviceProfileId,
  corsOrigin = process.env.CORS_ORIGIN ?? "*",
  seedOptions,
  routing = createRoutingContextFromEnv()
} = {}) {
  const seeded = seedConfiguredData(repository, seedOptions);
  const activeServiceProfileId = resolveActiveServiceProfileId({
    repository,
    requestedServiceProfileId: serviceProfileId,
    seededProfileId: seeded.profileId
  });
  const requestContext = {
    routing
  };

  const server = http.createServer(async (req, res) => {
    try {
      writeCorsHeaders(res, corsOrigin);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return null;
      }

      const parsedUrl = new URL(req.url ?? "/", "http://localhost");
      const pathname = parsedUrl.pathname;

      if (req.method === "GET" && req.url === "/api/health") {
        const activeProfile = repository.getServiceProfile(activeServiceProfileId);
        return jsonResponse(res, 200, {
          ok: true,
          service: "reqmo-backend",
          seedSource: seeded.source,
          activeServiceProfileId,
          dispatchPolicy: {
            algorithmPrimary: activeProfile?.dispatchPolicy?.algorithmPrimary ?? null,
            algorithmFallback: activeProfile?.dispatchPolicy?.algorithmFallback ?? null
          },
          highs: getHighsRuntimeDiagnostics()
        });
      }

      if (req.method === "GET" && pathname === "/api/line/public-config") {
        return jsonResponse(res, 200, {
          status: "OK",
          config: resolveLinePublicConfig(req)
        });
      }

      if (req.method === "GET" && pathname === "/api/line/miniapp/session") {
        const lineUserId = (parsedUrl.searchParams.get("lineUserId") ?? "").trim();
        if (!lineUserId) {
          throw new Error("lineUserId is required");
        }
        const displayName = (parsedUrl.searchParams.get("displayName") ?? "").trim() || null;
        const session = buildLineMiniAppSession({
          repository,
          lineUserId,
          displayName
        });
        await flushRepository(repository);
        return jsonResponse(res, 200, {
          status: "OK",
          ...session,
          config: resolveLinePublicConfig(req)
        });
      }

      if (req.method === "POST" && pathname === "/api/line/miniapp/link-phone") {
        const body = await parseJsonBody(req);
        const lineUserId = typeof body.lineUserId === "string" ? body.lineUserId.trim() : "";
        if (!lineUserId) {
          throw new Error("lineUserId is required");
        }
        const displayName =
          typeof body.displayName === "string" && body.displayName.trim()
            ? body.displayName.trim()
            : null;
        const linked = linkLineUserByPhone({
          repository,
          lineUserId,
          phoneNumber: body.phoneNumber,
          defaultCountryCode: resolveDefaultCountryCode(repository, activeServiceProfileId),
          displayName
        });

        if (linked.status === "NOT_FOUND") {
          return jsonResponse(res, 404, {
            status: "NOT_FOUND",
            lineUserId,
            normalizedPhoneE164: linked.normalizedPhoneE164
          });
        }

        const reservations = listLineUserRideRequests({
          repository,
          userId: linked.user.id,
          limit: 5
        });
        await flushRepository(repository);
        return jsonResponse(res, 200, {
          status: "LINKED",
          lineUserId,
          normalizedPhoneE164: linked.normalizedPhoneE164,
          user: {
            id: linked.user.id,
            name: linked.user.name ?? null
          },
          identity: {
            source: linked.identity?.source ?? null,
            verified: linked.identity?.verified === true,
            displayName: linked.identity?.displayName ?? null,
            lastSeenAt: linked.identity?.lastSeenAt ?? null
          },
          reservations: reservations.map((rideRequest) =>
            serializeLineReservation(repository, rideRequest)
          ),
          summaryText: buildReservationSummaryText({
            repository,
            requests: reservations,
            displayName: linked.user.name ?? linked.identity?.displayName ?? ""
          }),
          config: resolveLinePublicConfig(req)
        });
      }

      if (req.method === "POST" && pathname === "/api/line/miniapp/reservations") {
        const body = await parseJsonBody(req);
        const lineUserId = typeof body.lineUserId === "string" ? body.lineUserId.trim() : "";
        if (!lineUserId) {
          throw new Error("lineUserId is required");
        }

        const displayName =
          typeof body.displayName === "string" && body.displayName.trim()
            ? body.displayName.trim()
            : null;
        const pickupStopId = normalizeLineMiniAppStopId(body.pickupStopId, "pickupStopId");
        const dropoffStopId = normalizeLineMiniAppStopId(body.dropoffStopId, "dropoffStopId");
        if (pickupStopId === dropoffStopId) {
          throw new Error("pickupStopId and dropoffStopId must be different");
        }

        const pickupStop =
          typeof repository.findStopById === "function"
            ? repository.findStopById(pickupStopId)
            : null;
        if (!pickupStop) {
          return jsonResponse(res, 404, {
            status: "STOP_NOT_FOUND",
            field: "pickupStopId",
            stopId: pickupStopId
          });
        }
        const dropoffStop =
          typeof repository.findStopById === "function"
            ? repository.findStopById(dropoffStopId)
            : null;
        if (!dropoffStop) {
          return jsonResponse(res, 404, {
            status: "STOP_NOT_FOUND",
            field: "dropoffStopId",
            stopId: dropoffStopId
          });
        }

        const desiredMode = normalizeLineMiniAppDesiredMode(body.desiredMode);
        const desiredAt = normalizeLineMiniAppDesiredAt(body.desiredAt);
        const parsedPartySize = Number(body.partySize);
        const partySize =
          Number.isFinite(parsedPartySize) && parsedPartySize > 0
            ? Math.max(1, Math.trunc(parsedPartySize))
            : 1;
        const tenantId = resolveLineMiniAppTenantId(body.tenantId);

        const { user } = ensureLineUserIdentity({
          repository,
          lineUserId,
          displayName,
          source: "LINE_MINIAPP_BOOKING"
        });

        const result = await createRideRequest({
          repository,
          serviceProfileId: body.serviceProfileId ?? activeServiceProfileId,
          tenantId,
          requesterId: user.id,
          pickup: { mode: "FIXED_STOP", stopId: pickupStopId },
          dropoff: { mode: "FIXED_STOP", stopId: dropoffStopId },
          partySize,
          passenger:
            normalizePassenger(body.passenger) ??
            (user.name
              ? {
                  name: user.name
                }
              : null),
          channel: "PASSENGER_APP",
          requestType: desiredMode === "PICKUP" ? "DEPART_AT" : "ARRIVE_BY",
          desiredPickupAt: desiredMode === "PICKUP" ? desiredAt : null,
          desiredDropoffAt: desiredMode === "DROPOFF" ? desiredAt : null,
          context: requestContext
        });

        const rideRequest =
          result && typeof result === "object" && result.rideRequest
            ? result.rideRequest
            : null;
        const session = buildLineMiniAppSession({
          repository,
          lineUserId,
          displayName
        });

        await flushRepository(repository);
        return jsonResponse(res, 200, {
          status: "CREATED",
          resultStatus: typeof result?.status === "string" ? result.status : null,
          reservation: rideRequest ? serializeLineReservation(repository, rideRequest) : null,
          ...session,
          config: resolveLinePublicConfig(req)
        });
      }

      if (req.method === "POST" && pathname === "/api/line/webhook") {
        const config = resolveLineConfig({
          requestBaseUrl: resolveRequestBaseUrl(req)
        });
        if (!config.channelSecret || !config.channelAccessToken) {
          return jsonResponse(res, 503, {
            error: "LINE bot is not configured"
          });
        }

        const rawBody = await parseRawBody(req);
        const signature = readRequestHeader(req, "x-line-signature");
        const verified = verifyLineWebhookSignature({
          channelSecret: config.channelSecret,
          rawBody,
          signature
        });
        if (!verified) {
          return jsonResponse(res, 401, {
            error: "Invalid LINE signature"
          });
        }

        const payload = parseLineWebhookPayload(rawBody);
        const results = [];
        for (const event of payload.events) {
          try {
            const result = await handleLineWebhookEvent({
              repository,
              serviceProfileId: activeServiceProfileId,
              config,
              event
            });
            results.push(result);
          } catch (error) {
            results.push({
              status: "ERROR",
              reason: error instanceof Error ? error.message : "Unknown error"
            });
          }
        }

        await flushRepository(repository);
        return jsonResponse(res, 200, {
          status: "OK",
          handledEvents: results.length,
          results
        });
      }

      if (req.method === "GET" && pathname === "/api/state") {
        return jsonResponse(res, 200, {
          vehicles: repository.listVehicles().length,
          stops: repository.listStops().length,
          rideRequests: repository.listRideRequests().length,
          callEvents: repository.listCallEvents().length,
          serviceProfileId: activeServiceProfileId
        });
      }

      if (req.method === "GET" && pathname === "/api/vehicles") {
        return jsonResponse(res, 200, {
          data: repository.listVehicles()
        });
      }

      if (req.method === "POST" && pathname === "/api/vehicles") {
        const body = await parseJsonBody(req);
        const firstStop = repository.listStops()[0];
        const fallbackLocation =
          normalizePointInput(body.currentLocation ?? body.officePoint ?? body.homeBase) ??
          (firstStop ? { lat: firstStop.lat, lng: firstStop.lng } : null);

        const result = createVehicle({
          repository,
          vehicle: body,
          fallbackLocation
        });
        await flushRepository(repository);

        return jsonResponse(res, 200, {
          status: "CREATED",
          vehicle: result
        });
      }

      if (req.method === "GET" && pathname === "/api/stops") {
        return jsonResponse(res, 200, {
          data: repository.listStops()
        });
      }

      if (req.method === "GET" && pathname === "/api/geocode/reverse") {
        const lat = Number(parsedUrl.searchParams.get("lat"));
        const lng = Number(parsedUrl.searchParams.get("lng"));
        const result = await reverseGeocodePoint({ lat, lng });
        return jsonResponse(res, 200, {
          point: { lat, lng },
          title: result.title,
          source: result.source,
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.displayName ? { displayName: result.displayName } : {})
        });
      }

      if (req.method === "GET" && pathname === "/api/ride-requests") {
        return jsonResponse(res, 200, {
          data: repository.listRideRequests()
        });
      }

      if (req.method === "GET" && pathname === "/api/call-events") {
        return jsonResponse(res, 200, {
          data: repository.listCallEvents()
        });
      }

      if (req.method === "GET" && pathname === "/api/service-profiles") {
        return jsonResponse(res, 200, {
          data: repository.listServiceProfiles(),
          activeServiceProfileId
        });
      }

      if (req.method === "GET" && pathname === "/api/fare-policies") {
        return jsonResponse(res, 200, {
          data: repository.listFarePolicies()
        });
      }

      if (req.method === "GET" && pathname === "/api/telephony-configs") {
        return jsonResponse(res, 200, {
          data: repository.listTelephonyConfigs()
        });
      }

      if (req.method === "POST" && pathname === "/api/ride-requests") {
        const body = await parseJsonBody(req);
        const rideInput = toRideInput(body);
        const result = await createRideRequest({
          repository,
          serviceProfileId: body.serviceProfileId ?? activeServiceProfileId,
          tenantId: body.tenantId ?? "tenant_default",
          requesterId: body.requesterId ?? null,
          pickup: rideInput.pickup,
          dropoff: rideInput.dropoff,
          partySize: body.partySize ?? 1,
          passenger: normalizePassenger(body.passenger),
          channel: body.channel,
          requestType: body.requestType ?? null,
          desiredDropoffAt: body.desiredDropoffAt ?? null,
          desiredPickupAt: body.desiredPickupAt ?? null,
          preferredVehicleId: body.preferredVehicleId ?? null,
          context: requestContext
        });
        await flushRepository(repository);

        return jsonResponse(res, 200, result);
      }

      if (req.method === "POST" && pathname === "/api/ride-requests/options") {
        const body = await parseJsonBody(req);
        const rideInput = toRideInput(body);
        const result = await listRideRequestOptions({
          repository,
          serviceProfileId: body.serviceProfileId ?? activeServiceProfileId,
          tenantId: body.tenantId ?? "tenant_default",
          requesterId: body.requesterId ?? null,
          pickup: rideInput.pickup,
          dropoff: rideInput.dropoff,
          partySize: body.partySize ?? 1,
          passenger: normalizePassenger(body.passenger),
          channel: body.channel,
          requestType: body.requestType ?? null,
          desiredDropoffAt: body.desiredDropoffAt ?? null,
          desiredPickupAt: body.desiredPickupAt ?? null,
          optionLimit: body.optionLimit ?? 5,
          context: requestContext
        });
        return jsonResponse(res, 200, result);
      }

      if (req.method === "POST" && pathname === "/api/ride-requests/preview") {
        const body = await parseJsonBody(req);
        const rideInput = toRideInput(body);
        const result = await previewRideRequest({
          repository,
          serviceProfileId: body.serviceProfileId ?? activeServiceProfileId,
          tenantId: body.tenantId ?? "tenant_default",
          requesterId: body.requesterId ?? null,
          pickup: rideInput.pickup,
          dropoff: rideInput.dropoff,
          partySize: body.partySize ?? 1,
          passenger: normalizePassenger(body.passenger),
          channel: body.channel,
          requestType: body.requestType ?? null,
          desiredDropoffAt: body.desiredDropoffAt ?? null,
          desiredPickupAt: body.desiredPickupAt ?? null,
          context: requestContext
        });

        return jsonResponse(res, 200, result);
      }

      if (req.method === "POST" && pathname === "/api/ride-requests/reset") {
        const result = await resetRideRequests({
          repository
        });
        await flushRepository(repository);
        return jsonResponse(res, 200, result);
      }

      const cancelPathMatch = pathname.match(/^\/api\/ride-requests\/([^/]+)\/cancel$/);
      if (req.method === "POST" && cancelPathMatch) {
        const body = await parseJsonBody(req);
        const requestId = decodeURIComponent(cancelPathMatch[1]);
        const result = await cancelRideRequest({
          repository,
          requestId,
          reason: body.reason ?? "OPERATOR_CANCELLED",
          context: requestContext
        });
        await flushRepository(repository);
        return jsonResponse(res, 200, result);
      }

      const vehicleLocationPathMatch = pathname.match(/^\/api\/vehicles\/([^/]+)\/location$/);
      const vehicleUpdatePathMatch = pathname.match(/^\/api\/vehicles\/([^/]+)$/);
      if (req.method === "POST" && vehicleUpdatePathMatch) {
        const body = await parseJsonBody(req);
        const vehicleId = decodeURIComponent(vehicleUpdatePathMatch[1]);
        const updated = updateVehicleConfig({
          repository,
          vehicleId,
          updates: body
        });
        await flushRepository(repository);
        return jsonResponse(res, 200, {
          status: "UPDATED",
          vehicle: updated
        });
      }

      if (req.method === "POST" && vehicleLocationPathMatch) {
        const body = await parseJsonBody(req);
        const vehicleId = decodeURIComponent(vehicleLocationPathMatch[1]);

        const locationInput = body.point ?? {
          lat: body.lat,
          lng: body.lng
        };

        const result = await updateVehicleLocation({
          repository,
          serviceProfileId: body.serviceProfileId ?? activeServiceProfileId,
          vehicleId,
          point: locationInput,
          source: body.source ?? "DRIVER_APP",
          heading: body.heading,
          speedKmh: body.speedKmh,
          capturedAt: body.capturedAt,
          skipReoptimization: body.skipReoptimization === true,
          context: requestContext
        });
        await flushRepository(repository);

        return jsonResponse(res, 200, result);
      }

      const passengerEventPathMatch = pathname.match(/^\/api\/vehicles\/([^/]+)\/passenger-events$/);
      if (req.method === "POST" && passengerEventPathMatch) {
        const body = await parseJsonBody(req);
        const vehicleId = decodeURIComponent(passengerEventPathMatch[1]);

        const result = await recordVehiclePassengerEvent({
          repository,
          serviceProfileId: body.serviceProfileId ?? activeServiceProfileId,
          vehicleId,
          requestId: body.requestId ?? null,
          taskType: body.taskType ?? null,
          source: body.source ?? "SIMULATION",
          processedAt: body.processedAt ?? null
        });
        await flushRepository(repository);

        return jsonResponse(res, 200, result);
      }

      if (req.method === "POST" && pathname === "/api/routing/path") {
        const body = await parseJsonBody(req);
        const result = await getRoutePath({
          points: body.points,
          context: requestContext
        });
        return jsonResponse(res, 200, result);
      }

      if (req.method === "POST" && pathname === "/api/phone-rides") {
        const body = await parseJsonBody(req);
        const rideInput = toRideInput(body);
        const result = await createPhoneRideRequest({
          repository,
          serviceProfileId: body.serviceProfileId ?? activeServiceProfileId,
          tenantId: body.tenantId ?? "tenant_default",
          callerRaw: body.callerRaw,
          pickup: rideInput.pickup,
          dropoff: rideInput.dropoff,
          partySize: body.partySize ?? 1,
          passenger: normalizePassenger(body.passenger),
          requestType: body.requestType ?? null,
          desiredDropoffAt: body.desiredDropoffAt ?? null,
          desiredPickupAt: body.desiredPickupAt ?? null,
          preferredVehicleId: body.preferredVehicleId ?? null,
          context: requestContext
        });
        await flushRepository(repository);

        return jsonResponse(res, 200, result);
      }

      if (req.method === "POST" && pathname === "/api/phone-rides/options") {
        const body = await parseJsonBody(req);
        const rideInput = toRideInput(body);
        const result = await listPhoneRideOptions({
          repository,
          serviceProfileId: body.serviceProfileId ?? activeServiceProfileId,
          tenantId: body.tenantId ?? "tenant_default",
          callerRaw: body.callerRaw,
          pickup: rideInput.pickup,
          dropoff: rideInput.dropoff,
          partySize: body.partySize ?? 1,
          passenger: normalizePassenger(body.passenger),
          requestType: body.requestType ?? null,
          desiredDropoffAt: body.desiredDropoffAt ?? null,
          desiredPickupAt: body.desiredPickupAt ?? null,
          optionLimit: body.optionLimit ?? 5,
          context: requestContext
        });
        return jsonResponse(res, 200, result);
      }

      if (req.method === "POST" && pathname === "/api/telephony/ingest") {
        const body = await parseJsonBody(req);
        const result = ingestCall({
          repository,
          serviceProfileId: body.serviceProfileId ?? activeServiceProfileId,
          provider: body.provider ?? "unknown",
          adapterType: body.adapterType,
          payload: body.payload ?? body
        });
        await flushRepository(repository);

        return jsonResponse(res, 200, result);
      }

      if (req.method === "POST" && pathname === "/api/service-profiles") {
        const body = await parseJsonBody(req);
        const result = upsertServiceProfile({
          repository,
          profile: body
        });
        await flushRepository(repository);
        return jsonResponse(res, 200, result);
      }

      if (req.method === "POST" && pathname === "/api/fare-policies") {
        const body = await parseJsonBody(req);
        const result = upsertFarePolicy({
          repository,
          farePolicy: body
        });
        await flushRepository(repository);
        return jsonResponse(res, 200, result);
      }

      if (req.method === "POST" && pathname === "/api/telephony-configs") {
        const body = await parseJsonBody(req);
        const result = upsertTelephonyConfig({
          repository,
          config: body
        });
        await flushRepository(repository);
        return jsonResponse(res, 200, result);
      }

      if (req.method === "POST" && pathname === "/api/phone-identities/link") {
        const body = await parseJsonBody(req);
        const result = linkPhoneIdentity({
          repository,
          serviceProfileId: body.serviceProfileId ?? activeServiceProfileId,
          userId: body.userId,
          phoneNumber: body.phoneNumber,
          verified: body.verified ?? true
        });
        await flushRepository(repository);
        return jsonResponse(res, 200, result);
      }

      jsonResponse(res, 404, { error: "Not Found" });
      return null;
    } catch (error) {
      jsonResponse(res, 400, {
        error: error instanceof Error ? error.message : "Unknown error"
      });
      return null;
    }
  });

  return {
    repository,
    serviceProfileId: activeServiceProfileId,
    server
  };
}

export async function createReqmoServerFromEnv({
  repositoryAdapter,
  tenantId,
  firestore,
  ...serverOptions
} = {}) {
  const repository = await createRepositoryFromEnv({
    adapter: repositoryAdapter,
    tenantId,
    firestore
  });

  return createReqmoServer({
    ...serverOptions,
    repository
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8787);

  createReqmoServerFromEnv()
    .then(({ server }) => {
      server.listen(port, () => {
        // eslint-disable-next-line no-console
        console.log(`Reqmo backend API listening on http://localhost:${port}`);
      });
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error("Failed to bootstrap Reqmo backend:", error);
      process.exit(1);
    });
}
