import { InMemoryRepository } from "./inMemoryRepository.ts";

const COLLECTIONS = [
  "users",
  "vehicles",
  "stops",
  "rideRequests",
  "trips",
  "phoneIdentities",
  "callEvents",
  "serviceProfiles",
  "farePolicies",
  "telephonyConfigs"
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function createFirestoreClient() {
  const { getApps, initializeApp } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");

  if (!getApps().length) {
    initializeApp();
  }

  return getFirestore();
}

export class FirestoreRepository extends InMemoryRepository {
  constructor({ firestore, tenantId = "tenant_default", seed = {}, counter = 0 } = {}) {
    super({ ...seed, counter });
    this.firestore = firestore;
    this.tenantId = tenantId;
    this._pending = Promise.resolve();
    this._lastError = null;
  }

  static async create({ firestore = null, tenantId = "tenant_default" } = {}) {
    const db = firestore ?? (await createFirestoreClient());
    const tenantRef = db.collection("tenants").doc(tenantId);

    const [
      users,
      vehicles,
      stops,
      rideRequests,
      trips,
      phoneIdentities,
      callEvents,
      serviceProfiles,
      farePolicies,
      telephonyConfigs,
      counterSnapshot
    ] = await Promise.all([
      tenantRef.collection("users").get(),
      tenantRef.collection("vehicles").get(),
      tenantRef.collection("stops").get(),
      tenantRef.collection("rideRequests").get(),
      tenantRef.collection("trips").get(),
      tenantRef.collection("phoneIdentities").get(),
      tenantRef.collection("callEvents").get(),
      tenantRef.collection("serviceProfiles").get(),
      tenantRef.collection("farePolicies").get(),
      tenantRef.collection("telephonyConfigs").get(),
      tenantRef.collection("__meta").doc("counters").get()
    ]);

    const seed = {
      users: users.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      vehicles: vehicles.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      stops: stops.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      rideRequests: rideRequests.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      trips: trips.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      phoneIdentities: phoneIdentities.docs.map((doc) => ({
        normalizedPhoneE164: doc.id,
        ...doc.data()
      })),
      callEvents: callEvents.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      serviceProfiles: serviceProfiles.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      farePolicies: farePolicies.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      telephonyConfigs: telephonyConfigs.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
    };

    const counter = Number(counterSnapshot.data()?.counter ?? 0);

    return new FirestoreRepository({
      firestore: db,
      tenantId,
      seed,
      counter
    });
  }

  collection(name) {
    return this.firestore.collection("tenants").doc(this.tenantId).collection(name);
  }

  enqueue(task) {
    this._pending = this._pending
      .then(task)
      .catch((error) => {
        this._lastError = error;
      });
  }

  writeDocument(collection, id, payload) {
    this.enqueue(async () => {
      await this.collection(collection).doc(id).set(clone(payload));
    });
  }

  persistCounter() {
    const counter = this._counter;
    this.enqueue(async () => {
      await this.collection("__meta").doc("counters").set(
        {
          counter,
          updatedAt: new Date().toISOString()
        },
        { merge: true }
      );
    });
  }

  nextId(prefix) {
    const id = super.nextId(prefix);
    this.persistCounter();
    return id;
  }

  addUser(user) {
    const next = super.addUser(user);
    this.writeDocument("users", next.id, next);
    return next;
  }

  addVehicle(vehicle) {
    const next = super.addVehicle(vehicle);
    this.writeDocument("vehicles", next.id, next);
    return next;
  }

  updateVehicle(vehicleId, updates) {
    const next = super.updateVehicle(vehicleId, updates);
    if (next) {
      this.writeDocument("vehicles", next.id, next);
    }
    return next;
  }

  addStop(stop) {
    const next = super.addStop(stop);
    this.writeDocument("stops", next.id, next);
    return next;
  }

  setServiceProfile(profile) {
    const next = super.setServiceProfile(profile);
    this.writeDocument("serviceProfiles", next.id, next);
    return next;
  }

  setFarePolicy(farePolicy) {
    const next = super.setFarePolicy(farePolicy);
    this.writeDocument("farePolicies", next.id, next);
    return next;
  }

  setTelephonyConfig(config) {
    const next = super.setTelephonyConfig(config);
    this.writeDocument("telephonyConfigs", next.id, next);
    return next;
  }

  createRideRequest(rideRequest) {
    const next = super.createRideRequest(rideRequest);
    this.writeDocument("rideRequests", next.id, next);
    return next;
  }

  updateRideRequest(requestId, updates) {
    const next = super.updateRideRequest(requestId, updates);
    if (next) {
      this.writeDocument("rideRequests", next.id, next);
    }
    return next;
  }

  createTrip(trip) {
    const next = super.createTrip(trip);
    this.writeDocument("trips", next.id, next);
    return next;
  }

  linkPhoneIdentity({ userId, normalizedPhoneE164, source = "OPERATOR_REGISTERED", verified = false }) {
    const next = super.linkPhoneIdentity({ userId, normalizedPhoneE164, source, verified });
    this.writeDocument("phoneIdentities", normalizedPhoneE164, next);
    return next;
  }

  saveCallEvent(callEvent) {
    const next = super.saveCallEvent(callEvent);
    this.writeDocument("callEvents", next.id, next);
    return next;
  }

  async flush() {
    await this._pending;
    if (this._lastError) {
      const error = this._lastError;
      this._lastError = null;
      throw error;
    }
  }

  static collectionNames() {
    return [...COLLECTIONS];
  }
}
