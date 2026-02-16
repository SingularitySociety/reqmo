import fs from "node:fs";
import path from "node:path";

import { createDefaultServiceProfile } from "../../../shared/src/defaults.ts";
import { upsertServiceProfile, upsertFarePolicy, upsertTelephonyConfig } from "../api/functions.ts";

function readJsonIfExists(filePath) {
  if (!filePath) {
    return null;
  }
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function ensureStops(repository, stops = [], { overwriteExisting = false } = {}) {
  const existingStopIds = new Set(
    repository.listStops().map((stop) => stop.id)
  );

  for (const stop of stops) {
    if (!overwriteExisting && existingStopIds.has(stop.id)) {
      continue;
    }
    repository.addStop({
      id: stop.id,
      name: stop.name,
      lat: stop.lat,
      lng: stop.lng
    });
    existingStopIds.add(stop.id);
  }
}

function upsertServiceProfiles(repository, profiles = [], { overwriteExisting = false } = {}) {
  const existingProfileIds = new Set(
    repository.listServiceProfiles().map((profile) => profile.id)
  );

  for (const profile of profiles) {
    if (!overwriteExisting && existingProfileIds.has(profile.id)) {
      continue;
    }
    upsertServiceProfile({ repository, profile });
    existingProfileIds.add(profile.id);
  }
}

function upsertFarePolicies(repository, policies = [], { overwriteExisting = false } = {}) {
  const existingPolicyIds = new Set(
    repository.listFarePolicies().map((policy) => policy.id)
  );

  for (const policy of policies) {
    if (!overwriteExisting && policy.id && existingPolicyIds.has(policy.id)) {
      continue;
    }
    upsertFarePolicy({ repository, farePolicy: policy });
    if (policy.id) {
      existingPolicyIds.add(policy.id);
    }
  }
}

function upsertTelephonyConfigs(repository, configs = [], { overwriteExisting = false } = {}) {
  const existingConfigIds = new Set(
    repository.listTelephonyConfigs().map((config) => config.id)
  );

  for (const config of configs) {
    if (!overwriteExisting && config.id && existingConfigIds.has(config.id)) {
      continue;
    }
    upsertTelephonyConfig({ repository, config });
    if (config.id) {
      existingConfigIds.add(config.id);
    }
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
  telephonyConfigPath,
  overwriteExisting = false
}) {
  const bundle = readJsonIfExists(bundlePath);
  const stopsPayload = readJsonIfExists(stopsPath);
  const serviceProfile = readJsonIfExists(serviceProfilePath);
  const farePolicy = readJsonIfExists(farePolicyPath);
  const telephonyConfig = readJsonIfExists(telephonyConfigPath);

  if (bundle) {
    ensureStops(repository, bundle.stops ?? [], { overwriteExisting });
    upsertServiceProfiles(repository, bundle.serviceProfiles ?? [], { overwriteExisting });
    upsertFarePolicies(repository, bundle.farePolicies ?? [], { overwriteExisting });
    upsertTelephonyConfigs(repository, bundle.telephonyConfigs ?? [], { overwriteExisting });

    return {
      profileId: resolveProfileId(bundle, serviceProfile),
      source: path.basename(bundlePath),
      stopsCount: (bundle.stops ?? []).length
    };
  }

  if (stopsPayload?.stops?.length) {
    ensureStops(repository, stopsPayload.stops, { overwriteExisting });
  }

  if (serviceProfile) {
    upsertServiceProfiles(repository, [serviceProfile], { overwriteExisting });
  }
  if (farePolicy) {
    upsertFarePolicies(repository, [farePolicy], { overwriteExisting });
  }
  if (telephonyConfig) {
    upsertTelephonyConfigs(repository, [telephonyConfig], { overwriteExisting });
  }

  return {
    profileId: resolveProfileId(bundle, serviceProfile),
    source: "config-files",
    stopsCount: stopsPayload?.stops?.length ?? 0
  };
}
