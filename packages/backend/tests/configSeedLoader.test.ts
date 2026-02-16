import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { InMemoryRepository } from "../src/repository/inMemoryRepository.ts";
import { loadConfiguredSeedData } from "../src/seed/configSeedLoader.ts";
import { createReqmoServer } from "../src/api/server.ts";
import { createDefaultServiceProfile } from "../../shared/src/defaults.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixtureBundlePath = path.join(__dirname, "fixtures", "seed.bundle.json");

test("loadConfiguredSeedData loads stops and profiles from bundle", () => {
  const repository = new InMemoryRepository();

  const loaded = loadConfiguredSeedData({
    repository,
    bundlePath: fixtureBundlePath
  });

  assert.equal(loaded.profileId, "weekday_city_v1");
  assert.ok(repository.listStops().length >= 2);
  assert.ok(repository.listServiceProfiles().some((profile) => profile.id === "weekday_city_v1"));
});

test("loadConfiguredSeedData keeps existing profile values by default", () => {
  const seededProfile = {
    ...createDefaultServiceProfile({ id: "weekday_city_v1" }),
    fleetPolicy: {
      ...createDefaultServiceProfile().fleetPolicy,
      maxActiveVehicles: 99
    },
    dispatchPolicy: {
      ...createDefaultServiceProfile().dispatchPolicy,
      cruiseSpeedKmh: 12
    }
  };
  const repository = new InMemoryRepository({
    serviceProfiles: [seededProfile]
  });

  loadConfiguredSeedData({
    repository,
    bundlePath: fixtureBundlePath
  });

  const persistedProfile = repository.getServiceProfile("weekday_city_v1");
  assert.equal(persistedProfile?.fleetPolicy?.maxActiveVehicles, 99);
  assert.equal(persistedProfile?.dispatchPolicy?.cruiseSpeedKmh, 12);
});

test("loadConfiguredSeedData can overwrite existing profile values when enabled", () => {
  const seededProfile = {
    ...createDefaultServiceProfile({ id: "weekday_city_v1" }),
    fleetPolicy: {
      ...createDefaultServiceProfile().fleetPolicy,
      maxActiveVehicles: 99
    }
  };
  const repository = new InMemoryRepository({
    serviceProfiles: [seededProfile]
  });

  loadConfiguredSeedData({
    repository,
    bundlePath: fixtureBundlePath,
    overwriteExisting: true
  });

  const overwrittenProfile = repository.getServiceProfile("weekday_city_v1");
  assert.equal(overwrittenProfile?.fleetPolicy?.maxActiveVehicles, 20);
});

test("createReqmoServer uses configured seed options", () => {
  const { repository, serviceProfileId } = createReqmoServer({
    seedOptions: {
      bundlePath: fixtureBundlePath
    }
  });

  assert.equal(serviceProfileId, "weekday_city_v1");
  assert.ok(repository.listStops().length >= 2);
  assert.ok(repository.listVehicles().length >= 1);
});
