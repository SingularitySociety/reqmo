import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { InMemoryRepository } from "../src/repository/inMemoryRepository.js";
import { loadConfiguredSeedData } from "../src/seed/configSeedLoader.js";
import { createReqmoServer } from "../src/api/server.js";

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
