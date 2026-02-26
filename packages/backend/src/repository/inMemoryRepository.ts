import { createDefaultServiceProfile } from "../../../shared/src/defaults.ts";

export class InMemoryRepository {
  constructor(seed = {}) {
    this.users = new Map();
    this.vehicles = new Map();
    this.stops = new Map();
    this.rideRequests = new Map();
    this.trips = new Map();
    this.phoneIdentities = new Map();
    this.lineIdentities = new Map();
    this.lineChatSessions = new Map();
    this.callEvents = new Map();
    this.serviceProfiles = new Map();
    this.farePolicies = new Map();
    this.telephonyConfigs = new Map();
    this._counter = Number(seed.counter ?? 0);

    const defaultProfile = createDefaultServiceProfile();
    this.serviceProfiles.set(defaultProfile.id, defaultProfile);

    if (seed.users) {
      seed.users.forEach((user) => this.users.set(user.id, { ...user }));
    }
    if (seed.vehicles) {
      seed.vehicles.forEach((vehicle) => this.vehicles.set(vehicle.id, { ...vehicle }));
    }
    if (seed.stops) {
      seed.stops.forEach((stop) => this.stops.set(stop.id, { ...stop }));
    }
    if (seed.serviceProfiles) {
      seed.serviceProfiles.forEach((profile) => this.serviceProfiles.set(profile.id, { ...profile }));
    }
    if (seed.farePolicies) {
      seed.farePolicies.forEach((farePolicy) => this.farePolicies.set(farePolicy.id, { ...farePolicy }));
    }
    if (seed.telephonyConfigs) {
      seed.telephonyConfigs.forEach((config) => this.telephonyConfigs.set(config.id, { ...config }));
    }
    if (seed.rideRequests) {
      seed.rideRequests.forEach((request) => this.rideRequests.set(request.id, { ...request }));
    }
    if (seed.trips) {
      seed.trips.forEach((trip) => this.trips.set(trip.id, { ...trip }));
    }
    if (seed.callEvents) {
      seed.callEvents.forEach((event) => this.callEvents.set(event.id, { ...event }));
    }
    if (seed.phoneIdentities) {
      seed.phoneIdentities.forEach((identity) => {
        this.phoneIdentities.set(identity.normalizedPhoneE164, { ...identity });
      });
    }
    if (seed.lineIdentities) {
      seed.lineIdentities.forEach((identity) => {
        this.lineIdentities.set(identity.lineUserId, { ...identity });
      });
    }
    if (seed.lineChatSessions) {
      seed.lineChatSessions.forEach((session) => {
        const lineUserId = typeof session?.lineUserId === "string" ? session.lineUserId.trim() : "";
        if (!lineUserId) {
          return;
        }
        this.lineChatSessions.set(lineUserId, { ...session, lineUserId });
      });
    }
  }

  nextId(prefix) {
    this._counter += 1;
    return `${prefix}_${String(this._counter).padStart(6, "0")}`;
  }

  addUser(user) {
    this.users.set(user.id, { ...user });
    return this.users.get(user.id);
  }

  getUser(userId) {
    if (typeof userId !== "string") {
      return null;
    }
    const key = userId.trim();
    if (!key) {
      return null;
    }
    return this.users.get(key) ?? null;
  }

  updateUser(userId, updates = {}) {
    const current = this.getUser(userId);
    if (!current) {
      return null;
    }
    const next = {
      ...current,
      ...updates
    };
    this.users.set(current.id, next);
    return next;
  }

  listUsers() {
    return Array.from(this.users.values());
  }

  addVehicle(vehicle) {
    this.vehicles.set(vehicle.id, {
      status: "ACTIVE",
      route: [],
      onboardCount: 0,
      ...vehicle
    });
    return this.vehicles.get(vehicle.id);
  }

  updateVehicle(vehicleId, updates) {
    const current = this.vehicles.get(vehicleId);
    if (!current) {
      return null;
    }
    const next = { ...current, ...updates };
    this.vehicles.set(vehicleId, next);
    return next;
  }

  listVehicles() {
    return Array.from(this.vehicles.values());
  }

  addStop(stop) {
    this.stops.set(stop.id, { ...stop });
    return this.stops.get(stop.id);
  }

  listStops() {
    return Array.from(this.stops.values());
  }

  findStopById(stopId) {
    return this.stops.get(stopId) ?? null;
  }

  setServiceProfile(profile) {
    this.serviceProfiles.set(profile.id, { ...profile });
    return this.serviceProfiles.get(profile.id);
  }

  getServiceProfile(profileId) {
    if (profileId && this.serviceProfiles.has(profileId)) {
      return this.serviceProfiles.get(profileId);
    }
    return this.serviceProfiles.get("weekday_default_v1") ?? Array.from(this.serviceProfiles.values())[0] ?? null;
  }

  setFarePolicy(farePolicy) {
    const id = farePolicy.id ?? this.nextId("fare");
    const next = { id, ...farePolicy };
    this.farePolicies.set(id, next);
    return next;
  }

  listFarePolicies() {
    return Array.from(this.farePolicies.values());
  }

  setTelephonyConfig(config) {
    const id = config.id ?? this.nextId("telephony");
    const next = { id, ...config };
    this.telephonyConfigs.set(id, next);
    return next;
  }

  listTelephonyConfigs() {
    return Array.from(this.telephonyConfigs.values());
  }

  getTelephonyConfig(configId) {
    if (configId && this.telephonyConfigs.has(configId)) {
      return this.telephonyConfigs.get(configId);
    }
    return Array.from(this.telephonyConfigs.values())[0] ?? null;
  }

  listServiceProfiles() {
    return Array.from(this.serviceProfiles.values());
  }

  createRideRequest(rideRequest) {
    const id = rideRequest.id ?? this.nextId("req");
    const now = new Date().toISOString();
    const next = {
      id,
      status: "REQUESTED",
      createdAt: now,
      updatedAt: now,
      ...rideRequest
    };
    this.rideRequests.set(id, next);
    return next;
  }

  updateRideRequest(requestId, updates) {
    const current = this.rideRequests.get(requestId);
    if (!current) {
      return null;
    }
    const next = { ...current, ...updates, updatedAt: new Date().toISOString() };
    this.rideRequests.set(requestId, next);
    return next;
  }

  getRideRequest(requestId) {
    return this.rideRequests.get(requestId) ?? null;
  }

  listRideRequests() {
    return Array.from(this.rideRequests.values());
  }

  resetRideRequests() {
    const clearedRideRequests = this.rideRequests.size;
    const clearedTrips = this.trips.size;
    const updatedVehicles = this.vehicles.size;

    this.rideRequests.clear();
    this.trips.clear();

    this.vehicles.forEach((vehicle, vehicleId) => {
      this.vehicles.set(vehicleId, {
        ...vehicle,
        onboardCount: 0,
        route: []
      });
    });

    return {
      clearedRideRequests,
      clearedTrips,
      updatedVehicles
    };
  }

  createTrip(trip) {
    const id = trip.id ?? this.nextId("trip");
    const now = new Date().toISOString();
    const next = {
      id,
      status: "PLANNED",
      createdAt: now,
      updatedAt: now,
      ...trip
    };
    this.trips.set(id, next);
    return next;
  }

  linkPhoneIdentity({ userId, normalizedPhoneE164, source = "OPERATOR_REGISTERED", verified = false }) {
    const key = normalizedPhoneE164;
    const now = new Date().toISOString();
    const current = this.phoneIdentities.get(key);
    const next = {
      id: current?.id ?? this.nextId("phone"),
      userId,
      normalizedPhoneE164,
      source,
      verified,
      lastSeenAt: now,
      blockStatus: current?.blockStatus ?? "ACTIVE"
    };
    this.phoneIdentities.set(key, next);
    return next;
  }

  findUserByPhone(normalizedPhoneE164) {
    const identity = this.phoneIdentities.get(normalizedPhoneE164);
    if (!identity || identity.blockStatus === "BLOCKED") {
      return null;
    }
    return this.users.get(identity.userId) ?? null;
  }

  getPhoneIdentity(normalizedPhoneE164) {
    const key = typeof normalizedPhoneE164 === "string" ? normalizedPhoneE164.trim() : "";
    if (!key) {
      return null;
    }
    return this.phoneIdentities.get(key) ?? null;
  }

  findPhoneIdentityByUserId(userId) {
    const key = typeof userId === "string" ? userId.trim() : "";
    if (!key) {
      return null;
    }
    for (const identity of this.phoneIdentities.values()) {
      if (identity?.userId === key && identity?.blockStatus !== "BLOCKED") {
        return identity;
      }
    }
    return null;
  }

  listPhoneIdentities() {
    return Array.from(this.phoneIdentities.values());
  }

  linkLineIdentity({
    userId,
    lineUserId,
    source = "LINE_MINIAPP",
    verified = true,
    displayName = null
  }) {
    const key = typeof lineUserId === "string" ? lineUserId.trim() : "";
    if (!key) {
      throw new Error("lineUserId is required");
    }
    const now = new Date().toISOString();
    const current = this.lineIdentities.get(key);
    const normalizedDisplayName =
      typeof displayName === "string" && displayName.trim() ? displayName.trim() : null;
    const next = {
      id: current?.id ?? this.nextId("line"),
      userId,
      lineUserId: key,
      source,
      verified,
      displayName: normalizedDisplayName ?? current?.displayName ?? null,
      lastSeenAt: now,
      blockStatus: current?.blockStatus ?? "ACTIVE"
    };
    this.lineIdentities.set(key, next);
    return next;
  }

  getLineIdentity(lineUserId) {
    const key = typeof lineUserId === "string" ? lineUserId.trim() : "";
    if (!key) {
      return null;
    }
    return this.lineIdentities.get(key) ?? null;
  }

  findUserByLine(lineUserId) {
    const identity = this.getLineIdentity(lineUserId);
    if (!identity || identity.blockStatus === "BLOCKED") {
      return null;
    }
    return this.users.get(identity.userId) ?? null;
  }

  listLineIdentities() {
    return Array.from(this.lineIdentities.values());
  }

  upsertLineChatSession(lineUserId, session) {
    const key = typeof lineUserId === "string" ? lineUserId.trim() : "";
    if (!key) {
      throw new Error("lineUserId is required");
    }
    if (!session || typeof session !== "object") {
      throw new Error("session is required");
    }
    const next = {
      lineUserId: key,
      ...session
    };
    this.lineChatSessions.set(key, next);
    return next;
  }

  getLineChatSession(lineUserId) {
    const key = typeof lineUserId === "string" ? lineUserId.trim() : "";
    if (!key) {
      return null;
    }
    return this.lineChatSessions.get(key) ?? null;
  }

  clearLineChatSession(lineUserId) {
    const key = typeof lineUserId === "string" ? lineUserId.trim() : "";
    if (!key) {
      return false;
    }
    return this.lineChatSessions.delete(key);
  }

  saveCallEvent(callEvent) {
    const id = callEvent.id ?? this.nextId("call");
    const next = {
      id,
      status: "RECEIVED",
      receivedAt: new Date().toISOString(),
      ...callEvent
    };
    this.callEvents.set(id, next);
    return next;
  }

  listCallEvents() {
    return Array.from(this.callEvents.values());
  }
}
