import fs from "node:fs";
import path from "node:path";

import { createDefaultServiceProfile } from "../../../shared/src/defaults.js";
import { upsertServiceProfile, upsertFarePolicy, upsertTelephonyConfig } from "../api/functions.js";

function readJsonIfExists(filePath) {
  if (!filePath) {
    return null;
  }
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function ensureStops(repository, stops = []) {
  for (const stop of stops) {
    repository.addStop({
      id: stop.id,
      name: stop.name,
      lat: stop.lat,
      lng: stop.lng
    });
  }
}

function resolveProfileId(bundle, serviceProfile) {
  if (bundle?.serviceProfiles?.[0]?.id) {
    return bundle.serviceProfiles[0].id;
  }
  if (serviceProfile?.id) {
    return serviceProfile.id;
  }
  return createDefaultServiceProfile().id;
}

export function loadConfiguredSeedData({
  repository,
  bundlePath,
  stopsPath,
  serviceProfilePath,
  farePolicyPath,
  telephonyConfigPath
}) {
  const bundle = readJsonIfExists(bundlePath);
  const stopsPayload = readJsonIfExists(stopsPath);
  const serviceProfile = readJsonIfExists(serviceProfilePath);
  const farePolicy = readJsonIfExists(farePolicyPath);
  const telephonyConfig = readJsonIfExists(telephonyConfigPath);

  if (bundle) {
    ensureStops(repository, bundle.stops ?? []);
    for (const profile of bundle.serviceProfiles ?? []) {
      upsertServiceProfile({ repository, profile });
    }
    for (const policy of bundle.farePolicies ?? []) {
      upsertFarePolicy({ repository, farePolicy: policy });
    }
    for (const config of bundle.telephonyConfigs ?? []) {
      upsertTelephonyConfig({ repository, config });
    }

    return {
      profileId: resolveProfileId(bundle, serviceProfile),
      source: path.basename(bundlePath),
      stopsCount: (bundle.stops ?? []).length
    };
  }

  if (stopsPayload?.stops?.length) {
    ensureStops(repository, stopsPayload.stops);
  }

  if (serviceProfile) {
    upsertServiceProfile({ repository, profile: serviceProfile });
  }
  if (farePolicy) {
    upsertFarePolicy({ repository, farePolicy });
  }
  if (telephonyConfig) {
    upsertTelephonyConfig({ repository, config: telephonyConfig });
  }

  return {
    profileId: resolveProfileId(bundle, serviceProfile),
    source: "config-files",
    stopsCount: stopsPayload?.stops?.length ?? 0
  };
}
