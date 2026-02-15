/**
 * Firebase Functions bridge for Reqmo backend.
 *
 * This file intentionally depends on firebase-admin/functions runtime packages.
 * Domain logic lives in ../../packages/backend/src
 */

const { onCall } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");

initializeApp();

let repoRef = null;
let coreRef = null;

async function loadCore() {
  if (!coreRef) {
    coreRef = await import("../../packages/backend/src/index.js");
  }
  if (!repoRef) {
    repoRef = new coreRef.InMemoryRepository();
  }
  return { core: coreRef, repository: repoRef };
}

exports.createRideRequestFn = onCall((request) => {
  return loadCore().then(({ core, repository }) =>
    core.createRideRequest({
      repository,
      ...request.data
    })
  );
});

exports.ingestCallEventFn = onCall((request) => {
  return loadCore().then(({ core, repository }) =>
    core.ingestCall({
      repository,
      ...request.data
    })
  );
});

exports.createRideRequestByPhoneFn = onCall((request) => {
  return loadCore().then(({ core, repository }) =>
    core.createPhoneRideRequest({
      repository,
      ...request.data
    })
  );
});

exports.upsertServiceProfileFn = onCall((request) => {
  return loadCore().then(({ core, repository }) =>
    core.upsertServiceProfile({
      repository,
      profile: request.data
    })
  );
});

exports.upsertFarePolicyFn = onCall((request) => {
  return loadCore().then(({ core, repository }) =>
    core.upsertFarePolicy({
      repository,
      farePolicy: request.data
    })
  );
});

exports.upsertTelephonyConfigFn = onCall((request) => {
  return loadCore().then(({ core, repository }) =>
    core.upsertTelephonyConfig({
      repository,
      config: request.data
    })
  );
});
