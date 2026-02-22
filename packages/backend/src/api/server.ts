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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
        return jsonResponse(res, 200, {
          ok: true,
          service: "reqmo-backend",
          seedSource: seeded.source
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
          desiredDropoffAt: body.desiredDropoffAt ?? body.desiredPickupAt ?? null,
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
          desiredDropoffAt: body.desiredDropoffAt ?? body.desiredPickupAt ?? null,
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
          desiredDropoffAt: body.desiredDropoffAt ?? body.desiredPickupAt ?? null,
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
          desiredDropoffAt: body.desiredDropoffAt ?? body.desiredPickupAt ?? null,
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
          desiredDropoffAt: body.desiredDropoffAt ?? body.desiredPickupAt ?? null,
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
