/**
 * Firebase Functions bridge for Reqmo backend.
 *
 * This file intentionally depends on firebase-admin/functions runtime packages.
 * Domain logic lives in ../../packages/backend/src
 */

import { onCall } from "firebase-functions/v2/https";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) {
  initializeApp();
}

let runtimeRef = null;

async function loadRuntime() {
  if (!runtimeRef) {
    const core = await import("../../packages/backend/src/index.ts");
    const repositoryAdapter = process.env.REPOSITORY_ADAPTER ?? "memory";
    const tenantId = process.env.REQMO_TENANT_ID ?? "tenant_default";

    const repository = await core.createRepositoryFromEnv({
      adapter: repositoryAdapter,
      tenantId,
      firestore: repositoryAdapter === "firestore" ? getFirestore() : undefined
    });

    runtimeRef = {
      core,
      repository,
      tenantId
    };
  }

  return runtimeRef;
}

async function flushRepository(repository) {
  if (typeof repository.flush === "function") {
    await repository.flush();
  }
}

export const createRideRequestFn = onCall(async (request) => {
  const { core, repository, tenantId } = await loadRuntime();
  const result = await core.createRideRequest({
    repository,
    ...request.data,
    tenantId: request.data?.tenantId ?? tenantId
  });
  await flushRepository(repository);
  return result;
});

export const ingestCallEventFn = onCall(async (request) => {
  const { core, repository } = await loadRuntime();
  const result = core.ingestCall({
    repository,
    ...request.data
  });
  await flushRepository(repository);
  return result;
});

export const createRideRequestByPhoneFn = onCall(async (request) => {
  const { core, repository, tenantId } = await loadRuntime();
  const result = await core.createPhoneRideRequest({
    repository,
    ...request.data,
    tenantId: request.data?.tenantId ?? tenantId
  });
  await flushRepository(repository);
  return result;
});

export const upsertServiceProfileFn = onCall(async (request) => {
  const { core, repository } = await loadRuntime();
  const result = core.upsertServiceProfile({
    repository,
    profile: request.data
  });
  await flushRepository(repository);
  return result;
});

export const upsertFarePolicyFn = onCall(async (request) => {
  const { core, repository } = await loadRuntime();
  const result = core.upsertFarePolicy({
    repository,
    farePolicy: request.data
  });
  await flushRepository(repository);
  return result;
});

export const upsertTelephonyConfigFn = onCall(async (request) => {
  const { core, repository } = await loadRuntime();
  const result = core.upsertTelephonyConfig({
    repository,
    config: request.data
  });
  await flushRepository(repository);
  return result;
});
